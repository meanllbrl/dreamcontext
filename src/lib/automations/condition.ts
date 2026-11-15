import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, writeFileSync } from 'node:fs';
import { claudeAwarePath } from '../claude-path.js';
import { cliAwarePath } from './cli-path.js';
import { hasHiddenChars, showHiddenChars } from '../hidden-chars.js';
import { redactSecrets } from '../telegram/format.js';

/**
 * A routine's CONDITION (kosullu-otomasyon plan): an inline shell script the runner runs on a
 * scheduled fire BEFORE any model turn. Exit 0 = true (the agent wakes and reads the script's
 * stdout as fenced data), exit 1 = false (nothing starts, a quiet `condition-false` row), anything
 * else (another code, a signal, a failed start, the timeout) = a loud condition error.
 *
 * Nothing here parses stdout: truth is the exit code alone.
 */

/** The condition sentence of `super schedule add --help` (the one rule text, kosullu-otomasyon C7). */
export const SUPER_CONDITION_HELP = 'For "check every N, act only if X", a condition script is the better default: '
  + 'the agent wakes only on its answer (exit 0 = true, exit 1 = false, anything else = a loud error), so a check that finds nothing costs no tokens. '
  + 'Combine checks inside the script (&&, ||, !). A source only an MCP connector reaches (claude.ai Gmail, Slack) cannot be checked by a script. '
  + 'The owner approves the script on its card: until he does, the job waits.';

/** The fixed timeout of one check. */
export const CONDITION_TIMEOUT_MS = 60_000;
/** The grace between SIGTERM and SIGKILL of the script's process group. */
const KILL_GRACE_MS = 2_000;
/** The most of the script's stdout that ever reaches a model, in UTF-8 bytes, marker included. */
export const CONDITION_DATA_MAX_BYTES = 8192;
/** The stderr tail an error row keeps (after the credential scrub). */
export const CONDITION_ERR_CAP = 2048;
/** The longest condition script a manifest may hold. */
export const CONDITION_MAX_CHARS = 4000;
/** The `## Condition` section heading. */
export const CONDITION_HEADING = 'Condition';

const TRUNCATED = '\n[... truncated]';

export type ConditionVerdict = 'true' | 'false' | 'error';

export interface ConditionResult {
  verdict: ConditionVerdict;
  /** The bounded stdout ({@link boundConditionData}); '' on an error or when nothing was printed. */
  data: string;
  /** The scrubbed last {@link CONDITION_ERR_CAP} bytes of stderr. */
  stderrTail: string;
  exitCode: number | null;
  /** Why an error is an error ("exit 3", "timed out after 60 s", "could not start: …"). */
  reason?: string;
}

/** CRLF→LF and trimmed: the form the hash, the mark and the runner all use. */
export function normalizeCondition(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

/** sha256 hex of the normalized condition and its wake switch: what an approval's witness mark
 *  holds. `wake: false` (wake when the script is NOT true) is part of it, so flipping the switch
 *  needs the owner again; the default `true` adds nothing. */
export function conditionSha(script: string, wake: boolean = true): string {
  return createHash('sha256').update(normalizeCondition(script) + (wake ? '' : '\nwake:false'), 'utf8').digest('hex');
}

/** Does this verdict wake the agent under this switch? An error never wakes. */
export function conditionWakes(verdict: ConditionVerdict, wake: boolean = true): boolean {
  return wake ? verdict === 'true' : verdict === 'false';
}

/**
 * Why a condition script cannot be stored or run, or null when it can. The rules keep "what is
 * shown is what runs": no hidden or direction-changing character, and no line that would end the
 * `## Condition` section or its fence when the file is read back.
 */
export function conditionInvalidReason(raw: string): string | null {
  const s = normalizeCondition(raw);
  if (!s) return 'the condition script is empty';
  if (s.length > CONDITION_MAX_CHARS) return `the condition script is longer than ${CONDITION_MAX_CHARS} characters`;
  if (s.includes('\u0000')) return 'the condition script holds a NUL character';
  const hidden = s.split('\n').find((l) => hasHiddenChars(l));
  if (hidden !== undefined) {
    return `the condition script holds a hidden or direction-changing character: ${showHiddenChars(hidden).trim()}`;
  }
  for (const line of s.split('\n')) {
    const t = line.trimStart();
    if (t.startsWith('##')) return 'a line of the condition script starts with "##" (that would end the section; write a comment as "# ...")';
    if (t.startsWith('```')) return 'a line of the condition script starts with ``` (that would end its fence)';
  }
  return null;
}

/** Cut `text` to at most {@link CONDITION_DATA_MAX_BYTES} UTF-8 bytes, marker included, at a
 *  character boundary. The ONE producer every store hop's validator agrees with. */
export function boundConditionData(text: string): string {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= CONDITION_DATA_MAX_BYTES) return s;
  const room = CONDITION_DATA_MAX_BYTES - Buffer.byteLength(TRUNCATED, 'utf8');
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > room) break;
    out += ch;
    used += n;
  }
  return out + TRUNCATED;
}

/** Is `v` condition data as the producer emits it? Every store hop and renderer asks this. */
export function isConditionData(v: unknown): v is string {
  return typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= CONDITION_DATA_MAX_BYTES;
}

/** A condition's stderr tail with credentials scrubbed: the one string every error surface gets. */
export function scrubConditionText(text: string): string {
  return redactSecrets(text)
    .replace(/(authorization\s*:\s*)(?:\S+\s+)?\S+/gi, '$1[redacted]')
    .replace(/\b((?:[A-Za-z0-9_]*?)(?:token|key|secret|password|passwd|pwd))(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]');
}

/** The script drawn for a human: every line kept, each indented, hidden characters made visible. */
export function visibleScript(script: string, indent = '  '): string {
  return showHiddenChars(normalizeCondition(script)).split('\n').map((l) => `${indent}${l}`).join('\n');
}

/** Env keys a condition never inherits. */
const STRIPPED_PREFIXES = ['DREAMCONTEXT_WINDOW_'];
const STRIPPED_KEYS = new Set(['CLAUDE_CONFIG_DIR']);

/**
 * THE env of a condition script. It starts from this process's env without the window token and
 * the Claude account dir, gets a PATH that resolves `dreamcontext`, `node` and `claude` (never
 * launchd's bare PATH), and is marked as an agent-driven run (`DREAMCONTEXT_AUTOMATION_RUN`), so
 * every owner-only verb refuses the script exactly as it refuses a run.
 */
export function conditionEnv(
  input: { slug: string; slot?: string; fireAt: Date },
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIPPED_KEYS.has(k) || STRIPPED_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  env.PATH = cliAwarePath(claudeAwarePath(base.PATH ?? ''));
  env.DREAMCONTEXT_AUTOMATION_SLUG = input.slug;
  if (input.slot) env.DREAMCONTEXT_AUTOMATION_SLOT = input.slot;
  else delete env.DREAMCONTEXT_AUTOMATION_SLOT;
  env.DREAMCONTEXT_CONDITION = '1';
  env.DREAMCONTEXT_AUTOMATION_RUN = input.fireAt.toISOString();
  return env;
}

export type ConditionSpawn = (file: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface RunConditionOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  errCap?: number;
  spawnFn?: ConditionSpawn;
  /** Told the live child, so a signal handler can kill it. */
  onChild?: (child: ChildProcess | null) => void;
}

/** Kill the script's whole process group (POSIX) or tree (win32). Never throws. */
function killTree(child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (platform === 'win32') {
      nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Kill a live condition child from outside (the runner's signal handlers). */
export function killCondition(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  killTree(child, platform, 'SIGKILL');
}

/**
 * Run one condition script. Never throws, and settles within the timeout plus three seconds.
 * POSIX: `/bin/sh -c <script>`; win32: the script as a fresh temp `.cmd`, run with
 * `cmd.exe /d /c`, deleted afterwards. stdin is closed; the process group is killed on timeout.
 */
export function runCondition(script: string, opts: RunConditionOptions): Promise<ConditionResult> {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? CONDITION_TIMEOUT_MS;
  const errCap = opts.errCap ?? CONDITION_ERR_CAP;
  const spawnFn: ConditionSpawn = opts.spawnFn ?? ((f, a, o) => nodeSpawn(f, a, o));
  const body = normalizeCondition(script);

  return new Promise<ConditionResult>((resolve) => {
    let tmpCmd: string | null = null;
    let settled = false;
    let timedOut = false;
    // Kept bounded while reading: writing too much never kills the child, it only stops being kept.
    const outChunks: Buffer[] = [];
    let outBytes = 0;
    const OUT_KEEP = CONDITION_DATA_MAX_BYTES * 2;
    let errBuf = Buffer.alloc(0);
    const timers: NodeJS.Timeout[] = [];

    const finish = (r: Omit<ConditionResult, 'data' | 'stderrTail'>): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.onChild?.(null);
      if (tmpCmd) { try { unlinkSync(tmpCmd); } catch { /* gone */ } }
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const tail = errBuf.toString('utf8');
      resolve({
        ...r,
        data: r.verdict === 'error' ? '' : boundConditionData(stdout.replace(/\s+$/, '')),
        stderrTail: scrubConditionText(tail).slice(-errCap),
      });
    };

    let child: ChildProcess;
    try {
      let file: string;
      let args: string[];
      if (platform === 'win32') {
        tmpCmd = join(tmpdir(), `dc-condition-${process.pid}-${randomBytes(6).toString('hex')}.cmd`);
        writeFileSync(tmpCmd, `@echo off\r\n${body.replace(/\n/g, '\r\n')}\r\n`, 'utf8');
        file = 'cmd.exe';
        args = ['/d', '/c', tmpCmd];
      } else {
        file = '/bin/sh';
        args = ['-c', body];
      }
      child = spawnFn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      finish({ verdict: 'error', exitCode: null, reason: `could not start: ${(err as Error).message}` });
      return;
    }
    opts.onChild?.(child);

    child.stdout?.on('data', (b: Buffer) => {
      if (outBytes >= OUT_KEEP) return;
      outChunks.push(b);
      outBytes += b.length;
    });
    child.stderr?.on('data', (b: Buffer) => {
      errBuf = Buffer.concat([errBuf, b]);
      if (errBuf.length > errCap * 2) errBuf = errBuf.subarray(errBuf.length - errCap * 2);
    });
    child.on('error', (err) => {
      finish({ verdict: 'error', exitCode: null, reason: `could not start: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({ verdict: 'error', exitCode: code, reason: `timed out after ${Math.round(timeoutMs / 1000)} s` });
      } else if (code === 0) {
        finish({ verdict: 'true', exitCode: 0 });
      } else if (code === 1) {
        finish({ verdict: 'false', exitCode: 1 });
      } else {
        finish({ verdict: 'error', exitCode: code, reason: code === null ? `killed by ${signal ?? 'a signal'}` : `exit ${code}` });
      }
    });

    timers.push(setTimeout(() => {
      timedOut = true;
      killTree(child, platform, 'SIGTERM');
      timers.push(setTimeout(() => killTree(child, platform, 'SIGKILL'), KILL_GRACE_MS));
    }, timeoutMs));
    // The hard bound: whatever the child does, the promise settles.
    timers.push(setTimeout(() => {
      killTree(child, platform, 'SIGKILL');
      finish({ verdict: 'error', exitCode: null, reason: `timed out after ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs + KILL_GRACE_MS + 1_000));
  });
}
