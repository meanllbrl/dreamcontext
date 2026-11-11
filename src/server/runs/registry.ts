/**
 * The run registry (plan H4, H5, H7, I1, I3, J1, K1): a run card's process is a SERVER object,
 * not a socket.
 *
 * Before this, a run card's command lived and died with the one WebSocket that spawned it: the
 * Mac card's InlineTerminal. Now the same card can be started from the Mac, the hands-free phone
 * page or a Telegram button, watched from all three at once, and must run ONCE. So a run is keyed
 * `(sessionId, cardRef)`; it owns its PTY; clients ATTACH (a set of outputs, a 64 KB replay of
 * what they missed); there is ONE stdin writer, through which every keystroke and every Telegram
 * line goes; Ctrl-C writes `\x03`; a 30 minute cap; the server's shutdown kills it (`trackChild`).
 * One run per chat across all three places.
 *
 * What runs is the RECORD's spec (src/lib/cards/records.ts), never a client's string: the
 * command, the card's `cwd` (project-relative, realpath-contained) and the project of the chat
 * the record belongs to.
 *
 * The SERVER reports a run it owns (H5): on exit it closes the card record itself, BEFORE the
 * report goes anywhere (J1), then hands one `[ran in chat]` report (src/lib/run-report.ts, the
 * Mac card's own builder) to the delivery hook. Attached cards never post a second one.
 *
 * Relayed terminals (H7): every run gets `DREAMCONTEXT_RELAYED_PTY=1` (the CLI prints no
 * terminal-only secret into it) and the hands-free login token is scrubbed from the stream
 * before it enters the replay buffer or reaches any client.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { appendTail, buildRunReport, finishTail, stripAnsi } from '../../lib/run-report.js';
import { finishCardRun, getCard, markCardStarted, setCardRun, type CardRecordEntry } from '../../lib/cards/records.js';
import { RUN_CAP_MS, RUN_REPLAY_BYTES, type RunReport } from '../../lib/telegram/contract.js';
import { scrubLoginToken } from '../../lib/telegram/format.js';
import { RELAYED_PTY_ENV } from '../../lib/handsfree/mac/contract.js';
import type { RunViewSpec } from '../../lib/chat-view-spec.js';

export type RunStarter = 'mac' | 'phone' | 'telegram';

/** What the registry needs of a PTY (node-pty's IPty, or a test fake). */
export interface RunPty {
  pid: number;
  /** node-pty's pts path on unix (`/dev/ttys003`); absent on a fake or Windows. */
  ptsName?: string;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SpawnRequest { command: string; cwd: string; env: Record<string, string> }
export type RunSpawner = (req: SpawnRequest) => RunPty;

export interface Run {
  readonly runId: string;
  readonly sessionId: string;
  readonly cardRef: string;
  readonly startedBy: RunStarter;
  /** "Çalıştır, çıktıyı ajana verme": the report carries no output, Telegram shows none (H7). */
  readonly withheld: boolean;
  /** A Mac "Run again" of a closed card (K1): reported as a Mac run, never to Telegram. */
  readonly rerun: boolean;
  readonly command: string;
  readonly startedAt: number;
  /** Output sequence number: bumped on every chunk (I3: "no output after the edit you answer"). */
  seq(): number;
  /** The scrubbed replay (≤ 64 KB) for an attaching client. */
  replay(): string;
  /** The scrubbed, ANSI-stripped text tail (Telegram's message, the prompt check). */
  textTail(): string;
  /** Raw keystrokes from an attached terminal (the one stdin writer). */
  input(data: string): void;
  /** One line from a relay (Telegram), already through {@link relayLine}'s checks. */
  writeLine(line: string): void;
  interrupt(): void;
  resize(cols: number, rows: number): void;
  onOutput(fn: (chunk: string, seq: number) => void): () => void;
  onExit(fn: (report: RunReport, code: number | null) => void): () => void;
  /** Ended (and its report built)? */
  ended(): boolean;
  /** The pts path, for the ECHO check. */
  ptsName(): string | null;
  kill(): void;
}

export type RunRefusal = 'no_record' | 'closed' | 'busy' | 'not_run' | 'no_pty' | 'bad_cwd' | 'spawn_failed';

export interface RunDelivery {
  /** The run started: hold a "cut off" report on disk now, so a server that dies before the
   *  exit still owes the agent one (sent when the chat's window mounts after the restart). */
  started?(run: Run, record: CardRecordEntry): void;
  /** The run ended: HOLD its report, synchronously, BEFORE the record closes (sahip-karti-yerinde
   *  K6: a result is held before anything that can lose it). */
  hold?(run: Run, record: CardRecordEntry, report: RunReport): void;
  /** The run ended: deliver its report to the chat (H5). The record is already closed. Must put
   *  the report on disk before its first await: the process may exit right after. */
  report(run: Run, record: CardRecordEntry, report: RunReport): void;
}

interface Deps {
  spawner: RunSpawner | null;
  /** The project root of a vault name (registered vaults only). */
  projectRootOf: (vault: string) => string | null;
  resolveCwd: (projectRoot: string, rel: string) => string | null;
  delivery: RunDelivery | null;
  trackChild: (kill: () => void) => () => void;
  now: () => number;
  capMs: number;
}

const deps: Deps = {
  spawner: null,
  projectRootOf: () => null,
  resolveCwd: () => null,
  delivery: null,
  trackChild: () => () => { /* untracked */ },
  now: Date.now,
  capMs: RUN_CAP_MS,
};

/** Wire the registry (the server at start; tests with fakes). */
export function configureRuns(next: Partial<Deps>): void {
  Object.assign(deps, next);
}

const runs = new Map<string, Run>(); // by sessionId: one run per chat

/** The project root the registry was wired with for a vault (registered vaults only): where a
 *  card's working folder is resolved from (K5). */
export function runProjectRootOf(vault: string): string | null {
  return deps.projectRootOf(vault);
}

/** The live run of a chat, if any. */
export function runOfSession(sessionId: string): Run | null {
  return runs.get(sessionId) ?? null;
}

/** The live run of exactly this card, if any. */
export function attachRun(sessionId: string, cardRef: string): Run | null {
  const r = runs.get(sessionId);
  return r && r.cardRef === cardRef && !r.ended() ? r : null;
}

/**
 * Start the card's run, or return the one already going for it. Phone and Telegram may only start
 * an OPEN record; the Mac may start a closed one as a Run again (K1), which keeps it closed.
 */
export function startRun(
  sessionId: string,
  cardRef: string,
  by: RunStarter,
  opts: { withheld?: boolean; rerun?: boolean; root?: string } = {},
): Run | { refused: RunRefusal } {
  const rec = getCard(sessionId, cardRef);
  if (!rec) return { refused: 'no_record' };
  if (rec.kind !== 'run') return { refused: 'not_run' };
  const live = runs.get(sessionId);
  if (live && !live.ended()) return live.cardRef === cardRef ? live : { refused: 'busy' };
  const rerun = rec.state === 'closed';
  if (rerun && !(by === 'mac' && opts.rerun)) return { refused: 'closed' };
  if (!deps.spawner) return { refused: 'no_pty' };
  // The card's working folder (sahip-karti-yerinde K5): the caller resolved it from the server's
  // state (`cardWorkingRoot`, the child's worktree when it has one) BEFORE this call. Only a
  // caller that never names one (a test of the registry alone) falls back to the project root.
  const projectRoot = opts.root ?? deps.projectRootOf(rec.vault);
  if (!projectRoot) return { refused: 'no_record' };
  const spec = rec.spec as RunViewSpec;
  const cwd = spec.cwd ? deps.resolveCwd(projectRoot, spec.cwd) : projectRoot;
  if (!cwd) return { refused: 'bad_cwd' };
  let pty: RunPty;
  try {
    pty = deps.spawner({
      command: spec.command,
      cwd,
      env: { [RELAYED_PTY_ENV]: '1' },
    });
  } catch {
    return { refused: 'spawn_failed' };
  }
  const run = makeRun(rec, pty, by, { withheld: !!opts.withheld, rerun });
  runs.set(sessionId, run);
  // The cut-off placeholder is held FIRST (K6: a result is held before anything that can lose
  // it; a crew run's `pending` receipt entry, for a first run and every rerun alike), then the
  // start is on disk before the first byte of output: a crash from here on can never bring this
  // card back as a fresh ▶, and the agent is still owed a report.
  try { deps.delivery?.started?.(run, rec); } catch { /* delivery logs its own */ }
  markCardStarted(sessionId, cardRef);
  setCardRun(sessionId, cardRef, { runId: run.runId, owner: by });
  return run;
}

function makeRun(rec: CardRecordEntry, pty: RunPty, by: RunStarter, o: { withheld: boolean; rerun: boolean }): Run {
  const runId = randomUUID();
  const startedAt = deps.now();
  const spec = rec.spec as RunViewSpec;
  const outputs = new Set<(chunk: string, seq: number) => void>();
  const exits = new Set<(report: RunReport, code: number | null) => void>();
  let replay = '';
  let tail = '';
  let text = '';
  let seq = 0;
  let done = false;
  let finalReport: { report: RunReport; code: number | null } | null = null;
  // A login token split over two chunks: the scrub runs over the held-back end too.
  let carry = '';
  const CARRY = 256;

  const untrack = deps.trackChild(() => { try { pty.kill(); } catch { /* gone */ } });
  const cap = setTimeout(() => { try { pty.kill(); } catch { /* gone */ } }, deps.capMs);
  cap.unref?.();

  const emitChunk = (chunk: string) => {
    if (!chunk) return;
    seq++;
    replay = (replay + chunk).slice(-RUN_REPLAY_BYTES);
    tail = appendTail(tail, chunk);
    text = (text + stripAnsi(chunk)).slice(-8000);
    for (const fn of [...outputs]) { try { fn(chunk, seq); } catch { /* its own */ } }
  };

  // Hold back only an end that could still become a token URL: an unfinished `/login?…` or a
  // tail that is a prefix of `/login`. Released after a beat if nothing follows (a prompt).
  let carryTimer: ReturnType<typeof setTimeout> | null = null;
  const holdOf = (s: string): number => {
    const open = /\/login\?[^\s"'<>#]*$/.exec(s);
    if (open && open[0].length < CARRY) return open[0].length;
    for (let k = Math.min(6, s.length); k > 0; k--) if ('/login'.startsWith(s.slice(-k))) return k;
    return 0;
  };
  pty.onData((data) => {
    if (carryTimer) { clearTimeout(carryTimer); carryTimer = null; }
    const joined = carry + data;
    const hold = holdOf(joined);
    carry = hold ? joined.slice(-hold) : '';
    emitChunk(scrubLoginToken(hold ? joined.slice(0, -hold) : joined));
    if (carry) {
      carryTimer = setTimeout(() => { carryTimer = null; const c = carry; carry = ''; emitChunk(scrubLoginToken(c)); }, 300);
      carryTimer.unref?.();
    }
  });

  pty.onExit(({ exitCode }) => {
    if (done) return;
    if (carryTimer) { clearTimeout(carryTimer); carryTimer = null; }
    if (carry) { emitChunk(scrubLoginToken(carry)); carry = ''; }
    done = true;
    clearTimeout(cap);
    untrack();
    const code = typeof exitCode === 'number' ? exitCode : null;
    const seconds = Math.max(1, Math.round((deps.now() - startedAt) / 1000));
    const finished = finishTail(tail);
    const textReport = buildRunReport(spec.command, { code, tail: finished, seconds }, { includeOutput: !o.withheld });
    const report: RunReport = { exitCode: code, withheld: o.withheld, text: textReport, ...(o.withheld ? {} : { tail: finished }) };
    finalReport = { report, code };
    if (runs.get(rec.sessionId) === run) runs.delete(rec.sessionId);
    // K6: the report is held in the same synchronous block, before the record closes.
    try { deps.delivery?.hold?.(run, rec, report); } catch { /* delivery logs its own */ }
    // J1: the record closes itself, whatever happens to the report afterwards.
    finishCardRun(rec.sessionId, rec.cardRef, code);
    for (const fn of [...exits]) { try { fn(report, code); } catch { /* its own */ } }
    try { deps.delivery?.report(run, rec, report); } catch { /* delivery logs its own */ }
  });

  const run: Run = {
    runId,
    sessionId: rec.sessionId,
    cardRef: rec.cardRef,
    startedBy: by,
    withheld: o.withheld,
    rerun: o.rerun,
    command: spec.command,
    startedAt,
    seq: () => seq,
    replay: () => replay,
    textTail: () => text,
    input: (data) => { if (!done) pty.write(data); },
    writeLine: (line) => { if (!done) pty.write(`${line}\r`); },
    interrupt: () => { if (!done) pty.write('\x03'); },
    resize: (cols, rows) => { if (!done) { try { pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0)); } catch { /* gone */ } } },
    onOutput: (fn) => { outputs.add(fn); return () => { outputs.delete(fn); }; },
    onExit: (fn) => {
      if (finalReport) { const f = finalReport; queueMicrotask(() => fn(f.report, f.code)); return () => { /* already ended */ }; }
      exits.add(fn);
      return () => { exits.delete(fn); };
    },
    ended: () => done,
    ptsName: () => (typeof pty.ptsName === 'string' && pty.ptsName.startsWith('/dev/') ? pty.ptsName : null),
    kill: () => { if (!done) { try { pty.kill(); } catch { /* gone */ } } },
  };
  return run;
}

// ─── Telegram lines into stdin, fail closed (I3, J4) ────────────────────────

/** A prompt asking for something secret: a Telegram reply is never typed into it. */
export const SECRET_PROMPT_RE = /(password|passphrase|şifre|parola|token|api[ _-]?key|secret|code|otp|pin)\b[^\n]*[:>?]\s*$/i;

/** The termios ECHO flag of a pts, or null when it could not be read within 500 ms. */
export type EchoReader = (pts: string) => Promise<boolean | null>;

export const readEcho: EchoReader = (pts) => new Promise((resolve) => {
  if (!/^\/dev\/[a-z0-9/]+$/i.test(pts)) { resolve(null); return; }
  const flag = platform() === 'darwin' ? '-f' : '-F';
  execFile('/bin/stty', [flag, pts, '-a'], { timeout: 500 }, (err, stdout) => {
    if (err) { resolve(null); return; }
    const tokens = String(stdout).split(/[\s;]+/);
    if (tokens.includes('-echo')) resolve(false);
    else if (tokens.includes('echo')) resolve(true);
    else resolve(null);
  });
});

let echoReader: EchoReader = readEcho;
/** Tests: a fake termios. */
export function setEchoReaderForTests(r: EchoReader | null): void { echoReader = r ?? readEcho; }

export type RelayRefusal = 'ended' | 'echo_off' | 'secret_prompt' | 'output_changed' | 'not_text';

/** The last non-empty line of the run's text tail. */
export function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trimEnd());
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i];
  return '';
}

/**
 * A Telegram reply reaches stdin ONLY if all hold (I3): the run lives; ECHO is on (termios read
 * within 500 ms; a failed read refuses); the last output line is not a secret prompt; no output
 * arrived after the edit it replies to (`seenSeq`), checked again right before the write (J4).
 * One line; control characters stripped.
 */
export async function relayLine(run: Run, line: string, seenSeq: number): Promise<{ ok: true } | { ok: false; why: RelayRefusal }> {
  if (run.ended()) return { ok: false, why: 'ended' };
  if (run.seq() !== seenSeq) return { ok: false, why: 'output_changed' };
  if (SECRET_PROMPT_RE.test(lastLine(run.textTail()))) return { ok: false, why: 'secret_prompt' };
  const pts = run.ptsName();
  const echo = pts ? await echoReader(pts) : null;
  if (echo !== true) return { ok: false, why: 'echo_off' };
  if (run.ended()) return { ok: false, why: 'ended' };
  if (run.seq() !== seenSeq) return { ok: false, why: 'output_changed' };
  // eslint-disable-next-line no-control-regex
  const clean = line.split(/\r?\n/)[0].replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  run.writeLine(clean);
  return { ok: true };
}

// ─── The real spawner (node-pty) ────────────────────────────────────────────

/** The server's spawner: the same login-shell argv the Mac card's PTY used (`execShellArgs`). */
export function nodePtySpawner(load: () => typeof import('node-pty') | null, argv: (shell: string, command: string) => string[], path: () => string): RunSpawner {
  return ({ command, cwd, env }) => {
    const pty = load();
    if (!pty) throw new Error('node-pty missing');
    const shell = process.env.SHELL || '/bin/zsh';
    return pty.spawn(shell, argv(shell, command), {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, PATH: path(), TERM: 'xterm-256color', ...env } as Record<string, string>,
    }) as unknown as RunPty;
  };
}

/** Tests only. */
export function _resetRunsForTests(): void {
  for (const r of runs.values()) r.kill();
  runs.clear();
  echoReader = readEcho;
}

