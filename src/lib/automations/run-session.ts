import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureGitignoreEntries } from '../gitignore.js';

/**
 * The Claude session of a run while it runs. The runner learns it only from the JSON printed at
 * the end, so the run's own SessionStart hook writes it here and a card can show the real session
 * from its first minute. Machine-local, one small file per run, swept by age.
 */
const KEEP_MS = 2 * 86_400_000;

function dir(contextRoot: string): string {
  return join(contextRoot, 'state', '.run-sessions');
}
function fileFor(contextRoot: string, slug: string, runId: string): string {
  return join(dir(contextRoot), `${createHash('sha256').update(`${slug}\u0000${runId}`).digest('hex').slice(0, 32)}.json`);
}

/** Written from the hook: failing here must never touch the run. */
export function noteRunSession(contextRoot: string, slug: string, runId: string, sessionId: string, now = Date.now()): void {
  try {
    if (!existsSync(dir(contextRoot))) {
      // An existing brain repo never rewrites its ignore file: this entry has to reach it here.
      const comment = 'dreamcontext: machine-local session ids of running agents';
      try { ensureGitignoreEntries(dirname(contextRoot), ['_dream_context/state/.run-sessions/'], { comment }); } catch { /* best-effort */ }
      try { if (existsSync(join(contextRoot, '.gitignore'))) ensureGitignoreEntries(contextRoot, ['state/.run-sessions/'], { comment }); } catch { /* best-effort */ }
      mkdirSync(dir(contextRoot), { recursive: true });
    }
    const path = fileFor(contextRoot, slug, runId);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessionId }), 'utf-8');
    renameSync(tmp, path);
    for (const f of readdirSync(dir(contextRoot))) {
      const p = join(dir(contextRoot), f);
      if (now - statSync(p).mtimeMs > KEEP_MS) rmSync(p, { force: true });
    }
  } catch { /* the card reads as unknown until the run ends */ }
}

export function runningSessionFor(contextRoot: string, slug: string, runId: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(fileFor(contextRoot, slug, runId), 'utf-8')) as { sessionId?: unknown };
    return typeof raw.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(raw.sessionId) ? raw.sessionId : null;
  } catch { return null; }
}
