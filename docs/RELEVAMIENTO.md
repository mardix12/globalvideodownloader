# Relevamiento técnico: descarga de video en Firefox

Fecha: noviembre 2026 · Proyecto: FF Video Downloader (extensión para uso personal/interno)

Este documento reúne:

1. Las formas en que un sitio le entrega video al navegador.
2. Los formatos, contenedores, códecs, resoluciones, protocolos de streaming, subtítulos y DRM.
3. Un análisis de extensiones similares (Video DownloadHelper y otras).
4. Las decisiones de diseño que salen de todo lo anterior.
5. Lo que exige Mozilla hoy para instalar una extensión de forma local.

---

## 1. Cómo llega un video al navegador

| Modo | Cómo se ve en la red | Cómo se detecta | Cómo se descarga |
|---|---|---|---|
| **Archivo progresivo** | Un solo `GET` (a veces con `Range`/206) a un `.mp4`, `.webm`, etc. | `Content-Type: video/*` o `audio/*`, extensión de la URL, `<video src>` | Descarga directa (gestor de descargas del navegador) |
| **HLS** (HTTP Live Streaming) | Playlist `.m3u8` + segmentos `.ts` / `.m4s` / `.aac` | MIME `application/vnd.apple.mpegurl` o `application/x-mpegURL`, extensión `.m3u8` | Leer la playlist, bajar los segmentos, descifrar si son AES-128, concatenar y pasar a MP4 |
| **MPEG-DASH** | Manifiesto `.mpd` (XML) + segmentos `.m4s` / `.webm` (video y audio **separados**) | MIME `application/dash+xml`, extensión `.mpd` | Leer el MPD, elegir una representación de video y una de audio, bajar los segmentos y unirlos (mux) |
| **MSE / `blob:`** | El reproductor JS baja los datos (a veces con URLs ofuscadas o firmadas) y se los pasa a `MediaSource` | `<video src="blob:…">`, llamadas a `MediaSource.addSourceBuffer` | Interceptar `SourceBuffer.appendBuffer` y grabar los fragmentos mientras se reproduce |
| **HDS / Smooth Streaming** | `.f4m` (Adobe) / `.ism/Manifest` (Microsoft) | MIME `application/f4m+xml`, `application/vnd.ms-sstr+xml` | Formatos en desuso; se detectan pero no se soportan |
| **WebRTC / WebSocket / RTMP** | Flujo en tiempo real (videollamadas, algunos vivos de baja latencia) | No hay archivo ni manifiesto | Solo grabando la pantalla o el `MediaStream`; queda fuera de alcance |

Hoy la mayoría de los sitios grandes usan **HLS o DASH reproducidos con MSE** (hls.js, dash.js, Shaka Player, Video.js, JW Player, Bitmovin, THEOplayer). Por eso se ve `blob:` en el `<video>` aunque detrás haya un manifiesto que se puede descargar.

---

## 2. Contenedores y extensiones

| Extensión | Contenedor | MIME habitual | Uso típico |
|---|---|---|---|
| `.mp4`, `.m4v` | ISO BMFF (MPEG-4 Part 14) | `video/mp4` | El más común. Progresivo o fragmentado (fMP4/CMAF) |
| `.m4a` | ISO BMFF (solo audio) | `audio/mp4` | Pistas de audio AAC (DASH/HLS fMP4) |
| `.m4s`, `.cmfv`, `.cmfa` | Segmento fMP4/CMAF | `video/iso.segment`, `video/mp4` | Segmentos de DASH y HLS moderno |
| `.ts`, `.m2ts`, `.mts` | MPEG-2 Transport Stream | `video/mp2t` | Segmentos HLS clásicos; Blu-ray/AVCHD |
| `.webm` | WebM (subconjunto de Matroska) | `video/webm`, `audio/webm` | VP8/VP9/AV1 + Opus/Vorbis. YouTube y DASH |
| `.mkv`, `.mka` | Matroska | `video/x-matroska` | Admite cualquier códec; salida "comodín" |
| `.mov` | QuickTime | `video/quicktime` | Cámaras, Apple |
| `.ogv`, `.ogg`, `.oga`, `.opus` | Ogg | `video/ogg`, `audio/ogg` | Theora/Vorbis/Opus (Wikipedia, sitios libres) |
| `.flv`, `.f4v` | Flash Video | `video/x-flv` | Legado; algunos vivos HTTP-FLV |
| `.avi` | AVI | `video/x-msvideo` | Legado |
| `.wmv`, `.asf`, `.wma` | ASF | `video/x-ms-wmv`, `video/x-ms-asf` | Legado de Windows Media |
| `.3gp`, `.3g2` | 3GPP | `video/3gpp` | Celulares viejos |
| `.mpg`, `.mpeg`, `.vob` | MPEG-PS | `video/mpeg` | DVD, legado |
| `.mp3` | MPEG audio | `audio/mpeg` | Podcasts, música |
| `.aac` | ADTS | `audio/aac` | Segmentos HLS solo-audio, radios |
| `.wav`, `.flac` | RIFF / FLAC | `audio/wav`, `audio/flac` | Audio sin compresión / sin pérdida |
| `.m3u8`, `.m3u` | Playlist HLS | `application/vnd.apple.mpegurl` | Manifiesto HLS |
| `.mpd` | Manifiesto DASH | `application/dash+xml` | Manifiesto DASH |
| `.vtt`, `.srt`, `.ttml`, `.dfxp` | Subtítulos | `text/vtt`, `application/ttml+xml` | WebVTT, SubRip, TTML/IMSC |

Muchos servidores mandan video como `application/octet-stream`, `binary/octet-stream` o sin `Content-Type`. Por eso la extensión mira también la extensión de la URL y el `Content-Disposition`.

---

## 3. Códecs

### Video

| Códec | Identificador (RFC 6381) | Contenedores | Notas |
|---|---|---|---|
| H.264 / AVC | `avc1.*`, `avc3.*` | MP4, TS, MKV, FLV | El más compatible. Perfiles Baseline/Main/High |
| H.265 / HEVC | `hvc1.*`, `hev1.*` | MP4, TS, MKV | 4K/HDR, Apple. Firefox lo decodifica solo con soporte del sistema operativo |
| AV1 | `av01.*` | MP4, WebM, MKV | YouTube, Netflix, Vimeo. Muy eficiente |
| VP9 | `vp09.*`, `vp9` | WebM, MP4, MKV | YouTube (hasta 8K), HDR con perfil 2 |
| VP8 | `vp8` | WebM | Legado, WebRTC |
| Dolby Vision | `dvh1`, `dvhe`, `dav1` | MP4 | HDR dinámico; casi siempre con DRM |
| MPEG-2, MPEG-4 Part 2, Theora, WMV | varios | TS/PS, AVI, Ogg, ASF | Legado |

### Audio

| Códec | Identificador | Notas |
|---|---|---|
| AAC-LC / HE-AAC v1/v2 | `mp4a.40.2` / `.5` / `.29` | El estándar en MP4/HLS/DASH |
| MP3 | `mp4a.6B`, `mp4a.40.34` | Legado, podcasts |
| Opus | `opus` | WebM/YouTube, muy eficiente |
| Vorbis | `vorbis` | WebM/Ogg legado |
| AC-3 / E-AC-3 (Dolby Digital / Plus, Atmos) | `ac-3`, `ec-3` | Streaming premium, 5.1/7.1 |
| FLAC, ALAC, PCM | `flac`, `alac`, `lpcm` | Sin pérdida |

### Qué códecs entran en qué contenedor (para el mux sin recodificar)

- **MP4**: H.264, H.265, AV1, VP9 (soportado, poco común), AAC, MP3, AC-3, E-AC-3, Opus (en ffmpeg moderno).
- **WebM**: solo VP8, VP9 y AV1 con Opus o Vorbis.
- **MKV**: cualquiera. Es la salida segura cuando se mezclan familias (por ejemplo VP9 con AAC).

La extensión elige el contenedor de salida según las pistas: si ambas son WebM sale `.webm`; si se mezclan WebM y MP4 sale `.mkv`; en cualquier otro caso sale `.mp4`. Siempre se usa `-c copy`, así que no hay pérdida de calidad ni recodificación.

---

## 4. Resoluciones, cuadros por segundo y bitrates de referencia

| Nombre | Resolución (16:9) | Bitrate H.264 típico | Bitrate AV1/VP9 típico |
|---|---|---|---|
| 144p | 256×144 | 0,1–0,2 Mbps | 0,08 Mbps |
| 240p | 426×240 | 0,3–0,5 Mbps | 0,2 Mbps |
| 360p | 640×360 | 0,6–1 Mbps | 0,4 Mbps |
| 480p (SD) | 854×480 | 1–2,5 Mbps | 0,7 Mbps |
| 720p (HD) | 1280×720 | 2,5–5 Mbps | 1,5 Mbps |
| 1080p (Full HD) | 1920×1080 | 4,5–8 Mbps | 2,5–3 Mbps |
| 1440p (2K/QHD) | 2560×1440 | 9–16 Mbps | 5–8 Mbps |
| 2160p (4K/UHD) | 3840×2160 | 15–35 Mbps | 10–20 Mbps |
| 4320p (8K) | 7680×4320 | — | 30–60 Mbps |

- **Video vertical** (Reels, Shorts, TikTok): por ejemplo 1080×1920. La "calidad" la marca el lado corto, así que eso es 1080p. La extensión etiqueta así.
- **Cuadros por segundo**: 24/25/30 son lo habitual; 50/60 en deportes y juegos. HLS lo indica en `FRAME-RATE` y DASH en `frameRate`.
- **HDR**: HDR10, HLG y Dolby Vision. HLS lo indica en `VIDEO-RANGE=PQ|HLG`. Se descarga igual, pero suele venir con DRM.
- **Tamaño estimado** = bitrate × duración ÷ 8. El popup lo muestra para cada variante HLS/DASH.

---

## 5. Protocolos de streaming en detalle

### HLS (RFC 8216 + borrador 8216bis)

- **Playlist maestra** (`#EXT-X-STREAM-INF`): lista variantes con `BANDWIDTH`, `AVERAGE-BANDWIDTH`, `RESOLUTION`, `CODECS`, `FRAME-RATE`, `AUDIO`, `SUBTITLES` y `VIDEO-RANGE`.
- **Pistas alternativas** (`#EXT-X-MEDIA`): `TYPE=AUDIO|SUBTITLES|CLOSED-CAPTIONS`, `GROUP-ID`, `LANGUAGE`, `NAME`, `DEFAULT`, `URI`. El audio puede venir aparte del video; en ese caso hay que unirlos.
- **Playlist de medios**: `#EXTINF` (duración), `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-ENDLIST` (si falta, es un vivo), `#EXT-X-PLAYLIST-TYPE:VOD|EVENT`, `#EXT-X-DISCONTINUITY` (cortes publicitarios), `#EXT-X-BYTERANGE` (segmentos como rangos de un solo archivo), `#EXT-X-MAP` (segmento de inicialización fMP4).
- **Cifrado** (`#EXT-X-KEY`):
  - `METHOD=AES-128`: el segmento entero va cifrado con AES-128-CBC y la clave se baja de una URL. El IV es explícito o, si falta, el número de secuencia. **Se puede descifrar** (WebCrypto).
  - `METHOD=SAMPLE-AES` / `SAMPLE-AES-CTR` con `KEYFORMAT` de FairPlay (`com.apple.streamingkeydelivery`), Widevine o PlayReady: es **DRM**.
- **Contenedor de segmentos**: MPEG-TS (clásico) o fMP4/CMAF (con `EXT-X-MAP`).
- **LL-HLS** (baja latencia): `#EXT-X-PART`, `#EXT-X-PRELOAD-HINT`. Solo afecta a los vivos.

### MPEG-DASH (ISO/IEC 23009-1)

- Jerarquía `MPD > Period > AdaptationSet > Representation`. Cada `Representation` es una calidad.
- `BaseURL` se resuelve de forma jerárquica, nivel por nivel.
- Formas de direccionar segmentos:
  - **SegmentTemplate** con `$Number$`: cantidad = duración ÷ (`duration`/`timescale`).
  - **SegmentTemplate + SegmentTimeline** con `$Time$` o `$Number$`: lista explícita de `<S t d r>`; `r=-1` repite hasta el final.
  - **SegmentList**: URLs explícitas, opcionalmente con `mediaRange`.
  - **SegmentBase / solo BaseURL**: un único archivo por representación (con `indexRange`/`sidx`).
- **Varios Period**: cortes publicitarios o capítulos. Hay que concatenar la misma calidad de cada período.
- `type="dynamic"` indica un vivo.
- `ContentProtection` (CENC, `urn:mpeg:dash:mp4protection:2011` + UUID de Widevine `edef8ba9-…`, PlayReady `9a04f079-…`, ClearKey `e2719d58-…`) indica contenido **cifrado**.

### CMAF

Formato de segmento fMP4 común a HLS y DASH. El mismo segmento sirve para ambos.

### Vivos

En los vivos solo se puede bajar la "ventana" que publica la playlist en ese momento. La alternativa es grabar con MSE mientras se mira.

---

## 6. Subtítulos

| Formato | Dónde aparece |
|---|---|
| WebVTT (`.vtt`) | HLS (`TYPE=SUBTITLES`), `<track>` HTML5 |
| TTML / IMSC / DFXP | DASH (`stpp`), Netflix, plataformas de TV |
| SRT | Descargas sueltas |
| CEA-608/708 | Incrustados en el video (H.264 SEI) |

La v0.1 detecta las pistas de subtítulos pero no las descarga. Queda como trabajo futuro.

---

## 7. DRM: qué se puede y qué no

| Sistema | Navegadores | Sitios |
|---|---|---|
| Widevine (Google) | Firefox, Chrome, Edge | Netflix, Disney+, Prime Video, Max, Spotify, Crunchyroll, YouTube (películas pagas) |
| PlayReady (Microsoft) | Edge, Smart TVs | Igual que Widevine en Windows |
| FairPlay (Apple) | Safari | Apple TV+, sitios con HLS en Safari |
| ClearKey | Todos | Pruebas; la clave viaja en claro |

El contenido con DRM se descifra dentro del CDM (módulo cerrado y aislado) y nunca queda accesible para una extensión. Sortearlo además es ilegal en muchos países (por ejemplo, DMCA §1201 en EE. UU.). **La extensión no lo intenta.** Lo detecta (EME `setMediaKeys`, `ContentProtection` en DASH, `KEYFORMAT` en HLS), lo avisa en el popup y deshabilita la descarga. Video DownloadHelper y las demás extensiones hacen lo mismo.

---

## 8. Extensiones similares

### Video DownloadHelper (VDH), la referencia

- Es la extensión de descarga de video más usada en Firefox y Chrome. Se mantiene activamente.
- **Detección**: observa las peticiones de red de la pestaña (`webRequest`) y arma una lista de "hits". Hay que reproducir el video para que aparezca. Analiza manifiestos M3U8 y MPD y ofrece las calidades.
- **App complementaria ("CoApp", `vdhcoapp`)**: programa de código abierto que se instala aparte y se comunica por *Native Messaging*. Trae ffmpeg y es necesaria para unir HLS/DASH y para convertir formatos. Según su ficha, el navegador no ofrece las interfaces necesarias y por eso hace falta la app. La gestiona la extensión.
- **Modelo**: tiene versión gratuita y una licencia paga que levanta límites, sobre todo en conversiones y descargas de streams.
- **Sitios**: dice soportar más de 1000 sitios (HLS, DASH, MPD…).
- **Qué tomamos de VDH**: el sniffing por `webRequest`, la lista por pestaña con contador en el ícono, el selector de calidades a partir del manifiesto y el aviso de contenido protegido.
- **En qué nos diferenciamos**: el usuario eligió **no** depender de una app nativa. Usamos **ffmpeg.wasm** dentro de la extensión (más lento y con tope de memoria, pero sin instalar nada) y agregamos **grabación MSE** como último recurso universal.

### Otras extensiones analizadas

| Extensión | Qué hace | Cómo | Observaciones |
|---|---|---|---|
| **Live Stream Downloader** (Chandler Stimson) | HLS (M3U8), vivos | Baja los segmentos en la extensión y escribe directo a disco | Código en GitHub (issues). No hace DASH ni MSE |
| **HLS Video Downloader** (cssnr, GitHub) | HLS | Requiere un cliente nativo para usar ffmpeg | Mismo enfoque que VDH, solo HLS |
| **StreamDL** | HLS y otros, descarga directa | Extensión pura | Software libre (GPL-3.0) |
| **Stream Recorder / StreamRec** | Graba streams basados en MSE | Intercepta `MediaSource`/`SourceBuffer` | Es la técnica que usamos como "Grabación MSE" |
| **VidNeatDown** | HLS, remux, mux DASH, MSE/blob | No verificado (no hay código público) | Las afirmaciones de su ficha no se pudieron confirmar |
| **yt-dlp** (no es extensión) | Más de 1800 sitios, YouTube incluido | Extractores por sitio + ffmpeg | La extensión genera el comando `yt-dlp` listo para copiar |

### Patrones comunes y lecciones

1. **Detectar por red, no por DOM**: el DOM casi siempre muestra `blob:`. Los manifiestos y archivos reales aparecen en `webRequest.onHeadersReceived` (tipos `media`, `xmlhttprequest`, `other`).
2. **Ocultar los segmentos** (`.ts`, `.m4s`) y las sub-playlists. Si no, la lista se llena de basura. VDH además filtra por tamaño mínimo (anuncios, previews).
3. **El Referer/Origin importa**: muchos CDN rechazan peticiones sin el `Referer` del sitio (error 403). Hay que reenviarlo.
4. **Hace falta ffmpeg** para unir audio y video (DASH, HLS con audio aparte) y para pasar de TS a MP4. Las opciones son una app nativa o wasm.
5. **YouTube es un caso aparte**: firma URLs, usa el protocolo SABR y exige tokens. Las extensiones de AMO en general no lo soportan. La recomendación es usar yt-dlp.
6. **DRM**: todas lo excluyen.

---

## 9. Decisiones de diseño de FF Video Downloader

| Requisito | Solución |
|---|---|
| Todos los formatos directos | Tabla de MIME y extensiones (`src/lib/formats.js`), incluido `octet-stream` con extensión conocida y `Content-Disposition` |
| HLS | Parser propio (`src/lib/hls.js`): master con variantes y audios alternativos, `BYTERANGE`, `EXT-X-MAP` (fMP4), AES-128 con IV implícito o explícito, detección de DRM y de vivos |
| DASH | Parser propio (`src/lib/dash.js`): Template ($Number$, $Time$, Timeline, formato `%05d`), List, Base, `BaseURL` jerárquico, varios períodos, `ContentProtection` |
| Unir y convertir sin app nativa | ffmpeg.wasm 0.12 (single-thread), entradas montadas con **WORKERFS** (se leen desde el Blob sin copiarse a la memoria de wasm), siempre `-c copy` |
| Sitios con reproductores JS | **Grabación MSE** (`src/content/page-hook.js` en el MAIN world): copia lo que se le pasa a `appendBuffer`. Separa por cambio de calidad, porque ffmpeg no acepta dos `moov` en el mismo MP4 |
| CDN que exigen Referer | Header interno `X-FFVD-Referer` que el background reemplaza por `Referer`/`Origin` reales (`webRequestBlocking`, que Firefox mantiene en MV3) |
| DRM | Detección por EME, MPD y HLS. Aviso y botón deshabilitado |
| YouTube | Aviso, grabación MSE y botón "Copiar comando yt-dlp" |
| Event page de MV3 que se descarga | Estado por pestaña en `storage.session`; las descargas corren en el background, que se mantiene vivo con una llamada a la API cada 10 s mientras haya trabajos; el historial va a `storage.session` |

---

## 10. Requisitos de Mozilla para instalarla localmente (vigentes a noviembre 2026)

### Firma

- **Firefox Release y Beta** (el que tenés instalado es 159) **solo instalan extensiones firmadas por Mozilla**. La firma se obtiene en addons.mozilla.org (AMO), también para extensiones que no se publican.
- **Distribución propia ("unlisted")**: se sube el ZIP en el *Developer Hub* de AMO (o con `web-ext sign`, que requiere Node.js) y se elige *"On your own"*. AMO valida en forma automática (puede tardar hasta 24 h) y devuelve un `.xpi` firmado que se instala arrastrándolo a Firefox. No aparece en la tienda, pero puede recibir revisión manual en cualquier momento y debe cumplir las *Add-on Policies*.
- **Sin firma**: solo en **Firefox Developer Edition, Nightly o ESR**, poniendo `xpinstall.signatures.required = false` en `about:config`. La extensión necesita un ID (`browser_specific_settings.gecko.id`). Esto no funciona en Release ni en Beta.
- **Instalación temporal** (cualquier edición, incluida Release): `about:debugging` → *Este Firefox* → *Cargar complemento temporal…* → elegir `manifest.json`. Se borra al cerrar Firefox. Sirve para desarrollo y pruebas.

### Manifest

| Clave | Valor en este proyecto | Por qué |
|---|---|---|
| `manifest_version` | `3` | MV2 sigue funcionando en Firefox, pero MV3 es el estándar actual |
| `browser_specific_settings.gecko.id` | `ffvideodownloader@local` | Obligatorio en MV3 para firmar y para instalar sin firma |
| `browser_specific_settings.gecko.strict_min_version` | `140.0` | `data_collection_permissions` (140), `world: "MAIN"` (128), `storage.session` (115). Coincide con Firefox ESR 140 |
| `browser_specific_settings.gecko.data_collection_permissions` | `{ "required": ["none"] }` | **Obligatorio desde el 3/11/2025** para extensiones nuevas que se suben a AMO, incluidas las unlisted. La extensión no recolecta ni transmite datos |
| `background.scripts` | event page | Firefox MV3 usa *event pages*, no *service workers* |
| `permissions` | `webRequest`, `webRequestBlocking`, `downloads`, `storage`, `tabs`, `scripting` | Firefox mantiene `webRequestBlocking` en MV3 (Chrome no) |
| `host_permissions` | `<all_urls>` | Para detectar en todos los sitios. En MV3 el usuario las puede revocar; el popup ofrece "Dar permiso" si faltan |
| `content_security_policy.extension_pages` | `script-src 'self' 'wasm-unsafe-eval'` | Necesario para compilar ffmpeg.wasm; MV3 no permite `unsafe-eval` |

### Revisión en AMO (si se firma como unlisted)

- El tamaño máximo es 200 MB. El paquete pesa unos 10 MB comprimido; el `.wasm` mide 31 MB sin comprimir.
- El código de terceros minificado (ffmpeg.wasm) tiene que ser la versión publicada en npm sin modificar. Usamos `@ffmpeg/ffmpeg@0.12.15` y `@ffmpeg/core@0.12.10`. Si el revisor lo pide, se indica el origen.
- **Riesgo de política**: AMO rechazó históricamente extensiones que descargan de YouTube. Esta extensión no tiene un extractor de YouTube; solo graba lo que se reproduce y copia un comando de yt-dlp. Aun así, un revisor podría objetar la grabación MSE. Para uso propio, la instalación sin firma en Developer Edition o ESR evita ese riesgo.

---

## 11. Limitaciones conocidas y trabajo futuro

- **Memoria**: los segmentos se juntan en memoria (Blob) y la salida de ffmpeg vive en el heap de wasm. Por encima de unos 1,5 GB de entrada se guardan video y audio por separado, sin unir. Mejora posible: escribir en OPFS o en el disco a medida que se baja.
- **Vivos**: se baja solo la ventana disponible en ese momento. Mejora posible: refrescar la playlist en bucle.
- **Subtítulos**: se detectan pero no se descargan.
- **HDS, Smooth Streaming y SAMPLE-AES sin DRM**: no soportados.
- **Peticiones desde service workers del sitio** (tabId -1): no se asocian a la pestaña. La grabación MSE las cubre igual.
- **Grabación MSE**: graba a la velocidad de reproducción (se puede acelerar). Si el reproductor cambia de calidad, se guarda el tramo más largo.
- **YouTube**: no hay extractor propio (por política y por fragilidad). Hay que usar yt-dlp o la grabación.

---

## Fuentes

- Video DownloadHelper en AMO: https://addons.mozilla.org/firefox/addon/video-downloadhelper/
- Video DownloadHelper en Chrome Web Store: https://chrome.google.com/webstore/detail/video-downloadhelper/lmjnegcaeklhafolokijcfjliaokphfk
- Live Stream Downloader: https://addons.mozilla.org/firefox/addon/live-stream-downloader/
- HLS Video Downloader (cssnr): https://github.com/cssnr/hls-video-downloader
- StreamDL: https://addons.mozilla.org/firefox/addon/streamdl/
- StreamRec: https://addons.mozilla.org/firefox/addon/streamrec/
- VidNeatDown: https://addons.mozilla.org/firefox/addon/vidneatdown/
- Firma y distribución (Extension Workshop): https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
- Consentimiento de recolección de datos: https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
- Add-on signing in Firefox (SUMO): https://support.mozilla.org/kb/add-on-signing-in-firefox
- MV3 en Firefox 128 (MAIN world): https://blog.mozilla.org/addons/?p=9190
- `storage.session` (bug 1687778): https://bugzilla.mozilla.org/show_bug.cgi?id=1687778
- `wasm-unsafe-eval` en MV3 (bug 1766027): https://bugzil.la/1766027
- MDN webRequest: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest
- ffmpeg.wasm releases: https://github.com/ffmpegwasm/ffmpeg.wasm/releases
- RFC 8216 (HLS): https://datatracker.ietf.org/doc/html/rfc8216
