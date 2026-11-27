/* Service worker de Chrome: carga las mismas piezas que el background de Firefox, salvo el motor de descargas
 * (que en Chrome corre en src/offscreen/). */
importScripts(
  '../lib/compat.js',
  '../lib/formats.js',
  '../lib/util.js',
  '../lib/hls.js',
  '../lib/dash.js',
  'platform-chrome.js',
  'background.js',
);
