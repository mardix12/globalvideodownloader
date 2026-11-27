/* Descarga de segmentos (HLS/DASH) con concurrencia, reintentos y descifrado AES-128.
 * Expone FFVD.downloader. Se usa desde la página manager. */
(function (root) {
  'use strict';
  const FFVD = (root.FFVD = root.FFVD || {});
  const t = (...a) => (FFVD.t ? FFVD.t(...a) : a[0]);
  const { siteFetch } = FFVD.util;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class Cancelled extends Error {
    constructor() { super(t("job_cancelled")); this.name = 'Cancelled'; }
  }

  async function fetchBuffer(url, { referer, range, signal }) {
    const res = await siteFetch(url, { referer, range, signal });
    if (!res.ok) {
      const err = new Error(t("err_httpAt", res.status, url.slice(0, 120)));
      err.status = res.status;
      throw err;
    }
    let buf = await res.arrayBuffer();
    // El servidor ignoró el Range y mandó el archivo completo.
    if (range && res.status === 200 && buf.byteLength > range[1] - range[0] + 1) {
      buf = buf.slice(range[0], range[1] + 1);
    }
    return buf;
  }

  async function withRetry(fn, { retries = 4, signal } = {}) {
    let last;
    for (let i = 0; i <= retries; i++) {
      if (signal && signal.aborted) throw new Cancelled();
      try {
        return await fn();
      } catch (e) {
        if (signal && signal.aborted) throw new Cancelled();
        last = e;
        // 403/404/410 no se arreglan reintentando (URL vencida o sin permiso).
        if (e.status && [401, 403, 404, 410].includes(e.status)) break;
        await sleep(500 * 2 ** i);
      }
    }
    throw last;
  }

  /** Descifra AES-128-CBC (PKCS7). WebCrypto quita el padding automáticamente. */
  async function decryptAes128(data, keyBytes, iv) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
  }

  /**
   * Descarga una lista de segmentos y devuelve un Blob con todo concatenado en orden.
   * @param {Array} segments [{url, range?, key?, single?}]
   * @param {Object} opts {referer, concurrency, signal, onProgress(done,total,bytes), mime}
   */
  async function downloadSegments(segments, opts) {
    const { referer, signal, onProgress, mime } = opts;
    const concurrency = Math.max(1, Math.min(16, opts.concurrency || 6));

    // Archivo único (DASH SegmentBase o similar): descarga en streaming con progreso.
    if (segments.length === 1 && segments[0].single) {
      return downloadSingle(segments[0].url, opts);
    }

    const parts = new Array(segments.length);
    const keyCache = new Map();
    let next = 0;
    let done = 0;
    let bytes = 0;

    const getKey = (uri) => {
      if (!keyCache.has(uri)) {
        keyCache.set(uri, withRetry(() => fetchBuffer(uri, { referer, signal }), { signal }).then((b) => {
          if (b.byteLength !== 16) throw new Error(t("err_aesKey", b.byteLength));
          return b;
        }));
      }
      return keyCache.get(uri);
    };

    async function worker() {
      while (next < segments.length) {
        if (signal && signal.aborted) throw new Cancelled();
        const i = next++;
        const s = segments[i];
        let buf = await withRetry(() => fetchBuffer(s.url, { referer, range: s.range, signal }), { signal });
        if (s.key && s.key.method === 'AES-128') {
          buf = await decryptAes128(buf, await getKey(s.key.uri), s.key.iv);
        }
        parts[i] = new Blob([buf]);
        done++;
        bytes += buf.byteLength;
        if (onProgress) onProgress(done, segments.length, bytes);
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));
    return new Blob(parts, { type: mime || 'application/octet-stream' });
  }

  async function downloadSingle(url, { referer, signal, onProgress, mime }) {
    const res = await withRetry(async () => {
      const r = await siteFetch(url, { referer, signal });
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
      return r;
    }, { signal });
    const total = parseInt(res.headers.get('content-length'), 10) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      if (signal && signal.aborted) { reader.cancel(); throw new Cancelled(); }
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.byteLength;
      if (onProgress) onProgress(bytes, total || bytes, bytes, true);
    }
    return new Blob(chunks, { type: mime || 'application/octet-stream' });
  }

  FFVD.downloader = { downloadSegments, Cancelled };
})(typeof self !== 'undefined' ? self : this);
