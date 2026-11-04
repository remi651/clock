import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const productionEnv = {
  ...process.env, NODE_ENV: 'production', APP_URL: 'https://clock.studio-katra.com',
  GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret',
  FURIOUS_API_USERNAME: 'test-api-user', FURIOUS_API_PASSWORD: 'test-api-password',
};

test('Production : refus du HTTP, du mode démo et des identifiants absents', () => {
  for (const scenario of [
    { env: { APP_URL: 'http://localhost:3000' }, args: [], message: /HTTPS/ },
    { env: {}, args: ['--demo'], message: /démonstration est interdit/ },
    { env: { FURIOUS_API_PASSWORD: '' }, args: [], message: /FURIOUS_API_PASSWORD/ },
    { env: { GOOGLE_CLIENT_SECRET: '' }, args: [], message: /GOOGLE_CLIENT_SECRET/ },
  ]) {
    const result = spawnSync(process.execPath, [serverPath, ...scenario.args], {
      env: { ...productionEnv, ...scenario.env }, encoding: 'utf8', timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, scenario.message);
  }
});

test('Production : port injecté, base persistante, cookies HTTPS, accès privé et arrêt propre', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clock-deploy-'));
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const databasePath = join(dir, 'volume', 'clock.sqlite');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...productionEnv, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: databasePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Le serveur de production n’a pas démarré.')), 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (chunk.includes('Katra Clock démarré')) { clearTimeout(timeout); resolve(); }
    });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Arrêt avant démarrage du serveur.')); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/health`);
  assert.deepEqual(await health.json(), { status: 'ok', demo: false });
  assert.ok(existsSync(databasePath), 'La base doit être créée dans le volume configuré.');
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  assert.equal((await fetch(`${base}/api/demo-login`, { method: 'POST' })).status, 404);
  const auth = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  const location = new URL(auth.headers.get('location'));
  assert.equal(location.hostname, 'accounts.google.com');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://clock.studio-katra.com/auth/google/callback');
  assert.equal(location.searchParams.get('hd'), 'studio-katra.com');
  assert.match(auth.headers.get('set-cookie'), /Secure/);
  assert.match(auth.headers.get('set-cookie'), /HttpOnly/);
  assert.match(auth.headers.get('strict-transport-security'), /max-age=/);
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
});
