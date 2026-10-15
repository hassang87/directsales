import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const DEFAULT_SETTINGS = {
  staff_mfa_required: config.isDemo ? '0' : '1',   // managers/admins must use TOTP or a passkey
  passkeys_enabled: '1',
  passkey_satisfies_mfa: '1',
  stale_minutes: '30',               // when a recorded location is labelled stale
  photo_max_age_seconds: '180',      // selfie must be captured this recently before upload
  photo_max_bytes: String(3 * 1024 * 1024),
  doc_max_bytes: String(5 * 1024 * 1024),
  location_max_accuracy_m: '100',    // readings worse than this are flagged for review
  location_request_minutes: '30',    // a location request expires after this
  photo_retention_days: '',          // empty = not configured, nothing auto-deleted
  invite_hours: '72',
  reset_hours: '2'
};

let db;

export function openDb(file = config.dbFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate();
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'migrations');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(name, at) VALUES (?, ?)').run(f, Date.now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw new Error(`Migration ${f} failed: ${e.message}`); }
  }
}

export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p)
};

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

export function setting(key) { return q.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? DEFAULT_SETTINGS[key]; }
export function settingNum(key) { return Number(setting(key)); }
export function setSetting(key, value) { q.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value)); }
export function allSettings() { return Object.fromEntries(q.all('SELECT key, value FROM settings').map(r => [r.key, r.value])); }
export function closeDb() { try { db?.close(); } catch {} db = null; }
export function rawDb() { return db; }
