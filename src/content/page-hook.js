/* Corre en el "MAIN world" de cada página/frame (sin acceso a APIs de extensión).
 *
 * - Grabación MSE: intercepta MediaSource.addSourceBuffer / SourceBuffer.appendBuffer y guarda una
 *   copia de los fragmentos que el reproductor le entrega al navegador. Es el método universal para
 *   sitios que arman el video con JavaScript (blob:), sin depender de la URL de los segmentos.
 * - Detección DRM: intercepta EME (requestMediaKeySystemAccess / setMediaKeys).
 *
 * Se comunica con content/detect.js vía window.postMessage con la etiqueta TAG.
 */
(() => {
  'use strict';
  if (window.__ffvdHooked) return;
  try { Object.defineProperty(window, '__ffvdHooked', { value: true }); } catch (e) { return; }

  const TAG = '__ffvd_v1__';
  const MAX_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB por página
  const post = (msg) => { try { window.postMessage({ [TAG]: true, from: 'page', ...msg }, '*'); } catch (e) { /* noop */ } };

  /** null = todavía no se sabe si está armado; se guardan los datos por las dudas. */
  let armed = null;
  let total = 0;
  let overflow = false;
  let nextId = 1;
  const tracks = [];
  const bySb = new WeakMap();

  function isInitSegment(u8) {
    if (u8.length < 8) return false;
    // WebM / Matroska: cabecera EBML
    if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return true;
    // MP4: caja ftyp o moov al inicio
    const box = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
    return box === 'ftyp' || box === 'moov';
  }

  function toU8(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return null;
  }

  let statusTimer = null;
  function scheduleStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      post({
        type: 'status',
        status: {
          bytes: total,
          overflow,
          armed: !!armed,
          tracks: tracks.map((t) => ({ id: t.id, mime: t.mime, bytes: t.bytes, parts: t.groups.length, hasInit: !!t.lastInit })),
        },
      });
    }, 1000);
  }

  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function clearTrack(t) {
    t.groups = [];
    t.bytes = 0;
  }

  /*
   * Cada pista guarda "grupos": un segmento de inicialización + los fragmentos que lo siguen.
   * Cuando el reproductor cambia de calidad manda un init nuevo y se abre otro grupo, porque
   * ffmpeg no acepta un MP4 con dos moov distintos en el medio.
   */
  function record(sb, data) {
    const t = bySb.get(sb);
    if (!t) return;
    const u8 = toU8(data);
    if (!u8 || !u8.length) return;
    if (isInitSegment(u8) || (!t.lastInit && !t.groups.length)) {
      // El init vigente siempre se guarda (es chico y sin él no se puede reproducir).
      // Un init idéntico (re-enviado tras un seek) no abre grupo nuevo.
      if (!sameBytes(u8, t.lastInit)) { t.lastInit = u8; t.newInit = true; }
      scheduleStatus();
      return;
    }
    if (armed === false) return;
    if (total + u8.length > MAX_BYTES) { overflow = true; scheduleStatus(); return; }
    let g = t.groups[t.groups.length - 1];
    if (!g || t.newInit) {
      g = { init: t.lastInit, chunks: [], bytes: 0 };
      t.groups.push(g);
      t.newInit = false;
    }
    g.chunks.push(u8);
    g.bytes += u8.length;
    t.bytes += u8.length;
    total += u8.length;
    scheduleStatus();
  }

  function hookMediaSource(MS) {
    if (!MS || !MS.prototype || !MS.prototype.addSourceBuffer) return;
    const orig = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (mime) {
      const sb = orig.apply(this, arguments);
      try {
        const t = { id: nextId++, mime: String(mime), lastInit: null, newInit: false, groups: [], bytes: 0 };
        tracks.push(t);
        bySb.set(sb, t);
        scheduleStatus();
      } catch (e) { /* noop */ }
      return sb;
    };
  }

  hookMediaSource(window.MediaSource);
  hookMediaSource(window.ManagedMediaSource);

  if (window.SourceBuffer && SourceBuffer.prototype.appendBuffer) {
    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try { record(this, data); } catch (e) { /* nunca romper el reproductor */ }
      return origAppend.apply(this, arguments);
    };
  }

  // ---------- EME / DRM ----------
  if (navigator.requestMediaKeySystemAccess) {
    const origReq = navigator.requestMediaKeySystemAccess.bind(navigator);
    navigator.requestMediaKeySystemAccess = function (keySystem, configs) {
      const p = origReq(keySystem, configs);
      p.then((access) => {
        try { window.__ffvdKeySystem = access.keySystem; } catch (e) { /* noop */ }
      }, () => {});
      return p;
    };
  }
  if (window.HTMLMediaElement && HTMLMediaElement.prototype.setMediaKeys) {
    const origSet = HTMLMediaElement.prototype.setMediaKeys;
    HTMLMediaElement.prototype.setMediaKeys = function (mk) {
      // Solo se reporta cuando un video realmente usa claves (las sondas de capacidad no cuentan).
      if (mk) post({ type: 'drm', keySystem: window.__ffvdKeySystem || 'EME' });
      return origSet.apply(this, arguments);
    };
  }

  // ---------- Órdenes desde el content script ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data[TAG] || e.data.from !== 'ext') return;
    const d = e.data;
    if (d.type === 'setArmed') {
      armed = !!d.armed;
      if (!armed) {
        tracks.forEach(clearTrack);
        total = 0;
        overflow = false;
      }
      scheduleStatus();
    } else if (d.type === 'reset') {
      tracks.forEach(clearTrack);
      total = 0;
      overflow = false;
      scheduleStatus();
    } else if (d.type === 'export') {
      // Por pista se exporta el tramo (grupo) más largo; se informa cuántos había.
      const out = tracks
        .filter((t) => t.bytes > 0)
        .map((t) => {
          const best = t.groups.reduce((a, b) => (b.bytes > a.bytes ? b : a));
          const parts = best.init ? [best.init, ...best.chunks] : best.chunks;
          return {
            id: t.id,
            mime: t.mime,
            bytes: best.bytes,
            parts: t.groups.length,
            droppedBytes: t.bytes - best.bytes,
            blob: new Blob(parts, { type: t.mime.split(';')[0] }),
          };
        });
      post({ type: 'exportResult', reqId: d.reqId, tracks: out });
    }
  });
})();
