import { $, $$, render, fill, escapeHtml, contentHtml, sleep } from './dom.js';

const LOGO = '<img src="static/logo.png" class="logo" alt="">';

const page = (body, footer = '') => `<div class="page">${LOGO}<div class="text">${body}</div>${footer}</div>`;
const button = (label, cls = '') => `<button type="submit" class="primary ${cls}">${escapeHtml(label)}</button>`;

/**
 * A text screen with one button; resolves with 'button' when it is clicked.
 * `link` adds a second, less prominent choice below it, which resolves with 'link'.
 */
export function message({ html, button: label, link }) {
  return new Promise((resolve) => {
    const alt = link ? `<button type="button" class="link" id="alt">${escapeHtml(link)}</button>` : '';
    const root = render(page(html, label ? `<div class="actions"><button type="button" class="primary" id="go">${escapeHtml(label)}</button></div>${alt}` : ''));
    if (label) $('#go', root).addEventListener('click', () => resolve('button'), { once: true });
    if (label && link) $('#alt', root).addEventListener('click', () => resolve('link'), { once: true });
  });
}

export function loading(strings) {
  render(`<div class="page"><div class="text centered">${escapeHtml(strings.ui.loading)}</div></div>`);
}

/**
 * A form screen. `fields` is [{name, label, type, attrs}]; `onSubmit(values)`
 * may throw an error with a `.code`, whose message is then shown under the form.
 * Resolves with whatever onSubmit returns.
 */
export function form({ strings, intro, fields, submit, onSubmit, links = [], note = '' }) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) => `
      <label>${escapeHtml(f.label)}
        <input name="${f.name}" type="${f.type || 'text'}" required ${f.attrs || ''} value="${escapeHtml(f.value || '')}">
      </label>`).join('');
    const extra = links.map((l, i) => `<button type="button" class="link" data-link="${i}">${escapeHtml(l.label)}</button>`).join('');
    const root = render(page(intro, `
      <form class="form" novalidate>
        ${inputs}
        ${note ? `<p class="note">${note}</p>` : ''}
        <p class="error" role="alert" hidden></p>
        <div class="actions">${button(submit)}</div>
        ${extra}
      </form>`));
    const el = $('form', root);
    const error = $('.error', root);
    $('input', root)?.focus();
    links.forEach((l, i) => $(`[data-link="${i}"]`, root).addEventListener('click', () => resolve(l.value)));
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(el));
      for (const k of Object.keys(values)) values[k] = String(values[k]).trim();
      const btn = $('button[type=submit]', root);
      error.hidden = true;
      btn.disabled = true;
      try {
        resolve(await onSubmit(values));
      } catch (err) {
        error.textContent = strings.errors[err.code] || strings.errors.server;
        error.hidden = false;
        btn.disabled = false;
      }
    });
  });
}

export async function fixation(ms) {
  if (ms <= 0) return;
  render('<div class="fixation">+</div>');
  await sleep(ms);
}

/**
 * Present one trial. Resolves with { selected: [option indexes], rtMs, timedOut }
 * when the participant submits or the time limit runs out.
 */
export function trial({ trial: t, progress, strings, config }) {
  return new Promise((resolve) => {
    const limitMs = config.trial.timeoutMs;
    const options = t.options.map((o, i) => `<button type="button" class="option" data-i="${i}" aria-pressed="false">${contentHtml(o.text)}</button>`).join('');
    const root = render(`
      <div class="trial">
        <header class="trial-head">
          <div></div>
          <div class="progress">${escapeHtml(progress)}</div>
          <div class="timer-slot">${config.trial.showTimer && limitMs > 0 ? '<div class="timer" id="timer"></div>' : ''}</div>
        </header>
        <div class="premises">${t.premises.map((p) => `<div>${contentHtml(p)}</div>`).join('')}</div>
        <div class="question">${fill(strings.trial.question, { probe: t.probe })}</div>
        <div class="options n${t.options.length}">${options}</div>
        <div class="actions"><button type="button" class="primary" id="submit">${escapeHtml(strings.ui.submit)}</button></div>
      </div>`);
    const started = performance.now();
    const submit = $('#submit', root);
    const timer = $('#timer', root);
    const selected = () => $$('.option[aria-pressed="true"]', root).map((b) => Number(b.dataset.i));
    const refresh = () => { if (config.trial.requireSelection) submit.disabled = selected().length === 0; };
    for (const b of $$('.option', root)) {
      b.addEventListener('click', () => { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); refresh(); });
    }
    refresh();

    let done = false;
    let tick = null;
    let timeout = null;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      clearTimeout(timeout);
      resolve({ selected: selected(), rtMs: Math.round(performance.now() - started), timedOut: timedOut ? 1 : 0 });
    };
    submit.addEventListener('click', () => finish(false));
    if (limitMs > 0) {
      const show = () => { if (timer) timer.textContent = Math.max(0, Math.ceil((limitMs - (performance.now() - started)) / 1000)); };
      show();
      tick = setInterval(show, 250);
      timeout = setTimeout(() => finish(true), limitMs);
    }
  });
}

export function completion({ strings, text, score, code, url, onDownload }) {
  const parts = [`<p>${text}</p>`];
  if (score) parts.push(`<p>${fill(strings.score, score)}</p>`);
  if (code) parts.push(`<p>${fill(strings.completionCode, { code: escapeHtml(code) })}</p>`);
  if (url) parts.push(`<p><a class="primary" href="${escapeHtml(url)}">${escapeHtml(strings.completionLink)}</a></p>`);
  else parts.push(`<p>${strings.closePage}</p>`);
  if (onDownload) parts.push(`<p><button type="button" class="link" id="download">${escapeHtml(strings.ui.download)}</button></p>`);
  const root = render(page(parts.join('')));
  if (onDownload) $('#download', root).addEventListener('click', onDownload);
}

export function fatal(text) {
  render(page(`<p>${text}</p>`));
}
