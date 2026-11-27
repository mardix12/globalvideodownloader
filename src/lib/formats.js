/* Tablas de formatos de video/audio y clasificación de respuestas de red.
 * Compartido por background, popup y manager (script clásico, expone FFVD.formats). */
(function (root) {
  'use strict';
  const FFVD = (root.FFVD = root.FFVD || {});

  // Archivos "completos" que se pueden descargar directamente.
  const DIRECT_EXT = {
    mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video',
    ogv: 'video', ogg: 'audio', flv: 'video', f4v: 'video', avi: 'video',
    wmv: 'video', asf: 'video', '3gp': 'video', '3g2': 'video', mpg: 'video',
    mpeg: 'video', m2ts: 'video', mts: 'video', vob: 'video', divx: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio', oga: 'audio',
    wav: 'audio', flac: 'audio', weba: 'audio', wma: 'audio', mka: 'audio',
    ac3: 'audio', eac3: 'audio',
  };

  // Manifiestos de streaming adaptativo.
  const MANIFEST_EXT = { m3u8: 'hls', m3u: 'hls', mpd: 'dash', f4m: 'hds', ism: 'mss', isml: 'mss' };

  // Segmentos sueltos: nunca se listan solos (pertenecen a un manifiesto o a MSE).
  const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'm4v_seg', 'cmfv', 'cmfa', 'cmft', 'fmp4', 'm4i', 'aac_seg', 'vtt', 'webvtt']);

  const MANIFEST_MIME = {
    'application/vnd.apple.mpegurl': 'hls',
    'application/x-mpegurl': 'hls',
    'audio/mpegurl': 'hls',
    'audio/x-mpegurl': 'hls',
    'video/x-mpegurl': 'hls',
    'application/mpegurl': 'hls',
    'application/dash+xml': 'dash',
    'video/vnd.mpeg.dash.mpd': 'dash',
    'application/f4m+xml': 'hds',
    'application/vnd.ms-sstr+xml': 'mss',
  };

  const SEGMENT_MIME = new Set(['video/mp2t', 'video/iso.segment', 'audio/iso.segment', 'text/vtt']);

  // MIME → extensión de salida.
  const MIME_EXT = {
    'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'video/x-matroska': 'mkv', 'video/ogg': 'ogv', 'video/x-flv': 'flv', 'video/x-msvideo': 'avi',
    'video/avi': 'avi', 'video/x-ms-wmv': 'wmv', 'video/x-ms-asf': 'asf', 'video/3gpp': '3gp',
    'video/3gpp2': '3g2', 'video/mpeg': 'mpg', 'video/mp2t': 'ts',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/aac': 'aac', 'audio/aacp': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
    'audio/webm': 'weba', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/x-ms-wma': 'wma', 'audio/x-matroska': 'mka',
  };

  // Hosts cuyo contenido no se puede descargar de forma directa (se sugiere grabación MSE o yt-dlp).
  const SPECIAL_HOSTS = [
    { re: /(^|\.)googlevideo\.com$/, reason: 'youtube' },
  ];

  function extOf(url) {
    try {
      const p = new URL(url).pathname;
      const m = /\.([a-z0-9]{2,5})$/i.exec(p);
      return m ? m[1].toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }

  function cleanMime(ct) {
    return (ct || '').split(';')[0].trim().toLowerCase();
  }

  /**
   * Clasifica una respuesta de red.
   * @returns {null | {kind:'direct'|'manifest'|'segment'|'special', mediaType?, protocol?, ext?, mime?}}
   */
  function classify(url, contentType, contentDisposition) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return null; }
    const mime = cleanMime(contentType);
    let ext = extOf(url);

    // Nombre real en Content-Disposition (ej. descargas servidas desde /download?id=)
    if (contentDisposition) {
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition);
      if (m) {
        const e2 = /\.([a-z0-9]{2,5})$/i.exec(decodeURIComponent(m[1]));
        if (e2) ext = e2[1].toLowerCase();
      }
    }

    for (const s of SPECIAL_HOSTS) {
      if (s.re.test(host)) return { kind: 'special', reason: s.reason, mime, ext };
    }

    if (MANIFEST_MIME[mime]) return { kind: 'manifest', protocol: MANIFEST_MIME[mime], mime, ext };
    if (MANIFEST_EXT[ext] && (!mime || /mpegurl|dash|xml|text|octet|binary/.test(mime))) {
      return { kind: 'manifest', protocol: MANIFEST_EXT[ext], mime, ext };
    }

    if (SEGMENT_MIME.has(mime) || SEGMENT_EXT.has(ext)) return { kind: 'segment', mime, ext };

    if (mime.startsWith('video/') || mime.startsWith('audio/')) {
      const outExt = MIME_EXT[mime] || DIRECT_EXT[ext] && ext || mime.split('/')[1].replace(/^x-/, '');
      return { kind: 'direct', mediaType: mime.startsWith('audio/') ? 'audio' : 'video', mime, ext: outExt };
    }

    // Servidores que mandan video como octet-stream o sin content-type.
    if (DIRECT_EXT[ext] && (!mime || /octet-stream|binary|force-download|unknown/.test(mime))) {
      return { kind: 'direct', mediaType: DIRECT_EXT[ext], mime: mime || 'application/octet-stream', ext };
    }
    return null;
  }

  function extForMime(mime) {
    return MIME_EXT[cleanMime(mime)] || '';
  }

  /** Describe códecs RFC 6381 en forma legible: avc1.640028 → H.264 */
  function codecLabel(codecs) {
    if (!codecs) return '';
    return codecs.split(',').map((c) => {
      c = c.trim().toLowerCase();
      if (/^(avc1|avc3)/.test(c)) return 'H.264';
      if (/^(hvc1|hev1)/.test(c)) return 'H.265';
      if (/^(dvh1|dvhe|dva1|dvav)/.test(c)) return 'Dolby Vision';
      if (/^av01/.test(c)) return 'AV1';
      if (/^vp0?9/.test(c)) return 'VP9';
      if (/^vp0?8/.test(c)) return 'VP8';
      if (/^mp4a\.40\.(2|5|29)/.test(c)) return 'AAC';
      if (/^mp4a\.6b|^mp3/.test(c)) return 'MP3';
      if (/^(ac-3|ac3)/.test(c)) return 'AC-3';
      if (/^(ec-3|eac3)/.test(c)) return 'E-AC-3';
      if (/^opus/.test(c)) return 'Opus';
      if (/^vorbis/.test(c)) return 'Vorbis';
      if (/^flac/.test(c)) return 'FLAC';
      if (/^(stpp|wvtt)/.test(c)) return 'Subt.';
      return c.split('.')[0];
    }).join(' + ');
  }

  /** Contenedor de salida razonable para un conjunto de códecs. */
  function containerFor(videoCodecs, audioCodecs, hint) {
    const all = `${videoCodecs || ''},${audioCodecs || ''}`.toLowerCase();
    if (/vp0?8|vp0?9|opus|vorbis/.test(all) && !/avc|hvc|hev|mp4a|ac-3|ec-3/.test(all)) return 'webm';
    if (/vp0?8|vp0?9|opus|vorbis/.test(all)) return 'mkv';
    return hint || 'mp4';
  }

  function qualityLabel(height, width) {
    if (!height) return '';
    // En videos verticales la "calidad" la da el lado corto.
    const p = width && width < height ? width : height;
    if (p >= 4320) return '8K';
    if (p >= 2160) return '4K';
    if (p >= 1440) return '1440p';
    return `${p}p`;
  }

  FFVD.formats = {
    DIRECT_EXT, MANIFEST_EXT, MANIFEST_MIME, SEGMENT_EXT, MIME_EXT,
    classify, extOf, cleanMime, extForMime, codecLabel, containerFor, qualityLabel,
  };
})(typeof self !== 'undefined' ? self : this);
