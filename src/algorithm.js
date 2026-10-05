// Smart Shuffle scoring + hybrid learned-weight suggestions.
//
// Four factors, all normalized to 0..1, weighted by user weights (0..100).
//   transition : strength of "current song -> candidate" in transitions table
//   novelty    : time since last play (recent = low, old = high)
//   timeOfDay  : how often this song is played in the current hour
//   skipPenalty: fraction of plays that were skipped (penalized)

import { getSetting, setSetting, songStats } from './library.js';
import { queryAll, queryOne } from './db.js';

export const DEFAULT_WEIGHTS = {
  transition: 40,
  novelty: 25,
  timeOfDay: 20,
  skipPenalty: 15
};

export function getWeights() {
  return { ...DEFAULT_WEIGHTS, ...(getSetting('weights', {}) || {}) };
}

export function saveWeights(w) {
  setSetting('weights', w);
}

export function getLearningEnabled() {
  return getSetting('learning_enabled', true);
}

export function setLearningEnabled(v) {
  setSetting('learning_enabled', !!v);
}

// ---------------- learned weights ----------------
// Derive an "observed" weight profile by looking at:
//   - how much of a user's history is transition-driven
//   - how much is novel vs. repeat
//   - how concentrated plays are by hour
//   - how many skips there are
// This is a heuristic, not ML. It's deterministic and inspectable.
export function learnedWeights() {
  const totals = queryOne(`
    SELECT
      (SELECT COUNT(*) FROM listening_events WHERE event_type='START') AS plays,
      (SELECT COUNT(*) FROM listening_events WHERE event_type='SKIP')  AS skips,
      (SELECT COUNT(*) FROM transitions)                              AS trans,
      (SELECT COUNT(DISTINCT work_id) FROM listening_events)          AS distinct_works,
      (SELECT COUNT(*) FROM works)                                    AS total_works
  `) || {};

  const plays = Math.max(1, totals.plays || 0);
  const skips = totals.skips || 0;
  const trans = totals.trans || 0;
  const distinct = totals.distinct_works || 0;
  const total = Math.max(1, totals.total_works || 0);

  // ratio-based signals
  const transitionSignal = Math.min(1, trans / Math.max(1, plays * 0.5));
  const noveltySignal    = Math.min(1, distinct / total);
  const skipSignal       = Math.min(1, skips / plays);

  // hour concentration: how peaked the histogram is across hours
  const hours = queryAll(`
    SELECT substr(timestamp, 12, 2) AS h, COUNT(*) AS n
    FROM listening_events GROUP BY h
  `);
  const hourTotal = hours.reduce((a, b) => a + b.n, 0) || 1;
  const hourMax   = hours.reduce((a, b) => Math.max(a, b.n), 0);
  const timeSignal = Math.min(1, (hourMax / hourTotal) * 6); // 1/6 is uniform across 24h

  // Normalize to a 0..100 weight space. Keep the same total as defaults (100).
  const raw = {
    transition: 0.15 + transitionSignal * 0.70,
    novelty:    0.15 + noveltySignal    * 0.70,
    timeOfDay:  0.15 + timeSignal       * 0.70,
    skipPenalty:0.15 + skipSignal       * 0.70
  };
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  const normalized = {};
  for (const [k, v] of Object.entries(raw)) normalized[k] = Math.round((v / sum) * 100);

  return normalized;
}

// Hybrid: propose only if the learned weights differ meaningfully.
export function maybeProposeWeights() {
  const current = getWeights();
  const learned = learnedWeights();
  const diff = Object.keys(DEFAULT_WEIGHTS)
    .reduce((a, k) => a + Math.abs((current[k] || 0) - (learned[k] || 0)), 0);
  if (diff < 12) return null;      // close enough, stay silent
  const dismissed = getSetting('weights_prompt_dismissed_for', null);
  const sig = JSON.stringify(learned);
  if (dismissed === sig) return null;
  return { current, learned };
}

export function dismissWeightsPrompt(learned) {
  setSetting('weights_prompt_dismissed_for', JSON.stringify(learned));
}

// ---------------- scoring ----------------
// Score a candidate song given context. Returns { score, reasons }.
// Weights are on a 0..100 scale; contributions are weights * signal.
export function scoreCandidate({ candidate, currentWorkId, stats, transitionsFromCurrent, hourHistogram, nowMs }) {
  const w = getWeights();
  const reasons = {};

  // transition
  let transitionSignal = 0;
  if (currentWorkId && transitionsFromCurrent.has(candidate.id)) {
    const n = transitionsFromCurrent.get(candidate.id);
    const maxN = Math.max(...transitionsFromCurrent.values(), 1);
    transitionSignal = n / maxN;
  }
  reasons.transition = w.transition * transitionSignal;

  // novelty
  let noveltySignal = 1;
  if (stats?.last_played_at) {
    const last = Date.parse(stats.last_played_at + 'Z') || 0;
    const days = (nowMs - last) / 86400000;
    noveltySignal = Math.min(1, days / 14); // 0 if just played, 1 if 2+ weeks
  }
  reasons.novelty = w.novelty * noveltySignal;

  // time-of-day
  let timeSignal = 0;
  if (hourHistogram) {
    const hour = String(new Date().getHours()).padStart(2, '0');
    const total = Object.values(hourHistogram).reduce((a, b) => a + b, 0) || 1;
    timeSignal = (hourHistogram[hour] || 0) / total;
  }
  reasons.timeOfDay = w.timeOfDay * timeSignal;

  // skip penalty
  let skipSignal = 0;
  if (stats && stats.play_count > 0) {
    skipSignal = stats.skip_count / Math.max(1, stats.play_count);
  }
  reasons.skipPenalty = -w.skipPenalty * skipSignal;

  const score = reasons.transition + reasons.novelty + reasons.timeOfDay + reasons.skipPenalty;
  return { score, reasons };
}
