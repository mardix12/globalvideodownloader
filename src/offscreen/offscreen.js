/* Offscreen document (solo Chrome): acá corre el motor de descargas (jobs.js).
 * Este documento solo tiene runtime.*; las demás APIs (downloads, storage, tabs) las pide al service worker
 * con mensajes "env.*". Las grabaciones MSE llegan del content script por un runtime.Port "rec:<jobId>",
 * en trozos base64 (los mensajes de Chrome solo admiten JSON, no Blob).
 */
'use strict';

(function () {
  const { jobs, dash } = window.FFVD;
  const sw = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

  let settings = {};
  const dlListeners = [];

  // Referer: el service worker pone una regla de declarativeNetRequest para el host antes de cada pedido.
  const refDone = new Map(); // host → referer ya registrado
  window.FFVD.prepareReferer = async (url, referer) => {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return; }
    if (refDone.get(host) === referer) return;
    await sw('env.registerReferer', { url, referer });
    refDone.set(host, referer);
  };

  // ---------- Grabaciones MSE (llegan por Port desde el content script) ----------

  const pendingRec = new Map(); // jobId → { resolve, timer }

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith('rec:')) return;
    const jobId = port.name.slice(4);
    const p = pendingRec.get(jobId);
    if (!p) { port.disconnect(); return; }
    let meta = null;
    const parts = [];
    let chain = Promise.resolve();
    const arm = () => {
      clearTimeout(p.timer);
      p.timer = setTimeout(() => finish({ tracks: [], error: 'timeout' }), 60000);
    };
    const finish = (res) => {
      clearTimeout(p.timer);
      if (pendingRec.delete(jobId)) p.resolve(res);
      try { port.disconnect(); } catch (e) { /* noop */ }
    };
    arm();
    port.onMessage.addListener((m) => {
      arm();
      if (m.type === 'meta') {
        meta = m.tracks;
        meta.forEach((_, i) => { parts[i] = []; });
      } else if (m.type === 'chunk') {
        // data: URL → Blob sin decodificar base64 a mano.
        chain = chain.then(() => fetch(m.data).then((r) => r.blob())).then((b) => { parts[m.track].push(b); });
      } else if (m.type === 'end') {
        chain.then(() => finish({
          tracks: (meta || []).map((tr, i) => ({ ...tr, blob: new Blob(parts[i], { type: tr.mime.split(';')[0] }) })),
        }), () => finish({ tracks: [] }));
      } else if (m.type === 'error') {
        finish({ tracks: [], error: m.error });
      }
    });
    port.onDisconnect.addListener(() => chain.then(() => { if (pendingRec.has(jobId) && !meta) finish({ tracks: [] }); }));
  });

  async function getRecording(job) {
    const done = new Promise((resolve) => pendingRec.set(job.id, { resolve, timer: setTimeout(() => {
      if (pendingRec.delete(job.id)) resolve({ tracks: [] });
    }, 60000) }));
    const r = await sw('env.requestRecording', { tabId: job.tabId, frameId: job.frameId, jobId: job.id });
    if (!r || !r.ok) {
      const p = pendingRec.get(job.id);
      if (p) { clearTimeout(p.timer); pendingRec.delete(job.id); }
      return { tracks: [] };
    }
    return done;
  }

  // ---------- Entorno del motor ----------

  jobs.init({
    download: ({ url, filename }) => sw('env.download', { url, filename }),
    searchDownload: (id) => sw('env.search', { id }),
    cancelDownload: (id) => sw('env.cancel', { id }),
    eraseDownload: (id) => sw('env.erase', { id }),
    onDownloadChanged: (cb) => dlListeners.push(cb),
    saveState: (list) => sw('env.saveState', { list }),
    loadState: () => sw('env.loadState'),
    getRecording,
    setBusy: () => {}, // el offscreen document no se suspende solo
    registerReferer: (url, referer) => window.FFVD.prepareReferer(url, referer),
    getSettings: () => settings,
  });

  // ---------- Órdenes del service worker ----------

  // Antes de atender órdenes: traducciones (este documento no tiene chrome.i18n) y opciones.
  const ready = (async () => {
    await window.FFVD.loadMessages(await sw('env.uiLocale'));
    settings = (await sw('env.getSettings')) || {};
  })().catch((e) => console.error('[gvd] offscreen init', e));

  window.FFVD.onMessage((msg) => {
    if (!msg || msg.to !== 'offscreen') return undefined;
    return ready.then(() => handle(msg));
  });

  function handle(msg) {
    switch (msg.type) {
      case 'engine.add': return jobs.add(msg.job);
      case 'engine.cancel': jobs.cancel(msg.id); return true;
      case 'engine.retry': jobs.retry(msg.id); return true;
      case 'engine.clearDone': jobs.clearDone(); return true;
      case 'engine.settings': settings = msg.settings || settings; jobs.settingsChanged(); return true;
      case 'engine.dlChanged': dlListeners.forEach((cb) => cb({ id: msg.id, state: msg.state })); return true;
      case 'engine.parseDash':
        try { return dash.summarize(dash.parse(msg.text, msg.url)); } catch (e) { return { error: String(e.message || e) }; }
      default: return null;
    }
  }

  ready.then(() => jobs.restore()).catch((e) => console.error('[gvd] offscreen restore', e));
})();
