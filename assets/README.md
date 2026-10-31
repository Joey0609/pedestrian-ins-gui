# 行迹 / WalkingJourney brand assets

The mark combines a continuous journey track, a destination pin and a split footprint. Its blue palette matches the application's `#2b6ef6` primary color. All artwork has transparent outer corners and is independent of fonts or remote assets.

## Files and usage

- `logo.svg` — preferred renderer/UI mark, 512 × 512 viewBox; accessible SVG title and description included. From `renderer/index.html`, use `<img src="../assets/logo.svg" alt="行迹" width="40" height="40">`.
- `logo.png` — 512 × 512 RGBA preview/export.
- `icon.png` — 256 × 256 RGBA Electron/Linux window icon.
- `icon.ico` — Windows app icon with 16, 24, 32, 48, 64, 128 and 256 px PNG-backed, 32-bit RGBA frames. Used by BrowserWindow on Windows, electron-packager and electron-builder.
- `generate-icons.js` — the single source of the shared vector scene and a dependency-free renderer/PNG/ICO encoder.
- `verify-icons.js` — independent PNG CRC/decompression, ICO frame, transparency and Electron configuration checks.

Keep the mark square without cropping; it already contains its own safe inset. Recommended visible UI sizes are 32–48 px. The icon intentionally contains no wordmark, so the UI can render its own localized application name.

## Rebuild and verify

```powershell
npm run generate:icons
npm run check:icons
node --check assets/generate-icons.js
node --check main.js
```

Generation uses only Node.js built-ins, a fixed scene, four-times supersampling and PNG compression with no embedded timestamps. `check:icons` regenerates every asset in memory and compares the complete bytes without writing. Reproduction is deterministic within a Node.js/zlib version; different zlib versions can produce equivalent PNG streams with different compressed bytes.

The runtime Windows AppUserModelID is `com.walkingjourney.app`, matching `build.appId` in the package configuration. No renderer files need changes to use the Electron app/window icons.
