import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { dayAt, splitInterval } from '../lib/time.js';
import { exportDay } from '../lib/furious.js';
import { createApp, authorizedGoogleUser } from '../server.js';

const project = { id: 'p1', name: 'Projet réel de test', client: 'Test' };
const user = { id: 'u1', name: 'Camille', email: 'camille@studio-katra.com' };
const timestamp = Date.parse('2026-11-04T10:00:00Z');

test('Google : compte Workspace vérifié du domaine exact uniquement', () => {
  const valid = { sub: '123', name: 'Camille', email: 'Camille@studio-katra.com', hd: 'studio-katra.com', email_verified: true };
  assert.equal(authorizedGoogleUser(valid).email, 'camille@studio-katra.com');
  for (const changes of [
    { hd: undefined }, { hd: 'autre.com' }, { email_verified: false }, { email_verified: 'true' },
    { email: 'camille@gmail.com' }, { email: 'x@sub.studio-katra.com' }, { email: 'x@studio-katra.com.evil.com' },
    { sub: '' }, { email: 'x@studio-katra.com@evil.com' },
  ]) assert.equal(authorizedGoogleUser({ ...valid, ...changes }), null);
});

test('Les intervalles sont séparés à minuit à Paris et respectent les changements d’heure', () => {
  const parts = splitInterval(Date.parse('2026-11-04T22:30:00Z'), Date.parse('2026-11-04T23:30:00Z'));
  assert.deepEqual(parts.map(p => [p.day, p.seconds]), [['2026-11-04', 1800], ['2026-11-05', 1800]]);
  const spring = splitInterval(Date.parse('2026-03-28T23:00:00Z'), Date.parse('2026-03-29T22:00:00Z'));
  assert.deepEqual(spring.map(p => [p.day, p.seconds]), [['2026-03-29', 23 * 3600]]);
  const autumn = splitInterval(Date.parse('2026-10-24T22:00:00Z'), Date.parse('2026-10-25T23:00:00Z'));
  assert.deepEqual(autumn.map(p => [p.day, p.seconds]), [['2026-10-25', 25 * 3600]]);
  assert.equal(dayAt(Date.parse('2026-11-04T23:05:00Z')), '2026-11-05');
});

test('Une seule minuterie par utilisateur ; isolation et modifications avant export', () => {
  const store = new Store(':memory:');
  try {
    store.start(user.id, project, 'Création', timestamp);
    assert.equal(store.start(user.id, project, 'Autre description', timestamp + 1000).started_at, timestamp);
    store.start('other', project, '', timestamp);
    store.stop(user.id, timestamp + 90_000);
    const [entry] = store.entries(user.id, '2026-11-04');
    assert.equal(entry.seconds, 90);
    assert.equal(store.timer('other').started_at, timestamp);
    assert.equal(store.entries('other', '2026-11-04').length, 0);
    assert.throws(() => store.edit('other', entry.id, 200, ''), /introuvable/);
    store.edit(user.id, entry.id, 120, 'Retouche');
    assert.equal(store.entries(user.id, '2026-11-04')[0].seconds, 120);
    store.claimExport(user.id, '2026-11-04');
    assert.throws(() => store.edit(user.id, entry.id, 200, ''), /introuvable/);
  } finally { store.close(); }
});

test('Changer de projet termine le précédent au même instant, sans chevauchement et avec séparation à minuit', () => {
  const store = new Store(':memory:');
  try {
    const start = Date.parse('2026-11-04T22:30:00Z');
    const switchAt = Date.parse('2026-11-04T23:30:00Z');
    store.start(user.id, project, 'Ancien travail', start);
    store.start('other', project, 'Autre personne', start);
    const next = store.start(user.id, { id: 'p2', name: 'Nouveau projet' }, 'Nouveau travail', switchAt);
    assert.equal(next.started_at, switchAt);
    assert.equal(next.project_id, 'p2');
    assert.equal(next.note, 'Nouveau travail');
    assert.equal(store.entries(user.id, '2026-11-04')[0].seconds, 1800);
    const previous = store.entries(user.id, '2026-11-05')[0];
    assert.equal(previous.seconds, 1800);
    assert.equal(previous.note, 'Ancien travail');
    assert.equal(previous.project_id, project.id);
    assert.equal(previous.status, 'pending');
    assert.equal(store.timer('other').started_at, start);
    store.stop(user.id, switchAt + 60_000);
    const entries = store.entries(user.id, '2026-11-05');
    assert.equal(entries.find(e => e.project_id === 'p2').seconds, 60);
    assert.equal(entries.reduce((sum, e) => sum + e.seconds, 0), 1860);
  } finally { store.close(); }
});

test('Échec du nouveau démarrage : l’ancienne minuterie et ses temps sont préservés', () => {
  const store = new Store(':memory:');
  try {
    const original = store.start(user.id, project, 'À conserver', timestamp);
    assert.throws(() => store.start(user.id, { id: 'p2', name: 'Autre' }, null, timestamp + 60_000));
    assert.deepEqual(store.timer(user.id), original);
    assert.equal(store.entries(user.id, dayAt(timestamp)).length, 0);
  } finally { store.close(); }
});

test('Minuterie, sessions et saisies persistent après redémarrage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'katra-test-'));
  let store;
  try {
    store = new Store(join(dir, 'clock.sqlite'));
    const session = store.createSession(user);
    store.setPinned(user.id, 'pinned-project', true);
    store.start(user.id, project, '', timestamp);
    store.close();
    store = new Store(join(dir, 'clock.sqlite'));
    assert.equal(store.timer(user.id).started_at, timestamp);
    assert.equal(store.session(session.id).user.id, user.id);
    assert.deepEqual(store.pins(user.id), ['pinned-project']);
    assert.deepEqual(store.pins('other-user'), []);
    store.stop(user.id, timestamp + 60_000);
    store.claimExport(user.id, '2026-11-04');
    store.close();
    store = new Store(join(dir, 'clock.sqlite'));
    assert.equal(store.entries(user.id, '2026-11-04')[0].status, 'uncertain');
    assert.equal(store.claimExport(user.id, '2026-11-04').length, 0);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Export : concurrence et deuxième clic ne renvoient pas la même saisie', async () => {
  const store = new Store(':memory:');
  try {
    store.start(user.id, project, '', timestamp);
    store.stop(user.id, timestamp + 60_000);
    let calls = 0;
    const provider = { ready: true, async exportEntry(_user, entry) { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { id: entry.id }; } };
    const results = await Promise.all([exportDay(store, provider, user, '2026-11-04'), exportDay(store, provider, user, '2026-11-04')]);
    assert.equal(calls, 1);
    assert.equal(results.reduce((sum, r) => sum + r.exported, 0), 1);
    assert.equal((await exportDay(store, provider, user, '2026-11-04')).exported, 0);
    assert.equal(store.entries(user.id, '2026-11-04')[0].status, 'exported');
  } finally { store.close(); }
});

test('Un export sans confirmation reste à vérifier ; les saisies non envoyées restent disponibles', async () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 3; i++) {
      store.start(user.id, project, '', timestamp + i * 120_000);
      store.stop(user.id, timestamp + i * 120_000 + 60_000);
    }
    let calls = 0;
    const provider = { ready: true, async exportEntry() { if (++calls === 2) throw new Error('Timeout'); return { id: 'furious-1' }; } };
    const result = await exportDay(store, provider, user, '2026-11-04');
    assert.deepEqual([result.exported, result.uncertain, calls], [1, 1, 2]);
    assert.deepEqual(store.entries(user.id, '2026-11-04').map(e => e.status), ['exported', 'uncertain', 'pending']);
    assert.equal((await exportDay(store, { ready: true, async exportEntry() { return { id: 'furious-2' }; } }, user, '2026-11-04')).exported, 1);
    assert.equal(store.entries(user.id, '2026-11-04').filter(e => e.status === 'uncertain').length, 1);
  } finally { store.close(); }
});

async function fixture(t, options = {}) {
  const store = new Store(':memory:');
  const app = createApp({ store, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const session = store.createSession(user);
  const headers = { Cookie: `katra_session=${session.id}`, Origin: 'http://localhost:3000', 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  return { store, base, headers };
}

test('HTTP : accès privé, CSRF, contrôle des projets, modification et export désactivé en démo', async t => {
  const { base, store, headers } = await fixture(t, { demo: true });
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  assert.equal((await fetch(`${base}/api/timer/start`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{"projectId":"demo-1"}' })).status, 403);
  assert.equal((await fetch(`${base}/api/timer/start`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'é'.repeat(36) }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/timer/start`, { method: 'POST', headers, body: '{"projectId":"unknown"}' })).status, 400);
  assert.equal((await fetch(`${base}/api/projects`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/timer/start`, { method: 'POST', headers, body: '{"projectId":"demo-1","note":"Une idée"}' })).status, 200);
  const originalStart = store.timer(user.id).started_at;
  assert.equal((await fetch(`${base}/api/timer/start`, { method: 'POST', headers, body: '{"projectId":"unknown"}' })).status, 400);
  assert.equal(store.timer(user.id).started_at, originalStart);
  store.db.prepare('UPDATE timers SET started_at=started_at-60000').run();
  assert.equal((await fetch(`${base}/api/timer/start`, { method: 'POST', headers, body: '{"projectId":"demo-2","note":"Nouveau travail"}' })).status, 200);
  assert.equal(store.timer(user.id).project_id, 'demo-2');
  assert.equal(store.entries(user.id, dayAt())[0].project_id, 'demo-1');
  assert.equal((await fetch(`${base}/api/day`, { headers })).status, 200);
  store.db.prepare('UPDATE timers SET started_at=started_at-90000').run();
  assert.equal((await fetch(`${base}/api/timer/stop`, { method: 'POST', headers, body: '{}' })).status, 200);
  const entry = store.entries(user.id, dayAt()).find(e => e.project_id === 'demo-2');
  assert.ok(entry.seconds >= 90);
  assert.equal((await fetch(`${base}/api/entries/${entry.id}`, { method: 'PATCH', headers, body: '{"seconds":180,"note":"Retouche"}' })).status, 200);
  assert.equal((await fetch(`${base}/api/entries/${entry.id}`, { method: 'PATCH', headers, body: '{"seconds":-1,"note":""}' })).status, 400);
  assert.equal((await fetch(`${base}/api/export`, { method: 'POST', headers, body: '{}' })).status, 409);
  assert.equal(store.entries(user.id, dayAt())[0].status, 'pending');
  assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(`${base}/api/day`, { headers })).status, 401);
});

test('HTTP : le serveur normal ne permet aucune connexion de démonstration', async t => {
  const { base } = await fixture(t);
  assert.equal((await fetch(`${base}/api/demo-login`, { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/__test/login`, { method: 'POST' })).status, 404);
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /<html lang="fr">/);
});

test('Épingles : authentification, CSRF, contrôle des projets, isolation et désépinglage idempotent', async t => {
  const { base, store, headers } = await fixture(t, { demo: true });
  const pin = (id, pinned, customHeaders = headers) => fetch(`${base}/api/pins/${id}`, {
    method: 'PUT', headers: customHeaders, body: JSON.stringify({ pinned }),
  });
  assert.equal((await pin('demo-3', true, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await pin('demo-3', true, { ...headers, Origin: 'https://evil.test' })).status, 403);
  assert.equal((await pin('unknown', true)).status, 400);
  assert.equal((await pin('demo-3', 'yes')).status, 400);
  assert.deepEqual(store.pins(user.id), []);
  assert.deepEqual(await (await pin('demo-3', true)).json(), { pinnedProjectIds: ['demo-3'] });
  assert.equal((await pin('demo-3', true)).status, 200);
  assert.deepEqual(store.pins(user.id), ['demo-3']);
  assert.deepEqual((await (await fetch(`${base}/api/projects`, { headers })).json()).pinnedProjectIds, ['demo-3']);
  const other = store.createSession({ ...user, id: 'other-user' });
  const otherHeaders = { ...headers, Cookie: `katra_session=${other.id}`, 'X-CSRF-Token': other.csrf };
  assert.deepEqual((await (await fetch(`${base}/api/projects`, { headers: otherHeaders })).json()).pinnedProjectIds, []);
  await pin('demo-3', false, otherHeaders);
  assert.deepEqual(store.pins(user.id), ['demo-3']);
  assert.deepEqual(await (await pin('demo-3', false)).json(), { pinnedProjectIds: [] });
  assert.equal((await pin('demo-3', false)).status, 200);
});

test('OAuth : state lié au navigateur, nonce, session sécurisée et refus du mauvais domaine', async t => {
  let nonce, payloadChanges = {};
  const fakeOAuth = {
    async generateCodeVerifierAsync() { return { codeVerifier: 'verifier', codeChallenge: 'challenge' }; },
    generateAuthUrl(options) { nonce = options.nonce; return `https://accounts.google.com/o/oauth2/v2/auth?state=${options.state}`; },
    async getToken(options) { assert.equal(options.codeVerifier, 'verifier'); return { tokens: { id_token: 'test-token' } }; },
    async verifyIdToken() { return { getPayload: () => ({ sub: '123', email: user.email, email_verified: true, hd: 'studio-katra.com', nonce, ...payloadChanges }) }; },
  };
  const { base } = await fixture(t, { oauthClient: fakeOAuth, appUrl: 'https://clock.example.com' });
  async function begin() {
    const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    return { state: new URL(start.headers.get('location')).searchParams.get('state'), cookie: start.headers.get('set-cookie').split(';')[0] };
  }
  const first = await begin();
  const unbound = await fetch(`${base}/auth/google/callback?state=${first.state}&code=abc`, { redirect: 'manual' });
  assert.equal(unbound.headers.get('location'), '/?auth=invalid');
  const second = await begin();
  const accepted = await fetch(`${base}/auth/google/callback?state=${second.state}&code=abc`, { headers: { Cookie: second.cookie }, redirect: 'manual' });
  assert.equal(accepted.headers.get('location'), '/');
  const cookie = accepted.headers.getSetCookie().find(x => x.startsWith('katra_session='));
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
  const replay = await fetch(`${base}/auth/google/callback?state=${second.state}&code=abc`, { headers: { Cookie: second.cookie }, redirect: 'manual' });
  assert.equal(replay.headers.get('location'), '/?auth=invalid');
  for (const change of [{ hd: 'evil.com' }, { nonce: 'wrong' }]) {
    payloadChanges = change;
    const attempt = await begin();
    const response = await fetch(`${base}/auth/google/callback?state=${attempt.state}&code=abc`, { headers: { Cookie: attempt.cookie }, redirect: 'manual' });
    assert.equal(response.headers.get('location'), '/?auth=denied');
    assert.ok(!response.headers.getSetCookie().some(x => x.startsWith('katra_session=')));
  }
});
