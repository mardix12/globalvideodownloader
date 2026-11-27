/* Utilidades compartidas. Expone FFVD.util */
(function (root) {
  'use strict';
  const FFVD = (root.FFVD = root.FFVD || {});

  // Header interno: el background lo reemplaza por Referer/Origin reales (ver background.js).
  const REFERER_HEADER = 'X-FFVD-Referer';

  function humanSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

  function humanDuration(sec) {
    if (!sec || !isFinite(sec)) return '';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function humanBitrate(bps) {
    if (!bps) return '';
    return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
  }

  /** Nombre de archivo válido en Windows/macOS/Linux. */
  function sanitizeFilename(name, maxLen = 150) {
    let s = String(name || 'video')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
    if (s.length > maxLen) s = s.slice(0, maxLen).trim();
    return s || 'video';
  }

  function resolveUrl(rel, base) {
    try { return new URL(rel, base).href; } catch (e) { return rel; }
  }

  /** Clave para deduplicar: URL sin parámetros de rango/tiempo típicos. */
  function dedupeKey(url) {
    try {
      const u = new URL(url);
      ['range', 'rn', 'rbuf', 'bytestart', 'byteend', 'start', 'end', '_', 't', 'cb'].forEach((k) => u.searchParams.delete(k));
      u.hash = '';
      return u.href;
    } catch (e) {
      return url;
    }
  }

  function originOf(url) {
    try { return new URL(url).origin; } catch (e) { return ''; }
  }

  /** fetch con Referer del sitio original.
   * Firefox: header interno que el background reescribe (webRequest bloqueante).
   * Chrome: FFVD.prepareReferer agrega una regla de declarativeNetRequest para ese host antes de pedir. */
  async function siteFetch(url, { referer, range, signal, method } = {}) {
    const headers = {};
    if (referer) {
      if (FFVD.prepareReferer) await FFVD.prepareReferer(url, referer);
      else headers[REFERER_HEADER] = referer;
    }
    if (range) headers.Range = `bytes=${range[0]}-${range[1] != null ? range[1] : ''}`;
    return fetch(url, { method: method || 'GET', headers, credentials: 'include', cache: 'no-store', signal });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  FFVD.util = {
    REFERER_HEADER, humanSize, humanDuration, humanBitrate, sanitizeFilename,
    resolveUrl, dedupeKey, originOf, siteFetch, uid,
  };
})(typeof self !== 'undefined' ? self : this);
