import initSqlJs from 'sql.js';
import './style.css';
import '../public/manifest.webmanifest';

const SQL_WASM_URL =
  'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-wasm.wasm';

const SCHEMA = `
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

let db;

async function start() {
  const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });

  const saved = localStorage.getItem('musync.db');
  if (saved) {
    const bytes = Uint8Array.from(atob(saved), c => c.charCodeAt(0));
    db = new SQL.Database(bytes);
  } else {
    db = new SQL.Database();
  }

  db.run(SCHEMA);
  persist();
  render();
}

function persist() {
  const data = db.export();
  let s = '';
  for (const b of data) s += String.fromCharCode(b);
  localStorage.setItem('musync.db', btoa(s));
}

function addSong(title, artist) {
  if (!title.trim()) return;
  const workId = id();
  const recId = id();
  const entryId = id();

  db.run(
    'INSERT INTO works (id, canonical_title, original_artist_credit) VALUES (?, ?, ?)',
    [workId, title.trim(), artist.trim() || null]
  );
  db.run(
    'INSERT INTO recordings (id, work_id, title) VALUES (?, ?, ?)',
    [recId, workId, title.trim()]
  );
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
}

function listSongs() {
  const result = db.exec(`
    SELECT w.id, w.canonical_title, w.original_artist_credit
    FROM works w
    JOIN playlist_entries pe ON pe.work_id = w.id
    ORDER BY pe.position
  `);
  if (!result.length) return [];
  return result[0].values.map(([id, title, artist]) => ({ id, title, artist }));
}

function render() {
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

document.getElementById('add').addEventListener('click', () => {
  const title = document.getElementById('title').value;
  const artist = document.getElementById('artist').value;
  addSong(title, artist);
  document.getElementById('title').value = '';
  document.getElementById('artist').value = '';
});

start();
