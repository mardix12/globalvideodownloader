/* Popup: lista los medios detectados en la pestaña activa y arma los trabajos de descarga. */
'use strict';

const { util, formats, t, isChrome } = window.FFVD;
window.FFVD.localize();
const $ = (id) => document.getElementById(id);

let tab = null;
let state = null;
let includeHidden = false;
const selections = new Map(); // id de medio → { v, a } elegidos por el usuario
const names = new Map(); // id de medio → nombre de archivo escrito por el usuario

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.textContent = ''; }, 2500);
}

async function copy(text, what = t('toast_copied')) {
  await navigator.clipboard.writeText(text);
  toast(what);
}

const send = (msg) => browser.runtime.sendMessage(msg);

// ---------- Datos ----------

async function refresh() {
  state = await send({ type: 'getTab', tabId: tab.id, includeHidden });
  render();
}

function baseName() {
  return util.sanitizeFilename(tab.title || 'video', 120);
}

function fileNameFromUrl(url) {
  try {
    const p = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return p || url;
  } catch (e) {
    return url;
  }
}

function variantLabel(v, duration) {
  const parts = [];
  parts.push(v.height ? formats.qualityLabel(v.height, v.width) : (v.bandwidth ? '' : 'Variante'));
  if (v.frameRate && parseFloat(v.frameRate) > 30) parts.push(`${Math.round(parseFloat(v.frameRate))}fps`);
  if (v.bandwidth) parts.push(util.humanBitrate(v.bandwidth));
  if (v.codecs) parts.push(formats.codecLabel(v.codecs));
  if (v.bandwidth && duration) parts.push(`~${util.humanSize((v.bandwidth * duration) / 8)}`);
  return parts.filter(Boolean).join(' · ');
}

function ytdlpCommand(url, referer) {
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  return `yt-dlp ${referer ? `--referer ${q(referer)} ` : ''}${q(url)}`;
}

// ---------- Filtro por tamaño ----------

const SIZE_PRESETS_KB = [0, 100, 300, 512, 1024, 2048, 5120, 10240, 51200, 102400];

function renderSizeFilter() {
  const sel = $('minSize');
  if (document.activeElement === sel) return;
  const cur = (state.settings && state.settings.minSizeKB) || 0;
  const values = SIZE_PRESETS_KB.includes(cur) ? SIZE_PRESETS_KB : [...SIZE_PRESETS_KB, cur].sort((a, b) => a - b);
  if (sel.dataset.values !== values.join(',')) {
    sel.textContent = '';
    for (const kb of values) sel.append(h('option', { value: String(kb) }, kb ? util.humanSize(kb * 1024) : t('size_none')));
    sel.dataset.values = values.join(',');
  }
  sel.value = String(cur);
}

$('minSize').addEventListener('change', async () => {
  const cur = (await browser.storage.local.get('settings')).settings || {};
  await browser.storage.local.set({ settings: { ...cur, minSizeKB: parseInt($('minSize').value, 10) || 0 } });
  $('minSize').blur();
  setTimeout(refresh, 150); // dar tiempo a que el background reciba la nueva opción
});

// ---------- Render ----------

function render() {
  renderSizeFilter();
  $('openManager').textContent = state.activeJobs ? t('btn_downloadsN', state.activeJobs) : t('btn_downloads');
  const list = $('list');
  list.textContent = '';

  // DRM
  const drm = state.drm || state.media.some((m) => m.drm);
  $('drm').hidden = !drm;
  if (drm) {
    $('drm').textContent = t('drm_banner', state.drm ? ` (${state.drm.keySystem})` : '');
  }

  // Sitios especiales
  // Chrome: aviso neutro en YouTube (ahí la extensión no funciona, por política de la Chrome Web Store).
  $('blocked').hidden = !state.blocked;
  $('special').hidden = !state.special;
  if (state.special === 'youtube') {
    $('special').textContent = '';
    $('special').append(
      `${t('yt_banner')} `,
      h('button', { class: 'link', onclick: () => copy(`yt-dlp "${state.pageUrl || tab.url}"`, t('toast_ytdlpCopied')) }, t('btn_copyYtdlpPage')),
    );
  }

  const visible = state.media;
  if (!visible.length) {
    list.append(h('p', { class: 'empty muted' }, t('empty_list')));
  }
  for (const m of visible) list.append(renderItem(m));

  // Ocultos
  const sh = $('showHidden');
  sh.hidden = !state.hiddenCount && !includeHidden;
  sh.textContent = includeHidden ? t('hide_small') : t('show_small', state.hiddenCount);

  renderMse();
}

function badge(text, cls = '') {
  return h('span', { class: `tag ${cls}` }, text);
}

function renderItem(m) {
  const sel = selections.get(m.id) || {};
  const card = h('article', { class: 'card item' });
  const kindLabel = m.kind === 'direct' ? (m.ext || 'video').toUpperCase() : m.kind.toUpperCase();

  // Nombre con el que se va a guardar (editable). El nombre de la URL queda abajo, como referencia.
  const nameInput = h('input', {
    type: 'text', class: 'item-name', spellcheck: false, 'aria-label': t('name_aria'),
    title: t('name_title'),
    oninput: (e) => { if (e.target.value.trim()) names.set(m.id, e.target.value); else names.delete(m.id); },
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
  });
  nameInput.value = names.has(m.id) ? names.get(m.id) : fileNameFor(m, null);
  const source = h('div', { class: 'item-source muted small', title: [m.url, m.altUrl].filter(Boolean).join('\n') },
    `${m.kind === 'direct' ? '' : `${kindLabel} · `}${fileNameFromUrl(m.url)}${m.altUrl ? ` ${t('alt_url')}` : ''}`);

  const meta = [badge(kindLabel, `k-${m.kind}`)];
  if (m.mediaType === 'audio') meta.push(badge(t('word_audio')));
  if (m.size) meta.push(badge(util.humanSize(m.size)));
  if (m.height) meta.push(badge(formats.qualityLabel(m.height, m.width)));
  if (m.duration) meta.push(badge(util.humanDuration(m.duration)));
  if (m.live) meta.push(badge(t('badge_live'), 'live'));
  if (m.encryption === 'aes-128') meta.push(badge('AES-128'));
  if (m.drm) meta.push(badge('DRM', 'drm'));
  if (m.hidden) meta.push(badge(t('badge_small'), 'muted'));

  card.append(
    h('div', { class: 'item-title' }, nameInput, m.kind === 'direct' && h('span', { class: 'item-ext muted' }, `.${m.ext || 'mp4'}`)),
    source,
    h('div', { class: 'meta' }, meta),
  );

  if (m.status === 'parsing') {
    card.append(h('p', { class: 'muted small' }, t('parsing')));
    return card;
  }
  if (m.status === 'error') {
    card.append(
      h('p', { class: 'error small' }, t('parse_error', m.error)),
      h('div', { class: 'actions' },
        h('button', { class: 'ghost', onclick: async () => { await send({ type: 'reparse', tabId: tab.id, id: m.id }); refresh(); } }, t('btn_retry')),
        h('button', { class: 'ghost', onclick: () => copy(m.url, t('toast_urlCopied')) }, t('btn_copyUrl'))),
    );
    return card;
  }

  let vSelect = null;
  let aSelect = null;

  if (m.kind === 'hls' && m.variants && m.variants.length) {
    vSelect = h('select', { 'aria-label': t('aria_videoQuality'), onchange: () => { saveSel(); updateAudioOptions(); } },
      m.variants.map((v, i) => h('option', { value: String(i) }, variantLabel(v, m.duration))));
    if (m.audioTracks && m.audioTracks.length) {
      aSelect = h('select', { 'aria-label': t('aria_audioTrack'), onchange: saveSel });
    }
    vSelect.value = sel.v != null ? sel.v : '0';
  }

  if (m.kind === 'dash') {
    if (m.dashVideo && m.dashVideo.length) {
      vSelect = h('select', { 'aria-label': t('aria_videoQuality'), onchange: saveSel },
        m.dashVideo.map((r, i) => h('option', { value: String(i) }, variantLabel(r, m.duration))),
        h('option', { value: 'none' }, t('opt_noVideo')));
      vSelect.value = sel.v != null ? sel.v : '0';
    }
    if (m.dashAudio && m.dashAudio.length) {
      aSelect = h('select', { 'aria-label': t('aria_audioTrack'), onchange: saveSel },
        m.dashAudio.map((r, i) => h('option', { value: String(i) },
          [r.label || r.lang || 'Audio', util.humanBitrate(r.bandwidth), formats.codecLabel(r.codecs)].filter(Boolean).join(' · '))),
        h('option', { value: 'none' }, 'Sin audio'));
      aSelect.value = sel.a != null ? sel.a : '0';
    }
  }

  function updateAudioOptions() {
    if (!aSelect || m.kind !== 'hls') return;
    const v = m.variants[parseInt(vSelect.value, 10)] || m.variants[0];
    const tracks = m.audioTracks.filter((a) => !v.audioGroup || a.groupId === v.audioGroup);
    const list = tracks.length ? tracks : m.audioTracks;
    const prev = aSelect.value;
    aSelect.textContent = '';
    list.forEach((a) => aSelect.append(h('option', { value: a.url }, [a.name, a.lang].filter(Boolean).join(' · ') || t('word_audioCap'))));
    aSelect.append(h('option', { value: 'muxed' }, t('opt_muxedAudio')));
    const def = list.find((a) => a.default) || list[0];
    aSelect.value = [...aSelect.options].some((o) => o.value === (sel.a || prev)) ? (sel.a || prev) : (def ? def.url : 'muxed');
  }
  updateAudioOptions();

  function saveSel() {
    selections.set(m.id, { v: vSelect ? vSelect.value : null, a: aSelect ? aSelect.value : null });
    if (!names.has(m.id)) nameInput.value = fileNameFor(m, vSelect); // la calidad va en el nombre
  }
  if (!names.has(m.id)) nameInput.value = fileNameFor(m, vSelect);

  if (vSelect || aSelect) {
    card.append(h('div', { class: 'selects' },
      vSelect && h('label', {}, h('span', { class: 'muted small' }, t('word_videoCap')), vSelect),
      aSelect && h('label', {}, h('span', { class: 'muted small' }, t('word_audioCap')), aSelect)));
  }

  const dlBtn = h('button', { class: 'primary', disabled: !!m.drm, onclick: () => download(m, vSelect, aSelect) }, m.drm ? t('btn_protected') : t('btn_download'));
  card.append(h('div', { class: 'actions' },
    dlBtn,
    h('button', { class: 'ghost', onclick: () => copy(m.url, t('toast_urlCopied')) }, t('btn_copyUrl')),
    m.kind !== 'direct' && !isChrome && h('button', { class: 'ghost', title: t('ytdlp_title'), onclick: () => copy(ytdlpCommand(m.url, m.referer), t('toast_ytdlpCopied')) }, 'yt-dlp')));
  return card;
}

// ---------- Descargar ----------

/** Calidad elegida, para el nombre del archivo: " [720p]", " [audio]" o "". */
function qualitySuffix(m, vSelect) {
  const q = (o) => (o && o.height ? ` [${formats.qualityLabel(o.height, o.width)}]` : '');
  if (m.kind === 'direct') return q(m);
  if (m.kind === 'hls' && m.variants && m.variants.length) return q(m.variants[parseInt(vSelect && vSelect.value, 10)] || m.variants[0]);
  if (m.kind === 'dash' && vSelect) return vSelect.value === 'none' ? ' [audio]' : q(m.dashVideo[parseInt(vSelect.value, 10)]);
  if (m.kind === 'dash' && !vSelect && m.dashAudio && m.dashAudio.length) return ' [audio]';
  return '';
}

/** Nombre con el que se guarda (sin extensión): el que escribió el usuario o título de la página + calidad. */
function fileNameFor(m, vSelect) {
  const custom = (names.get(m.id) || '').trim();
  return util.sanitizeFilename(custom || `${baseName()}${qualitySuffix(m, vSelect)}`, 150);
}

async function download(m, vSelect, aSelect) {
  const filename = fileNameFor(m, vSelect);
  let job;
  if (m.kind === 'direct') {
    job = { type: 'direct', url: m.url, altUrl: m.altUrl || null, referer: m.referer, ext: m.ext || 'mp4', filename };
  } else if (m.kind === 'hls') {
    if (m.variants && m.variants.length) {
      const v = m.variants[parseInt(vSelect.value, 10)] || m.variants[0];
      const a = aSelect && aSelect.value !== 'muxed' ? aSelect.value : null;
      job = { type: 'hls', url: v.url, audioUrl: a, referer: m.referer, filename };
    } else {
      job = { type: 'hls', url: m.url, referer: m.referer, filename, audioOnly: m.mediaType === 'audio' };
    }
  } else if (m.kind === 'dash') {
    const vi = vSelect ? vSelect.value : 'none';
    const ai = aSelect ? aSelect.value : 'none';
    if (vi === 'none' && ai === 'none') { toast(t('toast_pickTrack')); return; }
    const v = vi !== 'none' ? m.dashVideo[parseInt(vi, 10)] : null;
    const a = ai !== 'none' ? m.dashAudio[parseInt(ai, 10)] : null;
    job = { type: 'dash', url: m.url, videoId: v ? v.id : null, audioId: a ? a.id : null, referer: m.referer, filename };
  } else {
    toast(t('err_protocol', m.kind.toUpperCase()));
    return;
  }
  await send({ type: 'enqueue', job });
  toast(t('toast_started')); refresh();
}

// ---------- Grabación MSE ----------

function renderMse() {
  const frames = Object.entries(state.mse || {}).filter(([, f]) => f.tracks && f.tracks.length);
  const sec = $('mse');
  // Se muestra si hay reproductores MSE o si se detectaron segmentos sueltos o YouTube.
  sec.hidden = !frames.length && !state.special && !state.segments;
  if (sec.hidden) return;

  const total = frames.reduce((s, [, f]) => s + (f.bytes || 0), 0);
  const best = frames.sort((a, b) => (b[1].bytes || 0) - (a[1].bytes || 0))[0];
  const tracksTxt = best ? best[1].tracks.map((t) => t.mime.split(';')[0]).join(' + ') : '';
  $('mseInfo').textContent = state.armed
    ? `● ${t('mse_recording')} · ${util.humanSize(total)}${tracksTxt ? ` · ${tracksTxt}` : ''}`
    : (frames.length ? `${t('mse_player')}${tracksTxt ? ` · ${tracksTxt}` : ''}` : t('mse_noPlayer'));

  $('mseHelp').textContent = state.armed
    ? t('mse_helpArmed')
    : t('mse_help');

  const acts = $('mseActions');
  acts.textContent = '';
  if (!state.armed) {
    acts.append(
      h('button', { class: 'primary', onclick: () => arm(true, true) }, t('mse_fromStart')),
      h('button', { class: 'ghost', onclick: () => arm(true, false) }, t('mse_fromNow')),
    );
  } else {
    acts.append(
      h('button', { class: 'primary', disabled: !total, onclick: () => saveRecording(best) }, t('mse_save')),
      h('button', { class: 'ghost', onclick: () => arm(false, false) }, t('mse_discard')),
    );
  }
}

async function arm(on, reload) {
  await send({ type: 'setArmed', tabId: tab.id, armed: on, reload });
  if (reload) window.close();
  else refresh();
}

async function saveRecording(best) {
  if (!best) return;
  const job = { type: 'mse', tabId: tab.id, frameId: parseInt(best[0], 10), filename: `${baseName()} [${t('word_recording')}]` };
  await send({ type: 'enqueue', job });
  toast(t('toast_recSent')); refresh();
}

// ---------- Inicio ----------

$('openManager').addEventListener('click', () => { send({ type: 'openManager' }); window.close(); });
$('clear').addEventListener('click', async () => { await send({ type: 'clearTab', tabId: tab.id }); selections.clear(); refresh(); });
$('rescan').addEventListener('click', async () => {
  await browser.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => {});
  setTimeout(refresh, 800);
  toast(t('toast_scanning'));
});
$('showHidden').addEventListener('click', () => { includeHidden = !includeHidden; refresh(); });
$('grant').addEventListener('click', async () => {
  const ok = await browser.permissions.request({ origins: ['<all_urls>'] });
  if (ok) { $('perm').hidden = true; toast(t('toast_permGranted')); }
});

(async () => {
  // ?tabId=N permite abrir el popup como pestaña para una pestaña concreta (pruebas / depuración).
  const forced = parseInt(new URLSearchParams(location.search).get('tabId'), 10);
  if (forced) tab = await browser.tabs.get(forced);
  else [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const hasPerm = await browser.permissions.contains({ origins: ['<all_urls>'] });
  $('perm').hidden = hasPerm;
  await refresh();
  // Refresco periódico sin pisar lo que el usuario está eligiendo.
  setInterval(() => {
    if (document.activeElement && ['SELECT', 'INPUT'].includes(document.activeElement.tagName)) return;
    refresh();
  }, 1500);
})();
