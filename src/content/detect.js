/* Content script (mundo aislado) en todas las páginas y frames.
 * - Escanea el DOM: <video>/<audio>/<source>, metadatos og:video / twitter, JSON-LD VideoObject y enlaces a archivos de video.
 * - Hace de puente entre page-hook.js (MAIN world) y el background/manager.
 */
(() => {
  'use strict';
  if (window.__ffvdDetect) return;
  window.__ffvdDetect = true;

  const TAG = '__ffvd_v1__';
  const MEDIA_LINK_RE = /\.(mp4|m4v|webm|mkv|mov|flv|f4v|avi|wmv|ogv|3gp|mpg|mpeg|mp3|m4a|aac|opus|oga|ogg|wav|flac|m3u8|mpd)(\?|#|$)/i;
  const sent = new Set();
  let lastStatus = null;
  const pendingExports = new Map();

  const toPage = (msg) => window.postMessage({ [TAG]: true, from: 'ext', ...msg }, '*');
  const send = (msg) => browser.runtime.sendMessage(msg).catch(() => {});

  // ---------- Puente con page-hook.js ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    let d = e.data;
    if (!d[TAG] && d.wrappedJSObject && d.wrappedJSObject[TAG]) d = d.wrappedJSObject;
    if (!d[TAG] || d.from !== 'page') return;
    if (d.type === 'status') {
      lastStatus = d.status;
      if (d.status.tracks.length) send({ type: 'mseStatus', status: JSON.parse(JSON.stringify(d.status)) });
    } else if (d.type === 'drm') {
      send({ type: 'drm', keySystem: String(d.keySystem) });
    } else if (d.type === 'exportResult') {
      const p = pendingExports.get(d.reqId);
      if (p) {
        pendingExports.delete(d.reqId);
        const tracks = [];
        for (let i = 0; i < d.tracks.length; i++) {
          const t = d.tracks[i];
          tracks.push({ id: t.id, mime: String(t.mime), bytes: t.bytes, parts: t.parts, droppedBytes: t.droppedBytes, blob: t.blob });
        }
        p(tracks);
      }
    }
  });

  browser.runtime.sendMessage({ type: 'isArmed' }).then((armed) => toPage({ type: 'setArmed', armed: !!armed }), () => toPage({ type: 'setArmed', armed: false }));

  function exportRecording() {
    const reqId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      pendingExports.set(reqId, (tracks) => resolve({ tracks, frameUrl: location.href }));
      toPage({ type: 'export', reqId });
      setTimeout(() => { if (pendingExports.delete(reqId)) resolve({ tracks: [], error: 'timeout' }); }, 30000);
    });
  }

  const CHUNK = 4 * 1024 * 1024;
  const readAsDataURL = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

  /** Chrome: los mensajes solo admiten JSON, así que la grabación viaja por un Port en trozos base64. */
  async function streamRecording(jobId) {
    const { tracks } = await exportRecording();
    const port = browser.runtime.connect({ name: `rec:${jobId}` });
    try {
      port.postMessage({ type: 'meta', tracks: tracks.map((tr) => ({ mime: tr.mime, bytes: tr.bytes, parts: tr.parts, droppedBytes: tr.droppedBytes })) });
      for (let i = 0; i < tracks.length; i++) {
        const b = tracks[i].blob;
        for (let off = 0; off < b.size; off += CHUNK) {
          port.postMessage({ type: 'chunk', track: i, data: await readAsDataURL(b.slice(off, off + CHUNK)) });
        }
      }
      port.postMessage({ type: 'end' });
    } catch (e) {
      try { port.postMessage({ type: 'error', error: String(e && e.message) }); } catch (e2) { /* noop */ }
    }
  }

  window.FFVD.onMessage((msg) => {
    if (!msg) return undefined;
    if (msg.type === 'setArmed') { toPage({ type: 'setArmed', armed: msg.armed }); return true; }
    if (msg.type === 'resetRecording') { toPage({ type: 'reset' }); return true; }
    if (msg.type === 'getRecording') {
      if (!lastStatus || !lastStatus.bytes) return undefined;
      return exportRecording();
    }
    if (msg.type === 'streamRecording') {
      if (!lastStatus || !lastStatus.bytes) return undefined;
      streamRecording(msg.jobId);
      return { ok: true };
    }
    if (msg.type === 'rescan') { scan(true); return true; }
    return undefined;
  });

  // ---------- Escaneo del DOM ----------
  function abs(u) {
    try { return new URL(u, location.href).href; } catch (e) { return ''; }
  }

  function collect() {
    const items = [];
    const add = (url, extra) => {
      url = abs(url);
      if (!url || /^(blob|data|javascript|mediastream):/i.test(url)) return;
      items.push({ url, ...extra });
    };

    document.querySelectorAll('video, audio').forEach((el) => {
      const extra = {
        tag: el.localName,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        duration: isFinite(el.duration) ? el.duration : 0,
      };
      if (el.currentSrc) add(el.currentSrc, extra);
      if (el.getAttribute('src')) add(el.getAttribute('src'), extra);
      el.querySelectorAll('source[src]').forEach((s) => add(s.getAttribute('src'), extra));
    });

    const metaSel = ['og:video', 'og:video:url', 'og:video:secure_url', 'og:audio', 'og:audio:url', 'og:audio:secure_url', 'twitter:player:stream'];
    document.querySelectorAll('meta[property], meta[name]').forEach((m) => {
      const k = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
      if (metaSel.includes(k) && m.content && MEDIA_LINK_RE.test(m.content)) add(m.content, { tag: k.includes('audio') ? 'audio' : 'video' });
    });

    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const walk = (o) => {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) { o.forEach(walk); return; }
          const type = [].concat(o['@type'] || []).join(',');
          if (/VideoObject|AudioObject/.test(type) && typeof o.contentUrl === 'string') add(o.contentUrl, { tag: /Audio/.test(type) ? 'audio' : 'video' });
          Object.values(o).forEach(walk);
        };
        walk(JSON.parse(s.textContent));
      } catch (e) { /* JSON inválido */ }
    });

    document.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href');
      if (MEDIA_LINK_RE.test(h)) add(h, { tag: 'link' });
    });
    return items;
  }

  function scan(force) {
    if (force) sent.clear();
    const fresh = [];
    for (const it of collect()) {
      const k = `${it.url}|${it.width}|${it.duration ? 1 : 0}`;
      if (sent.has(k)) continue;
      sent.add(k);
      fresh.push(it);
    }
    if (fresh.length) send({ type: 'domMedia', items: fresh });
  }

  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scan(false); }, 1500);
  };

  document.addEventListener('loadedmetadata', schedule, true);
  document.addEventListener('DOMContentLoaded', () => {
    scan(false);
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  });
})();
