const app = document.querySelector('#app');
const dialog = document.querySelector('#edit-dialog');
const editForm = document.querySelector('#edit-form');
let session, projects = [], dayData = { entries: [], timer: null }, selectedDay, projectError = '';
let editingId, toastTimeout, busy = false, serverOffset = 0;
let pinnedProjectIds = [], projectFilter = '', pinBusy = false;
let projectRates = [];
const rateChoices = new Map();
const icon = (name, cls = '') => {
  const paths = {
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    play: '<path d="m8 4 12 8-12 8Z"/>', stop: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    edit: '<path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 15Z"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    logout: '<path d="M9 4H4v16h5m5-12 4 4-4 4m-5-4h11"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    folder: '<path d="M3 7V5h6l2 2h10v13H3Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
    pin: '<path d="m9 3 8 0-1 6 4 4v2H5v-2l4-4Zm3 12v6"/>',
  };
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.clock}</svg>`;
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const duration = seconds => {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(n => String(n).padStart(2, '0')).join(':');
};
const dayAt = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const now = () => Date.now() + serverOffset;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(session?.csrf ? { 'X-CSRF-Token': session.csrf } : {}), ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { session = null; renderLogin(); }
    throw new Error(data.error || 'Une erreur est survenue.');
  }
  return data;
}
function toast(message, error = false) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.toggle('error-toast', error);
  element.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { element.hidden = true; }, error ? 10000 : 5500);
}

function brand() { return `<a class="brand" href="/" aria-label="Studio Katra Clock, accueil"><img src="/assets/katra-logo-white.png" alt="Studio Katra" width="130" height="72"><span class="brand-product">Clock</span></a>`; }

function renderLogin() {
  const auth = new URLSearchParams(location.search).get('auth');
  const errors = {
    denied: 'L’accès est réservé aux comptes Google Workspace studio-katra.com.',
    unconfigured: 'La connexion Google doit encore être configurée par l’administrateur.',
    invalid: 'La demande de connexion a expiré ou n’est pas valide. Recommencez.',
    failed: 'La connexion Google a échoué. Réessayez ou contactez votre administrateur.',
  };
  app.innerHTML = `<main class="login-layout">
    <aside class="login-aside">${brand()}<div><div class="eyebrow">LE TEMPS DES BONNES IDÉES.</div><h1>Moins de saisie.<br>Plus de <em>création.</em></h1><p>Vos projets, votre temps, un seul endroit.<br>Le compagnon quotidien du Studio Katra.</p></div><footer>STUDIO KATRA × CLOCK</footer></aside>
    <section class="login-main"><div class="login-card"><h2>Bonjour, le studio.</h2><p class="subtitle">Un peu de clarté dans votre journée.<br>Connectez-vous pour retrouver vos projets.</p>
    ${errors[auth] ? `<p class="error" role="alert">${escape(errors[auth])}</p>` : ''}
    ${!session?.googleConfigured ? '<div class="config-banner">La connexion Google n’est pas encore configurée.</div>' : ''}
    <a class="button google-button" href="/auth/google"><span class="google-g" aria-hidden="true">G</span>Continuer avec Google ${icon('arrow')}</a>
    <div class="login-restriction">${icon('lock')}<span>Réservé à l’équipe <strong>studio-katra.com</strong>.<br>Utilisez votre compte Google professionnel.</span></div>
    ${session?.demo ? '<button class="button primary demo-login" id="demo-login">Explorer la démonstration</button>' : ''}
    <div class="login-bottom">Les temps sont conservés dans Clock.<br>Vous choisissez quand les envoyer vers Furious.</div>
    </div></section></main>`;
  document.querySelector('#demo-login')?.addEventListener('click', async event => {
    event.target.disabled = true;
    try { await api('/api/demo-login', { method: 'POST', body: '{}' }); await initialize(); }
    catch (error) { toast(error.message, true); event.target.disabled = false; }
  });
}

async function loadData() {
  const [projectResult, dayResult] = await Promise.allSettled([
    api('/api/projects'), api(`/api/day?day=${encodeURIComponent(selectedDay)}`),
  ]);
  if (projectResult.status === 'fulfilled') { projects = projectResult.value.projects; projectRates = projectResult.value.projectRates || []; pinnedProjectIds = projectResult.value.pinnedProjectIds || []; projectError = ''; }
  else { projects = []; projectError = projectResult.reason.message; }
  if (dayResult.status === 'rejected') throw dayResult.reason;
  dayData = dayResult.value;
  serverOffset = dayData.serverTime - Date.now();
  renderDashboard();
}

function renderDashboard() {
  if (!session?.user) return;
  const user = session.user;
  const initials = user.name.split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
  const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${selectedDay}T12:00:00Z`));
  const pendingCount = dayData.entries.filter(e => e.status === 'pending').length;
  const uncertain = dayData.entries.filter(e => ['uncertain', 'exporting'].includes(e.status)).length;
  app.innerHTML = `
    <aside class="sidebar">${brand()}<div class="studio">STUDIO KATRA</div>
      <nav aria-label="Navigation principale"><a class="nav-item active" href="#today" aria-label="Chronomètre" title="Chronomètre">${icon('clock')}</a><a class="nav-item" href="#projects">${icon('grid')}Projets ouverts <small>${projects.length}</small></a></nav>
      <div class="sidebar-bottom"><div class="connection"><span class="dot ${session.furiousConfigured && !projectError ? 'ready' : ''}"></span>${session.demo ? 'Furious · démonstration' : session.furiousConfigured ? projectError ? 'Furious indisponible' : 'Furious connecté' : 'Furious à connecter'}</div><div class="profile"><span class="avatar">${escape(initials)}</span><div><div class="profile-name">${escape(user.name)}</div><div class="profile-email">${escape(user.email)}</div></div><button class="logout" id="${session.authMode === 'personal' ? 'settings' : 'logout'}" aria-label="${session.authMode === 'personal' ? 'Réglages' : 'Se déconnecter'}" title="${session.authMode === 'personal' ? 'Réglages' : 'Se déconnecter'}">${icon(session.authMode === 'personal' ? 'settings' : 'logout')}</button></div></div>
    </aside>
    <main class="main" id="today">
      <header class="topbar"><div class="breadcrumb"></div><div class="top-right"><span class="workspace-badge">STUDIO KATRA</span>${icon('sun')}</div></header>
      <div class="page-heading"><div><h1>Votre journée, en clair.</h1></div><label class="date-control">${icon('calendar')}<input type="date" id="day-select" value="${selectedDay}" max="${dayAt(now())}" aria-label="Journée à consulter"></label></div>
      ${session.demo ? '<div class="demo-banner"><strong>Mode démonstration</strong> · Projets fictifs et temps de test, enregistrés uniquement sur cette machine. Aucun export vers Furious.</div>' : !session.furiousConfigured ? '<div class="config-banner">Furious reste à connecter. Les projets réels et l’export seront disponibles une fois l’intégration configurée.</div>' : ''}
      <section class="timer-box" aria-label="Minuterie en cours"><div class="timer-icon">${icon('clock')}</div><div class="timer-info"><div class="timer-title">${dayData.timer ? escape(dayData.timer.project_name) : ''}</div><div class="timer-subtitle">${dayData.timer ? escape(dayData.timer.note || '') : ''}</div></div><div class="timer-time" id="running-time">00:00:00</div>${dayData.timer ? `<button class="button stop" id="stop-timer" aria-label="Terminer" title="Terminer">${icon('stop')}</button>` : ''}</section>
      <section id="projects"><div class="section-top"><div class="section-title"><h2>Projets ouverts</h2><span class="count">${projects.length}</span></div><label class="search">${icon('search')}<input id="project-search" type="search" placeholder="Rechercher un projet…" aria-label="Rechercher un projet"></label></div><p class="pin-help">${icon('pin')}Épinglez vos projets habituels pour les retrouver en premier.</p>
        ${projectError ? `<p class="error" role="alert">${escape(projectError)}</p>` : ''}<div class="project-grid" id="project-grid"></div>
      </section>
      <section aria-labelledby="entries-title"><div class="section-top"><div class="section-title"><h2 id="entries-title">${selectedDay === dayAt(now()) ? 'Les temps du jour' : 'Les temps de la journée'}</h2><span class="count">${dayData.entries.length}</span></div><span class="subtitle">${escape(date)}</span></div>
        ${uncertain ? '<p class="error" role="alert">Un export doit être vérifié. Utilisez la loupe de la saisie pour rechercher sa confirmation dans Furious, sans renvoyer le temps.</p>' : ''}
        <div class="table-wrap"><table><thead><tr><th scope="col">PROJET / DESCRIPTION</th><th scope="col">DURÉE</th><th scope="col">STATUT</th><th scope="col"><span aria-label="Actions"> </span></th></tr></thead><tbody>${renderEntries()}</tbody></table></div>
        <div class="day-footer"><span class="export-note">${icon('lock')}Vos temps restent privés jusqu’à leur export.</span><button class="button primary" id="export-day" ${!pendingCount || dayData.timer || !session.furiousConfigured || selectedDay !== dayAt(now()) ? 'disabled' : ''}>${icon('upload')}Exporter ma journée ${pendingCount ? `(${pendingCount})` : ''}</button></div>
      </section><footer class="page-footer"><span>Clock × Furious · Europe/Paris</span></footer>
    </main>`;
  document.querySelector('#project-search').value = projectFilter;
  renderProjects(projectFilter);
  tick();
  bindDashboard();
}

function renderProjects(filter = '') {
  const visible = projects.filter(p => `${p.name} ${p.client}`.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      const rankA = pinnedProjectIds.indexOf(a.id), rankB = pinnedProjectIds.indexOf(b.id);
      return (rankA < 0 ? Infinity : rankA) - (rankB < 0 ? Infinity : rankB) || 0;
    });
  const container = document.querySelector('#project-grid');
  if (!container) return;
  container.innerHTML = visible.map(project => {
    const running = dayData.timer?.project_id === project.id;
    const pinned = pinnedProjectIds.includes(project.id);
    const rate = projectRates.find(r => r.project_id === project.id);
    const choices = rateChoices.get(project.id) || [];
    const options = [...choices];
    if (rate?.id != null && rate.id !== -1 && !options.some(r => r.id === rate.id)) options.push(rate);
    const picker = `<select data-rate="${escape(project.id)}" aria-label="Prestation Furious — ${escape(project.name)}" ${running ? 'disabled' : ''}><option value="">Choisir une prestation</option><option value="-1" ${rate?.id === -1 ? 'selected' : ''}>Non vendu (hors grille)</option>${options.map(r => `<option value="${r.id}" ${rate?.id === r.id ? 'selected' : ''}>${escape(r.label)}</option>`).join('')}</select>`;
    return `<article class="project ${running ? 'running' : ''} ${pinned ? 'pinned' : ''}"><div class="project-top"><span class="client">${escape(project.client || 'Studio Katra')}</span><button class="pin-button ${pinned ? 'is-pinned' : ''}" data-pin="${escape(project.id)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Désépingler' : 'Épingler'} ${escape(project.name)}" title="${pinned ? 'Désépingler ce projet' : 'Épingler ce projet'}" ${pinBusy ? 'disabled' : ''}>${icon('pin')}</button></div><h3>${escape(project.name)}</h3><div class="project-footer">${picker}<button class="start-project ${running ? 'running' : ''}" data-start="${escape(project.id)}" aria-label="${running ? 'En cours' : 'Démarrer'}" title="${running ? 'En cours' : 'Démarrer'} ${escape(project.name)}" ${running ? 'disabled' : ''}>${icon(running ? 'clock' : 'play')}</button></div></article>`;
  }).join('') || `<div class="empty">${projectError ? 'Connexion Furious nécessaire pour afficher vos projets.' : filter ? 'Aucun projet ne correspond à votre recherche.' : 'Aucun projet ouvert pour le moment.'}</div>`;
  container.querySelectorAll('[data-rate]').forEach(select => {
    let loading = false;
    const load = async () => {
      const id = select.dataset.rate;
      if (loading) return;
      loading = true;
      try {
        const choices = rateChoices.get(id) || (await api(`/api/projects/${encodeURIComponent(id)}/rate-cards`)).rateCards;
        rateChoices.set(id, choices);
        for (const current of document.querySelectorAll('[data-rate]')) {
          if (current.dataset.rate !== id) continue;
          for (const choice of choices) {
            if (![...current.options].some(o => o.value === String(choice.id))) current.add(new Option(choice.label, String(choice.id)));
          }
        }
      } catch (error) { toast(error.message, true); }
      finally { loading = false; }
    };
    select.closest('.project').addEventListener('pointerenter', load);
    select.addEventListener('focus', load);
    select.addEventListener('pointerdown', load);
    select.addEventListener('change', () => act(() => api(`/api/projects/${encodeURIComponent(select.dataset.rate)}/rate-card`, {
      method: 'PUT', body: JSON.stringify({ projectRateCardId: select.value === '' ? null : Number(select.value) }),
    }), 'Prestation enregistrée pour ce projet.'));
  });
  container.querySelectorAll('[data-start]').forEach(button => button.addEventListener('click', () => {
    const projectId = button.dataset.start;
    act(() => api('/api/timer/start', { method: 'POST', body: JSON.stringify({ projectId }) }), 'Minuterie démarrée. Bonne création !');
  }));
  container.querySelectorAll('[data-pin]').forEach(button => button.addEventListener('click', async () => {
    if (pinBusy || busy) return;
    const projectId = button.dataset.pin;
    const pinned = !pinnedProjectIds.includes(projectId);
    pinBusy = true;
    renderProjects(projectFilter);
    try {
      const result = await api(`/api/pins/${encodeURIComponent(projectId)}`, { method: 'PUT', body: JSON.stringify({ pinned }) });
      pinnedProjectIds = result.pinnedProjectIds;
      toast(pinned ? 'Projet épinglé en tête de liste.' : 'Projet désépinglé.');
    } catch (error) { toast(error.message, true); }
    finally { pinBusy = false; renderProjects(projectFilter); }
  }));
}

function renderEntries() {
  const labels = { pending: 'À exporter', exported: 'Exporté', exporting: 'Export en cours', uncertain: 'À vérifier' };
  return dayData.entries.map(entry => {
    let action = '';
    if (entry.status === 'pending') action = `<button class="icon-button" data-edit="${escape(entry.id)}" aria-label="Modifier la saisie ${escape(entry.project_name)}" title="Modifier">${icon('edit')}</button>`;
    if (entry.status === 'uncertain') action = `<button class="icon-button" data-reconcile="${escape(entry.id)}" aria-label="Vérifier dans Furious : ${escape(entry.project_name)}" title="Vérifier dans Furious" ${!session.furiousConfigured ? 'disabled' : ''}>${icon('search')}</button>`;
    return `<tr><td><div class="entry-project">${escape(entry.project_name)}</div><div class="entry-note">${escape(entry.note || 'Sans description')}</div>${entry.project_rate_card_label ? `<div class="entry-rate-card">${escape(entry.project_rate_card_label)}</div>` : ''}</td><td class="duration">${duration(entry.seconds)}</td><td><span class="pill ${escape(entry.status)}">${labels[entry.status] || 'À vérifier'}</span></td><td>${action}</td></tr>`;
  }).join('') || `<tr><td colspan="4"><div class="empty">${icon('clock')}</div></td></tr>`;
}

function tick() {
  if (!session?.user || !document.querySelector('#running-time')) return;
  document.querySelector('#running-time').textContent = duration(dayData.timer ? Math.floor((now() - dayData.timer.started_at) / 1000) : 0);
  if (selectedDay === dayData.today && dayAt(now()) !== dayData.today && !busy && !dialog.open) {
    selectedDay = dayAt(now());
    loadData().catch(error => toast(error.message, true));
  }
}

async function act(action, success) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('[data-start],[data-pin],[data-rate],[data-reconcile],#stop-timer,#export-day').forEach(b => { b.disabled = true; });
  try {
    const result = await action();
    if (result.message) toast(result.message, Boolean(result.uncertain || result.failed));
    else if (success) toast(success);
  } catch (error) { toast(error.message, true); }
  finally {
    try { if (session?.user) await loadData(); }
    catch (error) { toast(error.message, true); }
    busy = false;
  }
}

function bindDashboard() {
  document.querySelector('#settings')?.addEventListener('click', () => { location.href = '/desktop/settings'; });
  document.querySelector('#logout')?.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }); session = { ...session, user: null, csrf: null }; renderLogin(); }
    catch (error) { toast(error.message, true); }
  });
  document.querySelector('#day-select').addEventListener('change', async event => {
    if (!event.target.value) return;
    selectedDay = event.target.value;
    try { await loadData(); } catch (error) { toast(error.message, true); }
  });
  document.querySelector('#project-search').addEventListener('input', event => { projectFilter = event.target.value; renderProjects(projectFilter); });
  document.querySelector('#stop-timer')?.addEventListener('click', () => act(() => api('/api/timer/stop', { method: 'POST', body: '{}' }), 'Temps enregistré dans votre journée.'));
  document.querySelector('#export-day').addEventListener('click', () => act(async () => {
    const result = await api('/api/export', { method: 'POST', body: '{}' });
    if (!result.uncertain && !result.failed) toast(`${result.exported} saisie(s) envoyée(s) à Furious.`);
    return result;
  }));
  document.querySelectorAll('[data-reconcile]').forEach(button => button.addEventListener('click', () => act(() =>
    api(`/api/entries/${encodeURIComponent(button.dataset.reconcile)}/reconcile`, { method: 'POST', body: '{}' }))));
  document.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => {
    const entry = dayData.entries.find(e => e.id === button.dataset.edit);
    editingId = entry.id;
    editForm.elements.duration.value = duration(entry.seconds);
    editForm.elements.note.value = entry.note;
    document.querySelector('#edit-error').textContent = '';
    dialog.showModal();
  }));
}

document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
editForm.addEventListener('submit', async event => {
  event.preventDefault();
  const parts = editForm.elements.duration.value.split(':').map(Number);
  const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  const button = editForm.querySelector('[type=submit]');
  button.disabled = true;
  try {
    await api(`/api/entries/${encodeURIComponent(editingId)}`, { method: 'PATCH', body: JSON.stringify({ seconds, note: editForm.elements.note.value }) });
    dialog.close();
    await loadData();
    toast('Saisie mise à jour.');
  } catch (error) { document.querySelector('#edit-error').textContent = error.message; }
  finally { button.disabled = false; }
});

async function initialize() {
  try {
    session = await api('/api/session');
    selectedDay ||= session.today;
    if (session.user) await loadData();
    else renderLogin();
  } catch (error) {
    app.innerHTML = '<main class="login-main"><div class="login-card"><h1>Clock est indisponible</h1><p class="subtitle">La connexion au serveur a échoué. Rechargez la page pour réessayer.</p><a class="button primary" href="/">Réessayer</a></div></main>';
  }
}
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !dialog.open && !busy) initialize();
});
await initialize();
