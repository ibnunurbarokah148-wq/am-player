# AM XML Player

Desktop Alight Motion XML project previewer built with Electron.

## Current features

- Open `.xml`, `.alight`, and `.zip` scene packages.
- Parse scene layers, transforms, keyframes, and cubic-bezier easing.
- Preview shape, text, color, image, and video layers.
- Detect media replacement slots from `fillVideo` / `fillImage` references.
- Replace template media with local image/video files.
- Replace or add audio tracks for preview playback.
- Browse project metadata, layers, and a basic timeline.
- Inspect supported Alight Motion share-link metadata.

## Development

```powershell
npm install
npm start
```

## Windows portable build

```powershell
npm run dist
```

The executable is generated in `dist/`.

## Scope

The renderer currently focuses on XML interoperability and a stable desktop
preview workflow. Full GLSL effect parity with Alight Motion is planned for a
future WebGL renderer.
