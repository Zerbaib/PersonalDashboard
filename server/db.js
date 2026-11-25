import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, 'dashboard.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  type             TEXT    NOT NULL CHECK (type IN ('ping','tcp','http','dns')),
  target           TEXT    NOT NULL,
  port             INTEGER,
  dns_record_type  TEXT,
  dns_expected     TEXT,
  dns_server       TEXT,
  link_url         TEXT,
  interval_sec     INTEGER NOT NULL DEFAULT 60,
  is_public        INTEGER NOT NULL DEFAULT 1,
  position         INTEGER NOT NULL DEFAULT 0,
  ip               TEXT,
  ssh_port         INTEGER NOT NULL DEFAULT 22,
  ssh_user         TEXT,
  ssh_password_enc TEXT,
  ssh_fingerprint  TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  up          INTEGER NOT NULL,
  latency_ms  REAL,
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_service_ts ON checks(service_id, ts);
`);

const stmts = {
  list: db.prepare('SELECT * FROM services ORDER BY position, id'),
  get: db.prepare('SELECT * FROM services WHERE id = ?'),
  insert: db.prepare(`INSERT INTO services
    (name, type, target, port, dns_record_type, dns_expected, dns_server, link_url, interval_sec, is_public, position, ip, ssh_port, ssh_user, ssh_password_enc)
    VALUES (@name, @type, @target, @port, @dns_record_type, @dns_expected, @dns_server, @link_url, @interval_sec, @is_public, @position, @ip, @ssh_port, @ssh_user, @ssh_password_enc)`),
  remove: db.prepare('DELETE FROM services WHERE id = ?'),
  setFingerprint: db.prepare('UPDATE services SET ssh_fingerprint = ? WHERE id = ?'),
  insertCheck: db.prepare('INSERT INTO checks (service_id, ts, up, latency_ms, message) VALUES (?, ?, ?, ?, ?)'),
  lastCheck: db.prepare('SELECT ts, up, latency_ms, message FROM checks WHERE service_id = ? ORDER BY ts DESC LIMIT 1'),
  uptime: db.prepare('SELECT AVG(up) AS uptime FROM checks WHERE service_id = ? AND ts >= ?'),
  buckets: db.prepare(`SELECT CAST((ts - @from) / @size AS INTEGER) AS b, AVG(up) AS up,
      AVG(CASE WHEN up = 1 THEN latency_ms END) AS latency, COUNT(*) AS n
    FROM checks WHERE service_id = @id AND ts >= @from GROUP BY b ORDER BY b`),
  purge: db.prepare('DELETE FROM checks WHERE ts < ?'),
};

export const listServices = () => stmts.list.all();
export const getService = (id) => stmts.get.get(id);
export const createService = (s) => getService(stmts.insert.run(s).lastInsertRowid);
export const deleteService = (id) => stmts.remove.run(id).changes > 0;
export const setFingerprint = (id, fp) => stmts.setFingerprint.run(fp, id);
export const insertCheck = (id, r) => stmts.insertCheck.run(id, Date.now(), r.up ? 1 : 0, r.latency ?? null, r.message ?? null);
export const lastCheck = (id) => stmts.lastCheck.get(id);
export const purgeChecks = (before) => stmts.purge.run(before).changes;

const UPDATABLE = ['name', 'type', 'target', 'port', 'dns_record_type', 'dns_expected', 'dns_server', 'link_url',
  'interval_sec', 'is_public', 'position', 'ip', 'ssh_port', 'ssh_user', 'ssh_password_enc', 'ssh_fingerprint'];

export function updateService(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (keys.length) {
    db.prepare(`UPDATE services SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }
  return getService(id);
}

/** Uptime + historique agrégé en `count` tranches sur les `hours` dernières heures. */
export function getHistory(id, hours = 24, count = 48) {
  const now = Date.now();
  const size = Math.ceil((hours * 3600 * 1000) / count);
  const from = now - size * count;
  const rows = new Map(stmts.buckets.all({ id, from, size }).map((r) => [r.b, r]));
  const history = Array.from({ length: count }, (_, i) => {
    const r = rows.get(i);
    return { t: from + i * size, up: r ? r.up : null, latency: r?.latency != null ? Math.round(r.latency) : null };
  });
  const { uptime } = stmts.uptime.get(id, from);
  return { uptime, history };
}
