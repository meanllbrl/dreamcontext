/**
 * Regenerates the dashboard's mirrors of the Lab board engine (the dashboard
 * cannot import `src/`):
 *   • dashboard/src/generated/block-catalog.json  from src/lib/lab/blocks.ts (`blockCatalogMirror()`)
 *   • dashboard/src/generated/frameOps.ts         BYTE-IDENTICAL copy of src/lib/lab/frameOps.ts
 *   • dashboard/src/generated/grid.ts             BYTE-IDENTICAL copy of src/lib/lab/grid.ts
 *   • dashboard/src/generated/presets.ts          BYTE-IDENTICAL copy of src/lib/lab/presets.ts
 *
 * `tests/unit/lab-mirrors-drift.test.ts` fails when any copy differs, so this
 * script, not a hand edit, is how a mirror moves. blocks.ts is bundled with
 * esbuild (already a dev dependency through tsup/vite) so plain node can run it.
 *
 * Usage: node scripts/gen-lab-mirrors.mjs
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const OUT = 'dashboard/src/generated';
const COPIES = ['frameOps.ts', 'grid.ts', 'presets.ts'];

mkdirSync(OUT, { recursive: true });
for (const file of COPIES) {
  copyFileSync(`src/lib/lab/${file}`, `${OUT}/${file}`);
  console.log(`${OUT}/${file}: copied from src/lib/lab/${file}`);
}

const bundle = await build({
  entryPoints: ['src/lib/lab/blocks.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const json = JSON.stringify(mod.blockCatalogMirror(), null, 2) + '\n';
writeFileSync(`${OUT}/block-catalog.json`, json, 'utf-8');
console.log(`${OUT}/block-catalog.json: ${mod.BLOCK_TYPES.length} block types`);
