import { request as httpRequest } from 'gaxios';

// Contract: html_print.pdf, API v2, pages 1–5, 82–84, 99–102, 158, 172–173.
const INSTANCE = 'https://studio-katra.furious-squad.com';
const PAGE_SIZE = 250;
class FuriousError extends Error {
  constructor(message, notWritten = true) {
    super(message);
    this.notWritten = notWritten;
  }
}
function refusedOperation(path, method, details) {
  if (path === 'auth') return 'Furious refuse l’authentification API. Utilisez l’identifiant et le mot de passe d’un compte API Furious, distincts de la connexion SSO Google. Vérifiez aussi les restrictions d’accès de ce compte.';
  if (path === 'user') return 'Furious refuse la lecture des utilisateurs. Vérifiez que le compte API autorise la consultation de l’API Utilisateurs ; cette lecture sert à retrouver votre fiche par son adresse e-mail.';
  if (path === 'project') return 'Furious refuse la lecture des projets. Vérifiez l’autorisation de consultation des Projets pour le compte API.';
  if (path === 'project-rate-card') return 'Furious refuse la lecture des grilles tarifaires projet. Vérifiez l’autorisation de consultation de cette API pour sélectionner une prestation.';
  if (path === 'user-daily-hours-history') return 'Furious refuse la lecture de l’historique des heures quotidiennes. Autorisez cette lecture ou renseignez la durée d’une journée dans les Réglages pour utiliser une valeur manuelle.';
  if (path === 'sprint' && method === 'GET') return 'Furious refuse la lecture des temps. Vérifiez l’autorisation de consultation des Temps pour le compte API.';
  if (path === 'sprint') {
    const text = JSON.stringify(details || '').toLowerCase();
    if (/autorisation|pas autoris|not allowed|not authorized|permission|forbidden|access denied/.test(text)) {
      return 'Furious refuse l’autorisation de créer des temps. Dans les droits du compte API, vérifiez « Temps / Sprint : création » ainsi que l’autorisation de saisir du temps sur ce projet.';
    }
    const labels = {
      sprint_name: 'nom du temps', project_id: 'projet', start_date: 'date de début', end_date: 'date de fin',
      num_days: 'durée en jours', assigned_people: 'collaborateur', project_rate_card_id: 'ligne de grille tarifaire',
      category_name: 'catégorie', todo_ids: 'tâche', proposal_id: 'devis', description: 'description',
    };
    const fields = new Set();
    function collect(value) {
      if (typeof value === 'string' && /obligatoire|invalide|required|invalid|incorrect|missing|renseign|format/i.test(value)) {
        for (const field of Object.keys(labels)) {
          if (new RegExp(`(?:^|\\W)${field}(?:\\W|$)`, 'i').test(value)) fields.add(field);
        }
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(labels, key)) fields.add(key);
        if (key === 'field' && typeof item === 'string' && Object.hasOwn(labels, item)) fields.add(item);
        collect(item);
      }
    }
    collect(details);
    // Only fixed field labels are shown, never the raw API message or values.
    if (fields.size) {
      const guidance = fields.has('project_rate_card_id') ? ' Ce projet demande de sélectionner une ligne de grille tarifaire ; Clock ne la choisit pas automatiquement.' : '';
      return `Furious refuse la création du temps et signale : ${[...fields].map(field => labels[field]).join(', ')}.${guidance}`;
    }
    return 'Furious refuse la création du temps. Vérifiez « Temps / Sprint : création » pour le compte API, puis les éventuels champs obligatoires du projet (grille tarifaire, catégorie ou tâche).';
  }
  return 'Furious refuse cette opération API. Vérifiez les droits du compte API.';
}
function positiveId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) {
    throw new FuriousError('Furious a renvoyé un identifiant invalide.');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new FuriousError('Furious a renvoyé un identifiant invalide.');
  return number;
}
function reference(entry) { return `[Clock:${entry.id}]`; }
function people(value) {
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'string') return value.split(',').map(x => x.trim()).filter(Boolean);
  if (Array.isArray(value) && value.every(x => typeof x === 'string')) return value.map(x => x.trim()).filter(Boolean);
  throw new FuriousError('Les restrictions du projet Furious sont illisibles. Aucun accès n’a été accordé.');
}

class FuriousProvider {
  constructor({ username = process.env.FURIOUS_API_USERNAME, password = process.env.FURIOUS_API_PASSWORD,
    hoursPerDay = process.env.FURIOUS_HOURS_PER_DAY, transport = httpRequest, now = Date.now } = {}) {
    this.ready = Boolean(username && password);
    this.username = username;
    this.password = password;
    this.manualHours = typeof hoursPerDay === 'string' ? hoursPerDay.trim() : hoursPerDay;
    this.transport = transport;
    this.now = now;
    this.token = null;
    this.loginPromise = null;
  }
  async send(path, { method = 'GET', data, query, token } = {}) {
    const url = new URL(`/api/v2/${path}/`, INSTANCE);
    if (query) url.searchParams.set('query', query);
    let response;
    try {
      response = await this.transport({
        url: url.href, method, data, timeout: 15000, retry: false, maxRedirects: 0,
        responseType: 'json',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'F-Auth-Token': token } : {}) },
      });
    } catch (error) {
      const status = error.response?.status;
      if (status === 401) this.token = null;
      const rejected = [400, 401, 403, 404, 422].includes(status);
      // Never propagate Gaxios errors: they can contain credentials and bodies.
      throw new FuriousError(rejected
        ? refusedOperation(path, method, error.response?.data?.message)
        : 'Impossible de joindre Furious ou de confirmer sa réponse. Réessayez la vérification plus tard.',
      method === 'GET' || path === 'auth' || rejected);
    }
    if (response.data?.success === false) throw new FuriousError(refusedOperation(path, method, response.data.message));
    if (response.data?.success !== true) throw new FuriousError('La réponse Furious n’est pas une confirmation valide.', method === 'GET' || path === 'auth');
    return response.data;
  }
  async accessToken() {
    if (!this.ready) throw new FuriousError('Renseignez les identifiants API Furious dans les paramètres sécurisés.');
    if (this.token?.expires > this.now()) return this.token.value;
    if (!this.loginPromise) {
      this.loginPromise = (async () => {
        const body = await this.send('auth', { method: 'POST', data: { action: 'auth', data: { username: this.username, password: this.password } } });
        const ttl = Number(body.expires_in);
        if (typeof body.token !== 'string' || !body.token || /[\r\n]/.test(body.token) || !Number.isFinite(ttl) || ttl <= 0) {
          throw new FuriousError('L’authentification Furious n’a pas fourni un jeton utilisable.');
        }
        this.token = { value: body.token, expires: this.now() + ttl * 1000 - Math.min(30_000, ttl * 100) };
        return body.token;
      })().finally(() => { this.loginPromise = null; });
    }
    return this.loginPromise;
  }
  async search(path, model, { filter, fields, limit = PAGE_SIZE, offset = 0, order = '[{id:asc}]' }) {
    const query = `{${model}(limit:${limit},offset:${offset},order:${order}${filter ? `,filter:${filter}` : ''}){${fields}}}`;
    const body = await this.send(path, { query, token: await this.accessToken() });
    const rows = body.data?.[model];
    if (!Array.isArray(rows) || rows.length > limit) throw new FuriousError('La liste renvoyée par Furious est invalide.');
    return { rows, total: body.meta?.totalElementsWithFilters };
  }
  async identity(user) {
    if (typeof user?.email !== 'string' || !/^[^@]+@studio-katra\.com$/i.test(user.email)) {
      throw new FuriousError('Un compte du studio vérifié est nécessaire.');
    }
    const email = user.email.toLowerCase();
    const { rows } = await this.search('user', 'User', {
      filter: `{email:{eq:${JSON.stringify(email)}}}`, fields: 'id,pseudo,email', limit: 2,
    });
    if (rows.length !== 1 || typeof rows[0].email !== 'string' || rows[0].email.toLowerCase() !== email
      || typeof rows[0].pseudo !== 'string' || !rows[0].pseudo.trim()) {
      throw new FuriousError('Votre adresse e-mail doit correspondre à un unique utilisateur actif dans Furious. Vérifiez sa fiche utilisateur.');
    }
    return { id: positiveId(rows[0].id), pseudo: rows[0].pseudo };
  }
  async openProjects(identity) {
    const result = [], seen = new Set();
    for (let offset = 0; offset < 25000;) {
      const { rows, total } = await this.search('project', 'Project', {
        filter: '{actif:{eq:"1"}}', fields: 'id,title,company_name,actif,restricted_time_users', offset,
      });
      for (const row of rows) {
        const id = String(positiveId(row?.id));
        if (seen.has(id)) throw new FuriousError('La pagination Furious a répété un projet. La liste ne peut pas être garantie complète.');
        seen.add(id);
        if (String(row.actif) !== '1') continue;
        const restricted = people(row.restricted_time_users);
        if (restricted.length && !restricted.includes(identity.pseudo)) continue;
        if (typeof row.title !== 'string' || !row.title.trim()) throw new FuriousError('Un projet Furious ne possède pas de titre exploitable.');
        result.push({ id, name: row.title, client: typeof row.company_name === 'string' ? row.company_name : '', code: `#${id}` });
      }
      offset += rows.length;
      if (!rows.length && Number(total) > offset) throw new FuriousError('La pagination Furious s’est arrêtée avant la fin des résultats.');
      if (!rows.length || (rows.length < PAGE_SIZE && !(Number(total) > offset)) || (Number.isFinite(Number(total)) && Number(total) === offset)) return result;
    }
    throw new FuriousError('La liste Furious dépasse la limite prise en charge. Aucun résultat partiel n’a été affiché.');
  }
  async projects(user) { return this.openProjects(await this.identity(user)); }
  async projectRateCards(projectId) {
    const result = [], seen = new Set();
    for (let offset = 0; offset < 25000;) {
      const { rows, total } = await this.search('project-rate-card', 'ProjectRateCard', {
        filter: `{project_id:{eq:${JSON.stringify(String(positiveId(projectId)))}}}`,
        fields: 'id,project_id,rate_card_row_label,exclude_from_sprint', offset,
      });
      for (const row of rows) {
        const id = positiveId(row?.id);
        if (String(row.project_id) !== String(projectId)) throw new FuriousError('La grille tarifaire renvoyée appartient à un autre projet.');
        if (seen.has(id)) throw new FuriousError('La pagination de la grille tarifaire a répété une ligne.');
        seen.add(id);
        if (String(row.exclude_from_sprint) === '1') continue;
        if (typeof row.rate_card_row_label !== 'string' || !row.rate_card_row_label.trim()) throw new FuriousError('Une ligne de grille tarifaire ne possède pas de libellé exploitable.');
        result.push({ id, label: row.rate_card_row_label });
      }
      offset += rows.length;
      if (!rows.length && Number(total) > offset) throw new FuriousError('La grille tarifaire reçue est incomplète.');
      if (!rows.length || (rows.length < PAGE_SIZE && !(Number(total) > offset)) || (Number.isFinite(Number(total)) && Number(total) === offset)) return result;
    }
    throw new FuriousError('La grille tarifaire dépasse la limite prise en charge.');
  }
  async rateCards(user, projectId) {
    const projects = await this.projects(user);
    if (!projects.some(project => project.id === String(projectId))) throw new FuriousError('Ce projet est fermé ou ne vous est pas accessible.');
    return this.projectRateCards(projectId);
  }
  async dailyHours(identity, day) {
    function checkedHours(value) {
      if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:[.,]\d+)?$/.test(value))) {
        throw new FuriousError('Renseignez une durée de journée valable dans les Réglages, entre 0 et 24 heures.');
      }
      const hours = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
        throw new FuriousError('Renseignez une durée de journée valable dans les Réglages, entre 0 et 24 heures.');
      }
      return hours;
    }
    // Explicit personal/admin configuration takes precedence. In manual mode,
    // do not request an API resource the account may not be allowed to read.
    if (this.manualHours !== undefined && this.manualHours !== null && this.manualHours !== '') {
      return checkedHours(this.manualHours);
    }
    const { rows } = await this.search('user-daily-hours-history', 'UserDailyHoursHistory', {
      filter: `{user_id:{eq:${JSON.stringify(String(identity.id))}},date:{leq:${JSON.stringify(day)}}}`,
      fields: 'id,user_id,date,daily_hours', limit: 1, order: '[{date:desc},{id:desc}]',
    });
    const record = rows[0];
    if (record && (Number(record.user_id) !== identity.id || typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) || record.date > day)) {
      throw new FuriousError('L’horaire journalier renvoyé par Furious ne correspond pas à cette personne et cette date.');
    }
    if (!record) throw new FuriousError('Aucun horaire journalier valable dans Furious. Renseignez la durée d’une journée dans les Réglages (ou FURIOUS_HOURS_PER_DAY) avant l’export.');
    return checkedHours(record.daily_hours);
  }
  async prepareExport(user, day) {
    const identity = await this.identity(user);
    const [projects, hours] = await Promise.all([this.openProjects(identity), this.dailyHours(identity, day)]);
    return { identity, projects, hours, userId: user.id, day, rateCardCache: new Map() };
  }
  async findExport(identity, entry) {
    const { rows } = await this.search('sprint', 'Sprint', {
      // No date/user restriction here: a reference already recorded against the
      // wrong target must block a second creation, rather than appear absent.
      filter: `{description:{like:${JSON.stringify(reference(entry))}}}`,
      fields: 'id,project_id,assigned_people,start_date,end_date,time_in_hours,description,project_rate_card_id', limit: 2,
    });
    if (!rows.length) return null;
    if (rows.length !== 1) throw new FuriousError('Plusieurs temps Furious portent cette référence. Une vérification manuelle est nécessaire.', false);
    const row = rows[0];
    if (String(row.project_id) !== entry.project_id || row.assigned_people !== identity.pseudo
      || (entry.project_rate_card_id !== null && entry.project_rate_card_id !== undefined && Number(row.project_rate_card_id) !== entry.project_rate_card_id)
      || row.start_date !== entry.day || row.end_date !== entry.day
      || typeof row.description !== 'string' || !row.description.endsWith(`\n${reference(entry)}`)
      || (typeof row.time_in_hours !== 'string' && typeof row.time_in_hours !== 'number')
      || !Number.isFinite(Number(row.time_in_hours)) || Math.abs(Number(row.time_in_hours) * 3600 - entry.seconds) > 1) {
      throw new FuriousError('Le temps trouvé dans Furious diffère de la saisie Clock. Aucun nouveau temps n’a été créé.', false);
    }
    return { id: String(positiveId(row.id)) };
  }
  async exportEntry(user, entry, context) {
    if (!context || context.userId !== user.id || context.day !== entry.day || entry.user_id !== user.id) {
      throw new FuriousError('La préparation de l’export ne correspond pas à cette saisie.');
    }
    // Re-read before creating: the API documents no native idempotency key.
    const existing = await this.findExport(context.identity, entry);
    if (existing) return existing;
    if (!context.projects.some(p => p.id === entry.project_id)) throw new FuriousError('Ce projet est fermé ou ne vous autorise plus à saisir du temps. Aucun temps n’a été envoyé.');
    if (!Number.isSafeInteger(entry.seconds) || entry.seconds <= 0) throw new FuriousError('Durée invalide. Aucun temps n’a été envoyé.');
    const rateCardId = entry.project_rate_card_id;
    if (rateCardId !== null && rateCardId !== undefined) {
      if (rateCardId !== -1) {
        positiveId(rateCardId);
        context.rateCardCache ||= new Map();
        if (!context.rateCardCache.has(entry.project_id)) context.rateCardCache.set(entry.project_id, this.projectRateCards(entry.project_id));
        const choices = await context.rateCardCache.get(entry.project_id);
        if (!choices.some(choice => choice.id === rateCardId)) throw new FuriousError('La prestation sélectionnée n’est plus disponible pour ce projet. Modifiez la saisie avant l’export.');
      }
    }
    const token = await this.accessToken();
    const body = await this.send('sprint', {
      method: 'POST', token,
      data: { action: 'create', data: {
        sprint_name: `Temps Clock — ${entry.project_name}`,
        project_id: positiveId(entry.project_id), start_date: entry.day, end_date: entry.day,
        num_days: entry.seconds / (context.hours * 3600), assigned_people: context.identity.pseudo,
        description: `${entry.note || ''}\n${reference(entry)}`,
        is_validated: 0, priority: 2,
        ...(rateCardId === null || rateCardId === undefined ? {} : { project_rate_card_id: rateCardId }),
      } },
    });
    // A success flag alone is insufficient; retain uncertainty on malformed IDs.
    try { return { id: String(positiveId(body.id)) }; }
    catch { throw new FuriousError('Furious n’a pas renvoyé l’identifiant du temps créé.', false); }
  }
  async reconcileEntry(user, entry) {
    if (entry.user_id !== user.id) throw new FuriousError('Cette saisie ne vous appartient pas.');
    return this.findExport(await this.identity(user), entry);
  }
}

export const demoProjects = [
  { id: 'demo-1', name: 'Identité de marque', client: 'Maison Aurore', code: 'AUR-024', color: '#8478ed' },
  { id: 'demo-2', name: 'Refonte du site web', client: 'Atelier Nord', code: 'NOR-018', color: '#eaa45f' },
  { id: 'demo-3', name: 'Campagne de lancement', client: 'Les Jardins', code: 'JAR-032', color: '#76bca4' },
  { id: 'demo-4', name: 'Direction artistique', client: 'Collectif Rivage', code: 'RIV-011', color: '#de8fab' },
];

export function createFurious({ demo = false, ...options } = {}) {
  if (!demo) return new FuriousProvider(options);
  return {
    ready: true,
    async projects() {
      return demoProjects;
    },
    async rateCards() { return [{ id: 1001, label: 'Conception (démonstration)' }, { id: 1002, label: 'Production (démonstration)' }]; },
    async exportEntry() {
      throw new Error('L’export Furious réel n’est pas configuré. Aucun temps n’a été envoyé.');
    },
  };
}

export async function exportDay(store, provider, user, day) {
  if (!provider.ready) throw new Error('Furious n’est pas encore connecté. Aucun temps n’a été envoyé.');
  if (store.timer(user.id)) throw new Error('Arrêtez la minuterie avant d’exporter.');
  if (!store.entries(user.id, day).some(e => e.status === 'pending')) return { exported: 0, uncertain: 0 };
  // Authentication, identity and hours failures must leave unsent entries editable.
  const context = await provider.prepareExport?.(user, day);
  const entries = store.claimExport(user.id, day);
  let exported = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      const acknowledgement = await provider.exportEntry(user, entry, context);
      if (!acknowledgement?.id) throw new Error('Réponse Furious sans confirmation d’enregistrement.');
      store.exportResult(entry.id, 'exported', String(acknowledgement.id));
      exported++;
    } catch (error) {
      store.exportResult(entry.id, error.notWritten ? 'pending' : 'uncertain');
      for (const unsent of entries.slice(i + 1)) store.exportResult(unsent.id, 'pending');
      if (error.notWritten) return { exported, uncertain: 0, failed: 1, message: error.message };
      return { exported, uncertain: 1, message: 'Export interrompu. Vérifiez la saisie dans Furious avant toute nouvelle tentative ; les autres temps restent à envoyer.' };
    }
  }
  return { exported, uncertain: 0 };
}
