import { createApp } from '../server.js';
import { Store } from '../lib/store.js';
import './furious-server.js';
import { startPersonalServer } from '../desktop/personal.mjs';

const app = createApp({ demo: true, store: new Store(':memory:'), appUrl: 'http://127.0.0.1:3107' });
// Test-only bootstrap; no such route is shipped by either startup command.
app.get('/__test/new-personal', async (_req, res) => {
  let saved = null;
  const personal = await startPersonalServer({
    directory: '/tmp', port: 0, store: new Store(':memory:'),
    vault: { async read() { return saved; }, async write(value) { saved = value; } },
    providerFactory: () => ({
      ready: true,
      async identity() { return { id: 17, pseudo: 'camille' }; },
      async projects() { return [{ id: '42', name: 'Projet personnel', client: 'Studio Katra' }]; },
      async exportEntry(_user, entry) { return { id: `fake-${entry.id}` }; },
    }),
  });
  res.redirect(personal.openUrl);
});
app.listen(3107, '127.0.0.1');
