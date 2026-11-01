import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { findTranscriptBySessionId } from '../transcript-locate.js';

/**
 * The Claude session of a run while it runs. The runner learns it only from the JSON printed at
 * the end, so the run's own SessionStart hook writes it here and a card can show the real session
 * from its first minute.
 *
 * AT THE HOME BOUNDARY, never in the brain: a note says which session a run lives in, and every
 * surface that opens a run believes it after a transcript check. `~/.dreamcontext/run-sessions/`
 * cannot arrive through a brain sync, and one file per run is keyed by the project's real path,
 * the slug and the run.
 *
 * FIRST WRITE WINS per run, so a nested `claude` that inherited the run's environment cannot
 * point the run at itself. The runner replaces the note at exit (`replaceRunSession`): it knows
 * first-hand which session finished, also after a failover.
 *
 * Beside each run's file sits a marker per SESSION (`isNotedRunSession`): the binding is written
 * only when a run ends, so a run in flight, or a killed one, is known as a run only from here.
 * What depends on that (the phone reads only an agent's words of a run) must outlive the run, so
 * an old note is swept only once its transcript is gone.
 */
const KEEP_MS = 2 * 86_400_000;
const SWEEP_EVERY_MS = 6 * 3_600_000;
const SWEEP_MAX_CHECKS = 50;
const SESSION_RE = /^[0-9a-f-]{36}$/i;
const SWEPT = '.swept';

function dir(home: string): string {
  return join(home, '.dreamcontext', 'run-sessions');
}

function realRoot(contextRoot: string): string {
  const root = dirname(contextRoot);
  try { return realpathSync(root); } catch { return root; }
}

function runFile(contextRoot: string, slug: string, runId: string, home: string): string {
  const key = createHash('sha256').update(`${realRoot(contextRoot)}\u0000${slug}\u0000${runId}`).digest('hex').slice(0, 32);
  return join(dir(home), `r-${key}.json`);
}

const sessionFile = (sessionId: string, home: string): string => join(dir(home), `s-${sessionId.toLowerCase()}`);

function write(path: string, body: string, exclusive: boolean): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  try {
    if (exclusive) linkSync(tmp, path); else renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** An old note goes only with its transcript. Throttled, and capped per sweep: this runs in a
 *  SessionStart hook, and each check walks the projects folder. */
function sweep(home: string, now: number): void {
  const marker = join(dir(home), SWEPT);
  try { if (now - statSync(marker).mtimeMs < SWEEP_EVERY_MS) return; } catch { /* never swept */ }
  writeFileSync(marker, '', { mode: 0o600 });
  utimesSync(marker, new Date(now), new Date(now));
  let checks = 0;
  for (const name of readdirSync(dir(home))) {
    if (name === SWEPT || name.endsWith('.tmp')) continue;
    const path = join(dir(home), name);
    if (now - statSync(path).mtimeMs <= KEEP_MS) continue;
    if (checks++ >= SWEEP_MAX_CHECKS) return;
    let id: string | null = null;
    if (name.startsWith('s-')) id = name.slice(2);
    else {
      try { id = (JSON.parse(readFileSync(path, 'utf-8')) as { sessionId?: string }).sessionId ?? null; } catch { id = null; }
    }
    if (!id || findTranscriptBySessionId([id], home) === null) rmSync(path, { force: true });
  }
}

/** Written from the hook: failing here must never touch the run. */
export function noteRunSession(contextRoot: string, slug: string, runId: string, sessionId: string, now = Date.now(), home: string = homedir()): void {
  try {
    if (!SESSION_RE.test(sessionId)) return;
    mkdirSync(dir(home), { recursive: true, mode: 0o700 });
    const path = runFile(contextRoot, slug, runId, home);
    // Taken before anything is marked: a nested session loses here and marks nothing.
    if (existsSync(path)) return;
    write(path, JSON.stringify({ sessionId }), true);
    write(sessionFile(sessionId, home), '', false);
    sweep(home, now);
  } catch { /* the card reads as unknown until the run ends */ }
}

/** The session the run really finished in, from the process that spawned it. The session noted
 *  before stays marked: its transcript is a run's all the same. */
export function replaceRunSession(contextRoot: string, slug: string, runId: string, sessionId: string, home: string = homedir()): void {
  try {
    if (!SESSION_RE.test(sessionId)) return;
    mkdirSync(dir(home), { recursive: true, mode: 0o700 });
    write(runFile(contextRoot, slug, runId, home), JSON.stringify({ sessionId }), false);
    write(sessionFile(sessionId, home), '', false);
  } catch { /* the binding it stands beside is the authority */ }
}

export function runningSessionFor(contextRoot: string, slug: string, runId: string, home: string = homedir()): string | null {
  try {
    const raw = JSON.parse(readFileSync(runFile(contextRoot, slug, runId, home), 'utf-8')) as { sessionId?: unknown };
    return typeof raw.sessionId === 'string' && SESSION_RE.test(raw.sessionId) ? raw.sessionId : null;
  } catch { return null; }
}

/** Was this session ever noted as a run's on this machine? */
export function isNotedRunSession(sessionId: string, home: string = homedir()): boolean {
  return SESSION_RE.test(sessionId) && existsSync(sessionFile(sessionId, home));
}
