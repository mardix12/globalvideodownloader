# Arma los paquetes de Global Video Downloader para Firefox y Chrome a partir del mismo código:
#   dist/firefox/   y dist/global-video-downloader-firefox-<versión>.zip   (manifest.json)
#   dist/chrome/    y dist/global-video-downloader-chrome-<versión>.zip    (manifest.chrome.json → manifest.json)
# Las carpetas dist/firefox y dist/chrome sirven para cargar la extensión sin empaquetar
# (about:debugging en Firefox, "Cargar descomprimida" en Chrome).
# Usa System.IO.Compression a mano porque Compress-Archive de PowerShell 5.1 escribe rutas con "\",
# y Firefox/AMO rechazan esos ZIP.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

$targets = @(
  @{ name = 'firefox'; manifest = 'manifest.json';
     exclude = @('src/background/platform-chrome.js', 'src/background/sw.js', 'src/offscreen/') },
  @{ name = 'chrome'; manifest = 'manifest.chrome.json';
     exclude = @('src/background/platform-firefox.js') }
)
$common = @('_locales', 'icons', 'src', 'vendor', 'LICENSE')

foreach ($t in $targets) {
  $manifest = Get-Content (Join-Path $root $t.manifest) -Raw -Encoding UTF8 | ConvertFrom-Json
  $stage = Join-Path $dist $t.name
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory $stage | Out-Null

  $files = @()
  foreach ($item in $common) {
    $path = Join-Path $root $item
    if (-not (Test-Path $path)) { continue }
    $files += if ((Get-Item $path).PSIsContainer) { Get-ChildItem $path -Recurse -File } else { Get-Item $path }
  }
  $out = Join-Path $dist ("global-video-downloader-{0}-{1}.zip" -f $t.name, $manifest.version)
  if (Test-Path $out) { Remove-Item $out -Force }
  $zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $t.manifest), 'manifest.json', [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    Copy-Item (Join-Path $root $t.manifest) (Join-Path $stage 'manifest.json')
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($root.Length + 1) -replace '\\', '/'
      if ($t.exclude | Where-Object { $rel -eq $_ -or ($_.EndsWith('/') -and $rel.StartsWith($_)) }) { continue }
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
      $dest = Join-Path $stage $rel
      New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
      Copy-Item $f.FullName $dest
    }
  } finally {
    $zip.Dispose()
  }
  "Generado: $out ({0:N1} MB)" -f ((Get-Item $out).Length / 1MB)
}
