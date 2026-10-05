import {
  getWeights, saveWeights, DEFAULT_WEIGHTS,
  maybeProposeWeights, dismissWeightsPrompt,
  getLearningEnabled, setLearningEnabled
} from '../algorithm.js';

const ROWS = [
  ['transition',  'Transition strength', 'How strongly A → B has happened in your history.'],
  ['novelty',     'Novelty boost',       'Rewards songs you have not heard recently.'],
  ['timeOfDay',   'Time-of-day match',   'Rewards songs you usually play at this hour.'],
  ['skipPenalty', 'Skip penalty',        'Penalizes songs you tend to skip.']
];

export function renderWeights() {
  const el = document.getElementById('weights');
  if (!el) return;
  const w = getWeights();

  el.innerHTML = ROWS.map(([key, name, desc]) => `
    <div class="weight-row">
      <div>
        <div class="name">${name}</div>
        <div class="desc">${desc}</div>
      </div>
      <input type="number" min="0" max="100" step="1" data-weight="${key}" value="${w[key] ?? 0}" />
    </div>
  `).join('');

  updateLearnButton();
}

function readFromUI() {
  const w = {};
  document.querySelectorAll('[data-weight]').forEach(i => {
    w[i.dataset.weight] = Number(i.value) || 0;
  });
  return w;
}

function updateLearnButton() {
  const btn = document.getElementById('learn-toggle');
  if (!btn) return;
  const on = getLearningEnabled();
  btn.textContent = `Learning: ${on ? 'on' : 'off'}`;
}

function flashStatus(msg) {
  const el = document.getElementById('weights-status');
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 2000);
}

export function checkLearnProposal() {
  const el = document.getElementById('weights-prompt');
  if (!el) return;
  if (!getLearningEnabled()) { el.hidden = true; return; }

  const p = maybeProposeWeights();
  if (!p) { el.hidden = true; return; }

  el.hidden = false;
  el.innerHTML = `
    <strong>The algorithm thinks it learned something.</strong>
    <div class="knowledge-row"><span class="label">Current</span><span class="value">${JSON.stringify(p.current)}</span></div>
    <div class="knowledge-row"><span class="label">Suggested</span><span class="value">${JSON.stringify(p.learned)}</span></div>
    <div class="actions">
      <button class="small" id="prompt-accept">Accept</button>
      <button class="small" id="prompt-dismiss">Dismiss this suggestion</button>
    </div>
  `;
  el.querySelector('#prompt-accept').onclick = () => {
    saveWeights(p.learned);
    renderWeights();
    el.hidden = true;
    flashStatus('Applied learned weights.');
  };
  el.querySelector('#prompt-dismiss').onclick = () => {
    dismissWeightsPrompt(p.learned);
    el.hidden = true;
  };
}

export function initWeights() {
  document.getElementById('save-weights').onclick = () => {
    saveWeights(readFromUI());
    flashStatus('Saved.');
  };
  document.getElementById('reset-weights').onclick = () => {
    saveWeights({ ...DEFAULT_WEIGHTS });
    renderWeights();
    flashStatus('Reset to defaults.');
  };
  document.getElementById('learn-toggle').onclick = () => {
    setLearningEnabled(!getLearningEnabled());
    updateLearnButton();
    checkLearnProposal();
  };
  renderWeights();
}
