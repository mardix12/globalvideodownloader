/* Envoltorio de ffmpeg.wasm (single-thread, sin SharedArrayBuffer). Expone FFVD.mux
 * Las entradas se montan con WORKERFS (se leen directo del Blob, sin copiarlas a la memoria de wasm);
 * solo la salida ocupa memoria dentro de ffmpeg. */
(function (root) {
  'use strict';
  const FFVD = (root.FFVD = root.FFVD || {});
  const t = (...a) => (FFVD.t ? FFVD.t(...a) : a[0]);

  // Límite práctico: las entradas se leen del Blob, pero la salida (≈ mismo tamaño) vive en la
  // memoria de wasm, que en wasm32 tiene tope de 2–4 GB. Por encima de esto se guardan las pistas por separado.
  const MAX_INPUT_BYTES = 1.5 * 1024 * 1024 * 1024;

  let ffPromise = null;
  let busy = Promise.resolve();

  function getFFmpeg() {
    if (!ffPromise) {
      ffPromise = (async () => {
        const ff = new FFmpegWASM.FFmpeg();
        await ff.load({
          coreURL: browser.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'),
          wasmURL: browser.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm'),
        });
        return ff;
      })().catch((e) => { ffPromise = null; throw e; });
    }
    return ffPromise;
  }

  /** Reinicia ffmpeg (libera toda la memoria de wasm). */
  function reset() {
    if (ffPromise) ffPromise.then((ff) => ff.terminate()).catch(() => {});
    ffPromise = null;
  }

  /**
   * Ejecuta ffmpeg con entradas Blob y devuelve el Blob de salida.
   * @param {Array<{name:string, blob:Blob}>} inputs
   * @param {(inputs:string[], out:string)=>string[]} buildArgs
   * @param {string} outName nombre de salida (define el contenedor por extensión)
   */
  function run(inputs, buildArgs, outName, { onProgress, onLog } = {}) {
    // ffmpeg.wasm no es reentrante: se serializan los trabajos.
    const job = busy.then(() => runNow(inputs, buildArgs, outName, onProgress, onLog));
    busy = job.catch(() => {});
    return job;
  }

  async function runNow(inputs, buildArgs, outName, onProgress, onLog) {
    const totalIn = inputs.reduce((s, i) => s + i.blob.size, 0);
    if (totalIn > MAX_INPUT_BYTES) {
      const e = new Error(t('err_tooBig'));
      e.code = 'TOO_BIG';
      throw e;
    }
    const ff = await getFFmpeg();
    const logs = [];
    const logCb = ({ message }) => { logs.push(message); if (logs.length > 60) logs.shift(); if (onLog) onLog(message); };
    const progCb = ({ progress }) => { if (onProgress && progress >= 0 && progress <= 1) onProgress(progress); };
    ff.on('log', logCb);
    ff.on('progress', progCb);
    const mnt = `/in${Date.now()}`;
    try {
      await ff.createDir(mnt);
      await ff.mount('WORKERFS', { blobs: inputs.map((i) => ({ name: i.name, data: i.blob })) }, mnt);
      const args = buildArgs(inputs.map((i) => `${mnt}/${i.name}`), outName);
      const ret = await ff.exec(['-hide_banner', '-y', ...args]);
      if (ret !== 0) {
        const e = new Error(t('err_ffmpegCode', ret));
        e.logs = logs.slice(-15).join('\n');
        throw e;
      }
      const data = await ff.readFile(outName);
      await ff.deleteFile(outName).catch(() => {});
      return new Blob([data.buffer], { type: mimeFor(outName) });
    } catch (e) {
      if (!e.logs) e.logs = logs.slice(-15).join('\n');
      // Tras un error (ej. sin memoria) la instancia puede quedar inservible.
      reset();
      throw e;
    } finally {
      ff.off('log', logCb);
      ff.off('progress', progCb);
      try { await ff.unmount(mnt); await ff.deleteDir(mnt); } catch (e) { /* noop */ }
    }
  }

  function mimeFor(name) {
    const ext = name.split('.').pop();
    return { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', m4a: 'audio/mp4', mp3: 'audio/mpeg', ts: 'video/mp2t' }[ext] || 'application/octet-stream';
  }

  /** Une video + audio sin recodificar. */
  function muxAV(videoBlob, videoExt, audioBlob, audioExt, outExt, cb) {
    return run(
      [{ name: `v.${videoExt}`, blob: videoBlob }, { name: `a.${audioExt}`, blob: audioBlob }],
      ([v, a], out) => ['-i', v, '-i', a, '-map', '0:v:0?', '-map', '1:a:0?', '-c', 'copy', out],
      `out.${outExt}`,
      cb,
    );
  }

  /** Cambia de contenedor sin recodificar (TS → MP4, fMP4 → MP4, etc.). */
  function remux(blob, inExt, outExt, cb) {
    return run(
      [{ name: `i.${inExt}`, blob }],
      ([i], out) => ['-i', i, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', out],
      `out.${outExt}`,
      cb,
    );
  }

  FFVD.mux = { muxAV, remux, reset, MAX_INPUT_BYTES };
})(typeof self !== 'undefined' ? self : this);
