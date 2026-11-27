# Publicación en Chrome Web Store y Firefox Add-ons (AMO)

Paquetes: `.\build.ps1` genera `dist/global-video-downloader-chrome-<versión>.zip` y `dist/global-video-downloader-firefox-<versión>.zip`.
Antes de cada envío hay que subir `version` en **los dos** manifests (`manifest.json` y `manifest.chrome.json`).

## Antes de enviar

1. Subir el código a un repositorio público (GitHub). La licencia GPL obliga a ofrecer el código fuente, y además sirve como URL de la política de privacidad (`PRIVACY.md`) y de soporte (Issues).
2. Revisar a mano en las dos tiendas que el nombre no esté tomado. Existe "Video Downloader Global - videos & streams" en la Chrome Web Store: el nombre es parecido, así que conviene que la descripción y el ícono se diferencien bien.
3. En la ficha de Chrome no enlazar la versión de Firefox: esa sí funciona en YouTube.

## Chrome Web Store

- Cuenta de desarrollador: pago único de USD 5 y verificación en dos pasos.
- **Categoría:** Productivity → Tools (o "Workflow & Planning").
- **Idioma principal:** English. Se pueden agregar las descripciones traducidas.
- **Recursos gráficos:** ícono 128×128 (`icons/icon128.png`), al menos 1 captura de 1280×800 (o 640×400) y un mosaico promocional de 440×280. Las capturas no pueden mostrar YouTube.

### Descripción corta (máx. 132 caracteres)
> Detect and download videos from web pages: MP4, HLS (m3u8) and DASH streams, with quality selection. No data collection.

### Descripción larga
> Global Video Downloader finds the videos and audio files a page loads and lets you save them.
>
> • Direct files: MP4, WebM, MKV, MOV, MP3, M4A and more
> • HLS (m3u8) and DASH (mpd) streams: choose the quality and audio track; video and audio are joined automatically (no re-encoding)
> • MSE recording for players that build the video with JavaScript
> • Downloads keep running in the background, with a Downloads page and history
> • Choose how many downloads run at the same time
> • Hide small files (ads, previews) with a size filter
> • Rename files before downloading
> • Available in English, Spanish, Portuguese, French and German
>
> DRM-protected content (Widevine, PlayReady, FairPlay) cannot be downloaded and is reported as such. Due to Chrome Web Store policies, this extension does not work on YouTube.
>
> Privacy: no data is collected or sent anywhere. Everything happens inside your browser.
>
> Open source (GPL-3.0).

### Propósito único (Single purpose)
> Detect video and audio files on the web pages the user visits and download the ones the user chooses.

### Justificación de permisos
| Permiso | Texto |
|---|---|
| `webRequest` | Used to observe the responses of the pages the user visits and recognize video/audio files and HLS/DASH manifests, which are listed in the popup. Requests are only observed, never blocked or modified. |
| `declarativeNetRequestWithHostAccess` | Many video servers reject requests without the page's Referer. A session rule sets the Referer/Origin of the original page only on the extension's own requests (tabId -1) to the media host, when the user downloads a file. |
| `downloads` | Saves the files the user chooses to download and shows download progress. |
| `storage` | Stores the user's options and the list of downloads of the current session. |
| `tabs` | Associates detected media with the tab it came from, uses the page title as the default file name, and opens the Downloads page. |
| `offscreen` | Video segments are downloaded and joined with ffmpeg.wasm (bundled, no remote code) in an offscreen document, because service workers cannot use Web Workers or create blob URLs. |
| Host permissions (`<all_urls>`) | Videos can be on any site; the extension needs to observe media requests and read `<video>` elements on the pages the user visits, and download the media from its server. |
| Remote code | No. All code, including ffmpeg.wasm, is included in the package. |

### Prácticas de privacidad (formulario)
- Datos recopilados: **ninguno** (no marcar ninguna categoría).
- Certificar: no se venden datos, no se usan para fines ajenos a la función, no se usan para créditos.
- URL de política de privacidad: el enlace a `PRIVACY.md` en GitHub.

## Firefox Add-ons (AMO), versión listada

- Es una extensión **nueva** (ID `global-video-downloader@gvd`), distinta de la que se firmó como "unlisted".
- **Licencia:** GNU General Public License v3.0.
- **Política de privacidad:** pegar el texto de `PRIVACY.md`.
- **Código fuente:** AMO pregunta si hay código minificado o generado. Responder que sí, solo en `vendor/ffmpeg/`, y que son los archivos **sin modificar** de npm:
  - `@ffmpeg/ffmpeg@0.12.15` → `dist/umd/ffmpeg.js` y `dist/umd/814.ffmpeg.js`
  - `@ffmpeg/core@0.12.10` → `dist/umd/ffmpeg-core.js` y `dist/umd/ffmpeg-core.wasm`
  
  El resto del código no tiene paso de compilación. Si el revisor lo pide, adjuntar el ZIP del repositorio.
- **Notas para el revisor** (sugerido):
  > The extension detects media on the pages the user visits (webRequest, content scripts) and downloads the files the user chooses. HLS/DASH segments are joined with ffmpeg.wasm (unmodified npm packages listed above, loaded locally, no remote code). The blocking webRequest listener only rewrites the Referer/Origin of the extension's own requests. No data is collected (data_collection_permissions: none).
- La descripción puede ser la misma que la de Chrome, cambiando la última línea sobre YouTube por:
  > On YouTube, use the MSE recording.
