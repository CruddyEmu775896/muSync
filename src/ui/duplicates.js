import { findDuplicates, deleteSongs } from '../library.js';

let visible = false;
let fuzzy = false;

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function render() {
  const listEl = document.getElementById('dupes-list');
  const statusEl = document.getElementById('dupes-status');
  if (!listEl) return;

  const groups = findDuplicates({ fuzzy });
  listEl.innerHTML = '';

  if (!groups.length) {
    statusEl.textContent = fuzzy ? 'No near-duplicates found.' : 'No exact duplicates found.';
    return;
  }

  statusEl.textContent = `${groups.length} duplicate group${groups.length === 1 ? '' : 's'}.`;

  for (const g of groups) {
    const div = document.createElement('div');
    div.className = 'dupe-group';
    div.innerHTML = `
      <h4>${esc(g.members[0].title)} — ${g.members.length} copies</h4>
      ${g.members.map(m => `
        <label class="dupe-member">
          <input type="checkbox" data-wid="${m.id}" />
          <span class="dm-title">
            <strong>${esc(m.title)}</strong>
            <span class="muted"> — ${esc(m.artist || '')}</span>
            ${m.fileId ? ' <span class="muted">[audio]</span>' : ''}
          </span>
          <span class="dm-added">${esc((m.createdAt || '').slice(0,10))}</span>
        </label>
      `).join('')}
    `;
    listEl.appendChild(div);
  }
}

export function initDuplicates() {
  const showToggle = document.getElementById('dupes-show');
  const controls   = document.getElementById('dupes-controls');
  const fuzzyBox   = document.getElementById('dupes-fuzzy');
  const rescan     = document.getElementById('dupes-rescan');
  const delBtn     = document.getElementById('dupes-delete');

  showToggle.onchange = () => {
    visible = showToggle.checked;
    controls.hidden = !visible;
    if (visible) render();
  };

  fuzzyBox.onchange = () => {
    fuzzy = fuzzyBox.checked;
    render();
  };

  rescan.onclick = render;

  delBtn.onclick = () => {
    const checked = Array.from(document.querySelectorAll('#dupes-list input[type=checkbox]:checked'));
    const ids = checked.map(c => c.dataset.wid);
    if (!ids.length) { alert('Select at least one song to delete.'); return; }
    if (!confirm(`Delete ${ids.length} song${ids.length === 1 ? '' : 's'}?`)) return;
    deleteSongs(ids);
    render();
  };
}

export function refreshDuplicates() {
  if (visible) render();
}
