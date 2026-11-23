"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
for (const d of ["", "media", "screenshots", "apk"]) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "signage.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','web')),
  file TEXT,
  url TEXT,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  duration INTEGER NOT NULL DEFAULT 10
);
CREATE TABLE IF NOT EXISTS screens (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  pairing_code TEXT,
  paired_at INTEGER,
  name TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
  orientation INTEGER NOT NULL DEFAULT 0 CHECK (orientation IN (0,90,180,270)),
  volume INTEGER NOT NULL DEFAULT 100,
  model TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  status_json TEXT NOT NULL DEFAULT '{}',
  last_seen INTEGER,
  screenshot_file TEXT,
  screenshot_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS screens_pairing_code ON screens(pairing_code) WHERE pairing_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  screen_id INTEGER NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  days INTEGER NOT NULL DEFAULT 127,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY,
  screen_id INTEGER NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
`);

// ---- Customer sub-accounts ----
// users.customer_id NULL = your own staff (see every customer). Otherwise the user belongs to that customer only.
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  screen_limit INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`);
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
for (const t of ["users", "media", "playlists", "screens"]) {
  if (!hasColumn(t, "customer_id")) db.exec(`ALTER TABLE ${t} ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE`);
  db.exec(`CREATE INDEX IF NOT EXISTS ${t}_customer ON ${t}(customer_id)`);
}
// Content made before sub-accounts existed moves into one customer so nothing is lost.
{
  const orphan = ["media", "playlists"].some(t => db.prepare(`SELECT 1 FROM ${t} WHERE customer_id IS NULL LIMIT 1`).get())
    || db.prepare("SELECT 1 FROM screens WHERE customer_id IS NULL AND paired_at IS NOT NULL LIMIT 1").get();
  if (orphan) {
    const r = db.prepare("INSERT INTO customers (name, created_at) VALUES ('Premier Computer', ?)").run(Date.now());
    for (const t of ["media", "playlists"]) db.prepare(`UPDATE ${t} SET customer_id = ? WHERE customer_id IS NULL`).run(r.lastInsertRowid);
    db.prepare("UPDATE screens SET customer_id = ? WHERE customer_id IS NULL AND paired_at IS NOT NULL").run(r.lastInsertRowid);
  }
}

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

/** Runs fn inside a transaction (rolls back if it throws). */
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

const now = () => Date.now();

module.exports = { db, all, get, run, tx, now, DATA_DIR };
