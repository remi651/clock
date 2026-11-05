import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dayAt, splitInterval } from './time.js';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS timers (
        user_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_name TEXT NOT NULL,
        started_at INTEGER NOT NULL, note TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
        project_name TEXT NOT NULL, day TEXT NOT NULL, seconds INTEGER NOT NULL,
        note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        export_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_user_day ON entries(user_id, day);
      CREATE TABLE IF NOT EXISTS pinned_projects (
        user_id TEXT NOT NULL, project_id TEXT NOT NULL, pinned_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, project_id)
      );
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(entries)').all().map(column => column.name));
    if (!columns.has('project_rate_card_id')) this.db.exec('ALTER TABLE entries ADD COLUMN project_rate_card_id INTEGER');
    if (!columns.has('project_rate_card_label')) this.db.exec('ALTER TABLE entries ADD COLUMN project_rate_card_label TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS project_rates (user_id TEXT, project_id TEXT, id INTEGER, label TEXT, PRIMARY KEY(user_id,project_id))');
    const timerColumns = new Set(this.db.prepare('PRAGMA table_info(timers)').all().map(c => c.name));
    for (const [name, type] of [['project_rate_card_id','INTEGER'], ['project_rate_card_label','TEXT']]) {
      if (!timerColumns.has(name)) this.db.exec(`ALTER TABLE timers ADD COLUMN ${name} ${type}`);
    }
    for (const table of ['timers', 'entries']) {
      const names = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      if (!names.has('furious_project_id')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN furious_project_id INTEGER`);
    }
    // Interrupted exports must be reconciled, never silently retried.
    this.db.prepare("UPDATE entries SET status='uncertain' WHERE status='exporting'").run();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createSession(user, now = Date.now()) {
    const id = randomUUID(), csrf = randomUUID();
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(id, JSON.stringify(user), csrf, now + 8 * 3600_000);
    return { id, csrf };
  }
  session(id) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(id || '', Date.now());
    return s ? { ...s, user: JSON.parse(s.user) } : null;
  }
  deleteSession(id) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  timer(user) { return this.db.prepare('SELECT * FROM timers WHERE user_id=?').get(user) || null; }
  entries(user, day) {
    return this.db.prepare('SELECT * FROM entries WHERE user_id=? AND day=? ORDER BY created_at DESC, id').all(user, day);
  }
  entry(user, id) { return this.db.prepare('SELECT * FROM entries WHERE id=? AND user_id=?').get(id, user) || null; }
  pins(user) {
    return this.db.prepare('SELECT project_id FROM pinned_projects WHERE user_id=? ORDER BY pinned_at DESC, project_id').all(user).map(row => row.project_id);
  }
  setPinned(user, projectId, pinned) {
    if (pinned) this.db.prepare('INSERT OR IGNORE INTO pinned_projects VALUES (?, ?, ?)').run(user, projectId, Date.now());
    else this.db.prepare('DELETE FROM pinned_projects WHERE user_id=? AND project_id=?').run(user, projectId);
    return this.pins(user);
  }
  rates(user) { return this.db.prepare('SELECT project_id,id,label FROM project_rates WHERE user_id=?').all(user); }
  setRate(user, projectId, rate) {
    return this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO project_rates VALUES (?,?,?,?)').run(user, projectId, rate?.id ?? null, rate?.label ?? null);
      if (rate) this.db.prepare("UPDATE entries SET project_rate_card_id=?,project_rate_card_label=? WHERE user_id=? AND project_id=? AND status='pending' AND project_rate_card_id IS NULL").run(rate.id, rate.label, user, projectId);
    });
  }
  start(user, project, note = '', now = Date.now(), rate) {
    return this.transaction(() => {
      const previous = this.timer(user);
      if (previous?.project_id === project.id) return previous;
      if (previous) this.finishTimer(previous, now);
      this.db.prepare('INSERT INTO timers (user_id,project_id,project_name,started_at,note,project_rate_card_id,project_rate_card_label,furious_project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(user, project.id, project.name, now, note, rate?.id ?? null, rate?.label ?? null, project.projectId == null ? null : Number(project.projectId));
      return this.timer(user);
    });
  }
  stop(user, now = Date.now()) {
    return this.transaction(() => {
      const timer = this.timer(user);
      if (!timer) throw new Error('Aucune minuterie en cours.');
      this.finishTimer(timer, now);
    });
  }
  // Called only inside start/stop transactions: saving the previous interval
  // and starting the next must either both succeed or both be rolled back.
  finishTimer(timer, now) {
    for (const part of splitInterval(timer.started_at, now)) {
      this.db.prepare('INSERT INTO entries (id,user_id,project_id,project_name,day,seconds,note,created_at,project_rate_card_id,project_rate_card_label,furious_project_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), timer.user_id, timer.project_id, timer.project_name, part.day, part.seconds, timer.note, part.start, timer.project_rate_card_id, timer.project_rate_card_label, timer.furious_project_id);
    }
    this.db.prepare('DELETE FROM timers WHERE user_id=?').run(timer.user_id);
  }
  edit(user, id, seconds, note, rateCard) {
    const result = rateCard === undefined
      ? this.db.prepare("UPDATE entries SET seconds=?,note=? WHERE id=? AND user_id=? AND status='pending'").run(seconds, note, id, user)
      : this.db.prepare("UPDATE entries SET seconds=?,note=?,project_rate_card_id=?,project_rate_card_label=? WHERE id=? AND user_id=? AND status='pending'")
        .run(seconds, note, rateCard?.id ?? null, rateCard?.label ?? null, id, user);
    if (!result.changes) throw new Error('Cette saisie est introuvable ou son export est déjà engagé.');
  }
  claimExport(user, day = dayAt()) {
    return this.transaction(() => {
      if (this.timer(user)) throw new Error('Arrêtez la minuterie avant d’exporter.');
      const rows = this.entries(user, day).filter(e => e.status === 'pending');
      this.db.prepare("UPDATE entries SET status='exporting' WHERE user_id=? AND day=? AND status='pending'").run(user, day);
      return rows;
    });
  }
  exportResult(id, status, exportId = null) {
    this.db.prepare('UPDATE entries SET status=?,export_id=? WHERE id=?').run(status, exportId, id);
  }
  close() { this.db.close(); }
}
