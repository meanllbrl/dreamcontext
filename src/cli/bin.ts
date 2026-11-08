// The built CLI's entry (`dist/index.js`), a few lines in front of the CLI itself (`dist/cli.js`,
// built from src/cli/index.ts). It exists for two things that must happen BEFORE the ~11 MB CLI
// bundle is compiled:
//
// 1. The inspector guard. Compiling the bundle takes ~0.15 s; on a Node without
//    `--disable-sigusr1` that is time in which SIGUSR1 opens an inspector (owner-key.ts). Run as
//    this file's first import, the guard lands before the compile instead of after it.
// 2. Node's on-disk compile cache (Node 22.8+, a no-op on older Node): the next start of the same
//    build reads compiled code instead of parsing the bundle again, about half of every start's
//    CPU, paid by every hook event. The cache is keyed by the file's content, so an upgrade never
//    runs stale code; a cache that cannot be written leaves the start as it was. Its folder is the
//    user's own cache folder, never a temp folder (compile-cache-dir.ts says why).
//
// Nothing here prints, reads argv or sets an environment variable (Node 22.16 leaves
// NODE_COMPILE_CACHE unset): `dist/cli.js` sees the same process.argv (argv[1] stays this file)
// and runs exactly as before.
import './inspector-guard.js';
import nodeModule from 'node:module';
import { compileCacheDir } from './compile-cache-dir.js';

type WithCompileCache = { enableCompileCache?: (dir: string) => unknown };
try {
  const dir = compileCacheDir();
  if (dir !== null) (nodeModule as unknown as WithCompileCache).enableCompileCache?.(dir);
} catch {
  // A cache is a speed-up only; the start goes on without it.
}

// A computed specifier, so the bundler leaves `cli.js` a file of its own instead of inlining it.
await import(new URL('./cli.js', import.meta.url).href);
