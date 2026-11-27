# Global Video Downloader

Browser extension (Manifest V3) for **Firefox** and **Chrome** that detects and downloads video and audio from web pages.

- **Direct files**: MP4, WebM, MKV, MOV, FLV, MP3, M4A and more.
- **HLS** (`.m3u8`): choose the quality and audio track. TS and fMP4 segments, byte ranges and AES-128 encryption are supported.
- **DASH** (`.mpd`): choose video and audio separately; they are joined automatically.
- **MSE recording**: last resort for JavaScript players (`blob:`). Records what the player loads.
- **DRM** (Widevine, PlayReady, FairPlay): detected and reported. Never downloaded.

Joining audio and video and converting TS to MP4 is done with **ffmpeg.wasm** inside the extension, without re-encoding (`-c copy`) and without installing anything else.

Other features:
- Downloads keep running in the background; the **Downloads** page can be closed and reopened (history is kept for the browser session).
- Configurable number of simultaneous downloads (default 5).
- Size filter ("hide files smaller than…"), newest detections first.
- Duplicate detection (redirects and identical file sizes are merged into one entry, with a fallback URL).
- Editable file name before downloading.
- Languages: English, Spanish, Portuguese (Brazil), French and German.

**Chrome:** following the Chrome Web Store policies, the extension does not work on YouTube (no detection, no recording).

## Install for development

```powershell
# Builds dist\firefox\, dist\chrome\ and one ZIP for each store
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

| Browser | Steps |
|---|---|
| Firefox | `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → choose `dist/firefox/manifest.json` (or the root `manifest.json`). |
| Chrome / Edge | `chrome://extensions` → enable *Developer mode* → *Load unpacked* → choose the `dist/chrome` folder. |

## Usage

1. Open a page with a video and **play it**. Many sites only request the stream after pressing play.
2. The toolbar icon shows how many media files were detected (or a red `!` if there is DRM).
3. In the popup, choose the quality (and audio, for HLS/DASH), adjust the file name if you want, and press **Download**.
4. Follow the progress in **Downloads**. Files are saved to the browser's download folder.

**MSE recording**, when nothing downloadable shows up: set a fixed quality in the site's player (not "Auto"), press **Record from the start (reloads)**, play the whole video (you can speed it up) and press **Save recording**.

## How it is built

```
manifest.json                      Firefox manifest
manifest.chrome.json               Chrome manifest (build.ps1 copies it as manifest.json)
_locales/                          translations (en, es, pt_BR, fr, de)
src/lib/compat.js                  Firefox/Chrome compatibility + i18n helpers
src/background/background.js      network sniffer, per-tab state, duplicates, size filter, messages
src/background/jobs.js             download engine: queue, segments, ffmpeg, saving, session history
src/background/platform-firefox.js Firefox: engine in the event page, Referer via blocking webRequest, keep-alive
src/background/platform-chrome.js  Chrome: engine in an offscreen document, Referer via declarativeNetRequest, YouTube excluded
src/background/sw.js               Chrome service worker entry point
src/offscreen/                     Chrome offscreen document (runs jobs.js and ffmpeg.wasm)
src/content/page-hook.js           MAIN world: MSE recording + EME/DRM detection
src/content/detect.js              DOM scan (video, og:video, JSON-LD, links) and bridge with page-hook
src/popup/                         media list, quality selection, recording
src/manager/                       Downloads page: job status and options
src/lib/formats.js                 MIME/extension/codec tables and classification
src/lib/hls.js, dash.js            HLS and DASH parsers
src/lib/downloader.js              concurrent segment download with retries and AES-128
src/lib/mux.js                     ffmpeg.wasm wrapper (WORKERFS, -c copy)
vendor/ffmpeg/                     @ffmpeg/ffmpeg 0.12.15 + @ffmpeg/core 0.12.10 (UMD, single-thread), unmodified
build.ps1                          packaging for both browsers
```

There is no build step for the code itself: it is plain JavaScript, loaded as-is.

## Limitations

- Larger than ~1.5 GB per download: video and audio are saved separately (wasm memory limit).
- Live streams: only what the playlist offers at that moment is downloaded.
- Subtitles: detected but not downloaded.
- DRM-protected content is not supported, by design.

## Privacy

The extension does not collect or send any data. See [PRIVACY.md](PRIVACY.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

Third-party code in `vendor/ffmpeg/`:
- `@ffmpeg/ffmpeg` 0.12.15: MIT.
- `@ffmpeg/core` 0.12.10: FFmpeg compiled with GPL components (e.g. x264), GPL-2.0-or-later. Source: https://github.com/ffmpegwasm/ffmpeg.wasm
