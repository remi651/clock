import { cp, mkdir, writeFile, chmod, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || resolve(root, '../artifacts/Katra-Clock-Mac'));
await mkdir(output, { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'server.js']) await cp(resolve(root, file), resolve(output, file));
for (const folder of ['desktop', 'lib', 'public']) await cp(resolve(root, folder), resolve(output, folder), { recursive: true });
await cp(resolve(root, 'desktop/mac/LIRE-EN-PREMIER.txt'), resolve(output, 'LIRE-EN-PREMIER.txt'));
await writeFile(resolve(output, 'Installer Clock.command'), '#!/bin/bash\nset -e\ncd "$(dirname "$0")"\nexec /bin/bash "desktop/mac/Installer Clock.command"\n', { mode: 0o755 });
await chmod(resolve(output, 'Installer Clock.command'), 0o755);
for (const name of await readdir(resolve(output, 'desktop/mac'))) {
  if (name.endsWith('.sh') || name.endsWith('.command')) await chmod(resolve(output, 'desktop/mac', name), 0o755);
}
console.log('Installateur Mac personnel généré, sans identifiants ni données locales.');
