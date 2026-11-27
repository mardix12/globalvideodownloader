/* Motor de descargas.
 *
 * - Cola con hasta `maxJobs` trabajos a la vez (opción; por defecto 5): directos (gestor de descargas del
 *   navegador), HLS / DASH (segmentos + ffmpeg.wasm) y grabaciones MSE.
 * - El estado de todos los trabajos de la sesión se guarda en storage.session ("jobsState"): la página
 *   "Descargas" solo lo muestra, y si el contexto se reinicia se recupera el historial.
 * - Dónde corre: en Firefox, en el background (event page); en Chrome, en un offscreen document
 *   (el service worker no tiene DOM ni Workers para ffmpeg). Todo lo que depende del navegador va por `env`:
 *     download({url, filename}) → id · searchDownload(id) · cancelDownload(id) · eraseDownload(id)
 *     onDownloadChanged(cb) · saveState(list) · loadState() · getRecording(job) · setBusy(bool)
 *     registerReferer(url, referer) · getSettings()
 * Expone FFVD.jobs.
 */
(function (root) {
  'use strict';
  const FFVD = (root.FFVD = root.FFVD || {});
  const { util, hls, dash, downloader, mux, t } = FFVD;

  const DEFAULT_MAX_JOBS = 5;
  const STORE_KEY = 'jobsState';
  const KIND_KEY = { direct: 'kind_direct', hls: 'kind_hls', dash: 'kind_dash', mse: 'kind_mse' };

  /** id → { job, state, text, progress, log, downloadId, createdAt, finishedAt, ctrl } */
  const records = new Map();
  const queue = [];
  let running = 0;
  const blobUrls = new Map(); // downloadId → objectURL
  let env = null;

  const settings = () => env.getSettings() || {};
  const maxJobs = () => Math.max(1, Math.min(20, parseInt(settings().maxJobs, 10) || DEFAULT_MAX_JOBS));

  // ---------- Persistencia / aviso a la UI ----------

  let saveTimer = null;
  function schedulePersist(now = false) {
    if (saveTimer && !now) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      Promise.resolve(env.saveState([...records.values()].map(snapshot))).catch((e) => console.warn('[gvd] jobs persist', e));
      updateBusy();
    }, now ? 0 : 300);
  }

  function snapshot(r) {
    return {
      id: r.job.id, job: r.job, kindLabel: t(KIND_KEY[r.job.type] || 'kind_direct'), state: r.state, text: r.text,
      progress: r.progress, log: r.log || '', downloadId: r.downloadId, createdAt: r.createdAt, finishedAt: r.finishedAt || null,
    };
  }

  let busy = false;
  function updateBusy() {
    const now = blobUrls.size > 0 || [...records.values()].some((r) => r.state === 'queued' || r.state === 'running');
    if (now !== busy) { busy = now; env.setBusy(now); }
  }

  function setState(rec, state, text, progress) {
    // Un aviso de progreso que llega tarde no "revive" un trabajo cancelado.
    if (rec.state === 'cancelled' && state === 'running') return;
    const changed = rec.state !== state;
    rec.state = state;
    rec.text = text;
    rec.progress = state === 'done' ? 1 : (progress == null ? null : Math.max(0, Math.min(1, progress)));
    if (['done', 'error', 'cancelled'].includes(state)) rec.finishedAt = Date.now();
    schedulePersist(changed);
  }

  function setLog(rec, text) {
    rec.log = text || '';
    schedulePersist();
  }

  // ---------- API pública ----------

  function add(job) {
    job.id = job.id || util.uid();
    job.createdAt = job.createdAt || Date.now();
    if (records.has(job.id)) return job.id;
    const rec = { job, state: 'queued', text: t('job_queued'), progress: null, log: '', downloadId: null, createdAt: job.createdAt, ctrl: null };
    records.set(job.id, rec);
    queue.push(rec);
    schedulePersist(true);
    pump();
    return job.id;
  }

  function cancel(id) {
    const rec = records.get(id);
    if (!rec) return;
    if (rec.ctrl) rec.ctrl.abort();
    const i = queue.indexOf(rec);
    if (i >= 0) queue.splice(i, 1);
    if (rec.state === 'running' && rec.job.type === 'direct' && rec.downloadId != null) Promise.resolve(env.cancelDownload(rec.downloadId)).catch(() => {});
    if (rec.state === 'queued' || rec.state === 'running') setState(rec, 'cancelled', t('job_cancelled'), 0);
  }

  function retry(id) {
    const rec = records.get(id);
    if (!rec || !['error', 'cancelled'].includes(rec.state)) return;
    rec.log = '';
    rec.downloadId = null;
    rec.finishedAt = null;
    setState(rec, 'queued', t('job_queued'), null);
    queue.push(rec);
    pump();
  }

  function clearDone() {
    for (const [id, rec] of records) if (['done', 'cancelled', 'error'].includes(rec.state)) records.delete(id);
    schedulePersist(true);
  }

  /** Se llama cuando cambian las opciones (ej. más descargas en paralelo). */
  function settingsChanged() { pump(); }

  /** Al arrancar: recupera el historial de la sesión. */
  async function restore() {
    const list = (await env.loadState()) || [];
    for (const it of list) {
      if (records.has(it.id)) continue;
      const rec = { job: it.job, state: it.state, text: it.text, progress: it.progress, log: it.log, downloadId: it.downloadId,
        createdAt: it.createdAt, finishedAt: it.finishedAt, ctrl: null };
      records.set(it.id, rec);
      if (rec.state === 'queued') {
        queue.push(rec);
      } else if (rec.state === 'running') {
        if (rec.job.type === 'direct' && rec.downloadId != null) {
          // La descarga la sigue haciendo el navegador: volver a seguirla.
          running++;
          rec.ctrl = new AbortController();
          waitDownload(rec, rec.downloadId)
            .catch((e) => finishWithError(rec, e))
            .finally(() => { running--; pump(); });
        } else {
          setState(rec, 'error', t('job_interrupted'), 0);
        }
      }
    }
    schedulePersist(true);
    pump();
  }

  function init(e) {
    env = e;
    env.onDownloadChanged((d) => {
      if (d.state && d.state !== 'in_progress' && blobUrls.has(d.id)) {
        URL.revokeObjectURL(blobUrls.get(d.id));
        blobUrls.delete(d.id);
        updateBusy();
      }
    });
  }

  // ---------- Planificador ----------

  function pump() {
    while (running < maxJobs() && queue.length) {
      const rec = queue.shift();
      running++;
      run(rec).finally(() => { running--; pump(); });
    }
  }

  function finishWithError(rec, e) {
    if (e instanceof downloader.Cancelled || (e && e.name === 'AbortError')) {
      if (rec.state !== 'cancelled') setState(rec, 'cancelled', t('job_cancelled'), 0);
    } else {
      console.error(e);
      setState(rec, 'error', t('job_error', e.message || e), 0);
      if (e.logs) setLog(rec, e.logs);
    }
  }

  async function run(rec) {
    rec.ctrl = new AbortController();
    setLog(rec, '');
    setState(rec, 'running', t('job_preparing'), null);
    try {
      if (rec.job.type === 'direct') await runDirect(rec);
      else await runStreams(rec);
    } catch (e) {
      finishWithError(rec, e);
    }
  }

  // ---------- Descarga directa (la hace el gestor de descargas del navegador) ----------

  async function runDirect(rec) {
    const { job } = rec;
    const urls = [job.url, job.altUrl].filter(Boolean);
    for (let i = 0; i < urls.length; i++) {
      if (job.referer) await env.registerReferer(urls[i], job.referer);
      const id = await env.download({ url: urls[i], filename: `${util.sanitizeFilename(job.filename)}.${job.ext || 'mp4'}` });
      rec.downloadId = id;
      setState(rec, 'running', t(i ? 'job_downloadingAlt' : 'job_downloading'), 0);
      try {
        await waitDownload(rec, id);
        return;
      } catch (e) {
        if (e instanceof downloader.Cancelled) throw e;
        Promise.resolve(env.eraseDownload(id)).catch(() => {});
        // Si falla la URL principal (ej. venció), se prueba la otra con la que se detectó el mismo archivo.
        if (i < urls.length - 1) continue;
        // El servidor rechazó al gestor de descargas (en Chrome no se le puede poner Referer):
        // se descarga desde la extensión, donde el Referer sí se aplica, y se guarda el resultado.
        if (job.referer && /^SERVER_|^NETWORK_/.test(e.dlError || '')) return runDirectViaFetch(rec);
        throw e;
      }
    }
  }

  async function runDirectViaFetch(rec) {
    const { job } = rec;
    const h = util.humanSize;
    setState(rec, 'running', t('job_downloading'), 0);
    const blob = await downloader.downloadSegments([{ url: job.url, single: true }], {
      referer: job.referer,
      signal: rec.ctrl.signal,
      mime: job.mime,
      onProgress: (bytes, total) => setState(rec, 'running', total > bytes
        ? t('job_downloadingOf', h(bytes), h(total))
        : t('job_downloadingBytes', h(bytes)), total > bytes ? bytes / total : null),
    });
    await saveBlob(rec, blob, `${util.sanitizeFilename(job.filename)}.${job.ext || 'mp4'}`);
  }

  function waitDownload(rec, id) {
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (rec.state === 'cancelled') { reject(new downloader.Cancelled()); return; }
        let d;
        try { d = await env.searchDownload(id); } catch (e) { d = null; }
        if (!d) { reject(new Error(t('err_dlGone'))); return; }
        if (d.state === 'complete') {
          setState(rec, 'done', t('job_done', util.humanSize(d.fileSize || d.bytesReceived)));
          resolve();
          return;
        }
        if (d.state === 'interrupted') {
          if (d.error === 'USER_CANCELED') reject(new downloader.Cancelled());
          else reject(Object.assign(new Error(t('err_dlInterrupted', d.error)), { dlError: d.error }));
          return;
        }
        if (rec.state === 'running') {
          const p = d.totalBytes > 0 ? d.bytesReceived / d.totalBytes : null;
          setState(rec, 'running', d.totalBytes > 0
            ? t('job_downloadingOf', util.humanSize(d.bytesReceived), util.humanSize(d.totalBytes))
            : t('job_downloadingBytes', util.humanSize(d.bytesReceived)), p);
        }
        setTimeout(tick, 700);
      };
      tick();
    });
  }

  // ---------- HLS / DASH / MSE ----------

  /** Devuelve [{role:'video'|'audio'|'muxed', ext, segments? | blob?, codecs}] */
  async function resolveStreams(rec) {
    const { job } = rec;
    const signal = rec.ctrl.signal;

    if (job.type === 'hls') {
      const load = async (url) => {
        const r = await util.siteFetch(url, { referer: job.referer, signal });
        if (!r.ok) throw new Error(t('err_playlist', r.status));
        let p = hls.parse(await r.text(), r.url || url);
        if (p.type === 'master') {
          // Se eligió "automático": mejor variante.
          const best = p.variants[0];
          const r2 = await util.siteFetch(best.url, { referer: job.referer, signal });
          p = hls.parse(await r2.text(), r2.url || best.url);
        }
        if (p.drm) throw new Error(t('err_drmStream'));
        return p;
      };
      const v = await load(job.url);
      const streams = [{ role: job.audioUrl ? 'video' : (job.audioOnly ? 'audio' : 'muxed'), ext: hlsExt(v), segments: v.segments, live: v.live }];
      if (job.audioUrl) {
        const a = await load(job.audioUrl);
        streams.push({ role: 'audio', ext: hlsExt(a), segments: a.segments });
      }
      return streams;
    }

    if (job.type === 'dash') {
      const r = await util.siteFetch(job.url, { referer: job.referer, signal });
      if (!r.ok) throw new Error(t('err_mpd', r.status));
      const p = dash.parse(await r.text(), r.url || job.url);
      const pick = (list, id) => list.find((x) => x.id === id) || list[0];
      const streams = [];
      if (job.videoId !== null && p.video.length) {
        const v = pick(p.video, job.videoId);
        if (v.drm) throw new Error(t('err_drmVideo'));
        if (!v.segments.length) throw new Error(t('err_noSegments'));
        streams.push({ role: 'video', ext: v.container, segments: v.segments, codecs: v.codecs });
      }
      if (job.audioId !== null && p.audio.length) {
        const a = pick(p.audio, job.audioId);
        if (a.drm) throw new Error(t('err_drmAudio'));
        streams.push({ role: 'audio', ext: a.container === 'webm' ? 'webm' : 'm4a', segments: a.segments, codecs: a.codecs });
      }
      if (!streams.length) throw new Error(t('err_noTracks'));
      if (streams.length === 1 && streams[0].role === 'video') streams[0].role = 'muxed';
      return streams;
    }

    if (job.type === 'mse') {
      setState(rec, 'running', t('job_askRecording'), null);
      const res = await env.getRecording(job);
      if (!res || !res.tracks || !res.tracks.length) throw new Error(t('err_noRecording'));
      const dropped = res.tracks.filter((x) => x.parts > 1);
      if (dropped.length) {
        setLog(rec, t('log_qualityChanged', util.humanSize(dropped.reduce((s, x) => s + (x.droppedBytes || 0), 0))));
      }
      const streams = res.tracks.map((x) => {
        const isAudio = /^audio\//.test(x.mime);
        const webm = /webm/.test(x.mime);
        return { role: isAudio ? 'audio' : 'video', ext: webm ? 'webm' : (isAudio ? 'm4a' : 'mp4'), blob: x.blob, codecs: (/codecs="?([^"]+)"?/.exec(x.mime) || [])[1] || '' };
      });
      const hasVideo = streams.some((s) => s.role === 'video');
      const v = streams.filter((s) => s.role === 'video').sort((a, b) => b.blob.size - a.blob.size)[0];
      const a = streams.filter((s) => s.role === 'audio').sort((x, y) => y.blob.size - x.blob.size)[0];
      const out = [v, a].filter(Boolean);
      if (out.length === 1 && hasVideo) out[0].role = 'muxed';
      return out;
    }
    throw new Error(t('err_unknownType', job.type));
  }

  function hlsExt(p) {
    if (p.container === 'mp4') return 'mp4';
    if (p.container === 'audio') {
      const m = /\.(aac|mp3|ac3)(\?|$)/i.exec(p.segments[0] && p.segments[0].url);
      return m ? m[1].toLowerCase() : 'aac';
    }
    return 'ts';
  }

  async function runStreams(rec) {
    const { job } = rec;
    const signal = rec.ctrl.signal;
    const opts = settings();
    const streams = await resolveStreams(rec);

    // 1) Descarga (el 85 % de la barra; el resto es ffmpeg)
    const weights = streams.map((s) => (s.blob ? 0 : (s.role === 'audio' ? 0.15 : 0.85)));
    const wTotal = weights.reduce((a, b) => a + b, 0) || 1;
    let base = 0;
    for (let i = 0; i < streams.length; i++) {
      const s = streams[i];
      if (s.blob) continue;
      const w = weights[i] / wTotal;
      const label = t(s.role === 'audio' ? 'word_audio' : 'word_video');
      if (s.live) setLog(rec, t('log_live'));
      s.blob = await downloader.downloadSegments(s.segments, {
        referer: job.referer,
        concurrency: opts.concurrency,
        signal,
        onProgress: (done, total, bytes, isBytes) => {
          const frac = total ? done / total : 0;
          const text = isBytes ? t('job_dlStream', label, util.humanSize(bytes)) : t('job_dlSegments', label, done, total, util.humanSize(bytes));
          setState(rec, 'running', text, (base + frac * w) * 0.85);
        },
      });
      base += w;
    }
    if (signal.aborted) throw new downloader.Cancelled();

    // 2) Unión / conversión (ffmpeg procesa de a un trabajo: el resto espera en "Uniendo…")
    const name = util.sanitizeFilename(job.filename);
    const onProgress = (p) => setState(rec, 'running', t('job_muxing'), 0.85 + p * 0.15);
    const video = streams.find((s) => s.role === 'video' || s.role === 'muxed');
    const audio = streams.find((s) => s.role === 'audio');

    if (video && audio) {
      const outExt = (video.ext === 'webm' && audio.ext === 'webm') ? 'webm'
        : (video.ext === 'webm' || audio.ext === 'webm') ? 'mkv' : 'mp4';
      setState(rec, 'running', t('job_muxingAV'), 0.85);
      try {
        const out = await mux.muxAV(video.blob, video.ext, audio.blob, audio.ext, outExt, { onProgress });
        await saveBlob(rec, out, `${name}.${outExt}`);
        return;
      } catch (e) {
        if (signal.aborted) throw new downloader.Cancelled();
        setLog(rec, `${t('log_muxFailed', e.message)}\n${e.logs || ''}`);
        await saveBlob(rec, video.blob, `${name}.video.${video.ext}`, true);
        await saveBlob(rec, audio.blob, `${name}.audio.${audio.ext}`);
        return;
      }
    }

    const only = video || audio;
    const isAudio = only.role === 'audio';
    // .ts → MP4 y fMP4 fragmentado → MP4 normal (mejor compatibilidad con reproductores y editores).
    const needsRemux = opts.convert !== false && ['ts', 'mp4', 'aac', 'm4a'].includes(only.ext);
    if (needsRemux) {
      const outExt = isAudio ? 'm4a' : 'mp4';
      setState(rec, 'running', t('job_converting', outExt.toUpperCase()), 0.85);
      try {
        const out = await mux.remux(only.blob, only.ext, outExt, { onProgress });
        await saveBlob(rec, out, `${name}.${outExt}`);
        return;
      } catch (e) {
        if (signal.aborted) throw new downloader.Cancelled();
        setLog(rec, `${t('log_convertFailed', e.message)}\n${e.logs || ''}`);
      }
    }
    await saveBlob(rec, only.blob, `${name}.${only.ext}`);
  }

  async function saveBlob(rec, blob, filename, partial) {
    if (rec.ctrl.signal.aborted) throw new downloader.Cancelled();
    setState(rec, 'running', t('job_saving', filename), 0.99);
    const url = URL.createObjectURL(blob);
    const id = await env.download({ url, filename });
    // El objectURL tiene que vivir hasta que el navegador termine de copiarlo.
    blobUrls.set(id, url);
    updateBusy();
    rec.downloadId = id;
    if (!partial) setState(rec, 'done', t('job_doneFile', filename, util.humanSize(blob.size)));
  }

  FFVD.jobs = { init, restore, add, cancel, retry, clearDone, settingsChanged, STORE_KEY, DEFAULT_MAX_JOBS };
})(typeof self !== 'undefined' ? self : this);
