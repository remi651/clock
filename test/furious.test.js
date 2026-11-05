import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as httpRequest } from 'gaxios';
import { createFurious, exportDay } from '../lib/furious.js';
import { Store } from '../lib/store.js';
import { createApp } from '../server.js';
import { dayAt } from '../lib/time.js';

const user = { id: 'google-123', email: 'camille@studio-katra.com', name: 'Camille' };
const day = '2026-11-04';
const project = { id: '42', name: 'Identité du studio' };
const remoteProject = { id: 42, title: project.name, company_name: 'Katra', actif: '1', restricted_time_users: '' };
const remoteUser = { id: 17, pseudo: 'camille.katra', email: user.email };
const entry = { id: 'f704cd91-7b9e-4da4-bc6c-19d97555bf24', user_id: user.id, project_id: '42', project_name: project.name, day, seconds: 5400, note: 'Pistes créatives' };

function apiFixture(overrides = {}) {
  const calls = [];
  let writes = 0;
  const handler = async options => {
    calls.push(options);
    assert.equal(new URL(options.url).origin, 'https://studio-katra.furious-squad.com');
    assert.equal(options.retry, false);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.timeout, 15000);
    const path = new URL(options.url).pathname.split('/').filter(Boolean).at(-1);
    const query = new URL(options.url).searchParams.get('query');
    const overridden = overrides[path];
    if (overridden) return { data: await overridden(options, query) };
    if (path === 'auth') {
      assert.deepEqual(options.data, { action: 'auth', data: { username: 'api-clock-test', password: 'fake-test-password' } });
      return { data: { success: true, token: 'fake-test-token', expires_in: 3600 } };
    }
    assert.equal(options.headers['F-Auth-Token'], 'fake-test-token');
    if (path === 'user') return { data: { success: true, data: { User: [remoteUser] } } };
    if (path === 'project') return { data: { success: true, data: { Project: [remoteProject] } } };
    if (path === 'project-rate-card') return { data: { success: true, data: { ProjectRateCard: [{ id: 4201, project_id: 42, rate_card_row_label: 'Direction artistique', exclude_from_sprint: 0 }] } } };
    if (path === 'user-daily-hours-history') return { data: { success: true, data: { UserDailyHoursHistory: [{ id: 2, user_id: 17, date: '2026-01-01', daily_hours: 7 }] } } };
    if (path === 'sprint' && options.method === 'GET') return { data: { success: true, data: { Sprint: [] } } };
    if (path === 'sprint' && options.method === 'POST') { writes++; return { data: { success: true, id: 9001 } }; }
    throw new Error(`Unexpected test request ${path}`);
  };
  const provider = createFurious({ username: 'api-clock-test', password: 'fake-test-password', transport: handler });
  return { provider, calls, handler, writes: () => writes };
}
function addEntry(store, seconds = 5400, date = day) {
  const start = Date.parse(`${date}T10:00:00Z`);
  store.start(user.id, project, 'Pistes créatives', start);
  store.stop(user.id, start + seconds * 1000);
  return store.entries(user.id, date)[0];
}
function remoteEntry(local = entry, changes = {}) {
  return { id: 9001, project_id: 42, assigned_people: remoteUser.pseudo,
    start_date: local.day, end_date: local.day, time_in_hours: String(local.seconds / 3600),
    description: `${local.note}\n[Clock:${local.id}]`, ...changes };
}

test('Contrat PDF : authentification, champs de recherche et conversion selon les heures du collaborateur', async () => {
  const { provider, calls, writes } = apiFixture();
  assert.equal(provider.ready, true);
  assert.deepEqual(await provider.projects(user), [{ id: '42', name: project.name, client: 'Katra', code: '#42' }]);
  const context = await provider.prepareExport(user, day);
  const result = await provider.exportEntry(user, entry, context);
  assert.deepEqual(result, { id: '9001' });
  assert.equal(writes(), 1);
  assert.equal(calls.filter(c => c.url.endsWith('/auth/')).length, 1);
  const queries = calls.map(c => new URL(c.url).searchParams.get('query')).filter(Boolean);
  assert.ok(queries.some(q => q.includes('email:{eq:"camille@studio-katra.com"}') && q.endsWith('{id,pseudo,email}}')));
  assert.ok(queries.some(q => q.includes('filter:{actif:{eq:"1"}}')));
  assert.ok(queries.some(q => q.includes('UserDailyHoursHistory') && q.includes('user_id:{eq:"17"},date:{leq:"2026-11-04"}') && q.includes('order:[{date:desc},{id:desc}]')));
  const write = calls.find(c => c.method === 'POST' && c.url.endsWith('/sprint/'));
  assert.deepEqual(write.data, { action: 'create', data: {
    sprint_name: `Temps Clock — ${project.name}`, project_id: 42, start_date: day, end_date: day,
    num_days: 5400 / (7 * 3600), assigned_people: 'camille.katra',
    description: `Pistes créatives\n[Clock:${entry.id}]`, is_validated: 0, priority: 2,
  } });
  assert.equal(write.headers['Idempotency-Key'], undefined, 'Aucun mécanisme d’idempotence non documenté');
});

test('Pagination complète ; projets inactifs et restrictions pour une autre personne exclus', async () => {
  const offsets = [];
  const { provider } = apiFixture({ project: async (_options, query) => {
    const offset = Number(query.match(/offset:(\d+)/)[1]); offsets.push(offset);
    const rows = Array.from({ length: offset ? 3 : 250 }, (_, i) => ({ ...remoteProject, id: offset + i + 1 }));
    if (offset) {
      rows[0].actif = '0';
      rows[1].restricted_time_users = 'quelquun, autre';
      rows[2].restricted_time_users = 'quelquun, camille.katra';
    }
    return { success: true, data: { Project: rows }, meta: { totalElementsWithFilters: 253 } };
  } });
  const projects = await provider.projects(user);
  assert.equal(projects.length, 251);
  assert.deepEqual(offsets, [0, 250]);
  assert.equal(projects.at(-1).id, '253');
});

test('Une pagination répétée ou tronquée ne présente pas une liste partielle', async () => {
  const repeated = apiFixture({ project: async () => ({ success: true, data: { Project: [remoteProject] }, meta: { totalElementsWithFilters: 2 } }) });
  await assert.rejects(() => repeated.provider.projects(user), /répété/);
  let count = 0;
  const truncated = apiFixture({ project: async () => ({ success: true, data: { Project: count++ ? [] : [remoteProject] }, meta: { totalElementsWithFilters: 2 } }) });
  await assert.rejects(() => truncated.provider.projects(user), /avant la fin/);
});

test('Aucun rattachement au compte API si l’email Google est absent ou ambigu dans Furious', async () => {
  for (const users of [[], [remoteUser, { ...remoteUser, id: 18 }], [{ ...remoteUser, email: 'other@studio-katra.com' }]]) {
    const { provider, writes, calls } = apiFixture({ user: async () => ({ success: true, data: { User: users } }) });
    await assert.rejects(() => provider.projects(user), /unique utilisateur/);
    assert.equal(writes(), 0);
    assert.ok(!calls.some(c => c.url.includes('/project/')));
  }
});

test('Les refus distinguent authentification SSO/API et lecture Utilisateurs sans révéler la réponse distante', async () => {
  const auth = apiFixture({ auth: async () => ({ success: false, message: 'fake-test-password' }) });
  await assert.rejects(() => auth.provider.projects(user), error => /authentification API/.test(error.message) && /SSO Google/.test(error.message) && !/fake-test-password/.test(error.message));
  const users = apiFixture({ user: async () => ({ success: false, message: 'fake-test-token' }) });
  await assert.rejects(() => users.provider.identity(user), error => /lecture des utilisateurs/.test(error.message) && !/projet|fake-test-token/.test(error.message));
  assert.equal(users.writes(), 0);
});

test('Export refusé : signaler le droit de création ou les champs concernés sans divulguer la réponse brute', async () => {
  for (const [message, expected] of [
    ['Vous n’avez pas les autorisations nécessaires', /autorisation de créer des temps/],
    [{ project_rate_card_id: 'Missing field fake-test-password' }, /ligne de grille tarifaire/],
    ['project_rate_card_id is required; fake-test-password', /ligne de grille tarifaire/],
    [{ num_days: 'Invalid private value', assigned_people: 'private@email.test' }, /durée en jours, collaborateur/],
  ]) {
    const { provider } = apiFixture({ sprint: async options => options.method === 'GET'
      ? { success: true, data: { Sprint: [] } } : { success: false, message } });
    const store = new Store(':memory:');
    try {
      addEntry(store);
      const result = await exportDay(store, provider, user, day);
      assert.match(result.message, expected);
      assert.doesNotMatch(result.message, /fake-test-password|private@email|private value/);
      assert.equal(result.failed, 1);
      assert.equal(store.entries(user.id, day)[0].status, 'pending');
    } finally { store.close(); }
  }
});

test('Mode automatique : aucun défaut de 7 ou 8 heures supposé ; référence manuelle prioritaire', async () => {
  const { provider, handler } = apiFixture({ 'user-daily-hours-history': async () => ({ success: true, data: { UserDailyHoursHistory: [] } }) });
  const store = new Store(':memory:');
  try {
    addEntry(store);
    await assert.rejects(() => exportDay(store, provider, user, day), /horaire journalier/);
    assert.equal(store.entries(user.id, day)[0].status, 'pending');
    const configured = createFurious({ username: 'api-clock-test', password: 'fake-test-password', hoursPerDay: '8', transport: handler });
    const context = await configured.prepareExport(user, day);
    assert.equal(context.hours, 8);
  } finally { store.close(); }
});

test('Journée manuelle : un export de 7 heures envoie 1 jour sans lire l’historique interdit', async () => {
  let historyRequests = 0;
  const { handler, calls } = apiFixture({ 'user-daily-hours-history': async () => {
    historyRequests++;
    return { success: false, message: 'Lecture interdite' };
  } });
  const provider = createFurious({ username: 'api-clock-test', password: 'fake-test-password', hoursPerDay: 7, transport: handler });
  const store = new Store(':memory:');
  try {
    addEntry(store, 7 * 3600);
    const result = await exportDay(store, provider, user, day);
    assert.equal(result.exported, 1);
    assert.equal(historyRequests, 0);
    const write = calls.find(c => c.method === 'POST' && c.url.endsWith('/sprint/'));
    assert.equal(write.data.data.num_days, 1);
    assert.equal(store.entries(user.id, day)[0].status, 'exported');
  } finally { store.close(); }
});

test('Référence manuelle invalide : aucun appel de l’historique ou écriture de temps', async () => {
  for (const hoursPerDay of [0, -1, 25, true, 'abc']) {
    const { handler, calls } = apiFixture();
    const provider = createFurious({ username: 'api-clock-test', password: 'fake-test-password', hoursPerDay, transport: handler });
    await assert.rejects(() => provider.dailyHours({ id: 17 }, day), /durée de journée/);
    assert.equal(calls.length, 0);
  }
});

test('Grilles tarifaires : filtre projet sous forme de texte et exclusion des lignes interdites aux temps', async () => {
  const { provider, calls } = apiFixture({ 'project-rate-card': async (_options, query) => {
    assert.ok(query.includes('project_id:{eq:"42"}'));
    assert.ok(!/amount|cjm/.test(query));
    return { success: true, data: { ProjectRateCard: [
      { id: 4201, project_id: '42', rate_card_row_label: 'Direction artistique', exclude_from_sprint: 0 },
      { id: 4202, project_id: '42', rate_card_row_label: 'Achats', exclude_from_sprint: 1 },
    ] } };
  } });
  assert.deepEqual(await provider.rateCards(user, '42'), [{ id: 4201, label: 'Direction artistique' }]);
  assert.ok(calls.some(c => c.url.includes('/project-rate-card/')));
  await assert.rejects(() => provider.rateCards(user, '999'), /fermé|accessible/);
});

test('Export : transmettre la prestation choisie, permettre un choix explicite non vendu et rejeter une ligne supprimée', async () => {
  for (const choice of [4201, -1, 999999]) {
    const { provider, calls, writes } = apiFixture();
    const store = new Store(':memory:');
    try {
      const entry = addEntry(store);
      store.edit(user.id, entry.id, entry.seconds, entry.note, { id: choice, label: 'Choix de test' });
      const result = await exportDay(store, provider, user, day);
      if (choice === 999999) {
        assert.equal(result.failed, 1);
        assert.equal(writes(), 0);
        assert.equal(store.entry(user.id, entry.id).status, 'pending');
      } else {
        assert.equal(result.exported, 1);
        assert.equal(calls.find(c => c.method === 'POST' && c.url.endsWith('/sprint/')).data.data.project_rate_card_id, choice);
        if (choice === -1) assert.ok(!calls.some(c => c.url.includes('/project-rate-card/')));
      }
    } finally { store.close(); }
  }
});

test('Une ligne d’un autre projet et une réconciliation sur une autre prestation sont refusées', async () => {
  const wrong = apiFixture({ 'project-rate-card': async () => ({ success: true, data: { ProjectRateCard: [{ id: 4201, project_id: 99, rate_card_row_label: 'Autre projet', exclude_from_sprint: 0 }] } }) });
  await assert.rejects(() => wrong.provider.rateCards(user, '42'), /autre projet/);
  const found = apiFixture({ sprint: async () => ({ success: true, data: { Sprint: [remoteEntry(entry, { project_rate_card_id: 4202 })] } }) });
  await assert.rejects(() => found.provider.reconcileEntry(user, { ...entry, project_rate_card_id: 4201 }), /diffère/);
  assert.equal(found.writes(), 0);
});

test('Auth partagée et renouvellement du jeton expiré, sans exposer les erreurs contenant des secrets', async () => {
  let now = 0;
  const { handler, calls } = apiFixture();
  const provider = createFurious({ username: 'api-clock-test', password: 'fake-test-password', transport: handler, now: () => now });
  await Promise.all([provider.projects(user), provider.projects(user), provider.projects(user)]);
  assert.equal(calls.filter(c => c.url.endsWith('/auth/')).length, 1);
  now = 3_600_000;
  await provider.projects(user);
  assert.equal(calls.filter(c => c.url.endsWith('/auth/')).length, 2);
  const broken = createFurious({ username: 'api-clock-test', password: 'fake-test-password', transport: async () => { throw new Error('fake-test-password fake-test-token'); } });
  await assert.rejects(() => broken.projects(user), error => !/fake-test/.test(error.message) && error.notWritten === true);
});

test('Un refus explicite reste modifiable ; un timeout ou un accusé incomplet reste à vérifier sans relance', async () => {
  for (const mode of ['refused', 'timeout', 'missing-id', 'bad-id']) {
    let posts = 0;
    const { provider } = apiFixture({ sprint: async options => {
      if (options.method === 'GET') return { success: true, data: { Sprint: [] } };
      posts++;
      if (mode === 'refused') return { success: false, message: 'Secret error body must not be propagated' };
      if (mode === 'timeout') throw new Error('Timeout');
      return { success: true, ...(mode === 'bad-id' ? { id: true } : {}) };
    } });
    const store = new Store(':memory:');
    try {
      addEntry(store);
      const result = await exportDay(store, provider, user, day);
      assert.equal(posts, 1);
      assert.equal(store.entries(user.id, day)[0].status, mode === 'refused' ? 'pending' : 'uncertain');
      assert.equal(result.uncertain, mode === 'refused' ? 0 : 1);
      assert.ok(!result.message.includes('Secret error body'));
      if (mode !== 'refused') {
        await exportDay(store, provider, user, day);
        assert.equal(posts, 1, 'Aucune relance automatique après une réponse ambiguë');
      }
    } finally { store.close(); }
  }
});

test('Référence existante : relecture et contrôle de la durée, de la personne et du projet avant tout renvoi', async () => {
  let returned = remoteEntry();
  const { provider, writes } = apiFixture({ sprint: async () => ({ success: true, data: { Sprint: [returned] } }) });
  const context = await provider.prepareExport(user, day);
  assert.deepEqual(await provider.exportEntry(user, entry, context), { id: '9001' });
  for (const changes of [{ project_id: 43 }, { assigned_people: 'autre' }, { time_in_hours: '2' }, { start_date: '2026-11-03' }, { description: 'wrong reference' }]) {
    returned = remoteEntry(entry, changes);
    await assert.rejects(() => provider.exportEntry(user, entry, context), /diffère/);
  }
  assert.equal(writes(), 0);
  await assert.rejects(() => provider.exportEntry({ ...user, id: 'other' }, entry, context), /ne correspond pas/);
});

test('Réconciliation HTTP : seule une saisie appartenant à la personne et confirmée dans Furious est marquée exportée', async t => {
  const store = new Store(':memory:');
  const local = addEntry(store, 5400, dayAt());
  store.exportResult(local.id, 'uncertain');
  let found = false, posts = 0;
  const { provider } = apiFixture({ sprint: async options => {
    if (options.method === 'POST') posts++;
    return { success: true, data: { Sprint: found ? [remoteEntry(local)] : [] } };
  } });
  const server = createApp({ store, provider }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = store.createSession(user), other = store.createSession({ ...user, id: 'other-user' });
  const headers = { Cookie: `katra_session=${session.id}`, Origin: 'http://localhost:3000', 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  const path = `${base}/api/entries/${local.id}/reconcile`;
  assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Cookie: `katra_session=${other.id}`, 'X-CSRF-Token': other.csrf }, body: '{}' })).status, 404);
  assert.equal((await fetch(path, { method: 'POST', headers, body: '{}' })).status, 409);
  assert.equal(store.entry(user.id, local.id).status, 'uncertain');
  found = true;
  assert.equal((await fetch(path, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(store.entry(user.id, local.id).status, 'exported');
  assert.equal(store.entry(user.id, local.id).export_id, '9001');
  assert.equal(posts, 0);
});

test('Transport HTTP : en-têtes, corps JSON et paramètres passent réellement par le client réseau', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v2/auth/') return res.end(JSON.stringify({ success: true, token: 'fake-test-token', expires_in: 3600 }));
    const model = req.url.startsWith('/api/v2/user/') ? 'User' : 'Project';
    res.end(JSON.stringify({ success: true, data: { [model]: model === 'User' ? [remoteUser] : [remoteProject] } }));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const provider = createFurious({ username: 'api-clock-test', password: 'fake-test-password', transport: options => {
    const url = new URL(options.url);
    return httpRequest({ ...options, url: `${base}${url.pathname}${url.search}` });
  } });
  assert.equal((await provider.projects(user))[0].id, '42');
  assert.equal(JSON.parse(requests[0].body).data.username, 'api-clock-test');
  assert.equal(requests[1].headers['f-auth-token'], 'fake-test-token');
  assert.ok(new URL(requests[1].path, base).searchParams.get('query').includes('User('));
});

const remoteProposal = { id: 42, title: 'Étude identité', company_name: 'Katra', statut: 'Pipe sûr', project_id: 0 };
function proposalFixture(rows = [remoteProposal], overrides = {}) {
  return apiFixture({ proposal: async () => ({ success: true, data: { Proposal: rows } }), ...overrides });
}
function quoteEntry(changes = {}) { return { ...entry, project_id: 'proposal:42', furious_project_id: null, project_name: remoteProposal.title, ...changes }; }

test('Devis : identifiants distincts des dossiers, statuts ouverts et respect du dossier associé', async () => {
  const { provider } = proposalFixture([
    remoteProposal,
    { ...remoteProposal, id: 43, statut: 'En cours', project_id: 42 },
    { ...remoteProposal, id: 44, statut: 'Gagnés en cours', project_id: 42 },
    { ...remoteProposal, id: 45, statut: 'Gagnés', project_id: 42 },
    { ...remoteProposal, id: 46, statut: 'Perdu' },
    { ...remoteProposal, id: 47, project_id: 99 },
  ]);
  const quotes = await provider.proposals(user);
  assert.deepEqual(quotes.map(p => p.id), ['proposal:42', 'proposal:43']);
  assert.equal(quotes[0].projectId, null);
  assert.equal(quotes[1].projectId, '42');
  assert.deepEqual(await provider.rateCards(user, 'proposal:42'), []);
  assert.deepEqual(await provider.rateCards(user, 'proposal:43'), [{ id: 4201, label: 'Direction artistique' }]);
  await assert.rejects(() => provider.rateCards(user, 'proposal:47'), /accessible/);
});

test('Devis : pagination complète, doublons et résultats tronqués refusés', async () => {
  const { provider } = apiFixture({ proposal: async (_options, query) => {
    const offset = Number(query.match(/offset:(\d+)/)[1]);
    const rows = Array.from({ length: offset ? 1 : 250 }, (_, i) => ({ ...remoteProposal, id: offset + i + 1 }));
    return { success: true, data: { Proposal: rows }, meta: { totalElementsWithFilters: 251 } };
  } });
  assert.equal((await provider.proposals(user)).length, 251);
  const repeated = proposalFixture([remoteProposal, remoteProposal]);
  await assert.rejects(() => repeated.provider.proposals(user), /répété/);
  const truncated = apiFixture({ proposal: async () => ({ success: true, data: { Proposal: [] }, meta: { totalElementsWithFilters: 1 } }) });
  await assert.rejects(() => truncated.provider.proposals(user), /incomplète/);
});

test('Devis : export sans dossier, conversion de sept heures et conservation de proposal_id', async () => {
  const { provider, calls, writes } = proposalFixture();
  const local = quoteEntry({ seconds: 7 * 3600 });
  const context = await provider.prepareExport(user, day);
  await provider.exportEntry(user, local, context);
  const data = calls.find(c => c.method === 'POST' && c.url.endsWith('/sprint/')).data.data;
  assert.equal(data.project_id, 0);
  assert.equal(data.proposal_id, 42);
  assert.equal(data.num_days, 1);
  assert.equal(writes(), 1);
  assert.equal(data.project_rate_card_id, undefined);
});

test('Devis : prestation du dossier associé validée, devis fermé ou changé refusé sans création', async () => {
  const valid = proposalFixture([{ ...remoteProposal, project_id: 42 }]);
  await valid.provider.exportEntry(user, quoteEntry({ furious_project_id: 42, project_rate_card_id: 4201 }), await valid.provider.prepareExport(user, day));
  const data = valid.calls.find(c => c.method === 'POST' && c.url.endsWith('/sprint/')).data.data;
  assert.equal(data.project_id, 42);
  assert.equal(data.proposal_id, 42);
  assert.equal(data.project_rate_card_id, 4201);
  for (const rows of [[{ ...remoteProposal, statut: 'Perdu' }], [{ ...remoteProposal, project_id: 42 }]]) {
    const rejected = proposalFixture(rows);
    const context = await rejected.provider.prepareExport(user, day);
    await assert.rejects(() => rejected.provider.exportEntry(user, quoteEntry(), context), /fermé|changé/);
    assert.equal(rejected.writes(), 0);
  }
});

test('Devis : réconciliation contrôle le devis exact et empêche toute deuxième création', async () => {
  for (const proposalId of [42, 43]) {
    const local = quoteEntry();
    const { provider, writes } = proposalFixture([remoteProposal], { sprint: async () => ({ success: true, data: { Sprint: [remoteEntry(local, { project_id: 0, proposal_id: proposalId })] } }) });
    if (proposalId === 42) assert.deepEqual(await provider.reconcileEntry(user, local), { id: '9001' });
    else await assert.rejects(() => provider.reconcileEntry(user, local), /diffère/);
    const context = await provider.prepareExport(user, day);
    if (proposalId === 42) await provider.exportEntry(user, local, context);
    else await assert.rejects(() => provider.exportEntry(user, local, context), /diffère/);
    assert.equal(writes(), 0);
  }
});

test('Devis : un refus de lecture reste explicite et ne bloque pas les dossiers', async () => {
  const { provider } = proposalFixture([], { proposal: async () => ({ success: false, message: 'secret fake-test-password' }) });
  await assert.rejects(() => provider.proposals(user), error => /lecture des devis/.test(error.message) && !/fake-test-password/.test(error.message));
  assert.equal((await provider.projects(user)).length, 1);
});
