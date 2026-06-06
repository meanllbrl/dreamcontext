#!/usr/bin/env node
// build_excalidraw.js — generate an Obsidian-compatible .excalidraw.md board from a high-level spec.
//
// Format reverse-engineered from the user's own vault (see ../reference/format.md):
//   - frontmatter `excalidraw-plugin: parsed`
//   - `## Text Elements`  : "<text> ^<id>" per text element
//   - `## Embedded Files` : "<sha1>: [[image.png]]"  (plugin resolves image from vault by this map)
//   - `%% ## Drawing ```json <scene> ``` %%`  (uncompressed JSON; plugin reads it fine)
// Images need NO base64 — the fileId (sha1 of the file) + the Embedded Files wikilink is enough.
//
// Usage (CLI):  node build_excalidraw.js <spec.json> [--out <path.excalidraw.md>]
// Usage (API):  const { buildExcalidraw, lane, grid } = require('./build_excalidraw.js')
//
// Spec shape:
// {
//   "out": "/abs/Board.excalidraw.md",          // or pass --out
//   "vaultRoot": "/abs/vault",                    // auto-detected (walks up for .obsidian) if omitted
//   "attachDir": "Attachments",                   // where external images get copied (relative to board dir)
//   "wikilinkMode": "basename" | "path",          // how Embedded Files links are written (default basename)
//   "background": "#ffffff",
//   "elements": [ <ElementSpec>, ... ]
// }
// ElementSpec.type: text | image | rectangle | ellipse | diamond | line | arrow | frame
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateNKeysBetween } = require('./lib/fractional-indexing.js');
const { imageSize } = require('./lib/imagesize.js');

// ---------- deterministic PRNG (stable seeds => clean git diffs) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function idFrom(rng) { let s = ''; for (let i = 0; i < 8; i++) s += B62[rng() % 62]; return s; }

const FIXED_UPDATED = 1735689600000; // stable timestamp; visual no-op

// ---------- vault helpers ----------
function findVaultRoot(startDir) {
  let d = startDir;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(d, '.obsidian'))) return d;
    const p = path.dirname(d);
    if (p === d) break; d = p;
  }
  return null;
}

// ---------- text sizing ----------
// When a fixedWidth is given the text element is treated as WRAPPING (autoResize off downstream),
// so height must reflect word-wrapped line count — otherwise long captions render as one wide line
// and overlap their neighbours. Honors explicit \n and greedily wraps each logical line to width.
function sizeText(text, fontSize, fixedWidth) {
  const rawLines = String(text).split('\n');
  if (fixedWidth != null) {
    const charW = fontSize * 0.52;                       // approx Excalifont glyph advance
    const perLine = Math.max(1, Math.floor(fixedWidth / charW));
    let totalLines = 0;
    for (const ln of rawLines) {
      const words = ln.split(/\s+/).filter(Boolean);
      if (!words.length) { totalLines += 1; continue; }
      let cur = 0, lc = 1;
      for (const w of words) {
        const add = (cur ? 1 : 0) + w.length;
        if (cur + add > perLine && cur > 0) { lc++; cur = w.length; }
        else cur += add;
      }
      totalLines += lc;
    }
    return { width: fixedWidth, height: Math.max(Math.round(fontSize * 1.25), Math.round(totalLines * fontSize * 1.25)) };
  }
  const maxLen = rawLines.reduce((m, l) => Math.max(m, l.length), 0);
  return { width: Math.max(10, Math.round(maxLen * fontSize * 0.6)), height: Math.round(rawLines.length * fontSize * 1.25) };
}

// ---------- element factory ----------
function baseEl(rng, type, x, y, w, h, overrides) {
  return Object.assign({
    id: idFrom(rng),
    type, x, y, width: w, height: h,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a0',
    roundness: null,
    seed: rng() >>> 0,
    version: 1,
    versionNonce: rng() >>> 0,
    isDeleted: false,
    boundElements: [],
    updated: FIXED_UPDATED,
    link: null,
    locked: false,
  }, overrides || {});
}

// ---------- main build ----------
function buildExcalidraw(spec) {
  const outPath = spec.out;
  if (!outPath) throw new Error('spec.out (output .excalidraw.md path) is required');
  const boardDir = path.dirname(path.resolve(outPath));
  const vaultRoot = spec.vaultRoot || findVaultRoot(boardDir) || boardDir;
  const attachDir = spec.attachDir || 'Attachments';
  const wikilinkMode = spec.wikilinkMode || 'basename';
  const background = spec.background || '#ffffff';

  const rng = mulberry32(strHash(path.resolve(outPath)));
  const elements = [];
  const textEntries = [];          // {text, id}
  const embedded = new Map();       // sha1 -> linkName
  const usedNames = new Map();       // linkName -> sha1 (collision guard)

  function placeImage(srcPath) {
    const abs = path.resolve(srcPath);
    if (!fs.existsSync(abs)) throw new Error('image not found: ' + abs);
    const bytes = fs.readFileSync(abs);
    const sha = crypto.createHash('sha1').update(bytes).digest('hex');
    const dims = imageSize(abs);
    if (embedded.has(sha)) return { sha, dims, link: embedded.get(sha) };

    // ensure the image is inside the vault so the plugin can resolve it
    let insideVault = abs.startsWith(path.resolve(vaultRoot) + path.sep);
    let finalAbs = abs;
    if (!insideVault) {
      const destDir = path.join(boardDir, attachDir);
      fs.mkdirSync(destDir, { recursive: true });
      finalAbs = path.join(destDir, path.basename(abs));
      fs.copyFileSync(abs, finalAbs);
    }
    let link;
    if (wikilinkMode === 'path') {
      link = path.relative(vaultRoot, finalAbs).split(path.sep).join('/');
    } else {
      link = path.basename(finalAbs);
      // disambiguate same-basename/different-content within this board
      if (usedNames.has(link) && usedNames.get(link) !== sha) {
        const ext = path.extname(link); const stem = link.slice(0, -ext.length || undefined);
        link = `${stem}-${sha.slice(0, 6)}${ext}`;
      }
    }
    usedNames.set(link, sha);
    embedded.set(sha, link);
    return { sha, dims, link };
  }

  for (const e of (spec.elements || [])) {
    const type = e.type;
    if (type === 'text') {
      const fontSize = e.fontSize || 20;
      const { width, height } = sizeText(e.text, fontSize, e.width);
      const el = baseEl(rng, 'text', e.x || 0, e.y || 0, width, height, {
        strokeColor: e.color || '#1e1e1e',
        text: String(e.text),
        rawText: String(e.text),
        originalText: String(e.text),
        fontSize,
        fontFamily: e.fontFamily || 5,
        textAlign: e.align || 'left',
        verticalAlign: e.verticalAlign || 'top',
        containerId: null,
        lineHeight: 1.25,
        // width given ⇒ wrap to it (autoResize off); width omitted ⇒ size to content (single line)
        autoResize: e.width == null,
        backgroundColor: 'transparent',
      });
      elements.push(el);
      textEntries.push({ text: el.text, id: el.id });
    } else if (type === 'image') {
      const { sha, dims, link } = placeImage(e.path);
      let w = e.width, h = e.height;
      if (w && !h) h = Math.round(w * dims.height / dims.width);
      else if (h && !w) w = Math.round(h * dims.width / dims.height);
      else if (!w && !h) { w = dims.width; h = dims.height; }
      const el = baseEl(rng, 'image', e.x || 0, e.y || 0, w, h, {
        strokeColor: 'transparent',
        fileId: sha,
        scale: [1, 1],
        status: 'pending',
        crop: null,
      });
      elements.push(el);
    } else if (type === 'rectangle' || type === 'ellipse' || type === 'diamond') {
      const el = baseEl(rng, type, e.x || 0, e.y || 0, e.width || 100, e.height || 100, {
        strokeColor: e.strokeColor || '#1e1e1e',
        backgroundColor: e.backgroundColor || 'transparent',
        fillStyle: e.fillStyle || 'solid',
        strokeWidth: e.strokeWidth || 2,
        strokeStyle: e.strokeStyle || 'solid',
        roundness: e.roundness ? { type: 3 } : null,
      });
      elements.push(el);
    } else if (type === 'line' || type === 'arrow') {
      const pts = (e.points && e.points.length ? e.points : [[0, 0], [100, 0]]);
      const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs); const minY = Math.min(...ys);
      const norm = pts.map((p) => [p[0] - minX, p[1] - minY]);
      const w = Math.max(...xs) - minX; const h = Math.max(...ys) - minY;
      const el = baseEl(rng, type, (e.x || 0) + minX, (e.y || 0) + minY, w, h, {
        strokeColor: e.strokeColor || '#1e1e1e',
        strokeWidth: e.strokeWidth || 2,
        strokeStyle: e.strokeStyle || 'solid',
        points: norm,
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: e.startArrow || null,
        endArrowhead: type === 'arrow' ? (e.endArrow || 'arrow') : (e.endArrow || null),
      });
      elements.push(el);
    } else if (type === 'frame') {
      const el = baseEl(rng, 'frame', e.x || 0, e.y || 0, e.width || 600, e.height || 400, {
        strokeColor: '#bbb', backgroundColor: 'transparent', name: e.name || 'Frame', roundness: null,
      });
      elements.push(el);
    } else {
      throw new Error('unknown element type: ' + type);
    }
  }

  // group support: specs sharing a `group` key move together in Excalidraw
  const groupMap = new Map();
  const gidFor = (key) => { if (!groupMap.has(key)) groupMap.set(key, idFrom(rng) + idFrom(rng)); return groupMap.get(key); };
  (spec.elements || []).forEach((e, i) => { if (e.group != null && elements[i]) elements[i].groupIds = [gidFor(String(e.group))]; });

  // assign canonical fractional indices in array order (z-order)
  const keys = generateNKeysBetween(null, null, elements.length);
  elements.forEach((el, i) => { el.index = keys[i]; });

  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'https://github.com/zsviczian/obsidian-excalidraw-plugin',
    elements,
    appState: { gridSize: null, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: background },
    files: {},
  };

  // ---------- assemble markdown ----------
  const L = [];
  L.push('---', '', 'excalidraw-plugin: parsed', 'tags: [excalidraw]', '', '---');
  L.push("==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'");
  L.push('', '', '# Excalidraw Data', '');
  L.push('## Text Elements');
  for (const t of textEntries) L.push(`${t.text} ^${t.id}`, '');
  L.push('## Embedded Files');
  for (const [sha, link] of embedded) L.push(`${sha}: [[${link}]]`, '');
  L.push('%%');
  L.push('## Drawing');
  L.push('```json');
  L.push(JSON.stringify(scene, null, '\t'));
  L.push('```');
  L.push('%%');
  const md = L.join('\n') + '\n';

  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');

  return { outPath, elements: elements.length, images: embedded.size, texts: textEntries.length, vaultRoot };
}

// ---------- layout helpers (JS API) ----------
// Real on-board thumbnail height from the image file, so captions hug the image and rows never
// gap (short image) or overlap (tall image). Falls back to a 1.6 aspect if the file is unreadable.
function thumbHeight(p, thumbW) {
  try { const d = imageSize(p); if (d && d.width) return Math.max(1, Math.round(thumbW * d.height / d.width)); } catch (e) {}
  return Math.round(thumbW * 1.6);
}

// A horizontal lane: optional title, then a row of images left->right with each caption hugging
// its own image's bottom (wraps to thumbW). Returns ElementSpec[] (spread with ...) and also carries
// `.width` / `.height` / `.nextY` so lanes/sections stack cleanly without manual height math.
function lane(opts) {
  const { title, images = [], x = 0, y = 0, thumbW = 220, gap = 40, captionSize = 14, captionGap = 8,
    titleSize = 28, titleColor = '#1e1e1e', captionColor = '#555', laneGap = 48 } = opts;
  const els = [];
  let cy = y, titleH = 0;
  if (title) {
    els.push({ type: 'text', x, y: cy, text: title, fontSize: titleSize, color: titleColor, width: Math.max(300, String(title).length * titleSize * 0.6) });
    titleH = titleSize * 1.4 + 12; cy += titleH;
  }
  let cx = x, maxH = 0, capMax = 0;
  for (const im of images) {
    const h = thumbHeight(im.path, thumbW);
    els.push({ type: 'image', x: cx, y: cy, path: im.path, width: thumbW, height: h });
    if (im.caption) {
      els.push({ type: 'text', x: cx, y: cy + h + captionGap, text: im.caption, fontSize: captionSize, color: captionColor, width: thumbW });
      capMax = Math.max(capMax, captionGap + sizeText(im.caption, captionSize, thumbW).height);
    }
    maxH = Math.max(maxH, h);
    cx += thumbW + gap;
  }
  els.width = images.length ? images.length * thumbW + (images.length - 1) * gap : 0;
  els.height = titleH + maxH + capMax;
  els.nextY = y + els.height + laneGap;
  return els;
}

// A wrapping grid of images. Each row sizes to its tallest image and every caption hugs its own
// image's bottom — no fixed-aspect rowH guess, so no gaps under short shots or overlaps under tall
// ones. Returns ElementSpec[] carrying `.height` / `.nextY` for stacking below the grid.
function grid(opts) {
  const { images = [], x = 0, y = 0, cols = 6, thumbW = 220, gapX = 36, gapY = 60,
    captionSize = 14, captionGap = 8, captionColor = '#555' } = opts;
  const els = [];
  let rowTop = y;
  for (let r = 0; r * cols < images.length; r++) {
    const row = images.slice(r * cols, r * cols + cols);
    const hs = row.map((im) => thumbHeight(im.path, thumbW));
    const maxH = Math.max(...hs);
    let capMax = 0;
    row.forEach((im, ci) => {
      const cx = x + ci * (thumbW + gapX);
      const h = hs[ci];
      els.push({ type: 'image', x: cx, y: rowTop, path: im.path, width: thumbW, height: h });
      if (im.caption) {
        els.push({ type: 'text', x: cx, y: rowTop + h + captionGap, text: im.caption, fontSize: captionSize, color: captionColor, width: thumbW });
        capMax = Math.max(capMax, captionGap + sizeText(im.caption, captionSize, thumbW).height);
      }
    });
    rowTop += maxH + capMax + gapY;
  }
  els.height = rowTop - y;
  els.nextY = rowTop;
  return els;
}

module.exports = { buildExcalidraw, lane, grid, thumbHeight };

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  let specPath = null, out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else specPath = args[i];
  }
  if (!specPath) { console.error('usage: node build_excalidraw.js <spec.json> [--out <path.excalidraw.md>]'); process.exit(1); }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (out) spec.out = out;
  const res = buildExcalidraw(spec);
  console.log(`OK  ${res.outPath}\n    elements=${res.elements} images=${res.images} texts=${res.texts}\n    vaultRoot=${res.vaultRoot}`);
}
