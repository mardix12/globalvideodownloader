/* Background de Global Video Downloader (común a Firefox y Chrome).
 *
 * 1. Sniffer de red: observa respuestas (webRequest.onHeadersReceived) y detecta archivos
 *    de video/audio, manifiestos HLS/DASH y hosts especiales.
 * 2. Recibe detecciones del DOM, avisos de DRM (EME) y estado de grabación MSE desde los content scripts.
 * 3. Pasa los trabajos de descarga al motor (FFVD.platform.engine); la página "Descargas" solo muestra su estado.
 * Lo que depende del navegador (dónde corre el motor, cómo se pone el Referer, YouTube) está en platform-*.js.
 */
'use strict';

const { formats, util, hls, platform, t: tr } = self.FFVD;
const MANAGER_URL = browser.runtime.getURL('src/manager/manager.html');

const DEFAULT_SETTINGS = { minSizeKB: 300, concurrency: 6, convert: true, maxJobs: 5 };
let settings = { ...DEFAULT_SETTINGS };

/** Tamaño conocido o estimado (bitrate × duración) de un medio, en bytes; 0 si no se sabe. */
function estimatedSize(m) {
  if (m.size) return m.size;
  if (!m.duration || m.live) return 0;
  const maxBw = (list) => (list || []).reduce((mx, r) => Math.max(mx, r.bandwidth || 0), 0);
  if (m.kind === 'hls') return (maxBw(m.variants) * m.duration) / 8;
  if (m.kind === 'dash') return ((maxBw(m.dashVideo) + maxBw(m.dashAudio)) * m.duration) / 8;
  return 0;
}

/** Más chico que el mínimo configurado (los de tamaño desconocido se muestran siempre). */
function isSmall(m) {
  const min = (settings.minSizeKB || 0) * 1024;
  if (!min) return false;
  const s = estimatedSize(m);
  return s > 0 && s < min;
}

/** tabId → estado de la pestaña */
const tabs = new Map();

function newTabState(pageUrl = '') {
  // aliases: clave de URL → clave del medio al que corresponde (redirecciones y duplicados unidos).
  return { pageUrl, media: new Map(), children: new Set(), aliases: {}, drm: null, mse: {}, special: null, armed: false, segments: 0 };
}

function getTab(tabId) {
  let t = tabs.get(tabId);
  if (!t) { t = newTabState(); tabs.set(tabId, t); }
  return t;
}

// ---------- Persistencia (el event page puede descargarse en cualquier momento) ----------

const ready = (async () => {
  try {
    const s = await browser.storage.local.get('settings');
    settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    const all = await browser.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('tab_')) continue;
      const t = newTabState(v.pageUrl);
      t.media = new Map(v.media.map((m) => [m.key, m]));
      t.children = new Set(v.children || []);
      t.aliases = v.aliases || {};
      Object.assign(t, { drm: v.drm, mse: v.mse || {}, special: v.special, armed: v.armed, segments: v.segments || 0 });
      tabs.set(parseInt(k.slice(4), 10), t);
    }
  } catch (e) {
    console.error('[ffvd] restore', e);
  }
  try {
    await platform.engine.restore();
  } catch (e) {
    console.error('[gvd] restore jobs', e);
  }
})();

platform.init({ getSettings: () => settings });

const saveTimers = new Map();
function persist(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(() => {
    saveTimers.delete(tabId);
    const t = tabs.get(tabId);
    if (!t) { browser.storage.session.remove(`tab_${tabId}`); return; }
    browser.storage.session.set({
      [`tab_${tabId}`]: {
        pageUrl: t.pageUrl, media: [...t.media.values()], children: [...t.children], aliases: t.aliases,
        drm: t.drm, mse: t.mse, special: t.special, armed: t.armed, segments: t.segments,
      },
    }).catch((e) => console.warn('[ffvd] persist', e));
  }, 400));
  updateBadge(tabId);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    for (const tabId of tabs.keys()) updateBadge(tabId);
    platform.engine.settingsChanged();
  }
});

// ---------- Badge ----------

function updateBadge(tabId) {
  const t = tabs.get(tabId);
  let n = 0;
  if (t) {
    for (const m of t.media.values()) if (m.status !== 'error' && !isSmall(m)) n++;
    if (Object.values(t.mse).some((f) => f.bytes > 0)) n++;
  }
  const color = t && t.drm ? '#b00020' : '#0060df';
  browser.action.setBadgeText({ tabId, text: n ? String(n) : (t && t.drm ? '!' : '') }).catch(() => {});
  browser.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// ---------- Alta de medios ----------

const isOwnRequest = (d) => platform.isOwnRequest(d);

function header(headers, name) {
  const h = headers && headers.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

// ---------- Duplicados: un mismo archivo puede llegar con varias URLs ----------
// Ej.: el <video src> de la página redirige a un CDN con otro nombre (la página da una URL y la red otra),
// o el sitio sirve el mismo archivo desde dos servidores. Se unen por redirección o por tamaño idéntico.

const TWIN_MIN_SIZE = 1024 * 1024; // por debajo de 1 MB el tamaño exacto no alcanza para asegurar que es el mismo archivo
const MAX_ALIASES = 500;

function resolveKey(t, key) {
  for (let i = 0; i < 8 && t.aliases[key] && t.aliases[key] !== key; i++) key = t.aliases[key];
  return key;
}

function setAlias(t, fromKey, toKey) {
  if (fromKey === toKey || resolveKey(t, toKey) === fromKey) return;
  t.aliases[fromKey] = toKey;
  const keys = Object.keys(t.aliases);
  if (keys.length > MAX_ALIASES) delete t.aliases[keys[0]];
}

function findTwin(t, size, except) {
  if (!size || size < TWIN_MIN_SIZE) return null;
  for (const m of t.media.values()) if (m !== except && m.kind === 'direct' && m.size === size) return m;
  return null;
}

/** Suma a `prev` los datos de `item`. Se prefiere la URL que figura en la página (sobrevive a tokens que vencen). */
function mergeInto(prev, item) {
  if (item.size && (!prev.size || item.size > prev.size)) prev.size = item.size;
  for (const k of ['width', 'height', 'duration']) if (item[k] && !prev[k]) prev[k] = item[k];
  if (!item.url || util.dedupeKey(item.url) === util.dedupeKey(prev.url)) return;
  if (item.source === 'dom' && prev.source !== 'dom') {
    prev.altUrl = prev.url;
    prev.url = item.url;
    prev.source = 'dom';
    if (item.referer) prev.referer = item.referer;
  } else if (!prev.altUrl && item.url !== prev.url) {
    prev.altUrl = item.url;
  }
}

/** Une dos medios ya listados: queda el más antiguo (conserva su posición y lo elegido en el popup). */
function mergeExisting(t, a, b) {
  const [keep, drop] = a.detectedAt <= b.detectedAt ? [a, b] : [b, a];
  mergeInto(keep, drop);
  if (drop.altUrl && !keep.altUrl && util.dedupeKey(drop.altUrl) !== util.dedupeKey(keep.url)) keep.altUrl = drop.altUrl;
  t.media.delete(drop.key);
  setAlias(t, drop.key, keep.key);
  return keep;
}

/** Registra que `fromUrl` redirigió a `toUrl` (son el mismo recurso). */
function linkUrls(tabId, fromUrl, toUrl) {
  const t = getTab(tabId);
  const from = resolveKey(t, util.dedupeKey(fromUrl));
  const toOwn = util.dedupeKey(toUrl);
  const to = resolveKey(t, toOwn);
  if (from === to) return;
  const a = t.media.get(from);
  const b = t.media.get(to);
  if (a && b) {
    if (a.kind === 'direct' && b.kind === 'direct') mergeExisting(t, a, b);
  } else if (b) {
    // El destino ya estaba listado: el origen pasa a apuntar a él.
    setAlias(t, from, to);
  } else {
    setAlias(t, toOwn, from);
  }
  persist(tabId);
}

function addMedia(tabId, item) {
  const t = getTab(tabId);
  const own = util.dedupeKey(item.url);
  const key = resolveKey(t, own);
  if (t.children.has(key) || t.children.has(own)) return null;
  let prev = t.media.get(key);
  if (!prev && item.kind === 'direct') {
    prev = findTwin(t, item.size);
    if (prev) setAlias(t, own, prev.key);
  }
  if (prev) {
    // Actualizar datos que antes no se conocían.
    const hadSize = prev.size;
    mergeInto(prev, item);
    // Recién ahora se sabe el tamaño: puede coincidir con otro ya listado.
    if (prev.kind === 'direct' && prev.size !== hadSize) {
      const twin = findTwin(t, prev.size, prev);
      if (twin) prev = mergeExisting(t, prev, twin);
    }
    persist(tabId);
    return prev;
  }
  const m = {
    id: util.uid(),
    key,
    status: 'ok',
    detectedAt: Date.now(),
    pageUrl: t.pageUrl,
    ...item,
  };
  t.media.set(key, m);
  persist(tabId);
  return m;
}

async function handleManifest(tabId, m) {
  m.status = 'parsing';
  persist(tabId);
  try {
    const res = await util.siteFetch(m.url, { referer: m.referer });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const finalUrl = res.url || m.url;
    if (m.kind === 'hls') await summarizeHls(tabId, m, text, finalUrl);
    else if (m.kind === 'dash') await summarizeDash(m, text, finalUrl);
    else throw new Error(tr('err_protocol', m.kind.toUpperCase()));
    m.status = 'ok';
  } catch (e) {
    m.status = 'error';
    m.error = String(e.message || e);
  }
  persist(tabId);
}

async function summarizeHls(tabId, m, text, url) {
  const p = hls.parse(text, url);
  const t = getTab(tabId);
  if (p.type === 'master') {
    m.variants = p.variants.map((v) => ({
      url: v.url, bandwidth: v.bandwidth, width: v.width, height: v.height,
      codecs: v.codecs, frameRate: v.frameRate, audioGroup: v.audioGroup,
    }));
    m.audioTracks = p.audio.filter((a) => a.url).map((a) => ({ url: a.url, groupId: a.groupId, name: a.name, lang: a.lang, default: a.default }));
    m.subtitleTracks = p.subtitles.filter((s) => s.url).map((s) => ({ url: s.url, name: s.name, lang: s.lang }));
    m.drm = p.drm;
    // Las sub-playlists no se listan por separado.
    for (const u of [...p.variants.map((v) => v.url), ...p.audio.map((a) => a.url), ...p.subtitles.map((s) => s.url)]) {
      if (!u) continue;
      const k = util.dedupeKey(u);
      t.children.add(k);
      t.media.delete(k);
    }
    // Leer la mejor variante para conocer duración, cifrado y si es en vivo.
    if (p.variants[0]) {
      try {
        const r = await util.siteFetch(p.variants[0].url, { referer: m.referer });
        const mp = hls.parse(await r.text(), r.url || p.variants[0].url);
        if (mp.type === 'media') {
          m.duration = mp.duration;
          m.live = mp.live;
          m.encryption = mp.encryption;
          m.drm = m.drm || mp.drm;
          m.container = mp.container;
        }
      } catch (e) { /* no crítico */ }
    }
  } else {
    m.variants = null;
    m.duration = p.duration;
    m.live = p.live;
    m.encryption = p.encryption;
    m.drm = p.drm;
    m.container = p.container;
    m.segmentCount = p.segments.length;
  }
  if (m.drm) markDrm(tabId, 'HLS (FairPlay/Widevine/SAMPLE-AES)');
}

async function summarizeDash(m, text, url) {
  const p = await platform.parseDash(text, url); // en Chrome se analiza en el offscreen document (DOMParser)
  m.dashVideo = p.video;
  m.dashAudio = p.audio;
  m.duration = p.duration;
  m.live = p.live;
  m.drm = p.drm;
}

function markDrm(tabId, keySystem) {
  const t = getTab(tabId);
  if (!t.drm) t.drm = { keySystem, at: Date.now() };
  persist(tabId);
}

// ---------- Sniffer de red ----------

browser.webRequest.onBeforeRequest.addListener((d) => {
  if (d.type === 'main_frame' && d.tabId >= 0 && !isOwnRequest(d)) {
    ready.then(() => {
      const prev = tabs.get(d.tabId);
      const t = newTabState(d.url);
      // Si el usuario armó la grabación y recarga, mantenerla armada.
      if (prev && prev.armed) t.armed = true;
      tabs.set(d.tabId, t);
      persist(d.tabId);
    });
  }
}, { urls: ['<all_urls>'], types: ['main_frame'] });

// Redirecciones: la URL de la página y la del CDN son el mismo archivo.
browser.webRequest.onBeforeRedirect.addListener((d) => {
  if (d.tabId < 0 || isOwnRequest(d) || !d.redirectUrl) return;
  ready.then(() => linkUrls(d.tabId, d.url, d.redirectUrl));
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] });

browser.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || isOwnRequest(d)) return;
  if (d.statusCode >= 300 && d.statusCode < 400) return;
  if (d.statusCode >= 400) return;
  const ct = header(d.responseHeaders, 'content-type');
  const cd = header(d.responseHeaders, 'content-disposition');
  const c = formats.classify(d.url, ct, cd);
  if (!c) return;

  ready.then(() => {
    const t = getTab(d.tabId);
    // Chrome: en YouTube no se detecta nada (política de la Chrome Web Store).
    if (platform.blockedPage(t.pageUrl) || platform.blockedPage(d.url)) return;
    const referer = d.documentUrl || d.originUrl || t.pageUrl;

    if (c.kind === 'segment') {
      t.segments++;
      return;
    }
    if (c.kind === 'special') {
      if (t.special !== c.reason) { t.special = c.reason; persist(d.tabId); }
      return;
    }
    if (c.kind === 'manifest') {
      const key = resolveKey(t, util.dedupeKey(d.url));
      if (t.media.has(key) || t.children.has(key)) return;
      const m = addMedia(d.tabId, { url: d.url, kind: c.protocol, mediaType: 'video', referer, source: 'network', frameUrl: d.documentUrl });
      if (m) handleManifest(d.tabId, m);
      return;
    }
    // Archivo directo
    let size = parseInt(header(d.responseHeaders, 'content-length'), 10) || 0;
    const cr = header(d.responseHeaders, 'content-range');
    if (cr) {
      const total = parseInt(cr.split('/')[1], 10);
      if (total) size = total;
    }
    addMedia(d.tabId, {
      url: d.url, kind: 'direct', mediaType: c.mediaType, mime: c.mime, ext: c.ext, size,
      referer, source: 'network', frameUrl: d.documentUrl,
    });
  });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other', 'main_frame', 'sub_frame'] }, ['responseHeaders']);

// ---------- Limpieza ----------

browser.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  persist(tabId);
});

// ---------- Manager / cola de trabajos ----------

async function ensureManager(activate = false) {
  const found = await browser.tabs.query({ url: MANAGER_URL });
  if (found.length) {
    if (activate) await browser.tabs.update(found[0].id, { active: true });
    return found[0];
  }
  return browser.tabs.create({ url: MANAGER_URL, active: activate });
}

function enqueue(job) {
  job.id = job.id || util.uid();
  job.createdAt = Date.now();
  return platform.engine.add(job);
}

async function activeJobs() {
  const s = await browser.storage.session.get('jobsState');
  return (s.jobsState || []).filter((j) => j.state === 'queued' || j.state === 'running').length;
}

// ---------- Mensajes ----------

async function onMessage(msg, sender) {
  await ready;
  const senderTab = sender.tab && sender.tab.id;
  switch (msg.type) {
    case 'getTab': {
      const t = getTab(msg.tabId);
      const all = [...t.media.values()].map((m) => ({ ...m, hidden: isSmall(m) }));
      return {
        pageUrl: t.pageUrl,
        // Lo más nuevo arriba.
        media: all.filter((m) => !m.hidden || msg.includeHidden).sort((a, b) => b.detectedAt - a.detectedAt),
        hiddenCount: all.filter((m) => m.hidden).length,
        activeJobs: await activeJobs(),
        drm: t.drm,
        mse: t.mse,
        special: t.special,
        armed: t.armed,
        segments: t.segments,
        settings,
        platform: platform.name,
        blocked: platform.blockedPage(t.pageUrl),
      };
    }
    case 'clearTab': {
      const prev = tabs.get(msg.tabId);
      tabs.set(msg.tabId, newTabState(prev ? prev.pageUrl : ''));
      persist(msg.tabId);
      return true;
    }
    case 'domMedia': {
      if (senderTab == null || platform.blockedPage(sender.tab.url)) return false;
      const t = getTab(senderTab);
      if (!t.pageUrl && sender.tab.url) t.pageUrl = sender.tab.url;
      for (const it of msg.items) await addDomItem(senderTab, it, sender.url);
      return true;
    }
    case 'drm': {
      if (senderTab != null && !platform.blockedPage(sender.tab.url)) markDrm(senderTab, msg.keySystem);
      return true;
    }
    case 'mseStatus': {
      if (senderTab == null || platform.blockedPage(sender.tab.url)) return false;
      const t = getTab(senderTab);
      const fid = String(sender.frameId || 0);
      t.mse[fid] = { ...msg.status, frameUrl: sender.url, updatedAt: Date.now() };
      persist(senderTab);
      return true;
    }
    case 'isArmed': {
      if (senderTab == null) return false;
      return getTab(senderTab).armed;
    }
    case 'setArmed': {
      const t = getTab(msg.tabId);
      t.armed = !!msg.armed;
      persist(msg.tabId);
      await browser.tabs.sendMessage(msg.tabId, { type: 'setArmed', armed: t.armed }).catch(() => {});
      if (msg.reload) await browser.tabs.reload(msg.tabId);
      return true;
    }
    case 'enqueue':
      return enqueue(msg.job);
    case 'openManager':
      await ensureManager(true);
      return true;
    case 'jobCancel':
      await platform.engine.cancel(msg.id);
      return true;
    case 'jobRetry':
      await platform.engine.retry(msg.id);
      return true;
    case 'jobsClearDone':
      await platform.engine.clearDone();
      return true;
    case 'reparse': {
      const t = getTab(msg.tabId);
      const m = [...t.media.values()].find((x) => x.id === msg.id);
      if (m && (m.kind === 'hls' || m.kind === 'dash')) await handleManifest(msg.tabId, m);
      return true;
    }
    default:
      return undefined;
  }
}

async function addDomItem(tabId, it, frameUrl) {
  if (!it.url || /^(blob|data|mediastream|mediasource):/i.test(it.url)) return;
  const referer = frameUrl || getTab(tabId).pageUrl;
  const ext = formats.extOf(it.url);
  if (formats.MANIFEST_EXT[ext]) {
    const t = getTab(tabId);
    const key = resolveKey(t, util.dedupeKey(it.url));
    if (t.media.has(key) || t.children.has(key)) return;
    const m = addMedia(tabId, { url: it.url, kind: formats.MANIFEST_EXT[ext], mediaType: 'video', referer, source: 'dom', frameUrl });
    if (m) handleManifest(tabId, m);
    return;
  }
  const t = getTab(tabId);
  if (t.media.has(resolveKey(t, util.dedupeKey(it.url)))) {
    addMedia(tabId, { url: it.url, width: it.width, height: it.height, duration: it.duration, source: 'dom', referer });
    return;
  }
  // Confirmar con HEAD qué es y cuánto pesa.
  let ct = '';
  let size = 0;
  let cd = '';
  try {
    const r = await util.siteFetch(it.url, { referer, method: 'HEAD' });
    // Si el HEAD terminó en otra URL (redirección), es el mismo archivo que puede aparecer por la red.
    if (r.url && r.url !== it.url) linkUrls(tabId, it.url, r.url);
    if (r.ok) {
      ct = r.headers.get('content-type') || '';
      size = parseInt(r.headers.get('content-length'), 10) || 0;
      cd = r.headers.get('content-disposition') || '';
    }
  } catch (e) { /* algunos servidores no aceptan HEAD */ }
  const c = formats.classify(it.url, ct, cd) || (it.tag ? { kind: 'direct', mediaType: it.tag === 'audio' ? 'audio' : 'video', mime: ct, ext: ext || 'mp4' } : null);
  if (!c || c.kind !== 'direct') return;
  addMedia(tabId, {
    url: it.url, kind: 'direct', mediaType: c.mediaType, mime: c.mime, ext: c.ext, size,
    width: it.width, height: it.height, duration: it.duration, referer, source: 'dom', frameUrl,
  });
}

const HANDLED = new Set(['getTab', 'clearTab', 'domMedia', 'drm', 'mseStatus', 'isArmed', 'setArmed',
  'enqueue', 'openManager', 'jobCancel', 'jobRetry', 'jobsClearDone', 'reparse']);

self.FFVD.onMessage((msg, sender) => {
  // Mensajes ajenos (ej. "env.*" del offscreen, "engine.*" para el offscreen) no se contestan acá.
  if (!msg || !HANDLED.has(msg.type) || msg.to) return undefined;
  return onMessage(msg, sender);
});
