/* Particularidades de Chrome (service worker sin DOM):
 * - El motor de descargas corre en un offscreen document (src/offscreen/), que sí tiene DOM, Workers y blob: URLs.
 *   Ese documento solo tiene acceso a runtime.*: lo demás (downloads, storage, tabs) se lo hace este service
 *   worker a pedido, con mensajes "env.*".
 * - Referer/Origin de las peticiones propias: reglas de sesión de declarativeNetRequest por host
 *   (Chrome no permite webRequest bloqueante en extensiones MV3).
 * - Política de la Chrome Web Store: nada de YouTube (no se detecta, no se graba, no se sugiere yt-dlp).
 * Expone FFVD.platform (lo usa background.js).
 */
(function (root) {
  'use strict';
  const FFVD = root.FFVD;
  const { util } = FFVD;
  const EXT_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;
  const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
  const STORE_KEY = 'jobsState';
  const YT_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/i;

  let getSettings = () => ({});

  // ---------- Referer / Origin con declarativeNetRequest ----------

  /** host → { id, referer } */
  const refRules = new Map();
  let rulesLoaded = null;
  function loadRules() {
    if (!rulesLoaded) {
      rulesLoaded = chrome.declarativeNetRequest.getSessionRules().then((rules) => {
        for (const r of rules) {
          const host = r.condition.requestDomains && r.condition.requestDomains[0];
          const h = (r.action.requestHeaders || []).find((x) => x.header === 'referer');
          if (host && h) refRules.set(host, { id: r.id, referer: h.value });
        }
      }).catch(() => {});
    }
    return rulesLoaded;
  }

  let ruleChain = Promise.resolve();
  function ensureRefererRule(url, referer) {
    // Serializado: evita dos reglas con el mismo id si llegan pedidos simultáneos.
    ruleChain = ruleChain.then(async () => {
      let host;
      try { host = new URL(url).hostname; } catch (e) { return; }
      if (!host || !referer) return;
      await loadRules();
      const cur = refRules.get(host);
      if (cur && cur.referer === referer) return;
      const id = cur ? cur.id : Math.max(0, ...[...refRules.values()].map((x) => x.id)) + 1;
      const requestHeaders = [{ header: 'referer', operation: 'set', value: referer }];
      const origin = util.originOf(referer);
      if (origin && origin !== 'null') requestHeaders.push({ header: 'origin', operation: 'set', value: origin });
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [{
          id,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders },
          // tabId -1 = peticiones que no son de una pestaña (service worker, offscreen, gestor de descargas).
          // (No alcanza a las peticiones del gestor de descargas: para esas, jobs.js descarga desde el offscreen.)
          condition: { requestDomains: [host], tabIds: [-1], resourceTypes: ['xmlhttprequest', 'media', 'other', 'object'] },
        }],
      });
      refRules.set(host, { id, referer });
    }).catch((e) => console.warn('[gvd] referer rule', e));
    return ruleChain;
  }
  FFVD.prepareReferer = ensureRefererRule;

  // ---------- Offscreen document ----------

  let creating = null;
  async function ensureOffscreen() {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length) return;
    if (!creating) {
      creating = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS', 'WORKERS'],
        justification: 'Download video segments, join them with ffmpeg.wasm and save the result.',
      }).catch((e) => { if (!/single offscreen/i.test(String(e && e.message))) throw e; })
        .finally(() => { creating = null; });
    }
    await creating;
  }

  async function callOffscreen(type, payload = {}) {
    await ensureOffscreen();
    let last;
    for (let i = 0; i < 20; i++) {
      try {
        const r = await chrome.runtime.sendMessage({ to: 'offscreen', type, ...payload });
        if (r !== undefined) return r;
      } catch (e) { last = e; }
      await new Promise((res) => setTimeout(res, 150)); // el documento todavía está cargando
    }
    throw last || new Error('offscreen document not responding');
  }

  // ---------- Pedidos del offscreen document (env.*) ----------

  FFVD.onMessage((msg, sender) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('env.')) return undefined;
    if (sender.url && !sender.url.startsWith(EXT_ORIGIN)) return undefined;
    switch (msg.type) {
      case 'env.download':
        return chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: 'uniquify', saveAs: false });
      case 'env.search':
        return chrome.downloads.search({ id: msg.id }).then((r) => r[0] || null);
      case 'env.cancel':
        return chrome.downloads.cancel(msg.id).then(() => true, () => false);
      case 'env.erase':
        return chrome.downloads.erase({ id: msg.id }).then(() => true, () => false);
      case 'env.saveState':
        return chrome.storage.session.set({ [STORE_KEY]: msg.list }).then(() => true);
      case 'env.loadState':
        return chrome.storage.session.get(STORE_KEY).then((s) => s[STORE_KEY] || []);
      case 'env.getSettings':
        return getSettings();
      case 'env.uiLocale':
        return chrome.i18n.getMessage('@@ui_locale') || chrome.i18n.getUILanguage();
      case 'env.registerReferer':
        return ensureRefererRule(msg.url, msg.referer).then(() => true);
      case 'env.requestRecording':
        // El content script manda la grabación directo al offscreen por un runtime.Port ("rec:<jobId>").
        return chrome.tabs.sendMessage(msg.tabId, { type: 'streamRecording', jobId: msg.jobId }, { frameId: msg.frameId || 0 })
          .then((r) => r || { ok: false }, () => ({ ok: false }));
      default:
        return undefined;
    }
  });

  chrome.downloads.onChanged.addListener((d) => {
    if (!d.state) return;
    chrome.runtime.sendMessage({ to: 'offscreen', type: 'engine.dlChanged', id: d.id, state: d.state.current }).catch(() => {});
  });

  // ---------- YouTube (política de la Chrome Web Store) ----------

  function blockedPage(url) {
    try { return YT_RE.test(new URL(url).hostname); } catch (e) { return false; }
  }

  FFVD.platform = {
    name: 'chrome',
    isOwnRequest: (d) => !!(d.initiator && d.initiator.startsWith(EXT_ORIGIN)),
    blockedPage,
    init(opts) {
      getSettings = opts.getSettings;
      loadRules();
    },
    engine: {
      // El offscreen document recupera el historial solo, al crearse.
      restore: async () => {
        const s = await chrome.storage.session.get(STORE_KEY);
        if ((s[STORE_KEY] || []).some((j) => j.state === 'queued' || j.state === 'running')) await ensureOffscreen();
      },
      add: (job) => callOffscreen('engine.add', { job }),
      cancel: (id) => callOffscreen('engine.cancel', { id }),
      retry: (id) => callOffscreen('engine.retry', { id }),
      clearDone: () => callOffscreen('engine.clearDone'),
      settingsChanged: () => chrome.runtime.sendMessage({ to: 'offscreen', type: 'engine.settings', settings: getSettings() }).catch(() => {}),
    },
    // DOMParser no existe en el service worker: el MPD se analiza en el offscreen document.
    parseDash: async (text, url) => {
      const r = await callOffscreen('engine.parseDash', { text, url });
      if (r && r.error) throw new Error(r.error);
      return r;
    },
  };
})(typeof self !== 'undefined' ? self : this);
