// Library list rendering + inline edit.

import { listSongs, updateSong, deleteSongs } from '../library.js';

const state = {
  search: '',
  sort: 'added-desc',
  editingId: null
};

export function setSearch(v) { state.search = v; renderLibrary(); }
export function setSort(v)   { state.sort = v; renderLibrary(); }
export function startEdit(id) { state.editingId = id; renderLibrary(); }
export function cancelEdit()  { state.editingId = null; renderLibrary(); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function filterAndSort(rows) {
  const q = state.search.trim().toLowerCase();
  let list = rows;
  if (q) {
    list = rows.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.artist || '').toLowerCase().includes(q)
    );
  }
  const s = list.slice();
  switch (state.sort) {
    case 'added-asc':  s.sort((a,b) => (a.createdAt||'').localeCompare(b.createdAt||'')); break;
    case 'added-desc': s.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||'')); break;
    case 'title-asc':  s.sort((a,b) => (a.title||'').localeCompare(b.title||'')); break;
    case 'title-desc': s.sort((a,b) => (b.title||'').localeCompare(a.title||'')); break;
    case 'artist-asc': s.sort((a,b) => (a.artist||'').localeCompare(b.artist||'')); break;
    case 'artist-desc':s.sort((a,b) => (b.artist||'').localeCompare(a.artist||'')); break;
    case 'manual':     s.sort((a,b) => (a.playlistPosition||0) - (b.playlistPosition||0)); break;
  }
  return s;
}

export function renderLibrary({ onPlay, onAttach, onWhy, onDelete } = {}) {
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  const summary = document.getElementById('library-summary');
  if (!list) return;

  const all = listSongs();
  const visible = filterAndSort(all);

  list.innerHTML = '';
  empty.style.display = visible.length ? 'none' : 'block';

  if (all.length === 0) summary.textContent = '';
  else if (visible.length === all.length) summary.textContent = `${all.length} song${all.length === 1 ? '' : 's'}`;
  else summary.textContent = `${visible.length} of ${all.length} songs`;

  for (const s of visible) {
    const li = document.createElement('li');

    if (state.editingId === s.id) {
      li.innerHTML = `
        <div style="flex:1; display:grid; gap:6px">
          <input id="edit-title-${s.id}" value="${escapeHtml(s.title)}" placeholder="Title" />
          <input id="edit-artist-${s.id}" value="${escapeHtml(s.rawArtist)}" placeholder="Artist ; Artist" />
        </div>
        <div style="display:flex; gap:6px; align-items:flex-start">
          <button class="small" data-save="${s.id}">Save</button>
          <button class="small" data-cancel="1">Cancel</button>
        </div>
      `;
      list.appendChild(li);
      li.querySelector(`[data-save="${s.id}"]`).onclick = () => {
        const t = document.getElementById(`edit-title-${s.id}`).value;
        const a = document.getElementById(`edit-artist-${s.id}`).value;
        try { updateSong(s.id, t, a); } catch (e) { alert(e.message); return; }
        cancelEdit();
      };
      li.querySelector('[data-cancel]').onclick = cancelEdit;
      continue;
    }

    const dupBadge = s.dupCount > 1 ? `<span class="dup-badge">dup ×${s.dupCount}</span>` : '';
    li.innerHTML = `
      <span class="row-title">
        <strong>${escapeHtml(s.title)}</strong>${dupBadge}
        <span class="muted"> — ${escapeHtml(s.artist || '')}</span>
      </span>
      <span class="row-actions">
        <button class="small" data-why="${s.id}">Why</button>
        <button class="small" data-edit="${s.id}">Edit</button>
        ${s.fileId ? `<button class="small" data-play="${s.fileId}">Play</button>` : ''}
        <button class="small" data-attach="${s.recordingId}">${s.fileId ? 'Replace' : 'Attach'}</button>
        ${s.fileId ? `<button class="small" data-detach="${s.recordingId}">Detach</button>` : ''}
        <button class="small danger" data-delete="${s.id}">Delete</button>
      </span>
    `;
    list.appendChild(li);

    li.querySelector('[data-edit]').onclick   = () => startEdit(s.id);
    li.querySelector('[data-why]').onclick    = () => onWhy?.(s.id, s.title);
    if (onAttach) li.querySelector('[data-attach]').onclick = () => onAttach(s.recordingId);
    if (onPlay && s.fileId) {
      li.querySelector('[data-play]').onclick = () => onPlay(s.fileId, s.title, s.artist, s.id, s.recordingId);
    }
    if (onDelete) li.querySelector('[data-delete]').onclick = () => onDelete(s.id, s.title);
  }
}

export function currentEditingId() { return state.editingId; }
