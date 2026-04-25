import {
  existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync,
  renameSync, unlinkSync, readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MARKETING_PATHS, marketingRoot } from './paths.js';
import { redactDeep } from './secrets.js';

// ─── Atomic write ────────────────────────────────────────────────────────────

function atomicWriteFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

/** Write JSON + paired .md bridge atomically. If .md fails, JSON is unwound. */
export function writeJsonWithBridge(
  jsonPath: string,
  bridgePath: string,
  jsonValue: unknown,
  bridgeMarkdown: string,
): void {
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(bridgePath), { recursive: true });

  const jsonStr = JSON.stringify(jsonValue, null, 2) + '\n';
  const jsonTmp = `${jsonPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const bridgeTmp = `${bridgePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;

  writeFileSync(jsonTmp, jsonStr, 'utf8');
  try {
    writeFileSync(bridgeTmp, bridgeMarkdown, 'utf8');
  } catch (e) {
    try { unlinkSync(jsonTmp); } catch { /* ignore */ }
    throw e;
  }

  // Both tmp files written — flip atomically. JSON first (canonical).
  renameSync(jsonTmp, jsonPath);
  try {
    renameSync(bridgeTmp, bridgePath);
  } catch (e) {
    // .md flip failed but JSON is live — best-effort cleanup, surface error.
    try { unlinkSync(bridgeTmp); } catch { /* ignore */ }
    throw e;
  }
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// ─── PID lockfile ────────────────────────────────────────────────────────────

export class LockBusyError extends Error {
  constructor(public readonly heldByPid: number) {
    super(`marketing lock held by PID ${heldByPid}`);
    this.name = 'LockBusyError';
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means process exists but we lack permission — treat as alive
    return code === 'EPERM';
  }
}

/** Acquire the marketing lock; returns a release fn. Throws LockBusyError. */
export function acquireLock(): () => void {
  const lockPath = MARKETING_PATHS.lockFile();
  mkdirSync(marketingRoot(), { recursive: true });

  if (existsSync(lockPath)) {
    const heldRaw = readFileSync(lockPath, 'utf8').trim();
    const heldPid = Number.parseInt(heldRaw, 10);
    // Treat any live PID as busy — including ourselves (don't allow silent
    // re-entrancy; concurrent acquisition is a bug, not a feature).
    if (pidAlive(heldPid)) {
      throw new LockBusyError(heldPid);
    }
    // Stale lock — clear
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }

  // O_EXCL create — fails if another process won the race
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      const heldRaw = existsSync(lockPath) ? readFileSync(lockPath, 'utf8').trim() : '?';
      throw new LockBusyError(Number.parseInt(heldRaw, 10) || -1);
    }
    throw e;
  }
  try {
    writeFileSync(fd, String(process.pid), 'utf8');
  } finally {
    closeSync(fd);
  }

  return function release(): void {
    try {
      const heldRaw = readFileSync(lockPath, 'utf8').trim();
      if (Number.parseInt(heldRaw, 10) === process.pid) {
        unlinkSync(lockPath);
      }
    } catch { /* ignore */ }
  };
}

export function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const release = acquireLock();
  return Promise.resolve()
    .then(() => fn())
    .finally(() => release());
}

// ─── WAL (write-ahead log) for runs/ ─────────────────────────────────────────

export interface RunRecord {
  id: string;            // ISO timestamp + random suffix
  verb: string;          // e.g. "competitor-ingest", "campaign-create"
  started_at: string;    // ISO
  completed_at: string | null;
  status: 'pending' | 'success' | 'failed';
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  events: Array<Record<string, unknown>>;
}

function isoTs(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function newRunId(verb: string): string {
  return `${isoTs()}__${verb}`;
}

export function runPath(runId: string): string {
  return join(MARKETING_PATHS.runsDir(), `${runId}.json`);
}

/** Begin a WAL entry. Returns helpers to append events and finalize. */
export function beginRun(verb: string, inputs: Record<string, unknown>): {
  id: string;
  path: string;
  appendEvent: (event: Record<string, unknown>) => void;
  succeed: (outputs?: Record<string, unknown>) => void;
  fail: (error: string) => void;
} {
  const id = newRunId(verb);
  const path = runPath(id);
  const record: RunRecord = {
    id,
    verb,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: 'pending',
    inputs: redactDeep(inputs),
    events: [],
  };
  atomicWriteFile(path, JSON.stringify(record, null, 2) + '\n');

  const flush = (): void => {
    atomicWriteFile(path, JSON.stringify(record, null, 2) + '\n');
  };

  return {
    id,
    path,
    appendEvent(event) {
      record.events.push(redactDeep(event));
      flush();
    },
    succeed(outputs) {
      record.status = 'success';
      record.completed_at = new Date().toISOString();
      if (outputs) record.outputs = redactDeep(outputs);
      flush();
      appendIndex(id, verb, 'success');
    },
    fail(error) {
      record.status = 'failed';
      record.completed_at = new Date().toISOString();
      record.error = error;
      flush();
      appendIndex(id, verb, 'failed');
    },
  };
}

/** Single LIFO log file at runs/index.md (no per-run .md proliferation). */
function appendIndex(runId: string, verb: string, status: string): void {
  const path = MARKETING_PATHS.runsIndex();
  mkdirSync(dirname(path), { recursive: true });
  const ts = new Date().toISOString();
  const line = `- \`${ts}\` **${verb}** (${status}) — [\`${runId}\`](./${runId}.json)\n`;
  let header = '';
  let body = '';
  if (existsSync(path)) {
    body = readFileSync(path, 'utf8');
  } else {
    header = '# Marketing runs (LIFO)\n\n';
  }
  // Prepend after header
  if (header) {
    writeFileSync(path, header + line + body, 'utf8');
  } else if (body.startsWith('# Marketing runs (LIFO)\n\n')) {
    const HDR = '# Marketing runs (LIFO)\n\n';
    writeFileSync(path, HDR + line + body.slice(HDR.length), 'utf8');
  } else {
    writeFileSync(path, '# Marketing runs (LIFO)\n\n' + line + body, 'utf8');
  }
}

// ─── List helpers ────────────────────────────────────────────────────────────

export function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}
