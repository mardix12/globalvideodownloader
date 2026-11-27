# Privacy Policy — Global Video Downloader

_Last updated: November 26, 2026_

**Global Video Downloader does not collect, store on any server, sell or share any personal data.** It has no analytics, no tracking and no remote servers of its own.

## What the extension accesses, and why

- **Network requests of the pages you visit** (`webRequest`, access to all sites): only to recognize video and audio files, HLS/DASH manifests and DRM-protected content, so they can be listed in the popup. This information stays in your browser.
- **Page content** (content scripts): to find `<video>`/`<audio>` elements and media links, and, only when you start an MSE recording, to capture the media data the page's player loads.
- **Downloads** (`downloads`): to save the files you choose to download.
- **Storage** (`storage`): your options (minimum size, simultaneous downloads, etc.) and the list of downloads of the current browser session. Session data is deleted when you close the browser.
- **Tabs** (`tabs`): to know which tab the detected media belongs to and to use the page title as the file name.
- **Chrome only:** `offscreen` (to download and join media in a hidden extension page) and `declarativeNetRequestWithHostAccess` (to send the original page as `Referer` when the extension downloads a file, as many video servers require it).

The extension only contacts the servers that host the media you choose to download, in the same way your browser does when you play it.

## Contact

Questions about this policy: open an issue in the project's repository.

---

# Política de privacidad — Global Video Downloader

**Global Video Downloader no recopila, no guarda en ningún servidor, no vende ni comparte datos personales.** No tiene analíticas, ni rastreo, ni servidores propios.

La extensión accede a las peticiones de red y al contenido de las páginas solo para detectar videos y audios dentro de tu navegador. Guarda tus opciones y la lista de descargas de la sesión de forma local (la lista se borra al cerrar el navegador). Solo se conecta con los servidores que alojan los archivos que eliges descargar.
