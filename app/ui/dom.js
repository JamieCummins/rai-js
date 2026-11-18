/** Small DOM helpers; every screen renders into #screen. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Escape content text, keeping only the <br> line breaks used in the trial files. */
export const contentHtml = (s) => String(s ?? '').split(/\s*<br\s*\/?>\s*/i).map(escapeHtml).join('<br>');

/** Fill {placeholders} in a template string. Values are inserted as-is (they are trusted app strings). */
export function fill(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
}

export function render(html) {
  const root = $('#screen');
  root.innerHTML = html;
  root.scrollTop = 0;
  window.scrollTo(0, 0);
  return root;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isFullscreen = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);

function requestFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) { try { const p = fn.call(el); if (p?.catch) p.catch(() => {}); } catch { /* ignore */ } }
}

/**
 * Browsers only allow fullscreen in response to a click, so "automatic" means:
 * enter on the participant's next click, and re-enter on any later click if
 * they have left it. Does nothing where fullscreen is unsupported (e.g. iPhone).
 */
export const fullscreen = {
  active: isFullscreen,
  keep() {
    if (this.listener) return;
    this.listener = () => { if (!isFullscreen()) requestFullscreen(); };
    document.addEventListener('click', this.listener, true);
  },
  release() {
    if (this.listener) document.removeEventListener('click', this.listener, true);
    this.listener = null;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (isFullscreen() && exit) { try { const p = exit.call(document); if (p?.catch) p.catch(() => {}); } catch { /* ignore */ } }
  },
};
