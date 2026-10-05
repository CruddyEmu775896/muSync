import { saveQueue, loadQueue, clearQueue, reorderQueue } from '../library.js';

const state = {
  mode: 'smart',
  items: [],
  playingIndex: -1
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function render() {
  const list = document.getElementById('queue');
  const empty = document.getElementById('queue-empty');
  const summary = document.getElementById('queue-summary');
  if (!list) return;

  list.innerHTML = '';
  empty.style.display = state.items.length ? 'none' : 'block';
  summary.textContent = state.items.length
    ? `${state.items.length} in queue — mode: ${state.mode}`
    : '';

  state.items.forEach((it, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.index = String(i);
    li.innerHTML = `
      <span class="grip" title="drag to reorder">⋮⋮</span>
      <span class="q-title">
        <strong>${esc(it.title)}</strong>
        ${it.reason ? `<span class="reason">score ${it.reason.score ?? '?'}</span>` : ''}
      </span>
      <button class="small" data-remove="${i}">×</button>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = () => {
      state.items.splice(Number(btn.dataset.remove), 1);
      save();
      render();
    };
  });

  wireDrag();
}

function wireDrag() {
  const list = document.getElementById('queue');
  let dragFrom = null;

  list.querySelectorAll('li').forEach(li => {
    li.addEventListener('dragstart', e => {
      dragFrom = Number(li.dataset.index);
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      list.querySelectorAll('li').forEach(x => x.classList.remove('drop-target'));
    });
    li.addEventListener('dragover', e => {
      e.preventDefault();
      li.classList.add('drop-target');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
    li.addEventListener('drop', e => {
      e.preventDefault();
      const to = Number(li.dataset.index);
      if (dragFrom === null || dragFrom === to) return;
      const [moved] = state.items.splice(dragFrom, 1);
      state.items.splice(to, 0, moved);
      save();
      render();
    });
  });
}

function save() {
  saveQueue(state.mode, state.items);
}

export function setQueue(mode, items) {
  state.mode = mode;
  state.items = items.slice();
  save();
  render();
}

export function getQueue() { return { mode: state.mode, items: state.items.slice() }; }

export function clearQueueUI() {
  state.items = [];
  clearQueue();
  render();
}

export function markPlaying(index) {
  state.playingIndex = index;
}

export function restoreQueue() {
  const q = loadQueue();
  if (q) {
    state.mode = q.mode;
    state.items = q.items;
  }
  render();
}

export function initQueue() {
  document.getElementById('queue-clear').onclick = clearQueueUI;
  render();
}
