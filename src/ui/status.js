export function setStatus(msg, kind = 'info') {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
  el.dataset.kind = kind;
}
