import { libraryTotals, topTransitions, hourHistogram, songStats, transitionsInto } from '../library.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

export function renderKnowledge() {
  const el = document.getElementById('knowledge');
  if (!el) return;

  const t = libraryTotals() || {};
  const trans = topTransitions(10) || [];
  const hours = hourHistogram() || [];

  el.innerHTML = `
    <div class="knowledge-block">
      <h3>Totals</h3>
      <div class="knowledge-row"><span class="label">Songs in library</span><span class="value">${t.songs || 0}</span></div>
      <div class="knowledge-row"><span class="label">Playback events recorded</span><span class="value">${t.events || 0}</span></div>
      <div class="knowledge-row"><span class="label">Playback sessions</span><span class="value">${t.sessions || 0}</span></div>
      <div class="knowledge-row"><span class="label">Completed plays</span><span class="value">${t.completes || 0}</span></div>
      <div class="knowledge-row"><span class="label">Skipped plays</span><span class="value">${t.skips || 0}</span></div>
      <div class="knowledge-row"><span class="label">Manual selections</span><span class="value">${t.manuals || 0}</span></div>
      <div class="knowledge-row"><span class="label">Transitions learned</span><span class="value">${t.transitions || 0}</span></div>
    </div>

    <div class="knowledge-block">
      <h3>Transitions I have seen (top 10)</h3>
      ${trans.length
        ? trans.map(r => `<div class="knowledge-row"><span class="label">${esc(r.from_title || '?')} → ${esc(r.to_title || '?')}</span><span class="value">${r.count}×</span></div>`).join('')
        : '<div class="knowledge-row"><span class="label">Nothing yet. Play some songs.</span></div>'}
    </div>

    <div class="knowledge-block">
      <h3>When you listen</h3>
      ${hours.length
        ? hours.map(r => `<div class="knowledge-row"><span class="label">${esc(r.hour)}:00</span><span class="value">${r.n} plays</span></div>`).join('')
        : '<div class="knowledge-row"><span class="label">No listening data yet.</span></div>'}
    </div>
  `;
}

export function showWhy(workId, title) {
  const el = document.getElementById('knowledge');
  if (!el) return;

  const stats = songStats(workId) || {};
  const into = transitionsInto(workId, 5) || [];

  el.innerHTML = `
    <div class="knowledge-block">
      <h3>Why this song? — ${esc(title)}</h3>
      <div class="knowledge-row"><span class="label">Total plays</span><span class="value">${stats.play_count || 0}</span></div>
      <div class="knowledge-row"><span class="label">Completed</span><span class="value">${stats.complete_count || 0}</span></div>
      <div class="knowledge-row"><span class="label">Skipped</span><span class="value">${stats.skip_count || 0}</span></div>
      <div class="knowledge-row"><span class="label">Manually chosen</span><span class="value">${stats.manual_count || 0}</span></div>
      <div class="knowledge-row"><span class="label">Last played</span><span class="value">${stats.last_played_at || 'never'}</span></div>
    </div>
    <div class="knowledge-block">
      <h3>What usually plays before this</h3>
      ${into.length
        ? into.map(r => `<div class="knowledge-row"><span class="label">${esc(r.from_title || 'unknown')}</span><span class="value">${r.count}×</span></div>`).join('')
        : '<div class="knowledge-row"><span class="label">No transition data yet.</span></div>'}
    </div>
  `;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
