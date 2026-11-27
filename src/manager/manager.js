/* Página "Descargas": muestra el estado de los trabajos que ejecuta el background (storage.session "jobsState").
 * Se puede cerrar y volver a abrir: las descargas siguen y el historial de la sesión se conserva. */
'use strict';

const { util, t } = window.FFVD;
window.FFVD.localize();
const STORE_KEY = 'jobsState';
const DEFAULT_SETTINGS = { minSizeKB: 300, concurrency: 6, convert: true, maxJobs: 5 };

const $jobs = document.getElementById('jobs');
const $empty = document.getElementById('empty');
const tpl = document.getElementById('jobTpl');
window.FFVD.localize(tpl.content);
const views = new Map(); // id → elemento

const send = (msg) => browser.runtime.sendMessage(msg);

function timeOf(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function createView(it) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.querySelector('.cancel').addEventListener('click', () => send({ type: 'jobCancel', id: it.id }));
  el.querySelector('.retry').addEventListener('click', () => send({ type: 'jobRetry', id: it.id }));
  el.querySelector('.show').addEventListener('click', () => {
    const id = Number(el.dataset.downloadId);
    if (el.dataset.downloadId) browser.downloads.show(id).catch(() => alert(t('file_missing')));
  });
  return el;
}

function updateView(el, it) {
  el.dataset.state = it.state;
  el.querySelector('.job-title').textContent = it.job.filename;
  el.querySelector('.job-kind').textContent = it.kindLabel;
  el.querySelector('.job-time').textContent = timeOf(it.createdAt);
  el.querySelector('.job-status').textContent = it.text || '';
  const bar = el.querySelector('progress');
  if (it.progress == null) bar.removeAttribute('value');
  else bar.value = it.progress;
  bar.hidden = it.state === 'done' || it.state === 'error' || it.state === 'cancelled';
  const active = it.state === 'queued' || it.state === 'running';
  el.querySelector('.cancel').hidden = !active;
  el.querySelector('.retry').hidden = !(it.state === 'error' || it.state === 'cancelled');
  el.querySelector('.show').hidden = !(it.state === 'done' && it.downloadId != null);
  if (it.downloadId != null) el.dataset.downloadId = String(it.downloadId);
  else delete el.dataset.downloadId;
  const pre = el.querySelector('.job-log');
  pre.textContent = it.log || '';
  pre.hidden = !it.log;
}

function render(list) {
  list = (list || []).slice().sort((a, b) => b.createdAt - a.createdAt); // lo más nuevo arriba
  const seen = new Set();
  let prev = null;
  for (const it of list) {
    seen.add(it.id);
    let el = views.get(it.id);
    if (!el) { el = createView(it); views.set(it.id, el); }
    updateView(el, it);
    // Mantener el orden sin recrear nodos.
    const want = prev ? prev.nextElementSibling : $jobs.firstElementChild;
    if (want !== el) $jobs.insertBefore(el, want);
    prev = el;
  }
  for (const [id, el] of views) if (!seen.has(id)) { el.remove(); views.delete(id); }
  $empty.hidden = list.length > 0;
  const active = list.filter((it) => it.state === 'queued' || it.state === 'running').length;
  document.title = active ? `(${active}) ${t('manager_title')}` : t('manager_title');
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[STORE_KEY]) render(changes[STORE_KEY].newValue);
  if (area === 'local' && changes.settings) fillSettings({ ...DEFAULT_SETTINGS, ...changes.settings.newValue });
});

document.getElementById('clearDone').addEventListener('click', () => send({ type: 'jobsClearDone' }));

// ---------- Opciones ----------

const form = document.getElementById('settings');
function fillSettings(s) {
  if (document.activeElement && form.contains(document.activeElement)) return;
  form.minSizeMB.value = Math.round(((s.minSizeKB || 0) / 1024) * 100) / 100;
  form.concurrency.value = s.concurrency;
  form.maxJobs.value = s.maxJobs;
  form.convert.checked = s.convert;
}
form.addEventListener('change', async () => {
  const cur = (await browser.storage.local.get('settings')).settings || {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...cur,
    minSizeKB: Math.max(0, Math.round((parseFloat(form.minSizeMB.value) || 0) * 1024)),
    concurrency: Math.max(1, Math.min(16, parseInt(form.concurrency.value, 10) || 6)),
    maxJobs: Math.max(1, Math.min(20, parseInt(form.maxJobs.value, 10) || 5)),
    convert: form.convert.checked,
  };
  await browser.storage.local.set({ settings });
  const msg = document.getElementById('savedMsg');
  msg.hidden = false;
  setTimeout(() => { msg.hidden = true; }, 1500);
});

// ---------- Inicio ----------

(async () => {
  const s = await browser.storage.local.get('settings');
  fillSettings({ ...DEFAULT_SETTINGS, ...(s.settings || {}) });
  const st = await browser.storage.session.get(STORE_KEY);
  render(st[STORE_KEY]);
})();
