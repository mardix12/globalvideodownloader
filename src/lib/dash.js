/* Parser MPEG-DASH (ISO/IEC 23009-1). Expone FFVD.dash
 *
 * parse(text, url) → { type:'dash', live, duration, drm, video[], audio[], subtitles[] }
 * Representación: { id, bandwidth, width, height, codecs, frameRate, mimeType, lang, label,
 *                   container, segments:[{url, range?, init?}] }
 * Soporta SegmentTemplate ($Number$/$Time$ + SegmentTimeline), SegmentList, SegmentBase/BaseURL
 * y múltiples Period (se concatenan).
 */
(function (root) {
  'use strict';
  const FFVD = (root.FFVD = root.FFVD || {});
  const t = (...a) => (FFVD.t ? FFVD.t(...a) : a[0]);

  const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
  const kid = (el, name) => kids(el, name)[0] || null;
  const attr = (el, name) => (el && el.hasAttribute(name) ? el.getAttribute(name) : null);

  function parseDuration(s) {
    if (!s) return 0;
    const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
    if (!m) return 0;
    const n = (i) => parseFloat(m[i] || 0);
    return n(1) * 31536000 + n(2) * 2592000 + n(3) * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
  }

  function resolve(u, base) {
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  function baseOf(el, parentBase) {
    const b = kid(el, 'BaseURL');
    return b && b.textContent.trim() ? resolve(b.textContent.trim(), parentBase) : parentBase;
  }

  function parseRange(s) {
    if (!s) return null;
    const [a, b] = s.split('-').map((x) => parseInt(x, 10));
    return [a, b];
  }

  function fillTemplate(tpl, vars) {
    return tpl.replace(/\$(RepresentationID|Number|Time|Bandwidth|SubNumber)(%0(\d+)d)?\$|\$\$/g, (all, name, fmt, width) => {
      if (all === '$$') return '$';
      let v = vars[name];
      if (v == null) return all;
      v = String(v);
      return width ? v.padStart(parseInt(width, 10), '0') : v;
    });
  }

  /** Combina atributos de SegmentTemplate de Period → AdaptationSet → Representation. */
  function mergedTemplate(els) {
    let out = null;
    for (const el of els) {
      const st = kid(el, 'SegmentTemplate');
      if (!st) continue;
      out = out || { attrs: {}, timeline: null };
      for (const a of st.attributes) out.attrs[a.name] = a.value;
      const tl = kid(st, 'SegmentTimeline');
      if (tl) out.timeline = tl;
    }
    return out;
  }

  function templateSegments(tpl, rep, base, periodDur) {
    const a = tpl.attrs;
    const timescale = parseInt(a.timescale || '1', 10);
    const startNumber = parseInt(a.startNumber != null ? a.startNumber : '1', 10);
    const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
    const segs = [];
    if (a.initialization) {
      segs.push({ url: resolve(fillTemplate(a.initialization, vars), base), init: true });
    }
    if (!a.media) return segs;

    if (tpl.timeline) {
      let t = 0;
      let num = startNumber;
      const S = kids(tpl.timeline, 'S');
      const endTime = periodDur ? periodDur * timescale + parseInt(a.presentationTimeOffset || '0', 10) : Infinity;
      S.forEach((s, idx) => {
        if (s.hasAttribute('t')) t = parseInt(s.getAttribute('t'), 10);
        const d = parseInt(s.getAttribute('d'), 10);
        let r = parseInt(s.getAttribute('r') || '0', 10);
        if (r < 0) {
          const next = S[idx + 1];
          const until = next && next.hasAttribute('t') ? parseInt(next.getAttribute('t'), 10) : endTime;
          r = isFinite(until) ? Math.ceil((until - t) / d) - 1 : 0;
        }
        for (let k = 0; k <= r; k++) {
          segs.push({ url: resolve(fillTemplate(a.media, { ...vars, Number: num, Time: t }), base), duration: d / timescale });
          t += d;
          num++;
        }
      });
    } else if (a.duration) {
      const d = parseInt(a.duration, 10) / timescale;
      let count = periodDur ? Math.ceil(periodDur / d - 1e-6) : 0;
      if (a.endNumber) count = parseInt(a.endNumber, 10) - startNumber + 1;
      for (let i = 0; i < count; i++) {
        const num = startNumber + i;
        segs.push({ url: resolve(fillTemplate(a.media, { ...vars, Number: num, Time: Math.round(i * d * timescale) }), base), duration: d });
      }
    }
    return segs;
  }

  function listSegments(sl, base) {
    const segs = [];
    const init = kid(sl, 'Initialization');
    if (init) {
      segs.push({ url: resolve(attr(init, 'sourceURL') || '', base), range: parseRange(attr(init, 'range')), init: true });
    }
    const timescale = parseInt(attr(sl, 'timescale') || '1', 10);
    const dur = parseInt(attr(sl, 'duration') || '0', 10) / timescale;
    for (const su of kids(sl, 'SegmentURL')) {
      segs.push({ url: resolve(attr(su, 'media') || '', base), range: parseRange(attr(su, 'mediaRange')), duration: dur });
    }
    return segs;
  }

  function hasDrm(...els) {
    return els.some((el) => kids(el, 'ContentProtection').some((cp) => {
      const scheme = (attr(cp, 'schemeIdUri') || '').toLowerCase();
      // urn:mpeg:dash:mp4protection:2011 solo indica "cenc"; los UUID indican el DRM concreto.
      // Cualquiera de los dos implica contenido cifrado.
      return scheme.length > 0;
    }));
  }

  function contentTypeOf(as, rep) {
    const ct = attr(as, 'contentType');
    if (ct) return ct;
    const mime = attr(rep, 'mimeType') || attr(as, 'mimeType') || '';
    if (mime.startsWith('video')) return 'video';
    if (mime.startsWith('audio')) return 'audio';
    if (mime.startsWith('text') || /stpp|wvtt/.test(attr(rep, 'codecs') || attr(as, 'codecs') || '') || mime.includes('ttml')) return 'text';
    return 'unknown';
  }

  function parsePeriod(period, mpdBase, periodDur) {
    const pBase = baseOf(period, mpdBase);
    const out = { video: [], audio: [], subtitles: [], drm: false };
    for (const as of kids(period, 'AdaptationSet')) {
      const asBase = baseOf(as, pBase);
      for (const rep of kids(as, 'Representation')) {
        const rBase = baseOf(rep, asBase);
        const type = contentTypeOf(as, rep);
        const mimeType = attr(rep, 'mimeType') || attr(as, 'mimeType') || '';
        const r = {
          id: attr(rep, 'id') || '',
          bandwidth: parseInt(attr(rep, 'bandwidth') || '0', 10),
          width: parseInt(attr(rep, 'width') || attr(as, 'width') || '0', 10),
          height: parseInt(attr(rep, 'height') || attr(as, 'height') || '0', 10),
          codecs: attr(rep, 'codecs') || attr(as, 'codecs') || '',
          frameRate: attr(rep, 'frameRate') || attr(as, 'frameRate') || '',
          mimeType,
          lang: attr(as, 'lang') || '',
          label: (kid(as, 'Label') && kid(as, 'Label').textContent) || attr(as, 'label') || '',
          container: /webm/.test(mimeType) ? 'webm' : 'mp4',
          segments: [],
        };
        if (hasDrm(as, rep)) { out.drm = true; r.drm = true; }

        const tpl = mergedTemplate([period, as, rep]);
        const sl = kid(rep, 'SegmentList') || kid(as, 'SegmentList');
        if (tpl) r.segments = templateSegments(tpl, r, rBase, periodDur);
        else if (sl) r.segments = listSegments(sl, rBase);
        else r.segments = [{ url: rBase, single: true }]; // SegmentBase o archivo único

        if (type === 'video') out.video.push(r);
        else if (type === 'audio') out.audio.push(r);
        else if (type === 'text') out.subtitles.push(r);
      }
    }
    return out;
  }

  /** Une representaciones equivalentes de varios Period (ej. con cortes publicitarios). */
  function mergePeriods(periods, key) {
    const first = periods[0][key];
    return first.map((rep) => {
      const merged = { ...rep, segments: [...rep.segments] };
      for (let i = 1; i < periods.length; i++) {
        const cands = periods[i][key];
        if (!cands.length) continue;
        const match = cands.find((c) => c.id === rep.id)
          || cands.reduce((best, c) => (Math.abs(c.bandwidth - rep.bandwidth) < Math.abs(best.bandwidth - rep.bandwidth) ? c : best));
        merged.segments.push(...match.segments);
      }
      return merged;
    });
  }

  function parse(text, url) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const mpd = doc.documentElement;
    if (!mpd || mpd.localName !== 'MPD') throw new Error(t('err_badMpd'));

    const live = attr(mpd, 'type') === 'dynamic';
    const total = parseDuration(attr(mpd, 'mediaPresentationDuration'));
    const mpdBase = baseOf(mpd, url);
    const periodEls = kids(mpd, 'Period');

    const periods = periodEls.map((p, i) => {
      const start = parseDuration(attr(p, 'start'));
      let dur = parseDuration(attr(p, 'duration'));
      if (!dur) {
        const next = periodEls[i + 1];
        dur = next && attr(next, 'start') ? parseDuration(attr(next, 'start')) - start : (total ? total - start : 0);
      }
      return parsePeriod(p, mpdBase, dur);
    });
    if (!periods.length) throw new Error(t('err_mpdNoPeriods'));

    const sortV = (a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth);
    const sortA = (a, b) => b.bandwidth - a.bandwidth;
    return {
      type: 'dash',
      live,
      duration: total,
      drm: periods.some((p) => p.drm),
      video: mergePeriods(periods, 'video').sort(sortV),
      audio: mergePeriods(periods, 'audio').sort(sortA),
      subtitles: mergePeriods(periods, 'subtitles'),
    };
  }

  /** Resumen sin segmentos (para la lista del popup). */
  function summarize(p) {
    const strip = (r) => ({ id: r.id, bandwidth: r.bandwidth, width: r.width, height: r.height, codecs: r.codecs,
      frameRate: r.frameRate, lang: r.lang, label: r.label, container: r.container, drm: !!r.drm });
    return { video: p.video.map(strip), audio: p.audio.map(strip), duration: p.duration, live: p.live, drm: p.drm };
  }

  FFVD.dash = { parse, parseDuration, fillTemplate, summarize };
})(typeof self !== 'undefined' ? self : this);
