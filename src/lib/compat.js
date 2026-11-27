/* Capa de compatibilidad Firefox / Chrome + traducciones. Se carga primero en todos los contextos.
 * - `browser` existe en Firefox; en Chrome se usa `chrome` (las APIs de MV3 devuelven promesas).
 * - FFVD.target: 'firefox' | 'chrome' (según el manifest: Chrome usa service worker).
 * - FFVD.t(clave, ...valores): texto traducido de _locales; "{1}", "{2}"… se reemplazan por los valores.
 * - FFVD.localize(raíz): completa los elementos con data-i18n / data-i18n-title / -placeholder / -aria-label.
 * - FFVD.onMessage(handler): listener de runtime.onMessage que funciona igual en los dos navegadores
 *   (handler devuelve un valor, una promesa o undefined = "no es para mí").
 */
(function (root) {
  'use strict';
  if (typeof root.browser === 'undefined' && typeof root.chrome !== 'undefined') root.browser = root.chrome;
  const FFVD = (root.FFVD = root.FFVD || {});
  if (FFVD.t) return;

  let target = 'firefox';
  try {
    const bg = browser.runtime.getManifest().background || {};
    if (bg.service_worker) target = 'chrome';
  } catch (e) { /* content script sin getManifest: no importa */ }
  FFVD.target = target;
  FFVD.isChrome = target === 'chrome';

  function t(key, ...subs) {
    let s = '';
    // El offscreen document de Chrome no tiene i18n: usa el diccionario que carga con FFVD.loadMessages().
    if (FFVD.messages) s = (FFVD.messages[key] || {}).message || '';
    else try { s = browser.i18n.getMessage(key); } catch (e) { /* noop */ }
    if (!s) s = key;
    return subs.length ? s.replace(/\{(\d)\}/g, (m, i) => (subs[i - 1] != null ? String(subs[i - 1]) : '')) : s;
  }

  function localize(rootEl) {
    const doc = rootEl || document;
    doc.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      doc.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`))));
    }
    if (doc === document) {
      document.documentElement.lang = (browser.i18n.getUILanguage() || 'en').split('-')[0];
      if (document.title && document.title.startsWith('__')) document.title = t(document.title.slice(2));
    }
  }

  function onMessage(handler) {
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      let r;
      try { r = handler(msg, sender); } catch (e) { console.error(e); return false; }
      if (r === undefined) return false;
      Promise.resolve(r).then(
        (v) => sendResponse(v === undefined ? null : v),
        (e) => { console.error(e); sendResponse(null); },
      );
      return true; // respuesta asíncrona
    });
  }

  /** Carga _locales/<locale>/messages.json a mano (para contextos sin browser.i18n), con caída a "en". */
  async function loadMessages(uiLocale) {
    const loc = String(uiLocale || 'en').replace('-', '_');
    const candidates = [...new Set([loc, loc.split('_')[0], 'en'])];
    const merged = {};
    // Primero el idioma por defecto y encima el más específico, como hace el navegador.
    for (const c of candidates.reverse()) {
      try {
        const r = await fetch(browser.runtime.getURL(`_locales/${c}/messages.json`));
        if (r.ok) Object.assign(merged, await r.json());
      } catch (e) { /* ese idioma no existe */ }
    }
    FFVD.messages = merged;
  }

  FFVD.t = t;
  FFVD.loadMessages = loadMessages;
  FFVD.localize = localize;
  FFVD.onMessage = onMessage;
})(typeof self !== 'undefined' ? self : this);
