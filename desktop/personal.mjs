import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Store } from '../lib/store.js';
import { createApp } from '../server.js';
import { createFurious } from '../lib/furious.js';
import { APP_VERSION } from '../lib/version.js';

const root = dirname(fileURLToPath(import.meta.url));
const accessCookie = 'clock_personal_access';
// Personal installation: the owner confirmed a 7-hour Furious day.
const personalHoursPerDay = 7;
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
function cookie(req, name) { return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1); }
function validate(config) {
  if (!config || typeof config.email !== 'string' || !/^[^\s@]+@studio-katra\.com$/i.test(config.email.trim())
    || typeof config.username !== 'string' || !config.username.trim() || config.username.length > 200
    || typeof config.password !== 'string' || !config.password || config.password.length > 4096) {
    throw new Error('Renseignez votre adresse du studio et les deux identifiants du compte API Furious.');
  }
  const hours = config.hoursPerDay === '' || config.hoursPerDay === undefined ? personalHoursPerDay : Number(typeof config.hoursPerDay === 'string' ? config.hoursPerDay.replace(',', '.') : config.hoursPerDay);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('L’horaire journalier doit être compris entre 0 et 24 heures.');
  return { email: config.email.trim().toLowerCase(), username: config.username.trim(), password: config.password, hoursPerDay: hours };
}
const localUser = config => ({ id: `personal:${config.email}`, email: config.email, name: config.email.split('@')[0] });

export async function startPersonalServer({ directory, vault, port = 34157, providerFactory = createFurious, store: suppliedStore } = {}) {
  if (!directory || !vault?.read || !vault?.write) throw new Error('Le stockage personnel et le Trousseau sont requis.');
  const saved = await vault.read();
  let config = saved ? validate(saved) : null;
  let provider, apiApp, configuring = false;
  const store = suppliedStore || new Store(resolve(directory, 'clock.sqlite'));
  const access = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  let bootstrap = randomBytes(32).toString('base64url');
  const bootstrapExpires = Date.now() + 5 * 60_000;
  const router = express();
  const server = createServer(router);
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveReady);
  }).catch(error => { if (!suppliedStore) store.close(); throw error; });
  const appUrl = `http://127.0.0.1:${server.address().port}`;
  const options = { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 7 * 86400_000 };
  function configure(next) {
    config = next;
    provider = providerFactory({ username: config.username, password: config.password, hoursPerDay: config.hoursPerDay });
    apiApp = createApp({ personal: true, store, provider, appUrl });
  }
  if (config) configure(config);
  router.disable('x-powered-by');
  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    // Reject alternate Host headers/DNS rebinding even though the socket is local.
    if (req.headers.host !== new URL(appUrl).host) return res.sendStatus(403);
    next();
  });
  router.get('/desktop/open', (req, res) => {
    if (!bootstrap || Date.now() > bootstrapExpires || !equal(req.query.key, bootstrap)) return res.sendStatus(403);
    bootstrap = null;
    res.cookie(accessCookie, access, options);
    res.redirect(config ? '/' : '/desktop/settings');
  });
  router.use((req, res, next) => {
    if (!equal(cookie(req, accessCookie), access)) return res.status(403).type('text').send('Ouvrez Clock depuis Applications sur votre Mac. Si nécessaire, quittez puis rouvrez l’application.');
    if (req.headers.origin && req.headers.origin !== appUrl) return res.sendStatus(403);
    next();
  });
  router.use(express.json({ limit: '8kb' }));
  router.get('/desktop/settings', (_req, res) => res.sendFile(resolve(root, 'settings.html')));
  router.get('/desktop/settings.js', (_req, res) => res.sendFile(resolve(root, 'settings.js')));
  router.get('/desktop/settings.css', (_req, res) => res.sendFile(resolve(root, 'settings.css')));
  router.use('/assets', express.static(resolve(root, '../public/assets')));
  router.get('/desktop/config', (_req, res) => res.json({
    email: config?.email || '', username: config?.username || '', hoursPerDay: config?.hoursPerDay || personalHoursPerDay,
    hasPassword: Boolean(config?.password), configured: Boolean(config), csrf, appVersion: APP_VERSION,
  }));
  router.post('/desktop/config', async (req, res) => {
    if (req.headers.origin !== appUrl || !equal(req.headers['x-csrf-token'], csrf)) return res.sendStatus(403);
    if (configuring) return res.status(409).json({ error: 'Enregistrement déjà en cours.' });
    configuring = true;
    try {
      const submitted = { ...req.body };
      // A blank password on settings updates means retain the existing secret.
      if (submitted.password === '' && config) submitted.password = config.password;
      const next = validate(submitted);
      if (config && config.email !== next.email && store.timer(localUser(config).id)) {
        return res.status(409).json({ error: 'Arrêtez la minuterie avant de changer d’adresse.' });
      }
      const candidate = providerFactory({ username: next.username, password: next.password, hoursPerDay: next.hoursPerDay });
      await candidate.identity(localUser(next)); // Read-only validation, no time creation.
      await vault.write(next); // Persist before changing the running configuration.
      configure(next);
      if (cookie(req, 'katra_session')) store.deleteSession(cookie(req, 'katra_session'));
      res.clearCookie('katra_session', { path: '/' });
      res.json({ ok: true });
    } catch (error) {
      // Providers return sanitized errors; never echo transport errors or secrets.
      const safe = error?.notWritten !== undefined || /^(Renseignez|L’horaire|Le Trousseau)/.test(error?.message || '');
      res.status(400).json({ error: safe ? error.message : 'L’enregistrement a échoué. Vérifiez l’accès à Furious et au Trousseau puis réessayez.' });
    } finally { configuring = false; }
  });
  router.use((req, res, next) => {
    if (!config) return res.redirect('/desktop/settings');
    let session = store.session(cookie(req, 'katra_session'));
    const owner = localUser(config);
    if (!session || session.user.id !== owner.id) {
      const created = store.createSession(owner);
      res.cookie('katra_session', created.id, { ...options, sameSite: 'lax', maxAge: 8 * 3600_000 });
      // Make the new session available to the existing application's middleware.
      req.headers.cookie = `${req.headers.cookie || ''}; katra_session=${created.id}`;
      // Remove an expired/foreign duplicate cookie; createApp reads the last value.
      session = store.session(created.id);
    }
    next();
  });
  router.use((req, res, next) => apiApp(req, res, next));
  router.use((_error, _req, res, _next) => res.status(400).json({ error: 'Requête locale invalide.' }));
  return {
    appUrl,
    openUrl: `${appUrl}/desktop/open?key=${bootstrap}`,
    address: server.address(),
    store,
    async close() {
      await new Promise(resolveClosed => server.close(resolveClosed));
      if (!suppliedStore) store.close();
    },
  };
}
