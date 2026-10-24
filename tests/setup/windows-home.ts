import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * The suite isolates every test's home the POSIX way: it points HOME at a scratch folder, in
 * this process and in the env of every CLI child it spawns (pattern-test-isolation-injectable).
 * On Windows `os.homedir()` reads USERPROFILE, not HOME, so without this every test would read
 * and write the CI runner's real profile (one shared vault registry, one shared accounts dir).
 *
 * Test harness only, and only on win32: a HOME set by a test is mirrored into USERPROFILE,
 * here and in spawned children's env. Product code is untouched (it reads USERPROFILE, as
 * Windows means it to).
 */

/** The env a child should get: USERPROFILE follows HOME unless the caller chose its own. */
export function mirrorHomeForChild(
  env: Record<string, string | undefined>,
  parent: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const home = env.HOME;
  if (!home) return env;
  const own = env.USERPROFILE;
  if (own !== undefined && own !== parent.USERPROFILE) return env; // an explicit choice stays
  return { ...env, USERPROFILE: home };
}

function optionsSlot(args: unknown[]): Record<string, unknown> | null {
  for (const a of args.slice(1, 4)) {
    if (a && typeof a === 'object' && !Array.isArray(a)) return a as Record<string, unknown>;
  }
  return null;
}

if (process.platform === 'win32') {
  const real = process.env;
  const originalProfile = real.USERPROFILE;
  const isHome = (k: string | symbol) => typeof k === 'string' && k.toUpperCase() === 'HOME';
  process.env = new Proxy(real, {
    set(target, key, value) {
      (target as Record<string | symbol, unknown>)[key] = value;
      if (isHome(key)) target.USERPROFILE = String(value);
      return true;
    },
    deleteProperty(target, key) {
      delete (target as Record<string | symbol, unknown>)[key];
      if (isHome(key)) {
        if (originalProfile === undefined) delete target.USERPROFILE;
        else target.USERPROFILE = originalProfile;
      }
      return true;
    },
  });
  if (real.HOME) real.USERPROFILE = real.HOME;

  const cp = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = function (this: unknown, ...args: unknown[]) {
      const opts = optionsSlot(args);
      if (opts && opts.env && typeof opts.env === 'object') {
        const i = args.indexOf(opts);
        args[i] = { ...opts, env: mirrorHomeForChild(opts.env as Record<string, string | undefined>, real) };
      }
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  // Windows keeps a folder busy for a moment after a child that worked in it exits (EBUSY /
  // ENOTEMPTY on a test's cleanup). A recursive rmSync gets Node's own retry there.
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const rmOrig = fs.rmSync as (p: unknown, o?: Record<string, unknown>) => void;
  // A folder that a still-running background child (an auto-sleep run, a hanging sync CLI) uses
  // as its working directory cannot be removed until it exits; a test's forced cleanup leaves it
  // on the runner rather than failing the test after it passed.
  fs.rmSync = (p: unknown, o?: Record<string, unknown>) => {
    if (!o || !o.recursive) { rmOrig(p, o); return; }
    try {
      rmOrig(p, o.maxRetries === undefined ? { ...o, maxRetries: 10, retryDelay: 100 } : o);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (o.force && (code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM')) {
        process.stderr.write(`[windows-home] cleanup left ${String(p)} behind (${code})\n`);
        return;
      }
      throw err;
    }
  };
  syncBuiltinESMExports();
}
