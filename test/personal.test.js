import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPersonalServer } from '../desktop/personal.mjs';
import { get } from 'node:http';

const config = { email: 'camille@studio-katra.com', username: 'fake-personal-api', password: 'fake-personal-password' };
const projects = [{ id: '42', name: 'Identité du studio', client: 'Katra' }, { id: '43', name: 'Site du studio', client: 'Katra' }];
function fixtureVault() {
  let saved = null, unavailable = false;
  return {
    async read() { return saved; },
    async write(value) { if (unavailable) throw new Error('Le Trousseau est verrouillé.'); saved = structuredClone(value); },
    lock() { unavailable = true; },
  };
}
function fixtureProvider() {
  return {
    ready: true,
    async identity(user) { assert.equal(user.email, config.email); return { id: 17, pseudo: 'camille' }; },
    async projects() { return projects; },
    async exportEntry(_user, entry) { return { id: `fake-export-${entry.id}` }; },
  };
}
function client(server) {
  const jar = new Map();
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(new URL(path, server.appUrl), {
      redirect: 'manual', method,
      headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(method === 'GET' ? {} : { Origin: server.appUrl, 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const part = header.split(';')[0], index = part.indexOf('=');
      jar.set(part.slice(0, index), part.slice(index + 1));
    }
    return response;
  };
}
async function personalFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'clock-personal-'));
  const vault = fixtureVault();
  const server = await startPersonalServer({ directory, vault, port: 0, providerFactory: fixtureProvider });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { server, vault, directory, request: client(server) };
}

test('Personnel : boucle locale, clé à usage unique, absence de Google, contrôle d’origine et mot de passe jamais renvoyé', async t => {
  const { server, request } = await personalFixture(t);
  assert.equal(server.address.address, '127.0.0.1');
  assert.equal((await request('/api/projects')).status, 403);
  assert.equal((await request('/desktop/open?key=wrong')).status, 403);
  const opened = await request(server.openUrl);
  assert.equal(opened.status, 302);
  assert.equal((await request(server.openUrl)).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    get(new URL('/desktop/config', server.appUrl), { headers: { Host: 'evil.test', Cookie: opened.headers.get('set-cookie').split(';')[0] } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  const state = await (await request('/desktop/config')).json();
  assert.equal((await request('/desktop/config', { method: 'POST', body: config })).status, 403);
  assert.equal((await request('/desktop/config', { method: 'POST', headers: { 'X-CSRF-Token': state.csrf, Origin: 'https://evil.test' }, body: config })).status, 403);
  assert.equal((await request('/desktop/config', { method: 'POST', headers: { 'X-CSRF-Token': state.csrf }, body: config })).status, 200);
  const saved = await (await request('/desktop/config')).json();
  assert.equal(saved.hasPassword, true);
  assert.equal(JSON.stringify(saved).includes(config.password), false);
  const session = await (await request('/api/session')).json();
  assert.equal(session.authMode, 'personal');
  assert.equal(session.googleConfigured, false);
  assert.equal(session.user.email, config.email);
  assert.equal((await request('/auth/google')).status, 404);
  assert.equal((await request('/api/projects')).status, 200);
});

test('Personnel : aucun fichier d’identifiants ; conservation des temps et des épingles après redémarrage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clock-personal-'));
  const vault = fixtureVault();
  let server;
  try {
    await vault.write(config);
    server = await startPersonalServer({ directory, vault, port: 0, providerFactory: fixtureProvider });
    let request = client(server);
    await request(server.openUrl);
    const session = await (await request('/api/session')).json();
    server.store.start(session.user.id, projects[0], '', Date.now() - 60_000);
    server.store.start(session.user.id, projects[1]);
    server.store.setPinned(session.user.id, '43', true);
    await server.close();
    server = await startPersonalServer({ directory, vault, port: 0, providerFactory: fixtureProvider });
    request = client(server);
    assert.equal((await request('/api/session')).status, 403);
    await request(server.openUrl);
    const restored = await (await request('/api/day')).json();
    assert.equal(restored.entries.length, 1);
    assert.ok(restored.entries[0].seconds >= 60);
    assert.equal(restored.timer.project_id, '43');
    assert.deepEqual((await (await request('/api/projects')).json()).pinnedProjectIds, ['43']);
    for (const name of readdirSync(directory)) {
      assert.ok(name.startsWith('clock.sqlite'));
      assert.equal(readFileSync(join(directory, name)).includes(Buffer.from(config.password)), false);
    }
  } finally { await server?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Personnel : refus du Trousseau sans sauvegarde en clair ni remplacement de la configuration active', async t => {
  const { server, vault, request } = await personalFixture(t);
  await request(server.openUrl);
  const { csrf } = await (await request('/desktop/config')).json();
  vault.lock();
  const response = await request('/desktop/config', { method: 'POST', headers: { 'X-CSRF-Token': csrf }, body: config });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Trousseau/);
  assert.equal((await (await request('/desktop/config')).json()).configured, false);
  assert.equal(await vault.read(), null);
});

test('Personnel : une réponse brute contenant un secret n’est pas transmise au navigateur', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clock-personal-'));
  const server = await startPersonalServer({ directory, vault: fixtureVault(), port: 0,
    providerFactory: () => ({ async identity() { throw new Error(config.password); } }) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = client(server);
  await request(server.openUrl);
  const { csrf } = await (await request('/desktop/config')).json();
  const response = await request('/desktop/config', { method: 'POST', headers: { 'X-CSRF-Token': csrf }, body: config });
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes(config.password), false);
});
