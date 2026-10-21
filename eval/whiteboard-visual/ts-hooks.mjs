// Node module hooks that run the CLI straight from its TypeScript source (no build): a `.js`
// import that has no file is retried as `.ts`, a `.ts` file is stripped by esbuild on load, and a
// JSON file loads without the import attribute Node would otherwise demand.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:');
    if (relative && specifier.endsWith('.js') && err?.code === 'ERR_MODULE_NOT_FOUND') {
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw err;
  }
}

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const file = fileURLToPath(url);
    const { code } = await transform(await readFile(file, 'utf-8'), { loader: 'ts', format: 'esm', target: 'node20', sourcefile: file });
    return { format: 'module', source: code, shortCircuit: true };
  }
  // The bundler inlines JSON imports written without an import attribute; Node wants one.
  if (url.startsWith('file:') && url.endsWith('.json')) {
    return { format: 'json', source: await readFile(fileURLToPath(url), 'utf-8'), shortCircuit: true };
  }
  return next(url, context);
}
