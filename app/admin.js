const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const status = (msg, ok = false) => { $('#status').textContent = msg; $('#status').style.color = ok ? '#1a8f2a' : '#c62828'; };

const TEXT = ['idLabel', 'accountDb', 'smartStudy', 'completionCode', 'completionUrl'];
const SELECT = ['login', 'registration'];
const CHECK = ['practice', 'attentionChecks', 'demographics', 'showScore', 'repeatable', 'fullscreen'];
let studies = [];

try { $('#api').value = localStorage.getItem('rai.admin.api') || ''; } catch { /* ignore */ }

function base() {
  const url = $('#api').value.trim().replace(/\/+$/, '');
  try { localStorage.setItem('rai.admin.api', url); } catch { /* ignore */ }
  return url;
}

async function api(method, path, body) {
  const res = await fetch(base() + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$('#token').value.trim()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += ' ' + JSON.stringify(await res.json()); } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res;
}

const table = (cols, rows) => `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

async function loadStudies() {
  status('Loading…');
  try {
    studies = await (await api('GET', '/admin/studies')).json();
    const link = (code) => `${location.origin}${location.pathname.replace(/admin\.html$/, '')}?study=${code}`;
    const options = (s) => ['attentionChecks', 'demographics', 'showScore', 'repeatable'].filter((k) => s.settings[k]).concat(s.settings.completionCode ? ['completionCode'] : []).join(', ') || 'none';
    $('#studies').innerHTML = studies.length
      ? table(['code', 'name', 'login', 'who', 'options', 'participants', 'completed', 'link', ''], studies.map((s) => [
        esc(s.code) + (s.active ? '' : ' (inactive)'), esc(s.label), esc(s.settings.login), esc(s.settings.registration), esc(options(s)),
        s.participants, s.completed, `<code>${esc(link(s.code))}</code>`, `<button class="small" data-edit="${esc(s.code)}">Edit</button>`,
      ]))
      : 'No studies yet. Create one below.';
    status(`${studies.length} studies`, true);
  } catch (e) { status(`Could not load studies: ${e.message}`); }
}

function editStudy(code) {
  const s = studies.find((x) => x.code === code);
  if (!s) return;
  $('#st-code').value = s.code;
  $('#st-label').value = s.label || '';
  $('#st-active').checked = s.active;
  for (const k of [...TEXT, ...SELECT]) $(`#st-${k}`).value = s.settings[k] ?? '';
  for (const k of CHECK) $(`#st-${k}`).checked = Boolean(s.settings[k]);
  $('#st-code').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveStudy() {
  const settings = {};
  for (const k of [...TEXT, ...SELECT]) settings[k] = $(`#st-${k}`).value.trim();
  for (const k of CHECK) settings[k] = $(`#st-${k}`).checked;
  if (!settings.idLabel) settings.idLabel = 'Participant ID';
  if (!settings.accountDb) settings.accountDb = 'DB';
  try {
    const saved = await (await api('PUT', '/admin/studies', { code: $('#st-code').value, label: $('#st-label').value || undefined, active: $('#st-active').checked, settings })).json();
    await loadStudies();
    status(`Saved study ${saved.code}`, true);
  } catch (e) { status(`Could not save the study: ${e.message}`); }
}

async function loadParticipants() {
  status('Loading…');
  try {
    const study = $('#p-study').value.trim();
    const rows = await (await api('GET', `/admin/participants${study ? `?study=${encodeURIComponent(study)}` : ''}`)).json();
    $('#participants').innerHTML = rows.length
      ? table(['study', 'participant', 'login', 'invited', 'started', 'completed', 'latest score', 'trials', 'last login', ''], rows.map((r) => [
        esc(r.study), esc(r.identifier), esc(r.source), r.invited ? 'yes' : '', r.started, r.completed, esc(r.latest_score ?? ''), r.trials, esc(r.last_login_at ?? ''),
        `<button class="small" data-delete="${r.id}" data-name="${esc(r.identifier)}">Delete</button>`,
      ]))
      : 'No participants yet.';
    status(`${rows.length} participants`, true);
  } catch (e) { status(`Could not load participants: ${e.message}`); }
}

async function addParticipants() {
  const identifiers = $('#p-new').value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!identifiers.length || !$('#p-study').value.trim()) { status('Enter a study code and at least one participant.'); return; }
  try {
    const out = await (await api('POST', '/admin/participants', { study: $('#p-study').value.trim(), identifiers })).json();
    await loadParticipants();
    status(`Added ${out.added.length}` + (out.errors.length ? `; not added: ${out.errors.map((e) => `${e.identifier} (${e.error})`).join(', ')}` : ''), !out.errors.length);
    if (!out.errors.length) $('#p-new').value = '';
  } catch (e) { status(`Could not add participants: ${e.message}`); }
}

async function deleteParticipant(id, name) {
  if (!confirm(`Permanently delete ${name} and all of their RAI data?`)) return;
  try {
    await api('DELETE', `/admin/participants?id=${id}`);
    await loadParticipants();
    status(`Deleted ${name}`, true);
  } catch (e) { status(`Could not delete: ${e.message}`); }
}

async function download(name) {
  status(`Exporting ${name}…`);
  try {
    const q = new URLSearchParams();
    if ($('#ex-study').value.trim()) q.set('study', $('#ex-study').value.trim());
    if ($('#ex-identifier').value.trim()) q.set('identifier', $('#ex-identifier').value.trim());
    if ($('#ex-since').value.trim()) q.set('since', $('#ex-since').value.trim());
    const blob = await (await api('GET', `/admin/export/${name}?${q}`)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rai-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    status(blob.size ? `Downloaded ${name}` : `No ${name} to export`, true);
  } catch (e) { status(`Export failed: ${e.message}`); }
}

$('#connect').addEventListener('click', loadStudies);
$('#st-save').addEventListener('click', saveStudy);
$('#st-clear').addEventListener('click', () => {
  for (const k of ['code', 'label', ...TEXT]) $(`#st-${k}`).value = '';
  $('#st-login').value = 'email';
  $('#st-registration').value = 'open';
  for (const k of CHECK) $(`#st-${k}`).checked = k === 'practice' || k === 'fullscreen';
  $('#st-active').checked = true;
});
$('#p-load').addEventListener('click', loadParticipants);
$('#p-add').addEventListener('click', addParticipants);
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset?.edit) editStudy(t.dataset.edit);
  if (t.dataset?.delete) deleteParticipant(t.dataset.delete, t.dataset.name);
  if (t.dataset?.export) download(t.dataset.export);
});
