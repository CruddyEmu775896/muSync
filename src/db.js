// SQLite via sql.js, persisted to IndexedDB, with pragmas and migrations.

import initSqlJs from 'sql.js/dist/sql-wasm.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { kvGet, kvSet } from './idb-kv.js';

export const SQL_WASM_URL = wasmUrl;

const DB_KEY = 'musync.db.blob';
const LEGACY_LS_KEY = 'musync.db';
const SCHEMA_VERSION_KEY = 'schema_version';

let SQL = null;
let db = null;
let saveTimer = null;
let dirty = false;

// ---------------- migrations ----------------
// Each entry runs ONCE on databases older than its version.
// Never edit an existing migration; always append a new one.
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    up(d) {
      d.run(`
        CREATE TABLE IF NOT EXISTS artists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name
          ON artists(name COLLATE NOCASE);

        CREATE TABLE IF NOT EXISTS works (
          id TEXT PRIMARY KEY,
          canonical_title TEXT NOT NULL,
          original_artist_credit TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS recordings (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          version_type TEXT NOT NULL DEFAULT 'STUDIO',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS credits (
          id TEXT PRIMARY KEY,
          artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL DEFAULT 'WORK',
          work_id TEXT REFERENCES works(id) ON DELETE CASCADE,
          recording_id TEXT REFERENCES recordings(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'MAIN',
          order_index INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS local_files (
          id TEXT PRIMARY KEY,
          path TEXT,
          filename TEXT NOT NULL,
          size_bytes INTEGER,
          format TEXT,
          added_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS media (
          id TEXT PRIMARY KEY,
          recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          media_type TEXT NOT NULL DEFAULT 'AUDIO',
          local_file_id TEXT REFERENCES local_files(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS playlist_entries (
          id TEXT PRIMARY KEY,
          position INTEGER NOT NULL,
          target_type TEXT NOT NULL DEFAULT 'WORK',
          work_id TEXT REFERENCES works(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS playback_sessions (
          id TEXT PRIMARY KEY,
          start_time TEXT NOT NULL,
          end_time TEXT,
          mode TEXT NOT NULL DEFAULT 'MANUAL',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS listening_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
          timestamp TEXT NOT NULL,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          recording_id TEXT,
          media_id TEXT,
          mode TEXT NOT NULL DEFAULT 'MANUAL',
          event_type TEXT NOT NULL,
          position_ms INTEGER,
          duration_played_ms INTEGER,
          completion_percent REAL,
          skipped_after_ms INTEGER,
          manual_selection INTEGER NOT NULL DEFAULT 0,
          previous_event_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_le_work ON listening_events(work_id);
        CREATE INDEX IF NOT EXISTS idx_le_prev ON listening_events(previous_event_id);
        CREATE INDEX IF NOT EXISTS idx_le_time ON listening_events(timestamp);

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }
  },
  {
    version: 2,
    name: 'transitions, stats, queues',
    up(d) {
      d.run(`
        CREATE TABLE IF NOT EXISTS transitions (
          from_work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          to_work_id   TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          count        INTEGER NOT NULL DEFAULT 0,
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (from_work_id, to_work_id)
        );
        CREATE INDEX IF NOT EXISTS idx_tr_to ON transitions(to_work_id);

        CREATE TABLE IF NOT EXISTS song_stats (
          work_id              TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
          play_count           INTEGER NOT NULL DEFAULT 0,
          complete_count       INTEGER NOT NULL DEFAULT 0,
          skip_count           INTEGER NOT NULL DEFAULT 0,
          manual_count         INTEGER NOT NULL DEFAULT 0,
          last_played_at       TEXT,
          hour_histogram_json  TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS queues (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL DEFAULT 'default',
          mode        TEXT NOT NULL DEFAULT 'smart',
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS queue_items (
          id           TEXT PRIMARY KEY,
          queue_id     TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
          position     INTEGER NOT NULL,
          work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          reason_json  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_qi_queue ON queue_items(queue_id, position);
      `);
    }
  }
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function getSchemaVersion(d) {
  try {
    const r = d.exec("SELECT value_json FROM settings WHERE key = ?", [SCHEMA_VERSION_KEY]);
    if (r.length && r[0].values.length) return Number(JSON.parse(r[0].values[0][0]));
  } catch {}
  return 0;
}

function setSchemaVersion(d, v) {
  d.run(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                    updated_at = excluded.updated_at`,
    [SCHEMA_VERSION_KEY, JSON.stringify(v)]
  );
}

function runMigrations(d) {
  const current = getSchemaVersion(d);
  if (current >= LATEST_VERSION) return current;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    console.log(`[db] applying migration ${m.version}: ${m.name}`);
    m.up(d);
    setSchemaVersion(d, m.version);
  }
  return LATEST_VERSION;
}

// ---------------- init ----------------
export async function initDb() {
  if (db) return db;

  SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });

  // 1. try IndexedDB
  const blob = await kvGet(DB_KEY);
  if (blob) {
    db = new SQL.Database(new Uint8Array(blob));
    console.log('[db] loaded from IndexedDB');
  }

  // 2. fall back to legacy localStorage
  if (!db) {
    const legacy = localStorage.getItem(LEGACY_LS_KEY);
    if (legacy) {
      try {
        const bytes = Uint8Array.from(atob(legacy), c => c.charCodeAt(0));
        db = new SQL.Database(bytes);
        console.log('[db] migrated from legacy localStorage (kept as rescue copy)');
      } catch (e) {
        console.warn('[db] legacy DB unreadable, keeping copy as musync.db.broken', e);
        try { localStorage.setItem('musync.db.broken', legacy); } catch {}
        localStorage.removeItem(LEGACY_LS_KEY);
      }
    }
  }

  // 3. fresh
  if (!db) {
    db = new SQL.Database();
    console.log('[db] fresh database');
  }

  // pragmas — must come before migrations
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA journal_mode = MEMORY;');
  db.run('PRAGMA synchronous = NORMAL;');

  // ensure settings table exists before we try to read schema_version
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  runMigrations(db);

  // first save so new DBs land in IndexedDB
  await persistNow();
  return db;
}

// ---------------- persistence ----------------
function encode(data) {
  // faster than per-char loop
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    s += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
  }
  return btoa(s);
}

export async function persistNow() {
  if (!db) return;
  const data = db.export();
  await kvSet(DB_KEY, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  dirty = false;
}

export function persist() {
  if (!db) return;
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persistNow().catch(e => console.warn('[db] persist failed', e));
  }, 400);
}

export function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

// ---------------- helpers used by library.js ----------------
export function exec(sql, params = []) {
  return getDb().exec(sql, params);
}

export function run(sql, params = []) {
  getDb().run(sql, params);
  persist();
}

export function tx(fn) {
  const d = getDb();
  d.run('BEGIN');
  try {
    fn(d);
    d.run('COMMIT');
    persist();
  } catch (e) {
    try { d.run('ROLLBACK'); } catch {}
    throw e;
  }
}

export function queryAll(sql, params = []) {
  const r = getDb().exec(sql, params);
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

export function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] ?? null;
}

export async function exportBlob() {
  if (!db) throw new Error('DB not initialized');
  const data = db.export();
  return new Blob([data], { type: 'application/octet-stream' });
}

export async function importBlob(file) {
  const buf = new Uint8Array(await file.arrayBuffer());

  const header = new TextDecoder('latin1').decode(buf.slice(0, 16));
  if (!header.startsWith('SQLite format 3')) {
    throw new Error(`Not a SQLite file (header: ${JSON.stringify(header)}). Size: ${buf.length} bytes.`);
  }

  let next;
  try {
    next = new SQL.Database(buf);
  } catch (e) {
    throw new Error('SQLite could not open file: ' + e.message);
  }

  // Report what's in there, then check.
  let tables = [];
  try {
    const r = next.exec("SELECT name FROM sqlite_master WHERE type='table'");
    tables = r.length ? r[0].values.map(v => v[0]) : [];
  } catch (e) {
    throw new Error('Could not list tables: ' + e.message);
  }
  console.log('[import] tables in file:', tables.join(', '));

  if (!tables.includes('works')) {
    throw new Error(`Missing 'works' table. Found: ${tables.join(', ') || '(none)'}`);
  }

  // Count rows to confirm it's a real library.
  try {
    const w = next.exec('SELECT COUNT(*) FROM works');
    const n = w.length ? w[0].values[0][0] : 0;
    console.log('[import] works rows:', n);
    if (n === 0) throw new Error('works table is empty — nothing to import.');
  } catch (e) {
    throw new Error('Could not count works: ' + e.message);
  }

  try {
    next.run('PRAGMA foreign_keys = ON;');
    next.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    runMigrations(next);
  } catch (e) {
    throw new Error('Migration failed: ' + e.message);
  }

  db = next;
  await persistNow();
  console.log('[import] success');
}
