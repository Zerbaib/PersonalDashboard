import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, 'dashboard.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const HOUR = 3600 * 1000;

db.exec(`
CREATE TABLE IF NOT EXISTS services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  type             TEXT    NOT NULL CHECK (type IN ('ping','tcp','http','dns')),
  target           TEXT    NOT NULL,
  port             INTEGER,
  dns_query        TEXT,
  dns_record_type  TEXT,
  link_url         TEXT,
  interval_sec     INTEGER NOT NULL DEFAULT 60,
  is_public        INTEGER NOT NULL DEFAULT 1,
  position         INTEGER NOT NULL DEFAULT 0,
  ip               TEXT,
  ssh_port         INTEGER NOT NULL DEFAULT 22,
  ssh_user         TEXT,
  ssh_password_enc TEXT,
  ssh_fingerprint  TEXT,
  notify           INTEGER NOT NULL DEFAULT 1,
  state            TEXT,
  state_since      INTEGER,
  fail_streak      INTEGER NOT NULL DEFAULT 0,
  fail_since       INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Mesures brutes (une ligne par vérification), conservées RETENTION_DAYS jours
CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  up          INTEGER NOT NULL,
  latency_ms  REAL,
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_service_ts ON checks(service_id, ts);

-- Agrégats horaires, conservés RETENTION_HOURLY_DAYS jours (1 an par défaut)
CREATE TABLE IF NOT EXISTS checks_hourly (
  service_id   INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  hour         INTEGER NOT NULL,
  n            INTEGER NOT NULL,
  up_count     INTEGER NOT NULL,
  latency_sum  REAL    NOT NULL DEFAULT 0,
  latency_n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, hour)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// Migrations des bases créées par une version précédente
const columns = new Set(db.prepare('PRAGMA table_info(services)').all().map((c) => c.name));
for (const [name, def] of [
  ['dns_query', 'TEXT'],
  ['notify', 'INTEGER NOT NULL DEFAULT 1'],
  ['state', 'TEXT'],
  ['state_since', 'INTEGER'],
  ['fail_streak', 'INTEGER NOT NULL DEFAULT 0'],
  ['fail_since', 'INTEGER'],
]) {
  if (!columns.has(name)) db.exec(`ALTER TABLE services ADD COLUMN ${name} ${def}`);
}
// Agrégats manquants : on les reconstruit depuis les mesures brutes
if (!db.prepare('SELECT 1 FROM checks_hourly LIMIT 1').get()) {
  db.prepare(`INSERT INTO checks_hourly (service_id, hour, n, up_count, latency_sum, latency_n)
    SELECT service_id, (ts / ${HOUR}) * ${HOUR}, COUNT(*), SUM(up),
           COALESCE(SUM(CASE WHEN up = 1 THEN latency_ms END), 0),
           COUNT(CASE WHEN up = 1 AND latency_ms IS NOT NULL THEN 1 END)
    FROM checks GROUP BY 1, 2`).run();
}

const stmts = {
  list: db.prepare('SELECT * FROM services ORDER BY position, id'),
  get: db.prepare('SELECT * FROM services WHERE id = ?'),
  insert: db.prepare(`INSERT INTO services
    (name, type, target, port, dns_query, dns_record_type, link_url, interval_sec, is_public, notify, position, ip, ssh_port, ssh_user, ssh_password_enc)
    VALUES (@name, @type, @target, @port, @dns_query, @dns_record_type, @link_url, @interval_sec, @is_public, @notify, @position, @ip, @ssh_port, @ssh_user, @ssh_password_enc)`),
  setState: db.prepare('UPDATE services SET state = @state, state_since = @state_since, fail_streak = @fail_streak, fail_since = @fail_since WHERE id = @id'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  deleteSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
  remove: db.prepare('DELETE FROM services WHERE id = ?'),
  setFingerprint: db.prepare('UPDATE services SET ssh_fingerprint = ? WHERE id = ?'),
  insertCheck: db.prepare('INSERT INTO checks (service_id, ts, up, latency_ms, message) VALUES (?, ?, ?, ?, ?)'),
  upsertHourly: db.prepare(`INSERT INTO checks_hourly (service_id, hour, n, up_count, latency_sum, latency_n)
    VALUES (@id, @hour, 1, @up, @lat, @latN)
    ON CONFLICT (service_id, hour) DO UPDATE SET
      n = n + 1, up_count = up_count + @up, latency_sum = latency_sum + @lat, latency_n = latency_n + @latN`),
  lastCheck: db.prepare('SELECT ts, up, latency_ms, message FROM checks WHERE service_id = ? ORDER BY ts DESC LIMIT 1'),
  uptimeRaw: db.prepare('SELECT AVG(up) AS uptime FROM checks WHERE service_id = ? AND ts >= ?'),
  uptimeHourly: db.prepare('SELECT CAST(SUM(up_count) AS REAL) / SUM(n) AS uptime FROM checks_hourly WHERE service_id = ? AND hour >= ?'),
  bucketsRaw: db.prepare(`SELECT CAST((ts - @from) / @size AS INTEGER) AS b, AVG(up) AS up,
      AVG(CASE WHEN up = 1 THEN latency_ms END) AS latency
    FROM checks WHERE service_id = @id AND ts >= @from GROUP BY b`),
  bucketsHourly: db.prepare(`SELECT CAST((hour - @from) / @size AS INTEGER) AS b,
      CAST(SUM(up_count) AS REAL) / SUM(n) AS up,
      CASE WHEN SUM(latency_n) > 0 THEN SUM(latency_sum) / SUM(latency_n) END AS latency
    FROM checks_hourly WHERE service_id = @id AND hour >= @from GROUP BY b`),
  purgeRaw: db.prepare('DELETE FROM checks WHERE ts < ?'),
  purgeHourly: db.prepare('DELETE FROM checks_hourly WHERE hour < ?'),
};

export const listServices = () => stmts.list.all();
export const getService = (id) => stmts.get.get(id);
export const createService = (s) => getService(stmts.insert.run(s).lastInsertRowid);
export const deleteService = (id) => stmts.remove.run(id).changes > 0;
export const setFingerprint = (id, fp) => stmts.setFingerprint.run(fp, id);
export const lastCheck = (id) => stmts.lastCheck.get(id);
export const setState = (id, st) => stmts.setState.run({ id, ...st });
export const getSetting = (key) => stmts.getSetting.get(key)?.value ?? null;
export const setSetting = (key, value) => (value == null ? stmts.deleteSetting.run(key) : stmts.setSetting.run(key, value));

export const insertCheck = db.transaction((id, r) => {
  const ts = Date.now();
  const up = r.up ? 1 : 0;
  const latency = r.latency != null ? Math.round(r.latency * 100) / 100 : null;
  stmts.insertCheck.run(id, ts, up, latency, r.message ?? null);
  const hasLat = up && latency != null;
  stmts.upsertHourly.run({ id, hour: Math.floor(ts / HOUR) * HOUR, up, lat: hasLat ? latency : 0, latN: hasLat ? 1 : 0 });
});

export function purge(rawBefore, hourlyBefore) {
  return stmts.purgeRaw.run(rawBefore).changes + stmts.purgeHourly.run(hourlyBefore).changes;
}

const UPDATABLE = ['name', 'type', 'target', 'port', 'dns_query', 'dns_record_type', 'link_url',
  'interval_sec', 'is_public', 'notify', 'position', 'ip', 'ssh_port', 'ssh_user', 'ssh_password_enc', 'ssh_fingerprint'];

export function updateService(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (keys.length) {
    db.prepare(`UPDATE services SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }
  return getService(id);
}

/** Périodes disponibles : nombre de barres et source (mesures brutes ou agrégats horaires). */
export const PERIODS = {
  1: { count: 60, source: 'raw' },        // 1 barre / minute
  24: { count: 48, source: 'raw' },       // 1 barre / 30 min
  168: { count: 42, source: 'hourly' },   // 7 j  : 1 barre / 4 h
  720: { count: 30, source: 'hourly' },   // 30 j : 1 barre / jour
  8760: { count: 52, source: 'hourly' },  // 1 an : 1 barre / semaine
};

/** Disponibilité + historique agrégé sur les `hours` dernières heures. */
export function getHistory(id, hours = 24) {
  const { count, source } = PERIODS[hours] ?? PERIODS[24];
  const now = Date.now();
  let size = Math.ceil((hours * HOUR) / count);
  let from = now - size * count;
  if (source === 'hourly') {
    // Tranches alignées sur l'heure, la dernière contenant l'heure en cours
    size = Math.round(size / HOUR) * HOUR;
    from = (Math.floor(now / HOUR) + 1) * HOUR - size * count;
  }
  const stmt = source === 'raw' ? stmts.bucketsRaw : stmts.bucketsHourly;
  const rows = new Map(stmt.all({ id, from, size }).map((r) => [r.b, r]));
  const history = Array.from({ length: count }, (_, i) => {
    const r = rows.get(i);
    return { t: from + i * size, up: r ? r.up : null, latency: r?.latency != null ? Math.round(r.latency) : null };
  });
  const { uptime } = (source === 'raw' ? stmts.uptimeRaw : stmts.uptimeHourly).get(id, from);
  return { uptime, history };
}

/** Disponibilité sur 24 h, 30 j et 1 an (agrégats horaires). */
export function getUptimes(id) {
  const now = Date.now();
  const pct = (ms) => {
    const { uptime } = stmts.uptimeHourly.get(id, Math.floor((now - ms) / HOUR) * HOUR);
    return uptime != null ? Math.round(uptime * 10000) / 100 : null;
  };
  return { uptime_30d: pct(30 * 24 * HOUR), uptime_1y: pct(365 * 24 * HOUR) };
}
