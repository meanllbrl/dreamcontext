// Rebuild every documentation diagram: run each Excalidraw board spec (writes the
// editable .excalidraw.md into the vault) then render it to a PNG under public/image/.
// This is the single command the pre-release workflow runs so README + DEEP-DIVE
// figures are always current.
//
//   node scripts/diagrams/build-all.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRenderer } from './render-excalidraw.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIA = resolve(ROOT, '_dream_context/knowledge/diagrams');
const OUT = resolve(ROOT, 'public/image');

// Boards live in per-title folders, optionally grouped under a category subfolder
// (e.g. diagrams/system/recall/recall.board.cjs). Resolve each board by basename
// anywhere under DIA so the manifest stays a flat name → png map regardless of how
// the boards are organized on disk.
function findUnder(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) {
      const hit = findUnder(full, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return full;
    }
  }
  return null;
}

// name → { board spec (.cjs), rendered png, scale }. PNG basenames are the public
// contract the docs reference; keep them stable.
const DIAGRAMS = [
  { board: 'how-it-works.board.cjs', png: 'diagram-howitworks.png', scale: 2 },
  { board: 'sleep.board.cjs', png: 'diagram-sleep.png', scale: 2 },
  { board: 'recall.board.cjs', png: 'diagram-recall.png', scale: 2 },
  { board: 'problem.board.cjs', png: 'diagram-problem.png', scale: 2 },
  { board: 'architecture.board.cjs', png: 'diagram-architecture.png', scale: 2 },
  { board: 'neuroscience.board.cjs', png: 'diagram-neuroscience.png', scale: 2 },
  { board: 'council.board.cjs', png: 'diagram-council.png', scale: 2 },
  // Federation also emits a standalone PDF (linkable from DEEP-DIVE).
  { board: 'federation.board.cjs', png: 'diagram-federation.png', pdf: 'diagram-federation.pdf', scale: 2 },
];

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

console.log('1/2  building boards (spec → .excalidraw.md)…');
for (const d of DIAGRAMS) {
  const boardPath = findUnder(DIA, d.board);
  if (!boardPath) { console.log(`  SKIP ${d.board} (not found)`); continue; }
  // Generators write their .excalidraw.md next to themselves (__dirname), so the
  // board folder's location is irrelevant to where the output lands.
  execFileSync('node', [boardPath], { stdio: 'pipe' });
  console.log(`  built ${d.board}`);
}

console.log('2/2  rendering PNGs (board → public/image)…');
await withRenderer(async (render) => {
  for (const d of DIAGRAMS) {
    const boardMd = findUnder(DIA, d.board.replace('.board.cjs', '.excalidraw.md'));
    if (!boardMd) continue;
    await render(boardMd, resolve(OUT, d.png), d.scale);
    if (d.pdf) await render.pdf(boardMd, resolve(OUT, d.pdf), d.scale);
  }
});
console.log('✓ diagrams rebuilt');
