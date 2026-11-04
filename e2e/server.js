import { createApp } from '../server.js';
import { Store } from '../lib/store.js';
import './furious-server.js';

createApp({ demo: true, store: new Store(':memory:'), appUrl: 'http://127.0.0.1:3107' }).listen(3107, '127.0.0.1');
