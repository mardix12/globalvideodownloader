/* Particularidades de Firefox (event page con DOM):
 * - El motor de descargas (jobs.js) corre acá mismo.
 * - Referer/Origin de las peticiones propias: se reescriben con webRequest bloqueante.
 * - Keep-alive: mientras haya trabajos se llama a una API cada 10 s (Firefox suspende el event page
 *   tras 30 s sin actividad de extensión; las llamadas a la API reinician ese contador).
 * Expone FFVD.platform (lo usa background.js).
 */
(function (root) {
  'use strict';
  const FFVD = root.FFVD;
  const { util, dash, jobs } = FFVD;
  const EXT_ORIGIN = new URL(browser.runtime.getURL('/')).origin;

  /** URL → referer para descargas directas lanzadas con downloads.download */
  const downloadReferers = new Map();
  let getSettings = () => ({});

  // ---------- Referer / Origin ----------

  const isOwn = (d) => (d.originUrl && d.originUrl.startsWith(EXT_ORIGIN)) || (d.documentUrl && d.documentUrl.startsWith(EXT_ORIGIN));

  browser.webRequest.onBeforeSendHeaders.addListener((d) => {
    if (!isOwn(d) && d.tabId !== -1) return {};
    let referer = '';
    const headers = d.requestHeaders.filter((h) => {
      if (h.name.toLowerCase() === util.REFERER_HEADER.toLowerCase()) { referer = h.value; return false; }
      return true;
    });
    if (!referer && downloadReferers.has(d.url)) referer = downloadReferers.get(d.url);
    if (!referer) return {};
    const out = headers.filter((h) => !/^(referer|origin)$/i.test(h.name));
    out.push({ name: 'Referer', value: referer });
    // Origin solo cuando el navegador lo hubiera mandado (peticiones CORS); se reemplaza el moz-extension://
    if (headers.some((h) => /^origin$/i.test(h.name))) out.push({ name: 'Origin', value: util.originOf(referer) });
    return { requestHeaders: out };
  }, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders']);

  // ---------- Entorno del motor ----------

  let kaTimer = null;
  const env = {
    download: ({ url, filename }) => browser.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }),
    searchDownload: async (id) => (await browser.downloads.search({ id }))[0] || null,
    cancelDownload: (id) => browser.downloads.cancel(id),
    eraseDownload: (id) => browser.downloads.erase({ id }),
    onDownloadChanged: (cb) => browser.downloads.onChanged.addListener((d) => cb({ id: d.id, state: d.state && d.state.current })),
    saveState: (list) => browser.storage.session.set({ [jobs.STORE_KEY]: list }),
    loadState: async () => (await browser.storage.session.get(jobs.STORE_KEY))[jobs.STORE_KEY] || [],
    getRecording: (job) => browser.tabs.sendMessage(job.tabId, { type: 'getRecording' }, { frameId: job.frameId || 0 }),
    setBusy: (on) => {
      if (on && !kaTimer) kaTimer = setInterval(() => browser.runtime.getPlatformInfo().catch(() => {}), 10000);
      else if (!on && kaTimer) { clearInterval(kaTimer); kaTimer = null; }
    },
    registerReferer: (url, referer) => {
      downloadReferers.set(url, referer);
      setTimeout(() => downloadReferers.delete(url), 10 * 60 * 1000);
    },
    getSettings: () => getSettings(),
  };

  FFVD.platform = {
    name: 'firefox',
    isOwnRequest: isOwn,
    /** En Firefox se mantiene el aviso y la grabación para YouTube. */
    blockedPage: () => false,
    init(opts) {
      getSettings = opts.getSettings;
      jobs.init(env);
    },
    engine: {
      restore: () => jobs.restore(),
      add: (job) => jobs.add(job),
      cancel: (id) => jobs.cancel(id),
      retry: (id) => jobs.retry(id),
      clearDone: () => jobs.clearDone(),
      settingsChanged: () => jobs.settingsChanged(),
    },
    parseDash: async (text, url) => dash.summarize(dash.parse(text, url)),
  };
})(typeof self !== 'undefined' ? self : this);
