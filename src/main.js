import './style.css';
import { initDb, exportBlob, importBlob, getDb } from './db.js';
import {
  addSongInternal, deleteSongs, attachMedia, recordEvent,
  getSetting, setSetting
} from './library.js';
import { saveFile, getFile, deleteFile } from './storage.js';
import { setStatus } from './ui/status.js';
import { renderLibrary, setSearch, setSort } from './ui/render.js';
import { initDuplicates, refreshDuplicates } from './ui/duplicates.js';
import { initQueue, setQueue, clearQueueUI, restoreQueue } from './ui/queue.js';
import { renderKnowledge, showWhy } from './ui/knowledge.js';
import { initWeights, checkLearnProposal } from './ui/weights.js';
import { buildQueue } from './shuffle.js';

// ---------------- boot ----------------
async function start() {
  try {
    await initDb();
    setStatus('');
  } catch (e) {
    console.error(e);
    setStatus('Database failed to load. Check console.', 'error');
    return;
  }

  wireUI();
  renderAll();
  restoreQueue();
  checkLearnProposal();

  const mode = getSetting('mode', 'smart');
  const radio = document.querySelector(`input[name=mode][value="${mode}"]`);
  if (radio) radio.checked = true;
}

function renderAll() {
  renderLibrary({
    onPlay: playFile,
    onAttach: pickAudioFor,
    onWhy: showWhy,
    onDelete: handleDelete
  });
  renderKnowledge();
  refreshDuplicates();
}

// ---------------- wire UI ----------------
function wireUI() {
  document.getElementById('add').onclick = () => {
    const t = document.getElementById('title').value;
    const a = document.getElementById('artist').value;
    if (!t.trim()) { setStatus('Enter a song title.'); return; }
    addSongInternal(t.trim(), a);
    document.getElementById('title').value = '';
    document.getElementById('artist').value = '';
    renderAll();
  };

  let t = null;
  document.getElementById('search').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => setSearch(e.target.value), 150);
  };

  document.getElementById('sort').onchange = (e) => setSort(e.target.value);

  document.getElementById('refresh-knowledge').onclick = renderKnowledge;

  document.querySelectorAll('input[name=mode]').forEach(r => {
    r.onchange = () => { if (r.checked) setSetting('mode', r.value); };
  });

  document.getElementById('queue-build').onclick = () => {
    const mode = getSetting('mode', 'smart');
    const q = buildQueue(mode, { size: 100 });
    setQueue(q.mode, q.items);
  };

  // backup
  document.getElementById('export-db').onclick = async () => {
    const blob = await exportBlob();
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = URL.createObjectURL(blob);
    a.download = `musync-${stamp}.db`;
    a.click();
    URL.revokeObjectURL(a.href);
    document.getElementById('backup-status').textContent = `Downloaded ${a.download}`;
  };

  document.getElementById('import-db').onclick = () =>
    document.getElementById('import-file').click();

  document.getElementById('import-file').onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      await importBlob(f);
      renderAll();
      restoreQueue();
      document.getElementById('backup-status').textContent = `Imported ${f.name}`;
    } catch (err) {
      console.error(err);
      document.getElementById('backup-status').textContent = 'Import failed: ' + err.message;
    }
  };

  // csv
  document.getElementById('import-csv-btn').onclick = () =>
    document.getElementById('import-csv-file').click();
  document.getElementById('import-csv-file').onchange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) importCSV(f);
  };

  initDuplicates();
  initQueue();
  initWeights();
}

// ---------------- delete ----------------
async function handleDelete(workId, title) {
  if (!confirm(`Delete "${title}"?\n\nThis removes the song, its artists, its audio link, and its listening history. It cannot be undone.`)) return;

  const db = getDb();
  const r = db.exec(
    `SELECT lf.id FROM local_files lf
     JOIN media m ON m.local_file_id = lf.id
     JOIN recordings rec ON rec.id = m.recording_id
     WHERE rec.work_id = ?`,
    [workId]
  );
  const fileIds = r.length ? r[0].values.map(v => v[0]) : [];

  deleteSongs([workId]);

  for (const fid of fileIds) {
    try { await deleteFile(fid); } catch {}
  }

  renderAll();
}

// ---------------- audio ----------------
function pickAudioFor(recordingId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,video/*';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    await attachAudio(recordingId, f);
  };
  input.click();
}

async function attachAudio(recordingId, file) {
  const fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await saveFile(fileId, file);
  const toDelete = attachMedia(recordingId, fileId, file.name, file.size, file.type);
  for (const old of toDelete || []) {
    try { await deleteFile(old); } catch {}
  }
  renderAll();
}

async function playFile(fileId, title, artist, workId, recordingId) {
  const blob = await getFile(fileId);
  if (!blob) { setStatus('Audio file not found.'); return; }

  const audio = document.getElementById('audio');
  const player = document.getElementById('player');
  document.getElementById('player-title').textContent = title || '';
  document.getElementById('player-artist').textContent = artist || '';
  player.hidden = false;

  audio.onloadedmetadata = null;
  audio.onended = null;
  audio.onseeked = null;
  audio.src = URL.createObjectURL(blob);

  let lastPosition = 0;

  audio.onseeked = () => {
    const delta = audio.currentTime - lastPosition;
    if (delta > 5) {
      recordEvent({
        workId, recordingId, eventType: 'SKIP',
        extra: { position_ms: Math.round(lastPosition * 1000), skipped_after_ms: Math.round(lastPosition * 1000) }
      });
    }
    lastPosition = audio.currentTime;
  };

  audio.onended = () => {
    const dur = audio.duration || 0;
    recordEvent({
      workId, recordingId, eventType: 'COMPLETE',
      extra: { position_ms: Math.round(dur * 1000), duration_played_ms: Math.round(dur * 1000), completion_percent: 100 }
    });
    renderKnowledge();
  };

  recordEvent({
    workId, recordingId, eventType: 'START',
    extra: { position_ms: 0, manual_selection: true }
  });

  audio.play();
}

// ---------------- CSV ----------------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findColumns(header) {
  const n = header.map(h => h.trim().toLowerCase());
  let t = n.findIndex(h => h === 'track name');
  if (t === -1) t = n.findIndex(h => h === 'title');
  if (t === -1) t = n.findIndex(h => h.includes('track name'));
  if (t === -1) t = n.findIndex(h => h.includes('title'));

  let a = n.findIndex(h => h === 'artist name(s)');
  if (a === -1) a = n.findIndex(h => h === 'artist name');
  if (a === -1) a = n.findIndex(h => h === 'artist');
  if (a === -1) a = n.findIndex(h => h.includes('artist'));

  return { t, a };
}

function importCSV(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result).replace(/^\uFEFF/, '');
      const rows = parseCSV(text);
      if (rows.length < 2) {
        document.getElementById('csv-status').textContent = 'CSV empty or no data rows.';
        return;
      }
      const { t, a } = findColumns(rows[0]);
      if (t === -1 || a === -1) {
        document.getElementById('csv-status').textContent = 'Could not find title/artist columns.';
        return;
      }
      let added = 0, skipped = 0;
      for (let r = 1; r < rows.length; r++) {
        const title = (rows[r][t] ?? '').toString().trim();
        let artist = (rows[r][a] ?? '').toString().trim();
        if (!title || title.toLowerCase() === 'undefined') { skipped++; continue; }
        if (artist.toLowerCase() === 'undefined') artist = '';
        const parts = artist.split(';').map(s => s.trim()).filter(Boolean);
        addSongInternal(title, parts.join('; '));
        added++;
      }
      renderAll();
      document.getElementById('csv-status').textContent =
        `Imported ${added} song${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`;
    } catch (e) {
      console.error(e);
      document.getElementById('csv-status').textContent = 'Failed to parse CSV.';
    }
  };
  reader.readAsText(file);
}

start();
