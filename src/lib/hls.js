/* Parser HLS (RFC 8216 + extensiones comunes). Expone FFVD.hls
 *
 * parse(text, url) devuelve:
 *  - { type:'master', variants[], audio[], subtitles[], drm }
 *  - { type:'media', segments[], duration, live, encryption, drm }
 *
 * Segmento: { url, duration, range?:[ini,fin], key?:{method,uri,iv}, init?:true }
 */
(function (root) {
  'use strict';
  const FFVD = (root.FFVD = root.FFVD || {});
  const t = (...a) => (FFVD.t ? FFVD.t(...a) : a[0]);

  function parseAttrs(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      let v = m[2];
      if (v.startsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  function resolve(u, base) {
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  function parseByteRange(s, lastEnd) {
    // "longitud[@offset]"
    const [len, off] = s.split('@');
    const start = off != null ? parseInt(off, 10) : lastEnd;
    const length = parseInt(len, 10);
    return [start, start + length - 1];
  }

  function ivFromHex(hex) {
    hex = hex.replace(/^0x/i, '').padStart(32, '0');
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    return iv;
  }

  function ivFromSeq(seq) {
    const iv = new Uint8Array(16);
    let n = seq;
    for (let i = 15; i >= 0 && n > 0; i--) { iv[i] = n & 0xff; n = Math.floor(n / 256); }
    return iv;
  }

  // KEYFORMAT de sistemas DRM (FairPlay, Widevine, PlayReady).
  const DRM_KEYFORMATS = /streamingkeydelivery|widevine|edef8ba9|playready|9a04f079|com\.apple\.fps/i;

  function isDrmKey(attrs) {
    const method = (attrs.METHOD || '').toUpperCase();
    const fmt = attrs.KEYFORMAT || 'identity';
    if (method === 'NONE' || method === '') return false;
    if (DRM_KEYFORMATS.test(fmt) || /^skd:/i.test(attrs.URI || '')) return true;
    // SAMPLE-AES con identity es técnicamente descifrable pero no lo soportamos: se trata como protegido.
    return method !== 'AES-128';
  }

  function parse(text, url) {
    const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
      throw new Error(t('err_badM3u8'));
    }
    const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
    return isMaster ? parseMaster(lines, url) : parseMedia(lines, url);
  }

  function parseMaster(lines, base) {
    const variants = [];
    const audio = [];
    const subtitles = [];
    let drm = false;
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (j >= lines.length) break;
        const vurl = resolve(lines[j], base);
        i = j;
        const [w, h] = (a.RESOLUTION || '').split('x').map((n) => parseInt(n, 10));
        const key = `${vurl}`;
        if (seen.has(key)) continue; // variantes duplicadas (CDN de respaldo)
        seen.add(key);
        variants.push({
          url: vurl,
          bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
          avgBandwidth: parseInt(a['AVERAGE-BANDWIDTH'], 10) || 0,
          width: w || 0,
          height: h || 0,
          codecs: a.CODECS || '',
          frameRate: parseFloat(a['FRAME-RATE']) || 0,
          audioGroup: a.AUDIO || '',
          subsGroup: a.SUBTITLES || '',
          videoRange: a['VIDEO-RANGE'] || '',
        });
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        const entry = {
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || a.LANGUAGE || '',
          lang: a.LANGUAGE || '',
          default: a.DEFAULT === 'YES',
          url: a.URI ? resolve(a.URI, base) : '',
          channels: a.CHANNELS || '',
        };
        if (a.TYPE === 'AUDIO') audio.push(entry);
        else if (a.TYPE === 'SUBTITLES') subtitles.push(entry);
      } else if (l.startsWith('#EXT-X-SESSION-KEY:')) {
        if (isDrmKey(parseAttrs(l.slice(19)))) drm = true;
      }
    }
    // Mejor calidad primero.
    variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
    return { type: 'master', variants, audio, subtitles, drm };
  }

  function parseMedia(lines, base) {
    const segments = [];
    let seq = 0;
    let duration = 0;
    let endList = false;
    let playlistType = '';
    let key = null;
    let encryption = 'none';
    let drm = false;
    let pendingDuration = 0;
    let pendingRange = null;
    let lastRangeEnd = 0;
    let lastRangeUrl = '';
    let currentMap = null;
    let mapEmitted = null;
    let discontinuities = 0;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seq = parseInt(l.slice(22), 10) || 0;
      } else if (l.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(l.slice(8)) || 0;
      } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = l.slice(17);
      } else if (l.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(l.slice(11));
        const method = (a.METHOD || 'NONE').toUpperCase();
        if (method === 'NONE') {
          key = null;
        } else if (isDrmKey(a)) {
          drm = true;
          encryption = method.toLowerCase();
          key = null;
        } else {
          encryption = 'aes-128';
          key = { method, uri: resolve(a.URI, base), iv: a.IV ? ivFromHex(a.IV) : null };
        }
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(l.slice(11));
        currentMap = { url: resolve(a.URI, base), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      } else if (l === '#EXT-X-ENDLIST') {
        endList = true;
      } else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        playlistType = l.slice(21);
      } else if (l === '#EXT-X-DISCONTINUITY') {
        discontinuities++;
      } else if (!l.startsWith('#')) {
        const surl = resolve(l, base);
        if (currentMap && currentMap !== mapEmitted) {
          segments.push({ url: currentMap.url, range: currentMap.range, duration: 0, init: true,
            key: key ? { ...key, iv: key.iv || ivFromSeq(seq) } : null });
          mapEmitted = currentMap;
        }
        let range = null;
        if (pendingRange) {
          range = parseByteRange(pendingRange, surl === lastRangeUrl ? lastRangeEnd + 1 : 0);
          lastRangeEnd = range[1];
          lastRangeUrl = surl;
        }
        segments.push({
          url: surl,
          duration: pendingDuration,
          range,
          key: key ? { method: key.method, uri: key.uri, iv: key.iv || ivFromSeq(seq) } : null,
        });
        duration += pendingDuration;
        pendingDuration = 0;
        pendingRange = null;
        seq++;
      }
    }

    // fMP4 (con EXT-X-MAP) o MPEG-TS
    const container = mapEmitted ? 'mp4' : (/\.(aac|mp3|ac3)(\?|$)/i.test(segments[0] && segments[0].url) ? 'audio' : 'ts');
    return {
      type: 'media',
      segments,
      duration,
      live: !endList && playlistType !== 'VOD',
      encryption,
      drm,
      container,
      discontinuities,
    };
  }

  FFVD.hls = { parse, parseAttrs };
})(typeof self !== 'undefined' ? self : this);
