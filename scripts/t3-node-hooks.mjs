// Node module hooks that let a child process run a vendored T3 `.ts` file
// under our Node floor (T3 itself runs Node 26 with native type stripping).
// Test-only: vitest.t3.config.ts puts `--import scripts/t3-node-register.mjs`
// into NODE_OPTIONS, so T3's fake ACP agent (apps/server/scripts/acp-mock-agent.ts),
// which its adapter tests spawn with the current Node, can start.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { resolveT3 } from './t3-aliases.mjs';

export async function resolve(specifier, context, next) {
  const file = resolveT3(specifier);
  if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context);
  const file = fileURLToPath(url);
  // sync-t3 puts the MIT notice on line 1, which pushes an upstream shebang to line 2.
  const source = (await readFile(file, 'utf8')).replace(/^(\/\*![^\n]*\*\/\n)#![^\n]*\n/, '$1');
  const { code } = await transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'node20',
    sourcefile: file,
    sourcemap: 'inline',
  });
  return { format: 'module', source: code, shortCircuit: true };
}
