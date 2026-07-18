/**
 * transcript-locate — shared resolver for finding a session's transcript on
 * disk under either layout Claude Code has used:
 *
 *   - FLAT (verified 2026-07-18, current): `<projectDir>/<sessionId>.jsonl`
 *   - DIR  (verified 2026-07-18, exists alongside flat TODAY but contains only
 *     `subagents/` + `tool-results/` — no main transcript inside — a future
 *     layout change could start writing the main jsonl there instead)
 *
 * Flat is always probed FIRST. The dir layout is a graceful fallback: when a
 * session dir exists but holds no recognizable main transcript, callers get
 * `{ mainPath: null, sessionDir: <dir>, layout: 'dir' }` instead of a silent
 * zero — the caller can still harvest `subagents/` even with no main file.
 * Never throws; every fs call is guarded.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface TranscriptLocation {
  mainPath: string | null;
  sessionDir: string | null;
  layout: 'flat' | 'dir' | 'none';
}

/**
 * Candidate main-jsonl filenames probed INSIDE a session dir, in order.
 * `<sessionId>.jsonl` is a template substituted with the resolved session id;
 * the other two are fixed names probed as-is.
 */
export const DIR_LAYOUT_MAIN_CANDIDATES: readonly string[] = [
  '<sessionId>.jsonl',
  'transcript.jsonl',
  'main.jsonl',
];

const SESSION_ID_TEMPLATE = '<sessionId>.jsonl';

function candidateFilename(template: string, sessionId: string | null): string | null {
  if (template === SESSION_ID_TEMPLATE) {
    return sessionId ? `${sessionId}.jsonl` : null;
  }
  return template;
}

function defaultExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function defaultIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function probeSessionDir(
  dirPath: string,
  existsImpl: (p: string) => boolean,
  isDirImpl: (p: string) => boolean,
): string | null {
  return existsImpl(dirPath) && isDirImpl(dirPath) ? dirPath : null;
}

function sessionIdFromFlatBasename(p: string): string {
  const b = basename(p);
  return b.endsWith('.jsonl') ? b.slice(0, -'.jsonl'.length) : b;
}

/**
 * Resolve a session's transcript location. Probes FLAT first (recorded path,
 * then the re-derived `<projectDir>/<sessionId>.jsonl` in case the recorded
 * path is stale), then falls back to the DIR layout. Returns
 * `{ null, null, 'none' }` when nothing can be resolved. Never throws.
 */
export function resolveTranscript(
  recordedPath: string | null,
  opts: {
    sessionId?: string;
    existsImpl?: (p: string) => boolean;
    isDirImpl?: (p: string) => boolean;
  } = {},
): TranscriptLocation {
  const existsImpl = opts.existsImpl ?? defaultExists;
  const isDirImpl = opts.isDirImpl ?? defaultIsDir;

  let projectDir: string | null = null;
  let sessionId: string | null = opts.sessionId ?? null;

  if (recordedPath) {
    projectDir = dirname(recordedPath);
    if (!sessionId) sessionId = sessionIdFromFlatBasename(recordedPath);
  }

  // FLAT #1: the recorded path itself, exactly as given.
  if (recordedPath && existsImpl(recordedPath) && !isDirImpl(recordedPath)) {
    const sessionDir = projectDir && sessionId
      ? probeSessionDir(join(projectDir, sessionId), existsImpl, isDirImpl)
      : null;
    return { mainPath: recordedPath, sessionDir, layout: 'flat' };
  }

  // FLAT #2: re-derive `<projectDir>/<sessionId>.jsonl` — covers a stale
  // recordedPath (e.g. an explicit sessionId override) whose derived flat
  // file still exists even though recordedPath itself does not.
  if (projectDir && sessionId) {
    const flatPath = join(projectDir, `${sessionId}.jsonl`);
    if (flatPath !== recordedPath && existsImpl(flatPath) && !isDirImpl(flatPath)) {
      const sessionDir = probeSessionDir(join(projectDir, sessionId), existsImpl, isDirImpl);
      return { mainPath: flatPath, sessionDir, layout: 'flat' };
    }
  }

  // DIR fallback.
  if (projectDir && sessionId) {
    const dirPath = join(projectDir, sessionId);
    if (existsImpl(dirPath) && isDirImpl(dirPath)) {
      for (const template of DIR_LAYOUT_MAIN_CANDIDATES) {
        const filename = candidateFilename(template, sessionId);
        if (!filename) continue;
        const candidate = join(dirPath, filename);
        if (existsImpl(candidate) && !isDirImpl(candidate)) {
          return { mainPath: candidate, sessionDir: dirPath, layout: 'dir' };
        }
      }
      return { mainPath: null, sessionDir: dirPath, layout: 'dir' };
    }
  }

  return { mainPath: null, sessionDir: null, layout: 'none' };
}

/** Cap on subagent transcripts harvested per session. */
export const SUBAGENT_HARVEST_CAP = 20;

const AGENT_JSONL_RE = /^agent-.*\.jsonl$/;

/**
 * List `<sessionDir>/subagents/agent-*.jsonl`, newest-mtime first, capped at
 * `SUBAGENT_HARVEST_CAP` (or `opts.max`). `[]` when `loc.sessionDir` is null
 * or the `subagents/` dir is absent/unreadable. Never throws.
 */
export function listSubagentTranscripts(
  loc: TranscriptLocation,
  opts: {
    max?: number;
    readdirImpl?: (p: string) => string[];
    statImpl?: (p: string) => { mtimeMs: number };
  } = {},
): string[] {
  if (!loc.sessionDir) return [];

  const readdirImpl = opts.readdirImpl ?? ((p: string) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  });
  const statImpl = opts.statImpl ?? ((p: string) => statSync(p));
  const max = opts.max ?? SUBAGENT_HARVEST_CAP;

  const subagentsDir = join(loc.sessionDir, 'subagents');
  const entries = readdirImpl(subagentsDir).filter((f) => AGENT_JSONL_RE.test(f));

  const withMtime = entries.map((f) => {
    const full = join(subagentsDir, f);
    let mtimeMs = 0;
    try {
      mtimeMs = statImpl(full).mtimeMs;
    } catch {
      // unreadable — sorts as oldest (0), still included
    }
    return { full, mtimeMs };
  });

  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime.slice(0, max).map((e) => e.full);
}

/** `'…/agent-a80407b614ff89f5e.jsonl'` → `'a80407b614ff89f5e'`. */
export function subagentIdFromPath(p: string): string {
  const b = basename(p);
  const m = b.match(/^agent-(.+)\.jsonl$/);
  return m ? m[1] : b;
}
