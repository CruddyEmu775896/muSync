import './style.css';
import '../public/manifest.webmanifest';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { saveFile, getFile, deleteFile } from './idb.js';

const SQL_WASM_URL = wasmUrl;

const DEFAULT_WEIGHTS = {
  transition: 40,
  novelty: 25,
  timeOfDay: 20,
  skipPenalty: 15
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
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
`;

const id = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

let db = null;
let dbReady = false;
let currentSessionId = null;
let lastEventId = null;
let editingWorkId = null;

// ---------- Boot ----------

async function start() {
  try {
    const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });

    let restored = false;
    const saved = localStorage.getItem('musync.db');
    if (saved) {
      try {
        const bytes = Uint8Array.from(atob(saved), c => c.charCodeAt(0));
        db = new SQL.Database(bytes);
        db.exec('SELECT 1');
        db.run(SCHEMA);
        restored = true;
      } catch (e) {
        console.warn('Saved DB corrupted. Keeping a rescue copy.', e);
        try { localStorage.setItem('musync.db.broken', saved); } catch {}
        localStorage.removeItem('musync.db');
        db = null;
      }
    }

    if (!restored) db = new SQL.Database();
    db.run(SCHEMA);

    persist();
    dbReady = true;
    render();
    renderKnowledge();
    renderWeights();
    setStatus('');
  } catch (err) {
    console.error('muSync failed to start:', err);
    setStatus('Database failed to load. Open console for details.');
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

function setStatus(msg) {
  let el = document.getElementById('status');
  if (!el) {
    el = document.createElement('p');
    el.id = 'status';
    el.className = 'muted';
    document.querySelector('.panel')?.appendChild(el);
  }
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

// ---------- Artists ----------

function upsertArtist(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const existing = db.exec('SELECT id FROM artists WHERE name = ? LIMIT 1', [trimmed]);
  if (existing.length && existing[0].values.length) return existing[0].values[0][0];
  const artistId = id();
  db.run('INSERT INTO artists (id, name) VALUES (?, ?)', [artistId, trimmed]);
  return artistId;
}

function parseArtistString(raw) {
  const parts = (raw || '').split(';').map(s => s.trim()).filter(Boolean);
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
  addSongInternal(cleanTitle, artistRaw);
}

function addSongInternal(cleanTitle, artistRaw) {
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

  return workId;
}

// ---------- Edit song ----------

function startEdit(workId) {
  editingWorkId = workId;
  render();
}

function cancelEdit() {
  editingWorkId = null;
  render();
}

function saveEdit(workId, newTitle, newArtist) {
  const cleanTitle = (newTitle || '').trim();
  if (!cleanTitle) {
    setStatus('Title cannot be empty.');
    return;
  }

  const parsed = parseArtistString(newArtist);
  const displayCredit = parsed.length ? parsed.map(p => p.name).join('; ') : null;

  db.run(
    'UPDATE works SET canonical_title = ?, original_artist_credit = ? WHERE id = ?',
    [cleanTitle, displayCredit, workId]
  );

  const rec = db.exec(
    'SELECT id FROM recordings WHERE work_id = ? LIMIT 1',
    [workId]
  );
  if (rec.length && rec[0].values.length) {
    db.run('UPDATE recordings SET title = ? WHERE id = ?', [cleanTitle, rec[0].values[0][0]]);
  }

  db.run("DELETE FROM credits WHERE work_id = ? AND target_type = 'WORK'", [workId]);

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

  editingWorkId = null;
  persist();
  render();
  renderKnowledge();
  setStatus('');
}

// ---------- Delete song ----------

async function deleteSong(workId) {
  const work = db.exec('SELECT canonical_title FROM works WHERE id = ?', [workId]);
  const title = work.length && work[0].values.length ? work[0].values[0][0] : 'this song';

  if (!confirm(`Delete "${title}"?\n\nThis removes the song, its artists, its audio link, and its listening history. It cannot be undone.`)) {
    return;
  }

  const files = db.exec(
    `SELECT lf.id FROM local_files lf
     JOIN media m ON m.local_file_id = lf.id
     JOIN recordings r ON r.id = m.recording_id
     WHERE r.work_id = ?`,
    [workId]
  );
  const fileIds = files.length ? files[0].values.map(v => v[0]) : [];

  db.run('DELETE FROM works WHERE id = ?', [workId]);

  for (const fid of fileIds) {
    try { await deleteFile(fid); } catch {}
  }

  persist();
  render();
  renderKnowledge();
}

// ---------- Detach audio ----------

async function detachAudio(recordingId) {
  const rows = db.exec(
    `SELECT m.id, m.local_file_id
     FROM media m
     WHERE m.recording_id = ? AND m.local_file_id IS NOT NULL`,
    [recordingId]
  );
  if (!rows.length || !rows[0].values.length) return;

  const [mediaId, fileId] = rows[0].values[0];

  db.run('DELETE FROM media WHERE id = ?', [mediaId]);
  db.run('DELETE FROM local_files WHERE id = ?', [fileId]);

  try { await deleteFile(fileId); } catch {}

  persist();
  render();
}

// ---------- Read library ----------

function listSongs() {
  const works = db.exec(`
    SELECT w.id, w.canonical_title,
           (SELECT r.id FROM recordings r WHERE r.work_id = w.id LIMIT 1) AS rec_id
    FROM works w
    JOIN playlist_entries pe ON pe.work_id = w.id
    ORDER BY pe.position
  `);

  if (!works.length) return [];

  return works[0].values.map(([workId, title, recId]) => {
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
    if (feat.length) artistLabel += (artistLabel ? ' ' : '') + `feat. ${feat.join(', ')}`;

    let rawArtist = '';
    if (main.length) rawArtist = main.join('; ');
    if (feat.length) rawArtist += (rawArtist ? '; ' : '') + feat.join('; ');

    const media = db.exec(
      `SELECT lf.id, lf.filename
       FROM media m
       JOIN local_files lf ON lf.id = m.local_file_id
       WHERE m.recording_id = ?
       LIMIT 1`,
      [recId]
    );
    const mediaRow = media.length && media[0].values.length ? media[0].values[0] : null;

    return {
      id: workId,
      recordingId: recId,
      title,
      artist: artistLabel,
      rawArtist,
      fileId: mediaRow ? mediaRow[0] : null,
      filename: mediaRow ? mediaRow[1] : null
    };
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

    if (editingWorkId === s.id) {
      li.innerHTML = `
        <div style="flex:1; display:grid; gap:6px">
          <input id="edit-title-${s.id}" value="${escapeAttr(s.title)}" placeholder="Title" />
          <input id="edit-artist-${s.id}" value="${escapeAttr(s.rawArtist)}" placeholder="Artist ; Artist" />
        </div>
        <div style="display:flex; gap:6px; align-items:flex-start">
          <button class="small" data-save="${s.id}">Save</button>
          <button class="small" data-cancel="1">Cancel</button>
        </div>
      `;
      list.appendChild(li);

      li.querySelector(`[data-save="${s.id}"]`).addEventListener('click', () => {
        const newTitle = document.getElementById(`edit-title-${s.id}`).value;
        const newArtist = document.getElementById(`edit-artist-${s.id}`).value;
        saveEdit(s.id, newTitle, newArtist);
      });
      li.querySelector('[data-cancel]').addEventListener('click', cancelEdit);

      continue;
    }

    li.innerHTML = `
      <span>
        <strong>${escapeHtml(s.title)}</strong>
        <span class="muted"> — ${escapeHtml(s.artist || '')}</span>
      </span>
      <span style="display:flex; gap:6px; align-items:center; flex-wrap:wrap">
        <button class="small" data-why="${s.id}" data-title="${escapeAttr(s.title)}">Why</button>
        <button class="small" data-edit="${s.id}">Edit</button>
        ${s.fileId
          ? `<button class="small" data-play="${s.fileId}" data-title="${escapeAttr(s.title)}" data-artist="${escapeAttr(s.artist || '')}" data-work="${s.id}">Play</button>`
          : ''}
        <button class="small" data-attach="${s.recordingId}">${s.fileId ? 'Replace' : 'Attach'}</button>
        ${s.fileId
          ? `<button class="small" data-detach="${s.recordingId}">Detach</button>`
          : ''}
        <button class="small" data-delete="${s.id}">Delete</button>
      </span>
    `;
    list.appendChild(li);
  }

  list.querySelectorAll('[data-attach]').forEach(btn => {
    btn.addEventListener('click', () => pickAudioFor(btn.dataset.attach));
  });

  list.querySelectorAll('[data-play]').forEach(btn => {
    btn.addEventListener('click', () =>
      playFile(btn.dataset.play, btn.dataset.title, btn.dataset.artist, btn.dataset.work)
    );
  });

  list.querySelectorAll('[data-why]').forEach(btn => {
    btn.addEventListener('click', () => showWhy(btn.dataset.why, btn.dataset.title));
  });

  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => startEdit(btn.dataset.edit));
  });

  list.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteSong(btn.dataset.delete));
  });

  list.querySelectorAll('[data-detach]').forEach(btn => {
    btn.addEventListener('click', () => detachAudio(btn.dataset.detach));
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// ---------- Audio attach + play ----------

function pickAudioFor(recordingId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    await attachAudio(recordingId, file);
  });
  input.click();
}

async function attachAudio(recordingId, file) {
  const fileId = id();
  await saveFile(fileId, file);

  db.run(
    'INSERT INTO local_files (id, filename, size_bytes, format) VALUES (?, ?, ?, ?)',
    [fileId, file.name, file.size, file.type || null]
  );

  const existing = db.exec(
    'SELECT id, local_file_id FROM media WHERE recording_id = ?',
    [recordingId]
  );
  if (existing.length) {
    for (const [mid, oldFileId] of existing[0].values) {
      db.run('DELETE FROM media WHERE id = ?', [mid]);
      if (oldFileId) {
        db.run('DELETE FROM local_files WHERE id = ?', [oldFileId]);
        try { await deleteFile(oldFileId); } catch {}
      }
    }
  }

  db.run(
    'INSERT INTO media (id, recording_id, media_type, local_file_id) VALUES (?, ?, ?, ?)',
    [id(), recordingId, 'AUDIO', fileId]
  );

  persist();
  render();
}

function ensureSession() {
  if (currentSessionId) return currentSessionId;
  currentSessionId = id();
  db.run(
    'INSERT INTO playback_sessions (id, start_time, mode) VALUES (?, ?, ?)',
    [currentSessionId, new Date().toISOString(), 'MANUAL']
  );
  persist();
  return currentSessionId;
}

function recordEvent(workId, recordingId, eventType, extra = {}) {
  const sessionId = ensureSession();
  const eventId = id();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO listening_events
      (id, session_id, timestamp, work_id, recording_id, mode, event_type,
       position_ms, duration_played_ms, completion_percent, skipped_after_ms,
       manual_selection, previous_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId, sessionId, now, workId, recordingId || null, 'MANUAL', eventType,
      extra.position_ms ?? null,
      extra.duration_played_ms ?? null,
      extra.completion_percent ?? null,
      extra.skipped_after_ms ?? null,
      extra.manual_selection ? 1 : 0,
      lastEventId
    ]
  );
  lastEventId = eventId;
  persist();
  renderKnowledge();
}

async function playFile(fileId, title, artist, workId) {
  const file = await getFile(fileId);
  if (!file) {
    setStatus('Audio file not found in local storage.');
    return;
  }

  const audio = document.getElementById('audio');
  const player = document.getElementById('player');
  document.getElementById('player-title').textContent = title || '';
  document.getElementById('player-artist').textContent = artist || '';
  player.hidden = false;

  audio.onloadedmetadata = null;
  audio.onended = null;
  audio.onseeked = null;

  audio.src = URL.createObjectURL(file);

  let startedAt = null;
  let lastPosition = 0;

  audio.onloadedmetadata = () => {
    startedAt = Date.now();
  };

  audio.onseeked = () => {
    const delta = audio.currentTime - lastPosition;
    if (delta > 5 && startedAt) {
      recordEvent(workId, null, 'SKIP', {
        position_ms: Math.round(lastPosition * 1000),
        skipped_after_ms: Math.round(lastPosition * 1000)
      });
    }
    lastPosition = audio.currentTime;
  };

  audio.onended = () => {
    const dur = audio.duration || 0;
    recordEvent(workId, null, 'COMPLETE', {
      position_ms: Math.round(dur * 1000),
      duration_played_ms: Math.round(dur * 1000),
      completion_percent: 100
    });
  };

  recordEvent(workId, null, 'START', {
    position_ms: 0,
    manual_selection: true
  });

  audio.play();
}

// ---------- Why this song panel ----------

function showWhy(workId, title) {
  const el = document.getElementById('knowledge');
  const events = db.exec(
    `SELECT COUNT(*),
            SUM(CASE WHEN event_type = 'COMPLETE' THEN 1 ELSE 0 END),
            SUM(CASE WHEN event_type = 'SKIP' THEN 1 ELSE 0 END),
            SUM(CASE WHEN manual_selection = 1 THEN 1 ELSE 0 END),
            MAX(timestamp)
     FROM listening_events WHERE work_id = ?`,
    [workId]
  );
  const e = events.length ? events[0].values[0] : [0, 0, 0, 0, null];

  const transitions = db.exec(
    `SELECT le_prev.work_id,
            (SELECT canonical_title FROM works WHERE id = le_prev.work_id),
            COUNT(*)
     FROM listening_events le
     JOIN listening_events le_prev ON le.previous_event_id = le_prev.id
     WHERE le.work_id = ?
     GROUP BY le_prev.work_id
     ORDER BY COUNT(*) DESC
     LIMIT 5`,
    [workId]
  );

  const trans = transitions.length ? transitions[0].values : [];

  let html = `
    <div class="knowledge-block">
      <h3>Why this song? — ${escapeHtml(title)}</h3>
      <div class="knowledge-row"><span class="label">Total plays</span><span class="value">${e[0] || 0}</span></div>
      <div class="knowledge-row"><span class="label">Completed</span><span class="value">${e[1] || 0}</span></div>
      <div class="knowledge-row"><span class="label">Skipped</span><span class="value">${e[2] || 0}</span></div>
      <div class="knowledge-row"><span class="label">Manually chosen</span><span class="value">${e[3] || 0}</span></div>
      <div class="knowledge-row"><span class="label">Last played</span><span class="value">${e[4] || 'never'}</span></div>
    </div>
    <div class="knowledge-block">
      <h3>What usually plays before this</h3>
      ${trans.length
        ? trans.map(([wid, wtitle, count]) =>
            `<div class="knowledge-row">
              <span class="label">${escapeHtml(wtitle || 'unknown')}</span>
              <span class="value">${count}×</span>
            </div>`).join('')
        : '<div class="knowledge-row"><span class="label">No transition data yet.</span></div>'}
    </div>
  `;

  el.innerHTML = html;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Knowledge panel ----------

function renderKnowledge() {
  const el = document.getElementById('knowledge');
  if (!el) return;

  const totals = db.exec(`
    SELECT
      (SELECT COUNT(*) FROM works),
      (SELECT COUNT(*) FROM listening_events),
      (SELECT COUNT(*) FROM playback_sessions),
      (SELECT COUNT(*) FROM listening_events WHERE event_type = 'COMPLETE'),
      (SELECT COUNT(*) FROM listening_events WHERE event_type = 'SKIP'),
      (SELECT COUNT(*) FROM listening_events WHERE manual_selection = 1)
  `);
  const t = totals.length ? totals[0].values[0] : [0, 0, 0, 0, 0, 0];

  const topTransitions = db.exec(`
    SELECT
      (SELECT canonical_title FROM works WHERE id = le_prev.work_id) AS from_title,
      (SELECT canonical_title FROM works WHERE id = le.work_id) AS to_title,
      COUNT(*) AS n
    FROM listening_events le
    JOIN listening_events le_prev ON le.previous_event_id = le_prev.id
    WHERE le.event_type = 'START' AND le.manual_selection = 1
    GROUP BY le_prev.work_id, le.work_id
    ORDER BY n DESC
    LIMIT 10
  `);

  const transitions = topTransitions.length ? topTransitions[0].values : [];

  const hours = db.exec(`
    SELECT substr(timestamp, 12, 2) AS hour, COUNT(*)
    FROM listening_events
    GROUP BY hour
    ORDER BY hour
  `);
  const hourRows = hours.length ? hours[0].values : [];

  el.innerHTML = `
    <div class="knowledge-block">
      <h3>Totals</h3>
      <div class="knowledge-row"><span class="label">Songs in library</span><span class="value">${t[0]}</span></div>
      <div class="knowledge-row"><span class="label">Playback events recorded</span><span class="value">${t[1]}</span></div>
      <div class="knowledge-row"><span class="label">Playback sessions</span><span class="value">${t[2]}</span></div>
      <div class="knowledge-row"><span class="label">Completed plays</span><span class="value">${t[3]}</span></div>
      <div class="knowledge-row"><span class="label">Skipped plays</span><span class="value">${t[4]}</span></div>
      <div class="knowledge-row"><span class="label">Manual selections</span><span class="value">${t[5]}</span></div>
    </div>

    <div class="knowledge-block">
      <h3>Transitions I have seen (top 10)</h3>
      ${transitions.length
        ? transitions.map(([from, to, n]) =>
            `<div class="knowledge-row">
              <span class="label">${escapeHtml(from || '?')} → ${escapeHtml(to || '?')}</span>
              <span class="value">${n}×</span>
            </div>`).join('')
        : '<div class="knowledge-row"><span class="label">Nothing yet. Play some songs.</span></div>'}
    </div>

    <div class="knowledge-block">
      <h3>When you listen</h3>
      ${hourRows.length
        ? hourRows.map(([hour, n]) =>
            `<div class="knowledge-row">
              <span class="label">${hour}:00</span>
              <span class="value">${n} plays</span>
            </div>`).join('')
        : '<div class="knowledge-row"><span class="label">No listening data yet.</span></div>'}
    </div>
  `;
}

// ---------- Weights panel ----------

function getWeights() {
  const r = db.exec("SELECT value_json FROM settings WHERE key = 'weights'");
  if (!r.length || !r[0].values.length) return { ...DEFAULT_WEIGHTS };
  try { return JSON.parse(r[0].values[0][0]); }
  catch { return { ...DEFAULT_WEIGHTS }; }
}

function saveWeights(w) {
  db.run(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES ('weights', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                    updated_at = excluded.updated_at`,
    [JSON.stringify(w)]
  );
  persist();
}

function renderWeights() {
  const el = document.getElementById('weights');
  if (!el) return;
  const w = getWeights();

  const rows = [
    ['transition', 'Transition strength', 'How strongly A → B has happened in your history.'],
    ['novelty', 'Novelty boost', 'Rewards songs you have not heard recently.'],
    ['timeOfDay', 'Time-of-day match', 'Rewards songs you usually play at this hour.'],
    ['skipPenalty', 'Skip penalty', 'Penalizes songs you tend to skip.']
  ];

  el.innerHTML = rows.map(([key, name, desc]) => `
    <div class="weight-row">
      <div>
        <div class="name">${name}</div>
        <div class="desc">${desc}</div>
      </div>
      <input type="number" min="0" max="100" step="1" data-weight="${key}" value="${w[key] ?? 0}" />
    </div>
  `).join('');
}

function readWeightsFromUI() {
  const w = {};
  document.querySelectorAll('[data-weight]').forEach(input => {
    w[input.dataset.weight] = Number(input.value) || 0;
  });
  return w;
}

// ---------- Backup ----------

function exportDatabase() {
  if (!db) return;
  const data = db.export();
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `musync-${stamp}.db`;
  a.click();
  URL.revokeObjectURL(url);
  setBackupStatus(`Downloaded ${a.download}`);
}

function importDatabase(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });
      const bytes = new Uint8Array(reader.result);
      const next = new SQL.Database(bytes);
      next.exec('SELECT 1 FROM works LIMIT 1');
      next.run(SCHEMA);
      db = next;
      persist();
      render();
      renderKnowledge();
      renderWeights();
      setBackupStatus(`Imported ${file.name}`);
    } catch (e) {
      console.error(e);
      setBackupStatus('That file does not look like a muSync library.');
    }
  };
  reader.readAsArrayBuffer(file);
}

function setBackupStatus(msg) {
  const el = document.getElementById('backup-status');
  if (el) el.textContent = msg || '';
}

// ---------- CSV import ----------

function parseCSV(text) {
  // RFC 4180-ish parser: handles quoted fields, escaped quotes, CRLF, LF
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      // swallow; \n will end the line
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Last field/row
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function findColumns(headerRow) {
  const normalized = headerRow.map(h => h.trim().toLowerCase());

  // Title: accept "title", "track name", "song", "name"
  const titleIdx = normalized.findIndex(h =>
    h.includes('title') ||
    h.includes('track name') ||
    h === 'song' ||
    h === 'name'
  );

  // Artist: accept "artist", "artists", "artist name(s)", "artist name"
  const artistIdx = normalized.findIndex(h =>
    h.includes('artist')
  );

  return { titleIdx, artistIdx };
}

function importCSV(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result).replace(/^\uFEFF/, ''); // strip BOM
      const rows = parseCSV(text);

      if (rows.length < 2) {
        setCsvStatus('CSV is empty or has no data rows.');
        return;
      }

      const header = rows[0];
      const { titleIdx, artistIdx } = findColumns(header);

      if (titleIdx === -1) {
        setCsvStatus('Could not find a title column. Header must contain "title".');
        return;
      }
      if (artistIdx === -1) {
        setCsvStatus('Could not find an artist column. Header must contain "artist".');
        return;
      }

      let added = 0;
      let skipped = 0;

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const title = (row[titleIdx] ?? '').toString();
        const artist = (row[artistIdx] ?? '').toString();

        if (!title.trim()) {
          skipped++;
          continue;
        }

        addSongInternal(title.trim(), artist);
        added++;
      }

      persist();
      render();
      renderKnowledge();

      setCsvStatus(`Imported ${added} song${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`);
    } catch (e) {
      console.error(e);
      setCsvStatus('Failed to parse CSV. Check the console for details.');
    }
  };
  reader.readAsText(file);
}

function setCsvStatus(msg) {
  const el = document.getElementById('csv-status');
  if (el) el.textContent = msg || '';
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

document.getElementById('refresh-knowledge').addEventListener('click', renderKnowledge);

document.getElementById('save-weights').addEventListener('click', () => {
  const w = readWeightsFromUI();
  saveWeights(w);
  document.getElementById('weights-status').textContent = 'Saved.';
  setTimeout(() => {
    document.getElementById('weights-status').textContent = '';
  }, 2000);
});

document.getElementById('reset-weights').addEventListener('click', () => {
  saveWeights({ ...DEFAULT_WEIGHTS });
  renderWeights();
  document.getElementById('weights-status').textContent = 'Reset to defaults.';
  setTimeout(() => {
    document.getElementById('weights-status').textContent = '';
  }, 2000);
});

document.getElementById('export-db').addEventListener('click', exportDatabase);
document.getElementById('import-db').addEventListener('click', () => {
  document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) importDatabase(f);
  e.target.value = '';
});

document.getElementById('import-csv-btn').addEventListener('click', () => {
  document.getElementById('import-csv-file').click();
});

document.getElementById('import-csv-file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) importCSV(f);
  e.target.value = '';
});

start();
