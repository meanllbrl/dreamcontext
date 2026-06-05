# Obsidian `.excalidraw.md` format (reverse-engineered from this vault)

Source files inspected: `lina/excalidraw/Lina Web Funnel.excalidraw.md` (decompressed),
`Lina Web Funnel Benchmark.excalidraw.md`. Plugin: `zsviczian/obsidian-excalidraw-plugin`.

## File anatomy
```
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW … ⚠== …saving hint…


# Excalidraw Data

## Text Elements
<text content> ^<elementId>      ← one block per text element, blank line between

## Embedded Files
<sha1>: [[image filename.png]]    ← maps fileId → vault image, blank line between

%%
## Drawing
```json
{ "type":"excalidraw", "version":2, "source":"…", "elements":[…], "appState":{…}, "files":{} }
```
%%
```
- `## Drawing` may be ` ```compressed-json ` (LZString.compressToBase64) **or** ` ```json `
  (uncompressed). The plugin reads both. We emit uncompressed JSON — readable, no deps.
- The whole drawing block is wrapped in `%% … %%` (Obsidian comment) so it hides in reading view.
- `## Text Elements` and `## Embedded Files` sit **before** the `%%`.

## Image embedding (the key mechanism)
- An image element is `{"type":"image", "fileId":"<sha1>", …, "scale":[1,1], "status":"pending", "crop":null}`.
- `fileId` is the **sha1 of the image file's bytes**.
- The `## Embedded Files` line `<sha1>: [[file.png]]` is what the plugin uses to load the picture
  from the vault. **The scene `files` object can be empty (`{}`)** — no base64 dataURL required.
- `crop` is optional (only when the user cropped). `null` shows the whole image.

## Ground-truth image element (decompressed from the vault)
```json
{
  "id":"GtJwnnEj","type":"image","x":-147.3,"y":-290.5,"width":118.8,"height":469,
  "angle":0,"strokeColor":"transparent","backgroundColor":"transparent","fillStyle":"solid",
  "strokeWidth":2,"strokeStyle":"solid","roughness":1,"opacity":100,"groupIds":[],"frameId":null,
  "index":"a0","roundness":null,"seed":2054545386,"version":188,"versionNonce":1261541290,
  "isDeleted":false,"boundElements":[],"updated":1779266944741,"link":null,"locked":false,
  "status":"pending","fileId":"3eaa974da433f70ba06cb3fb2587b486d6143d32","scale":[1,1],
  "crop":{ "x":713.7,"y":0,"width":871.3,"height":3440,"naturalWidth":2283,"naturalHeight":3440 },
  "hasTextLink":false
}
```
…and its `## Embedded Files` line:
```
3eaa974da433f70ba06cb3fb2587b486d6143d32: [[Pasted Image 20260515130812_941.png]]
```

## z-order: fractional indices
- Every element has a string `index` (`"a0"`, `"a1"`, …) — fractional indexing, compared
  lexicographically. We generate them with the vendored `fractional-indexing` lib
  (`generateNKeysBetween(null,null,N)`), which matches the vault output exactly.
- Excalidraw's `restore()` (run by the plugin on load) repairs invalid/missing indices, but we emit
  valid ascending ones anyway.

## appState
Minimal is fine: `{"gridSize":null,"gridStep":5,"gridModeEnabled":false,"viewBackgroundColor":"#ffffff"}`.

## House style (measured from MemoryOS High Level / Personalization Module / Research)
The vault's presentation boards share one fingerprint — `scripts/lib/style.js` encodes it:
- **Font:** Excalifont, `fontFamily: 5`, for ~100% of text. Sizes form a scale: ~16 labels, ~20 body,
  ~28 sub-headers, ~44–50 section titles (scaled up on large zoomed-out canvases).
- **Fills:** `fillStyle: "solid"` exclusively (never hachure). **Every rectangle is rounded.**
- **Ink:** `strokeColor: "#1e1e1e"`, `strokeWidth: 2` dominant (1 for fine/secondary).
- **Semantic palette** (Excalidraw native swatches): green `#b2f2bb`/`#2f9e44` (benefit/go),
  red `#ffc9c9`/`#e03131` (pain/risk), blue `#a5d8ff`/`#1971c2` (system/flow), purple `#d0bfff`/`#6741d9`
  (core service), yellow `#ffec99`/`#f08c00` (processing), mint `#96f2d7`/`#0c8599` (result),
  pale variants `#ebfbee`/`#e7f5ff`/`#f3f0ff` for backdrops.
- **Patterns:** rounded-card (rect + centered label, grouped) · color nodes by role · ellipse = actor,
  diamond = decision, container-rect groups sub-states · arrows almost always single end-arrowhead,
  labeled inline ("req", "msg+ctx") · side-annotation arrows to spec notes · big plain section titles
  ("Configuration", "Flow") · benefit/risk **card columns** · hub-and-spoke concept maps · bulleted
  spec lists as one text block. Heavy use of embedded screenshots in research murals (huge canvases,
  29+ groups) — exactly the funnel-map use case.

## Tooling note
The `yctimlin/mcp_excalidraw` MCP server was evaluated and rejected for this vault: it needs a
running localhost canvas server and exports excalidraw.com JSON / PNG / share-URLs — it does **not**
write Obsidian `.excalidraw.md` with the `## Embedded Files` wikilink section. Hand-generating the
file (this skill) is the correct, dependency-light path for bulk-embedding local screenshots.
