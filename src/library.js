// All library read/write queries. UI code should call these; nothing else
// should run raw SQL against the works/credits/etc tables.

import { exec, run, queryAll, queryOne, tx, persist, getDb } from './db.js';

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// ---------------- artists ----------------
export function upsertArtist(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const existing = queryOne(
    'SELECT id FROM artists WHERE name = ? COLLATE NOCASE LIMIT 1',
    [trimmed]
  );
  if (existing) return existing.id;
  const artistId = newId();
  run('INSERT INTO artists (id, name) VALUES (?, ?)', [artistId, trimmed]);
  return artistId;
}

// Split "Artist ; Artist ; feat. Artist" — only on ';'
// Keep "feat." inside a name as-is.
export function parseArtistString(raw) {
  const parts = String(raw || '')
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

// ---------------- add / update / delete ----------------
export function addSongInternal(cleanTitle, artistRaw) {
  const parsed = parseArtistString(artistRaw);
  const displayCredit = parsed.length ? parsed.map(p => p.name).join('; ') : null;

  const workId = newId();
  const recId = newId();
  const entryId = newId();

  tx(() => {
    run('INSERT INTO works (id, canonical_title, original_artist_credit) VALUES (?, ?, ?)',
      [workId, cleanTitle, displayCredit]);
    run('INSERT INTO recordings (id, work_id, title) VALUES (?, ?, ?)',
      [recId, workId, cleanTitle]);

    for (const p of parsed) {
      const artistId = upsertArtist(p.name);
      if (!artistId) continue;
      run(
        `INSERT INTO credits
          (id, artist_id, target_type, work_id, role, order_index)
         VALUES (?, ?, 'WORK', ?, ?, ?)`,
        [newId(), artistId, workId, p.role, p.order]
      );
    }

    const row = queryOne('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM playlist_entries');
    const pos = row?.pos ?? 1;

    run('INSERT INTO playlist_entries (id, position, target_type, work_id) VALUES (?, ?, ?, ?)',
      [entryId, pos, 'WORK', workId]);

    run(
      `INSERT INTO song_stats (work_id) VALUES (?)
       ON CONFLICT(work_id) DO NOTHING`,
      [workId]
    );
  });

  return workId;
}

export function updateSong(workId, newTitle, newArtist) {
  const cleanTitle = (newTitle || '').trim();
  if (!cleanTitle) throw new Error('Title cannot be empty');
  const parsed = parseArtistString(newArtist);
  const displayCredit = parsed.length ? parsed.map(p => p.name).join('; ') : null;

  tx(() => {
    run('UPDATE works SET canonical_title = ?, original_artist_credit = ? WHERE id = ?',
      [cleanTitle, displayCredit, workId]);
    const rec = queryOne('SELECT id FROM recordings WHERE work_id = ? LIMIT 1', [workId]);
    if (rec) run('UPDATE recordings SET title = ? WHERE id = ?', [cleanTitle, rec.id]);
    run("DELETE FROM credits WHERE work_id = ? AND target_type = 'WORK'", [workId]);
    for (const p of parsed) {
      const artistId = upsertArtist(p.name);
      if (!artistId) continue;
      run(
        `INSERT INTO credits
          (id, artist_id, target_type, work_id, role, order_index)
         VALUES (?, ?, 'WORK', ?, ?, ?)`,
        [newId(), artistId, workId, p.role, p.order]
      );
    }
  });
}

export function deleteSongs(workIds) {
  if (!workIds.length) return;
  tx(() => {
    const placeholders = workIds.map(() => '?').join(',');
    run(`DELETE FROM works WHERE id IN (${placeholders})`, workIds);
  });
}

// ---------------- read library ----------------
// One query for the whole library, plus one for credits, plus one for media.
// No N+1.
export function listSongs() {
  const works = queryAll(`
    SELECT w.id, w.canonical_title AS title, w.created_at,
           (SELECT r.id FROM recordings r WHERE r.work_id = w.id LIMIT 1) AS rec_id,
           pe.position AS playlist_position
    FROM works w
    JOIN playlist_entries pe ON pe.work_id = w.id
    ORDER BY pe.position
  `);
  if (!works.length) return [];

  const credits = queryAll(`
    SELECT c.work_id, c.role, c.order_index, a.name
    FROM credits c
    JOIN artists a ON a.id = c.artist_id
    WHERE c.target_type = 'WORK'
    ORDER BY c.work_id, c.order_index
  `);
  const creditMap = new Map();
  for (const c of credits) {
    if (!creditMap.has(c.work_id)) creditMap.set(c.work_id, []);
    creditMap.get(c.work_id).push(c);
  }

  const media = queryAll(`
    SELECT m.recording_id, lf.id AS file_id, lf.filename
    FROM media m
    JOIN local_files lf ON lf.id = m.local_file_id
  `);
  const mediaMap = new Map();
  for (const m of media) mediaMap.set(m.recording_id, m);

  const seenTitles = new Map();

  const rows = works.map(w => {
    const cs = creditMap.get(w.id) || [];
    const main = cs.filter(c => c.role === 'MAIN').map(c => c.name);
    const feat = cs.filter(c => c.role === 'FEATURED').map(c => c.name);

    let artistLabel = '';
    if (main.length) artistLabel = main.join(', ');
    if (feat.length) artistLabel += (artistLabel ? ' ' : '') + `feat. ${feat.join(', ')}`;

    let rawArtist = '';
    if (main.length) rawArtist = main.join('; ');
    if (feat.length) rawArtist += (rawArtist ? '; ' : '') + feat.join('; ');

    const m = mediaMap.get(w.rec_id) || null;

    const key = (w.title || '').trim().toLowerCase() + '\u0000' + (rawArtist || '').toLowerCase();
    seenTitles.set(key, (seenTitles.get(key) || 0) + 1);

    return {
      id: w.id,
      recordingId: w.rec_id,
      title: w.title,
      artist: artistLabel,
      rawArtist,
      createdAt: w.created_at,
      playlistPosition: w.playlist_position,
      fileId: m ? m.file_id : null,
      filename: m ? m.filename : null,
      dupKey: key
    };
  });

  for (const row of rows) row.dupCount = seenTitles.get(row.dupKey) || 1;

  return rows;
}

// ---------------- duplicates ----------------
function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\.?\b.*$/i, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findDuplicates({ fuzzy = false } = {}) {
  const rows = listSongs();
  const groups = new Map();

  for (const r of rows) {
    const key = fuzzy
      ? normalizeTitle(r.title)
      : (r.title || '').trim().toLowerCase() + '\u0000' + (r.artist || '').trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const [, members] of groups) {
    if (members.length > 1) {
      out.push({
        key: members[0].title.toLowerCase(),
        members
      });
    }
  }
  out.sort((a, b) => b.members.length - a.members.length);
  return out;
}

// ---------------- media attachment ----------------
export function attachMedia(recordingId, fileId, filename, size, mime) {
  const toDelete = [];
  tx(() => {
    const existing = queryAll(
      'SELECT id, local_file_id FROM media WHERE recording_id = ?',
      [recordingId]
    );
    for (const e of existing) {
      run('DELETE FROM media WHERE id = ?', [e.id]);
      if (e.local_file_id) {
        toDelete.push(e.local_file_id);
        run('DELETE FROM local_files WHERE id = ?', [e.local_file_id]);
      }
    }
    run('INSERT INTO local_files (id, filename, size_bytes, format) VALUES (?, ?, ?, ?)',
      [fileId, filename, size ?? null, mime ?? null]);
    run('INSERT INTO media (id, recording_id, media_type, local_file_id) VALUES (?, ?, ?, ?)',
      [newId(), recordingId, 'AUDIO', fileId]);
  });
  return toDelete; // caller should delete these from storage.js
}


// ---------------- listening events ----------------
let currentSessionId = null;

export function ensureSession(mode = 'MANUAL') {
  if (currentSessionId) return currentSessionId;
  currentSessionId = newId();
  run('INSERT INTO playback_sessions (id, start_time, mode) VALUES (?, ?, ?)',
    [currentSessionId, new Date().toISOString(), mode]);
  return currentSessionId;
}

export function resetSession() {
  currentSessionId = null;
}

let lastEventId = null;

export function setLastEventId(id) { lastEventId = id; }
export function getLastEventId() { return lastEventId; }

export function recordEvent({ workId, recordingId, eventType, mode = 'MANUAL', extra = {} }) {
  const sessionId = ensureSession(mode);
  const eventId = newId();
  const now = new Date().toISOString();

  const ev = {
    position_ms: extra.position_ms ?? null,
    duration_played_ms: extra.duration_played_ms ?? null,
    completion_percent: extra.completion_percent ?? null,
    skipped_after_ms: extra.skipped_after_ms ?? null,
    manual_selection: extra.manual_selection ? 1 : 0
  };

  tx(() => {
    run(
      `INSERT INTO listening_events
        (id, session_id, timestamp, work_id, recording_id, mode, event_type,
         position_ms, duration_played_ms, completion_percent, skipped_after_ms,
         manual_selection, previous_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, sessionId, now, workId, recordingId || null, mode, eventType,
       ev.position_ms, ev.duration_played_ms, ev.completion_percent,
       ev.skipped_after_ms, ev.manual_selection, lastEventId]
    );

    // update stats
    const isPlay = eventType === 'START';
    const isComplete = eventType === 'COMPLETE';
    const isSkip = eventType === 'SKIP';
    const hour = new Date().getUTCHours().toString().padStart(2, '0');

    run(
      `INSERT INTO song_stats (work_id, play_count, complete_count, skip_count,
                               manual_count, last_played_at, hour_histogram_json)
       VALUES (?, ?, ?, ?, ?, ?, '{}')
       ON CONFLICT(work_id) DO UPDATE SET
         play_count      = play_count      + excluded.play_count,
         complete_count  = complete_count  + excluded.complete_count,
         skip_count      = skip_count      + excluded.skip_count,
         manual_count    = manual_count    + excluded.manual_count,
         last_played_at  = COALESCE(excluded.last_played_at, song_stats.last_played_at)`,
      [workId, isPlay ? 1 : 0, isComplete ? 1 : 0, isSkip ? 1 : 0,
       ev.manual_selection, isPlay ? now : null]
    );

    if (isPlay) {
      const row = queryOne('SELECT hour_histogram_json FROM song_stats WHERE work_id = ?', [workId]);
      let hist = {};
      try { hist = JSON.parse(row?.hour_histogram_json || '{}'); } catch {}
      hist[hour] = (hist[hour] || 0) + 1;
      run('UPDATE song_stats SET hour_histogram_json = ? WHERE work_id = ?',
        [JSON.stringify(hist), workId]);
    }

    // transitions
    if (lastEventId && isPlay) {
      const prev = queryOne('SELECT work_id FROM listening_events WHERE id = ?', [lastEventId]);
      if (prev && prev.work_id !== workId) {
        run(
          `INSERT INTO transitions (from_work_id, to_work_id, count, last_seen_at)
           VALUES (?, ?, 1, datetime('now'))
           ON CONFLICT(from_work_id, to_work_id) DO UPDATE SET
             count = count + 1,
             last_seen_at = excluded.last_seen_at`,
          [prev.work_id, workId]
        );
      }
    }
  });

  lastEventId = eventId;
  return eventId;
}

// ---------------- transitions / knowledge ----------------
export function topTransitions(limit = 10) {
  return queryAll(`
    SELECT
      (SELECT canonical_title FROM works WHERE id = t.from_work_id) AS from_title,
      (SELECT canonical_title FROM works WHERE id = t.to_work_id)   AS to_title,
      t.count
    FROM transitions t
    ORDER BY t.count DESC
    LIMIT ?
  `, [limit]);
}

export function transitionsInto(workId, limit = 5) {
  return queryAll(`
    SELECT
      (SELECT canonical_title FROM works WHERE id = t.from_work_id) AS from_title,
      t.count
    FROM transitions t
    WHERE t.to_work_id = ?
    ORDER BY t.count DESC
    LIMIT ?
  `, [workId, limit]);
}

export function songStats(workId) {
  return queryOne('SELECT * FROM song_stats WHERE work_id = ?', [workId]);
}

export function libraryTotals() {
  return queryOne(`
    SELECT
      (SELECT COUNT(*) FROM works)                              AS songs,
      (SELECT COUNT(*) FROM listening_events)                   AS events,
      (SELECT COUNT(*) FROM playback_sessions)                  AS sessions,
      (SELECT COUNT(*) FROM listening_events WHERE event_type='COMPLETE') AS completes,
      (SELECT COUNT(*) FROM listening_events WHERE event_type='SKIP')     AS skips,
      (SELECT COUNT(*) FROM listening_events WHERE manual_selection=1)    AS manuals,
      (SELECT COUNT(*) FROM transitions)                        AS transitions
  `);
}

export function hourHistogram() {
  return queryAll(`
    SELECT substr(timestamp, 12, 2) AS hour, COUNT(*) AS n
    FROM listening_events
    GROUP BY hour
    ORDER BY hour
  `);
}

// ---------------- settings ----------------
export function getSetting(key, fallback = null) {
  const r = queryOne('SELECT value_json FROM settings WHERE key = ?', [key]);
  if (!r) return fallback;
  try { return JSON.parse(r.value_json); } catch { return fallback; }
}

export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    [key, JSON.stringify(value)]
  );
}

// ---------------- queues ----------------
export function saveQueue(mode, items) {
  tx(() => {
    run("DELETE FROM queues WHERE name = 'default'");
    const qid = newId();
    run("INSERT INTO queues (id, name, mode) VALUES (?, 'default', ?)", [qid, mode]);
    items.forEach((it, i) => {
      run(
        `INSERT INTO queue_items (id, queue_id, position, work_id, reason_json)
         VALUES (?, ?, ?, ?, ?)`,
        [newId(), qid, i, it.workId, it.reason ? JSON.stringify(it.reason) : null]
      );
    });
  });
}

export function loadQueue() {
  const q = queryOne("SELECT * FROM queues WHERE name = 'default' LIMIT 1");
  if (!q) return null;
  const items = queryAll(`
    SELECT qi.work_id, qi.position, qi.reason_json,
           w.canonical_title AS title
    FROM queue_items qi
    JOIN works w ON w.id = qi.work_id
    WHERE qi.queue_id = ?
    ORDER BY qi.position
  `, [q.id]);
  return {
    mode: q.mode,
    items: items.map(i => ({
      workId: i.work_id,
      title: i.title,
      reason: i.reason_json ? JSON.parse(i.reason_json) : null
    }))
  };
}

export function clearQueue() {
  run("DELETE FROM queues WHERE name = 'default'");
}

export function reorderQueue(workIdsInOrder) {
  tx(() => {
    const q = queryOne("SELECT id FROM queues WHERE name = 'default' LIMIT 1");
    if (!q) return;
    workIdsInOrder.forEach((wid, i) => {
      run('UPDATE queue_items SET position = ? WHERE queue_id = ? AND work_id = ?',
        [i, q.id, wid]);
    });
  });
}
