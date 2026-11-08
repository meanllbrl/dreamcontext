/**
 * The old excalidraw pack's builder as 0.41.x shipped it, rebuilt from skill-draw: the only
 * difference is the command block (now `main`). Tests check the result against the retired
 * pack's shipped table, so a drift fails loudly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DRAW = join(__dirname, '..', '..', 'skill-draw');

const OLD_TAIL = `module.exports = { buildExcalidraw, lane, grid, thumbHeight, SPEC_TYPES, LAYOUT_TYPES };

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
  console.log(\`OK  \${res.outPath}\\n    elements=\${res.elements} images=\${res.images} texts=\${res.texts} overlaps=\${res.overlaps} buriedText=\${res.buriedText} longLines=\${res.longLines} wallOfText=\${res.wallOfText}\\n    vaultRoot=\${res.vaultRoot}\`);
}
`;
export function oldBuilder(): string {
  const now = readFileSync(join(DRAW, 'scripts', 'build_excalidraw.js'), 'utf-8');
  const cut = now.indexOf('// ---------- CLI ----------');
  return (now.slice(0, cut) + OLD_TAIL).replace('(see ../references/format.md)', '(see ../reference/format.md)');
}

