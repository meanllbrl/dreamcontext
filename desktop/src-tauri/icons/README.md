# Icons

Real icons are generated from a high-resolution source image (1024x1024 PNG recommended):

```bash
npm run tauri icon path/to/icon.png
```

This produces all required sizes automatically (32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico, etc.) and places them in this directory.

Until real icons are generated, the placeholder icons (minimal valid PNGs) allow `cargo check` to pass, but the bundled app will have a blank/transparent icon. Generating real branded icons is manual design handoff step (A8).
