import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Store } from './lib/store.js';
import { createFurious, exportDay } from './lib/furious.js';
import { dayAt, TIME_ZONE } from './lib/time.js';

const root = dirname(fileURLToPath(import.meta.url));
const DOMAIN = 'studio-katra.com';
const cookieName = 'katra_session';
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(x => x.includes('=')).map(x => {
    const index = x.indexOf('=');
    return [x.slice(0, index).trim(), x.slice(index + 1).trim()];
  }));
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
export function authorizedGoogleUser(payload) {
  if (!payload?.sub || payload.email_verified !== true || payload.hd !== DOMAIN
    || typeof payload.email !== 'string' || !/^[^@]+@studio-katra\.com$/i.test(payload.email)) return null;
  return { id: payload.sub, email: payload.email.toLowerCase(), name: payload.name || payload.email.split('@')[0] };
}

export function createApp({ demo = false, store, provider, appUrl = 'http://localhost:3000', oauthClient, personal = false } = {}) {
  const app = express();
  const secure = new URL(appUrl).protocol === 'https:';
  store ||= new Store(resolve(root, demo ? 'data/demo.sqlite' : (process.env.DATABASE_PATH || 'data/clock.sqlite')));
  provider ||= createFurious({ demo });
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const googleConfigured = !personal && Boolean(oauthClient || (clientId && clientSecret));
  const oauth = oauthClient || new OAuth2Client(clientId, clientSecret, `${appUrl}/auth/google/callback`);
  const pendingLogins = new Map();
  const options = { httpOnly: true, secure, sameSite: 'lax', path: '/' };

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    if (secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.use((req, _res, next) => {
    req.session = store.session(cookies(req)[cookieName]);
    next();
  });

  app.get('/auth/google', async (_req, res) => {
    if (personal) return res.sendStatus(404);
    if (!googleConfigured) return res.redirect('/?auth=unconfigured');
    const now = Date.now();
    for (const [key, value] of pendingLogins) if (value.expires < now) pendingLogins.delete(key);
    if (pendingLogins.size >= 1000) return res.status(429).send('Trop de demandes de connexion. Réessayez plus tard.');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    pendingLogins.set(state, { nonce, codeVerifier, expires: now + 10 * 60_000 });
    res.cookie('katra_oauth', state, { ...options, maxAge: 10 * 60_000 });
    res.redirect(oauth.generateAuthUrl({
      scope: ['openid', 'email', 'profile'], state, nonce, hd: DOMAIN,
      code_challenge: codeChallenge, code_challenge_method: 'S256', prompt: 'select_account',
    }));
  });

  app.get('/auth/google/callback', async (req, res) => {
    if (personal) return res.sendStatus(404);
    const { state, code } = req.query;
    const pending = typeof state === 'string' ? pendingLogins.get(state) : null;
    const bound = equal(state, cookies(req).katra_oauth);
    if (bound) pendingLogins.delete(state);
    res.clearCookie('katra_oauth', options);
    if (!pending || !bound || pending.expires < Date.now() || typeof code !== 'string') {
      return res.redirect('/?auth=invalid');
    }
    try {
      const { tokens } = await oauth.getToken({ code, codeVerifier: pending.codeVerifier });
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const payload = ticket.getPayload();
      const user = authorizedGoogleUser(payload);
      if (!user || !equal(payload.nonce, pending.nonce)) return res.redirect('/?auth=denied');
      if (req.session) store.deleteSession(req.session.id);
      const session = store.createSession(user);
      res.cookie(cookieName, session.id, { ...options, maxAge: 8 * 3600_000 });
      return res.redirect('/');
    } catch {
      return res.redirect('/?auth=failed');
    }
  });

  app.get('/api/session', (req, res) => res.json({
    user: req.session?.user || null, csrf: req.session?.csrf || null,
    demo, googleConfigured, furiousConfigured: provider.ready && !demo,
    authMode: personal ? 'personal' : 'google',
    today: dayAt(), timeZone: TIME_ZONE,
  }));
  app.post('/api/demo-login', (req, res) => {
    if (!demo) return res.sendStatus(404);
    if (req.headers.origin !== appUrl) return res.sendStatus(403);
    const session = store.createSession({ id: 'demo-user', name: 'Camille', email: 'demo@studio-katra.com' });
    res.cookie(cookieName, session.id, { ...options, maxAge: 8 * 3600_000 });
    res.json({ ok: true });
  });

  app.use('/api', (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'Connectez-vous pour continuer.' });
    if (!['GET', 'HEAD'].includes(req.method)
      && (req.headers.origin !== appUrl || !equal(req.headers['x-csrf-token'], req.session.csrf))) {
      return res.status(403).json({ error: 'Cette action a été refusée. Rechargez la page.' });
    }
    next();
  });
  app.post('/api/logout', (req, res) => {
    store.deleteSession(req.session.id);
    res.clearCookie(cookieName, options);
    res.json({ ok: true });
  });
  app.get('/api/projects', async (req, res) => {
    try { res.json({ projects: await provider.projects(req.session.user), pinnedProjectIds: store.pins(req.session.user.id) }); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.put('/api/pins/:projectId', async (req, res) => {
    const { projectId } = req.params;
    const { pinned } = req.body || {};
    if (typeof pinned !== 'boolean' || !projectId || projectId.length > 100) return res.status(400).json({ error: 'Projet ou choix d’épinglage invalide.' });
    if (pinned) {
      try {
        const projects = await provider.projects(req.session.user);
        if (!projects.some(p => p.id === projectId)) return res.status(400).json({ error: 'Ce projet n’est pas ouvert ou ne vous est pas accessible.' });
      } catch (error) { return res.status(503).json({ error: error.message }); }
    }
    res.json({ pinnedProjectIds: store.setPinned(req.session.user.id, projectId, pinned) });
  });
  app.get('/api/day', (req, res) => {
    const day = req.query.day || dayAt();
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Date invalide.' });
    const user = req.session.user.id;
    res.json({ day, today: dayAt(), entries: store.entries(user, day), timer: store.timer(user), serverTime: Date.now() });
  });
  app.post('/api/timer/start', async (req, res) => {
    const { projectId, note = '' } = req.body || {};
    if (typeof projectId !== 'string' || typeof note !== 'string' || note.length > 500) return res.status(400).json({ error: 'Projet ou description invalide.' });
    let project;
    try { project = (await provider.projects(req.session.user)).find(p => p.id === projectId); }
    catch (error) { return res.status(503).json({ error: error.message }); }
    if (!project) return res.status(400).json({ error: 'Ce projet n’est pas ouvert ou ne vous est pas accessible.' });
    try { res.json({ timer: store.start(req.session.user.id, project, note.trim()) }); }
    catch (error) { res.status(409).json({ error: error.message }); }
  });
  app.post('/api/timer/stop', (req, res) => {
    try { store.stop(req.session.user.id); res.json({ ok: true }); }
    catch (error) { res.status(409).json({ error: error.message }); }
  });
  app.patch('/api/entries/:id', (req, res) => {
    const { seconds, note } = req.body || {};
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400 || typeof note !== 'string' || note.length > 500) {
      return res.status(400).json({ error: 'Indiquez une durée entre une seconde et 24 heures, et une description de 500 caractères maximum.' });
    }
    try { store.edit(req.session.user.id, req.params.id, seconds, note.trim()); res.json({ ok: true }); }
    catch (error) { res.status(409).json({ error: error.message }); }
  });
  app.post('/api/export', async (req, res) => {
    if (demo) return res.status(409).json({ error: 'Mode démonstration : aucun temps n’est envoyé à Furious.' });
    try { res.json(await exportDay(store, provider, req.session.user, dayAt())); }
    catch (error) { res.status(409).json({ error: error.message }); }
  });
  app.post('/api/entries/:id/reconcile', async (req, res) => {
    if (demo || !provider.ready || !provider.reconcileEntry) return res.status(409).json({ error: 'La vérification nécessite une connexion Furious configurée.' });
    const entry = store.entry(req.session.user.id, req.params.id);
    if (!entry) return res.status(404).json({ error: 'Saisie introuvable.' });
    if (entry.status !== 'uncertain') return res.status(409).json({ error: 'Cette saisie ne nécessite pas de vérification.' });
    try {
      const acknowledgement = await provider.reconcileEntry(req.session.user, entry);
      if (!acknowledgement?.id) return res.status(409).json({ error: 'Aucun temps correspondant n’a été trouvé dans Furious. La saisie reste à vérifier ; aucun temps n’a été renvoyé.' });
      store.exportResult(entry.id, 'exported', String(acknowledgement.id));
      res.json({ ok: true, message: 'Le temps a été retrouvé dans Furious et marqué comme exporté.' });
    } catch (error) { res.status(409).json({ error: error.message }); }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Action inconnue.' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', demo }));
  app.use(express.static(resolve(root, 'public'), { etag: false }));
  app.use((error, _req, res, _next) => {
    const status = error.status === 400 || error.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: status === 400 ? 'Requête invalide.' : 'Une erreur interne est survenue.' });
  });
  app.locals.store = store;
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  if (demo && process.env.NODE_ENV === 'production') throw new Error('Le mode démonstration est interdit en production.');
  const port = Number(process.env.PORT || 3000);
  const appUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production' && new URL(appUrl).protocol !== 'https:') {
    throw new Error('APP_URL doit utiliser HTTPS en production.');
  }
  if (process.env.NODE_ENV === 'production') {
    const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'FURIOUS_API_USERNAME', 'FURIOUS_API_PASSWORD'];
    const missing = required.filter(name => !process.env[name]);
    if (missing.length) throw new Error(`Configuration de production manquante : ${missing.join(', ')}`);
  }
  const app = createApp({ demo, appUrl });
  const server = app.listen(port, demo ? '127.0.0.1' : (process.env.HOST || '0.0.0.0'), () => {
    console.log(`Katra Clock démarré sur le port ${port}${demo ? ' (démonstration locale)' : ''}.`);
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // Allow in-flight requests to finish. An interrupted export remains locked
    // in SQLite and becomes uncertain at the next startup, without a resend.
    const deadline = setTimeout(() => process.exit(1), 20_000);
    deadline.unref();
    server.close(() => {
      app.locals.store.close();
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
