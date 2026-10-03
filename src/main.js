import './style.css';
import '../public/manifest.webmanifest';
import initSqlJs from 'sql.js';

const SQL_WASM_URL =
  'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-wasm.wasm';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name ON artists(name);

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
CREATE INDEX IF NOT EXISTS idx_credits_work ON credits(work_id);
CREATE INDEX IF NOT EXISTS idx_credits_artist ON credits(artist_id);

CREATE TABLE IF NOT EXISTS playlist_entries (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'WORK',
  work_id TEXT REFERENCES works(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const id = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

let db = null;
let dbReady = false;

// ---------- Boot ----------

async function start() {
  try {
    const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });

    // Try to restore; if anything is wrong with the saved DB, start fresh.
    let restored = false;
    const saved = localStorage.getItem('musync.db');
    if (saved) {
      try {
        const bytes = Uint8Array.from(atob(saved), c => c.charCodeAt(0));
        db = new SQL.Database(bytes);
        // sanity check: does the restored DB have the new tables?
        db.exec('SELECT 1 FROM artists LIMIT 1');
        restored = true;
      } catch (e) {
        console.warn('Saved DB is incompatible, starting fresh.', e);
        localStorage.removeItem('musync.db');
        db = null;
      }
    }

    if (!restored) {
      db = new SQL.Database();
    }

    db.run(SCHEMA);
    persist();
    dbReady = true;
    render();
    setStatus('');
  } catch (err) {
    console.error('muSync failed to start:', err);
    setStatus('Database failed to load. Open the console for details.');
  }
}

function persist() {
  if (!db) return;
  try {
    const data = db.export();
    let s = '';
    for (const b of data) s += String.fromCharCode(b);
    localStorage.setItem('musync.db', btoa(s));
  } catch (e) {
    console.warn('Failed to persist DB:', e);
  }
}

// ---------- Status line ----------

function setStatus(msg) {
  let el = document.getElementById('status');
  if (!el) {
    el = document.createElement('p');
    el.id = 'status';
    el.className = 'muted';
    const panel = document.querySelector('.panel');
    panel?.appendChild(el);
  }
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

// ---------- Artist + Credit helpers ----------

function upsertArtist(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const existing = db.exec(
    'SELECT id FROM artists WHERE name = ? LIMIT 1',
    [trimmed]
  );
  if (existing.length && existing[0].values.length) {
    return existing[0].values[0][0];
  }

  const artistId = id();
  db.run('INSERT INTO artists (id, name) VALUES (?, ?)', [artistId, trimmed]);
  return artistId;
}

function parseArtistString(raw) {
  const parts = (raw || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  if (!parts.length) return [];
  return parts.map((name, i) => ({
    name,
    role: i === 0 ? 'MAIN' : 'FEATURED',
    order: i
  }));
}

// ---------- Add song ----------

function addSong(title, artistRaw) {
  const cleanTitle = (title || '').trim();
  if (!cleanTitle) {
    setStatus('Please enter a song title.');
    return;
  }

  const parsed = parseArtistString(artistRaw);
  const displayCredit = parsed.length ? parsed.map(p => p.name).join('; ') : null;

  const workId = id();
  const recId = id();
  const entryId = id();

  db.run(
    'INSERT INTO works (id, canonical_title, original_artist_credit) VALUES (?, ?, ?)',
    [workId, cleanTitle, displayCredit]
  );

  db.run(
    'INSERT INTO recordings (id, work_id, title) VALUES (?, ?, ?)',
    [recId, workId, cleanTitle]
  );

  for (const p of parsed) {
    const artistId = upsertArtist(p.name);
    if (!artistId) continue;
    db.run(
      `INSERT INTO credits
        (id, artist_id, target_type, work_id, role, order_index)
       VALUES (?, ?, 'WORK', ?, ?, ?)`,
      [id(), artistId, workId, p.role, p.order]
    );
  }

  const [{ values }] = db.exec(
    'SELECT COALESCE(MAX(position), 0) + 1 FROM playlist_entries'
  );
  const pos = values[0][0];

  db.run(
    'INSERT INTO playlist_entries (id, position, target_type, work_id) VALUES (?, ?, ?, ?)',
    [entryId, pos, 'WORK', workId]
  );

  persist();
  render();
  setStatus('');
}

// ---------- Read back ----------

function listSongs() {
  const works = db.exec(`
    SELECT w.id, w.canonical_title
    FROM works w
    JOIN playlist_entries pe ON pe.work_id = w.id
    ORDER BY pe.position
  `);

  if (!works.length) return [];

  return works[0].values.map(([workId, title]) => {
    const credits = db.exec(
      `SELECT c.role, a.name
       FROM credits c
       JOIN artists a ON a.id = c.artist_id
       WHERE c.work_id = ?
       ORDER BY c.order_index`,
      [workId]
    );

    const rows = credits.length ? credits[0].values : [];
    const main = rows.filter(r => r[0] === 'MAIN').map(r => r[1]);
    const feat = rows.filter(r => r[0] === 'FEATURED').map(r => r[1]);

    let artistLabel = '';
    if (main.length) artistLabel = main.join(', ');
    if (feat.length) {
      artistLabel += (artistLabel ? ' ' : '') + `feat. ${feat.join(', ')}`;
    }

    return { id: workId, title, artist: artistLabel };
  });
}

function render() {
  if (!dbReady) return;
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  const songs = listSongs();

  list.innerHTML = '';
  empty.style.display = songs.length ? 'none' : 'block';

  for (const s of songs) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(s.title)}</span>
      <span class="muted">${escapeHtml(s.artist || '')}</span>`;
    list.appendChild(li);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------- Wire up ----------

document.getElementById('add').addEventListener('click', () => {
  if (!dbReady) {
    setStatus('Database is still loading. Try again in a second.');
    return;
  }
  const title = document.getElementById('title').value;
  const artist = document.getElementById('artist').value;
  addSong(title, artist);
  document.getElementById('title').value = '';
  document.getElementById('artist').value = '';
});

start();
