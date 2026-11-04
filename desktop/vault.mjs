import { userInfo } from 'node:os';

// The macOS implementation is loaded only by the personal launcher.
// No plaintext-file or environment-variable fallback is permitted.
export async function macVault() {
  if (process.platform !== 'darwin') throw new Error('Le Trousseau macOS est requis.');
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const entry = new AsyncEntry('com.studio-katra.clock.personal', userInfo().username);
  return {
    async read() {
      try {
        const saved = await entry.getPassword();
        return saved === null ? null : JSON.parse(saved);
      } catch { throw new Error('Le Trousseau macOS ne peut pas être lu. Autorisez son accès puis relancez Clock.'); }
    },
    async write(config) {
      try { await entry.setPassword(JSON.stringify(config)); }
      catch { throw new Error('Le Trousseau macOS n’a pas enregistré les identifiants. Aucune copie en clair n’a été créée.'); }
    },
  };
}
