import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Credential supply for every networked git call (decision F, resolves S1).
 * The token is NEVER embedded in a remote URL or process env/argv — it is
 * written to a fresh, 0600-at-create tmp file, and git is pointed at an
 * askpass helper via `GIT_ASKPASS` + `DREAMCONTEXT_ASKPASS_TOKEN_FILE`. The
 * tmp file is unlinked in `finally`, even when `fn` throws.
 */

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * `askpass.cjs` ships alongside this compiled module in dev/test (same dir as
 * `credentials.ts`/`.js`) and, in the bundled production dist (tsup produces a
 * single `dist/index.js`), is copied by the build to `dist/git-sync/askpass.cjs`
 * — see `tsup.config.ts` `onSuccess`. Both candidates are checked so this
 * resolves identically whether run from source, ts-node/vitest, or the packed CLI.
 */
export function resolveAskpassPath(): string {
  const candidates = [
    join(here, 'askpass.cjs'),
    join(here, 'git-sync', 'askpass.cjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('askpass.cjs not found — the dreamcontext installation may be corrupt or incomplete.');
}

/**
 * Run `fn` with a child-process env that supplies `token` to git via the
 * askpass contract. The token itself never appears in env or argv — only the
 * path to a 0600 tmp file holding it does.
 */
export async function withGitCredentials<T>(
  token: string,
  fn: (env: NodeJS.ProcessEnv) => Promise<T> | T,
): Promise<T> {
  const tmpPath = join(tmpdir(), `dreamcontext-askpass-${randomUUID()}`);
  // Created 0600 ATOMICALLY at write (mode-on-create) — never write-then-chmod,
  // which leaves a world-readable window. Belt-and-suspenders chmod follows,
  // mirroring secrets.ts:86-88 (mode-on-create doesn't apply on every filesystem).
  writeFileSync(tmpPath, token, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* best-effort on exotic filesystems */
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_ASKPASS: resolveAskpassPath(),
    DREAMCONTEXT_ASKPASS_TOKEN_FILE: tmpPath,
    GIT_TERMINAL_PROMPT: '0',
  };

  try {
    return await fn(env);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort — already gone */
    }
  }
}
