// Queue generation for three modes:
//   none   -> library in manual (playlist) order
//   random -> uniform random shuffle
//   smart  -> Markov chain scored by algorithm.js weights

import { listSongs, songStats } from './library.js';
import { queryAll } from './db.js';
import { scoreCandidate } from './algorithm.js';

function transitionsFrom(workId) {
  const rows = queryAll(
    'SELECT to_work_id, count FROM transitions WHERE from_work_id = ?',
    [workId]
  );
  const m = new Map();
  for (const r of rows) m.set(r.to_work_id, r.count);
  return m;
}

export function buildQueue(mode, { size = 100, startWith = null } = {}) {
  const songs = listSongs();
  if (!songs.length) return { mode, items: [] };

  if (mode === 'none') {
    return { mode, items: songs.map(s => ({ workId: s.id, title: s.title, reason: null })) };
  }

  if (mode === 'random') {
    const pool = songs.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return {
      mode,
      items: pool.slice(0, size).map(s => ({ workId: s.id, title: s.title, reason: null }))
    };
  }

  // smart
  const byId = new Map(songs.map(s => [s.id, s]));
  const used = new Set();
  const items = [];

  let current = startWith && byId.has(startWith) ? startWith : songs[Math.floor(Math.random() * songs.length)].id;

  while (items.length < size && used.size < songs.length) {
    const statsById = new Map();
    const fromCur = transitionsFrom(current);
    const nowMs = Date.now();

    let best = null;
    let bestScore = -Infinity;
    let bestReasons = null;

    for (const s of songs) {
      if (used.has(s.id)) continue;

      let stats = statsById.get(s.id);
      if (stats === undefined) {
        stats = songStats(s.id);
        statsById.set(s.id, stats);
      }
      let hourHist = null;
      try { hourHist = stats?.hour_histogram_json ? JSON.parse(stats.hour_histogram_json) : null; } catch {}

      const { score, reasons } = scoreCandidate({
        candidate: s,
        currentWorkId: current,
        stats,
        transitionsFromCurrent: fromCur,
        hourHistogram: hourHist,
        nowMs
      });

      if (score > bestScore) {
        bestScore = score;
        best = s;
        bestReasons = reasons;
      }
    }

    if (!best) break;

    items.push({
      workId: best.id,
      title: best.title,
      reason: {
        score: Math.round(bestScore * 10) / 10,
        ...Object.fromEntries(
          Object.entries(bestReasons).map(([k, v]) => [k, Math.round(v * 10) / 10])
        )
      }
    });

    used.add(best.id);
    current = best.id;
  }

  return { mode, items };
}
