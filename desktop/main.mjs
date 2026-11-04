import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { macVault } from './vault.mjs';
import { startPersonalServer } from './personal.mjs';

try {
  const directory = join(homedir(), 'Library', 'Application Support', 'Katra Clock', 'data');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const running = await startPersonalServer({ directory, vault: await macVault() });
  // API credentials never appear in process arguments, browser URLs or logs.
  const opener = spawn('/usr/bin/open', [running.openUrl], { stdio: 'ignore' });
  opener.on('error', () => console.error('Le navigateur n’a pas pu être ouvert. Quittez puis rouvrez Clock.'));
  let stopping = false;
  async function close() {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 20_000);
    timeout.unref();
    await running.close();
    clearTimeout(timeout);
    process.exit(0);
  }
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
} catch {
  console.error('Clock n’a pas pu démarrer. Vérifiez que l’application n’est pas déjà ouverte et que le Trousseau macOS est accessible.');
  spawn('/usr/bin/osascript', ['-e', 'display alert "Clock n’a pas pu démarrer" message "Vérifiez l’accès au Trousseau et qu’aucune autre copie de Clock n’est ouverte." as critical'], { stdio: 'ignore' });
  process.exitCode = 1;
}
