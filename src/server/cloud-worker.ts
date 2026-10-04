import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { spawnAsWorker } from './cloud-mode.js';
import {
  HandsfreeRefusal, assertTripId, createBundle, createSpawnRunner, fetchBundle, gitOut, gitPreflight, git as runGit,
  listWorktrees, objectFormat, parseRepoSnapshot, readRefs, snapRefPrefix, snapshotBundleRefs, snapshotId, snapshotRepo,
  type ProcessRunner, type RepoSnapshot,
} from '../lib/handsfree/git-snapshot.js';
import {
  addWorktreeNoCheckout, applyRemoteRefs, BASE_REF_PREFIX, baseTips, gitOpHandlers, planRepoApply, setBaseRefs,
} from '../lib/handsfree/git-apply.js';
import {
  buildManifest, diffManifests, isSecretClass, manifestFromJSON, manifestToJSON, rootIdFor, selectNonGitEntries, walk,
  type GoManifest, type Manifest, type ManifestEntry, type RootKind, type WalkResult,
} from '../lib/handsfree/manifest.js';
import { readPack, writePack } from '../lib/handsfree/pack.js';
import { BackupStore, applyPack, planMirror } from '../lib/handsfree/apply.js';
import { backupDir, conflictsDir, type JournalOp } from '../lib/handsfree/journal.js';
import { createHash } from 'node:crypto';

/**
 * The cloud's dcuser worker: every git, manifest, pack and apply operation of a trip runs
 * HERE, in a process spawned through `spawnAsWorker` (uid dcuser, no caps, allow-listed env),
 * never as dcserver. A dcuser-planted hook, filter or symlink therefore never acts with
 * dcserver's rights.
 *
 * Wire between dcserver and the worker (one process per operation):
 *   stdin  = [u32 BE header length][header JSON {op, params}] then the payload bytes (a
 *            bundle or pack dcserver holds in its 0700 dir: piped, never a path);
 *   stdout = the binary output (a bundle or pack for a `snapshot`), piped by dcserver into
 *            its downloads;
 *   fd 3   = the JSON result `{ok:true, result}` or `{ok:false, error:{code, message, ...}}`.
 */

export const WORKER_RESULT_FD = 3;
const MAX_HEADER = 32 * 1024 * 1024;

export class WorkerOpError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorkerOpError';
  }
}

// ─── dcserver side ──────────────────────────────────────────────────────────

let workerEntry: string | null = null;

/** `cloud serve` names the CLI entry the worker runs (`node <entry> cloud worker <op>`). */
export function setWorkerEntry(path: string): void {
  workerEntry = path;
}

export interface WorkerCall {
  op: string;
  params: unknown;
  /** A file in the dcserver dir whose bytes are piped to the worker after the header. */
  inputFile?: string;
  /** Where the worker's stdout goes (a download in the dcserver dir). */
  outputFile?: string;
  timeoutMs?: number;
}

export function frameHeader(header: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  if (json.length > MAX_HEADER) throw new Error('worker header too large');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([len, json]);
}

let inProcessForTests = false;

/** Tests only: run the very same op code in this process (same uid, no spawn). */
export function setWorkerInProcessForTests(on: boolean): void {
  inProcessForTests = on;
}

async function runInProcess<T>(call: WorkerCall): Promise<T> {
  const payload = call.inputFile ? createReadStream(call.inputFile) : (() => { const pt = new PassThrough(); pt.end(); return pt; })();
  const out = call.outputFile ? createWriteStream(call.outputFile, { mode: 0o600 }) : new PassThrough().resume();
  try {
    const result = await runOp(call.op, call.params as Record<string, unknown>, payload, out);
    if (!out.writableEnded) out.end();
    await finished(out).catch(() => { /* surfaced by the result */ });
    return result as T;
  } catch (err) {
    if (!out.writableEnded) out.end();
    const e = errorShape(err);
    const { code, message, status, ...extra } = e;
    throw new WorkerOpError(code, message, typeof status === 'number' ? status : 409, extra);
  }
}

/** Run one worker operation as dcuser and return its result (throws WorkerOpError). */
export async function runWorkerOp<T>(call: WorkerCall): Promise<T> {
  if (inProcessForTests) return runInProcess<T>(call);
  const entry = workerEntry ?? process.argv[1];
  if (!entry) throw new Error('cloud worker: no CLI entry');
  const child = spawnAsWorker(process.execPath, [entry, 'cloud', 'worker', call.op], {
    cwd: '/',
    stdio: ['pipe', call.outputFile ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const resultChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let errBytes = 0;
  const resultStream = child.stdio[WORKER_RESULT_FD] as Readable | null;
  resultStream?.on('data', (c: Buffer) => resultChunks.push(c));
  child.stderr?.on('data', (c: Buffer) => { if (errBytes < 64 * 1024) { errChunks.push(c); errBytes += c.length; } });

  let outDone: Promise<void> = Promise.resolve();
  if (call.outputFile && child.stdout) {
    const ws = createWriteStream(call.outputFile, { mode: 0o600 });
    child.stdout.pipe(ws);
    outDone = finished(ws);
  }

  const stdin = child.stdin!;
  stdin.on('error', () => { /* the worker exited early; its result says why */ });
  stdin.write(frameHeader({ op: call.op, params: call.params }));
  if (call.inputFile) createReadStream(call.inputFile).pipe(stdin);
  else stdin.end();

  let timer: NodeJS.Timeout | null = null;
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    if (call.timeoutMs) {
      timer = setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, call.timeoutMs);
    }
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
  }).finally(() => { if (timer) clearTimeout(timer); });
  await outDone.catch(() => { /* surfaced by the result */ });

  const raw = Buffer.concat(resultChunks).toString('utf-8');
  let parsed: { ok: boolean; result?: T; error?: { code: string; message: string; status?: number; [k: string]: unknown } } | null = null;
  try { parsed = JSON.parse(raw); } catch { /* below */ }
  if (!parsed) {
    const tail = Buffer.concat(errChunks).toString('utf-8').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
    throw new WorkerOpError('worker_failed', `cloud worker ${call.op} ended without a result (exit ${exit.code ?? exit.signal})${tail ? `: ${tail}` : ''}`, 500);
  }
  if (!parsed.ok) {
    const e = parsed.error ?? { code: 'worker_failed', message: 'worker failed' };
    const { code, message, status, ...extra } = e;
    throw new WorkerOpError(code, message, typeof status === 'number' ? status : 409, extra);
  }
  return parsed.result as T;
}

// ─── worker side ────────────────────────────────────────────────────────────

/** Common params every op carries: dcserver computes them (the worker sees no DC_HF_* env). */
export interface WorkerBase {
  gitConfigPath: string;
  workDir: string;
  /** Test seam only: the cloud keeps laptop path P at <prefix>P. */
  mirrorPrefix: string | null;
}

function laptopPathOf(base: WorkerBase, local: string): string {
  const p = resolve(local);
  if (!base.mirrorPrefix) return p;
  // git reports realpaths (on a Mac /var is /private/var): accept either spelling of the prefix.
  let real = base.mirrorPrefix;
  try { real = realpathSync(base.mirrorPrefix); } catch { /* not created yet */ }
  for (const pre of [base.mirrorPrefix, real]) if (p.startsWith(pre + sep)) return p.slice(pre.length);
  return p;
}

function localPathOf(base: WorkerBase, laptop: string): string {
  const p = resolve(laptop);
  return base.mirrorPrefix ? join(base.mirrorPrefix, p) : p;
}

const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** The worker's runner: already dcuser, so a plain spawn with the hardened git env. */
export function workerGitRunner(base: Pick<WorkerBase, 'gitConfigPath'>): ProcessRunner {
  const inner = createSpawnRunner({
    baseEnv: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: base.gitConfigPath, GIT_TERMINAL_PROMPT: '0' },
  });
  return (cmd, args, opts) => inner(cmd, cmd === 'git' ? [...SAFE_GIT, ...args] : args, opts);
}

async function readHeaderAndPayload(input: NodeJS.ReadableStream): Promise<{ header: { op: string; params: unknown }; payload: PassThrough }> {
  const payload = new PassThrough();
  let buf = Buffer.alloc(0);
  let need = -1;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const onData = (c: Buffer) => {
      if (settled) { payload.write(c); return; }
      buf = Buffer.concat([buf, c]);
      if (need < 0 && buf.length >= 4) {
        need = buf.readUInt32BE(0);
        if (need > MAX_HEADER) { reject(new Error('header too large')); return; }
      }
      if (need >= 0 && buf.length >= 4 + need) {
        settled = true;
        let header: { op: string; params: unknown };
        try { header = JSON.parse(buf.subarray(4, 4 + need).toString('utf-8')); } catch (e) { reject(e); return; }
        const rest = buf.subarray(4 + need);
        if (rest.length) payload.write(rest);
        resolvePromise({ header, payload });
      }
    };
    input.on('data', onData);
    input.on('end', () => {
      if (!settled) reject(new Error('worker header truncated'));
      payload.end();
    });
    input.on('error', (e) => { if (!settled) reject(e); payload.destroy(e as Error); });
  });
}

function writeResult(obj: unknown): void {
  const data = Buffer.from(JSON.stringify(obj));
  try {
    let off = 0;
    while (off < data.length) off += writeSync(WORKER_RESULT_FD, data, off, data.length - off);
    closeSync(WORKER_RESULT_FD);
  } catch {
    // No fd 3 (run by hand): print it instead.
    process.stderr.write(data);
  }
}

function errorShape(err: unknown): { code: string; message: string; status?: number; [k: string]: unknown } {
  if (err instanceof WorkerOpError) return { code: err.code, message: err.message, status: err.status, ...err.extra };
  if (err instanceof HandsfreeRefusal) return { code: 'refused', kind: err.kind, message: err.message, ...(err.path ? { path: err.path } : {}), status: 409 };
  const e = err as Error;
  return { code: 'worker_error', message: (e?.message ?? String(err)).slice(0, 1000), status: 500 };
}

/** Entry of `cloud worker <op>`: read the framed stdin, run the op, write fd 3, exit. */
export async function workerMain(op: string): Promise<void> {
  let exitCode = 0;
  try {
    const { header, payload } = await readHeaderAndPayload(process.stdin);
    if (header.op !== op) throw new WorkerOpError('bad_op', `header op ${header.op} != ${op}`, 400);
    // The ops end their output stream; Node's pipe() never ends process.stdout, so they get a
    // PassThrough and this loop pumps it out.
    const out = new PassThrough();
    const pumped = (async () => {
      for await (const c of out) {
        if (!process.stdout.write(c as Buffer)) await new Promise<void>((r) => process.stdout.once('drain', () => r()));
      }
    })();
    let result: unknown;
    try {
      result = await runOp(op, header.params as Record<string, unknown>, payload, out);
    } finally {
      if (!out.writableEnded) out.end();
      await pumped.catch(() => { /* reader gone */ });
    }
    writeResult({ ok: true, result });
  } catch (err) {
    exitCode = 1;
    writeResult({ ok: false, error: errorShape(err) });
  }
  // stdout may still be flushing a bundle/pack.
  await new Promise<void>((r) => { if (process.stdout.writableLength === 0) r(); else process.stdout.once('drain', () => r()); });
  process.exit(exitCode);
}

/** Dispatch one op. Exported so tests run the exact op code in-process (same uid). */
export async function runOp(op: string, p: Record<string, unknown>, payload: NodeJS.ReadableStream, out: NodeJS.WritableStream): Promise<unknown> {
  const base: WorkerBase = {
    gitConfigPath: String(p.gitConfigPath ?? ''),
    workDir: String(p.workDir ?? ''),
    mirrorPrefix: typeof p.mirrorPrefix === 'string' ? p.mirrorPrefix : null,
  };
  switch (op) {
    case 'state': return opState(base, p);
    case 'git-receive': return opGitReceive(base, p, payload);
    case 'files-receive': return opFilesReceive(base, p, payload);
    case 'global': return opGlobal(base, p, payload);
    case 'preflight': return opPreflight(base, p);
    case 'snapshot-repo': return opSnapshotRepo(base, p, out);
    case 'snapshot-files': return opSnapshotFiles(base, p, out);
    case 'wipe-secrets': return opWipeSecrets(base, p);
    case 'marker': return opMarker(p);
    case 'cut-scope': return opCutScope(p);
    case 'read': return opRead(p);
    case 'ensure-sandbox': return opEnsureSandbox(p);
    case 'lockfile-hash': return opLockfileHash(p);
    default: throw new WorkerOpError('bad_op', `unknown worker op ${op}`, 400);
  }
}

// ─── shared helpers ─────────────────────────────────────────────────────────

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new WorkerOpError('bad_request', `${name} is required`, 400);
  return v;
}

function absPath(v: unknown, name: string): string {
  const s = str(v, name);
  if (!s.startsWith('/') || s.includes('\0')) throw new WorkerOpError('bad_request', `${name} must be absolute`, 400);
  return resolve(s);
}

function isUnder(parent: string, child: string): boolean {
  const c = resolve(child);
  const forms = [resolve(parent)];
  try { forms.push(realpathSync(parent)); } catch { /* absent */ }
  return forms.some((p) => c === p || c.startsWith(p.endsWith(sep) ? p : p + sep));
}

function hasGitDir(root: string): boolean {
  try { return lstatSync(join(root, '.git')).isDirectory(); } catch { return false; }
}

function checkoutIdFor(base: WorkerBase) {
  return (abs: string) => rootIdFor(laptopPathOf(base, abs));
}

/** Rewrite a cloud snapshot to the laptop's paths (ids are already laptop-derived). */
function toLaptopSnapshot(base: WorkerBase, s: RepoSnapshot): RepoSnapshot {
  return {
    ...s,
    repoPath: laptopPathOf(base, s.repoPath),
    checkouts: s.checkouts.map((c) => ({ ...c, path: laptopPathOf(base, c.path) })),
  };
}

/** sha256 of the sorted `path\0sha256\n` lines: the files/receive digest both sides compute. */
export function manifestDigest(entries: Iterable<{ path: string; sha256: string }>): string {
  const lines = [...entries].map((e) => `${e.path}\0${e.sha256}\n`).sort();
  const h = createHash('sha256');
  for (const l of lines) h.update(l);
  return h.digest('hex');
}

/** The non-git candidate set of one root, walked on the CLOUD side (every link included). */
async function selectRoot(run: ProcessRunner, root: string, kind: RootKind, include: string[]): Promise<WalkResult> {
  if (!existsSync(root)) return { entries: [], refused: [] };
  if (kind === 'transcripts') return walk(root, ['.'], { side: 'cloud' });
  return selectNonGitEntries(run, root, { isGitRepo: hasGitDir(root), include, side: 'cloud' });
}

const ROOT_KINDS: readonly RootKind[] = ['vault', 'repo', 'worktree', 'transcripts'];
function rootKind(v: unknown): RootKind {
  if (!ROOT_KINDS.includes(v as RootKind)) throw new WorkerOpError('bad_request', 'bad root kind', 400);
  return v as RootKind;
}

function includes(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** What the laptop sends for the generated `.git` (wire v1.1): its info files as data and its
 *  remotes, userinfo already stripped. Validated again here. */
export interface GitDirSpec {
  exclude?: string;
  attributes?: string;
  remotes?: Array<{ name: string; url: string }>;
}

export const INFO_MAX_BYTES = 256 * 1024;
const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Throws on anything the generated config must not carry. Exported for the route. */
export function parseGitDirSpec(raw: { info?: unknown; remotes?: unknown }): GitDirSpec {
  const out: GitDirSpec = {};
  const info = raw.info as { exclude?: unknown; attributes?: unknown } | undefined;
  if (info !== undefined && (info === null || typeof info !== 'object')) throw new WorkerOpError('bad_request', 'info must be an object', 400);
  for (const k of ['exclude', 'attributes'] as const) {
    const v = info?.[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || Buffer.byteLength(v) > INFO_MAX_BYTES || v.includes('\0')) throw new WorkerOpError('bad_request', `info.${k} must be text up to 256 KiB`, 400);
    out[k] = v;
  }
  if (raw.remotes !== undefined) {
    if (!Array.isArray(raw.remotes) || raw.remotes.length > 100) throw new WorkerOpError('bad_request', 'remotes must be an array', 400);
    const names = new Set<string>();
    out.remotes = raw.remotes.map((r) => {
      const name = (r as { name?: unknown })?.name;
      const url = (r as { url?: unknown })?.url;
      if (typeof name !== 'string' || !REMOTE_NAME_RE.test(name) || names.has(name)) throw new WorkerOpError('bad_request', 'bad remote name', 400);
      // eslint-disable-next-line no-control-regex
      if (typeof url !== 'string' || !url || url.length > 2048 || /[\x00-\x1f\x7f"\\]/.test(url)) throw new WorkerOpError('bad_request', `bad url for remote ${name}`, 400);
      // A URL with a scheme must not carry userinfo (a token in https://user:token@host).
      const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
      if (m && m[1].includes('@')) throw new WorkerOpError('bad_request', `the url of remote ${name} still carries userinfo`, 400);
      names.add(name);
      return { name, url };
    });
  }
  return out;
}

/**
 * Generated .git/config, hooks/ and info/ (Transport 1): nothing under .git is ever received,
 * and whatever an agent planted (filters, fsmonitor, hooks) is dropped before our own git
 * reads the repo again. The laptop's info/exclude, info/attributes and remotes come in as
 * DATA (wire v1.1) and are written fresh each time; a remote is never fetched or pushed.
 */
async function regenerateGitDir(run: ProcessRunner, repoRoot: string, fmt: 'sha1' | 'sha256', spec: GitDirSpec = {}): Promise<void> {
  const gitDir = join(repoRoot, '.git');
  if (!lstatSync(gitDir).isDirectory()) throw new WorkerOpError('bad_repo', `${repoRoot}/.git is not a directory`);
  const remotes = spec.remotes ?? [];
  const config = [
    '[core]',
    `\trepositoryformatversion = ${fmt === 'sha256' ? 1 : 0}`,
    '\tfilemode = true',
    '\tbare = false',
    '\tlogallrefupdates = true',
    '\tsharedRepository = group',
    ...(fmt === 'sha256' ? ['[extensions]', '\tobjectformat = sha256'] : []),
    '[pull]',
    '\trebase = false',
    ...remotes.flatMap((r) => [`[remote "${r.name}"]`, `\turl = "${r.url}"`, `\tfetch = +refs/heads/*:refs/remotes/${r.name}/*`]),
    '',
  ].join('\n');
  const cfg = join(gitDir, 'config');
  const tmp = `${cfg}.dc-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, config, { mode: 0o664 });
  renameSync(tmp, cfg);
  const hooks = join(gitDir, 'hooks');
  rmSync(hooks, { recursive: true, force: true });
  mkdirSync(hooks, { mode: 0o2775 });
  const info = join(gitDir, 'info');
  if (existsSync(info) && !lstatSync(info).isDirectory()) rmSync(info, { force: true });
  mkdirSync(info, { recursive: true, mode: 0o2775 });
  for (const name of readdirSync(info)) rmSync(join(info, name), { recursive: true, force: true });
  writeFileSync(join(info, 'exclude'), spec.exclude ?? '', { mode: 0o664 });
  if (spec.attributes !== undefined) writeFileSync(join(info, 'attributes'), spec.attributes, { mode: 0o664 });
  void run;
}

/** Files an operation in progress leaves in a checkout's git dir. */
const IN_PROGRESS_LEFTOVERS = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'MERGE_RR', 'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG', 'BISECT_START', 'BISECT_TERMS', 'BISECT_NAMES', 'BISECT_EXPECTED_REV', 'BISECT_ANCESTORS_OK', 'rebase-merge', 'rebase-apply', 'sequencer'];
const IN_PROGRESS_HEAD_FILES: Array<[string, string]> = [
  ['MERGE_HEAD', 'MERGE_HEAD'], ['CHERRY_PICK_HEAD', 'CHERRY_PICK_HEAD'], ['REVERT_HEAD', 'REVERT_HEAD'], ['REBASE_HEAD', 'REBASE_HEAD'],
  ['rebase-merge/orig-head', 'REBASE_ORIG_HEAD'], ['rebase-merge/onto', 'REBASE_ONTO'],
  ['rebase-apply/orig-head', 'REBASE_APPLY_ORIG_HEAD'], ['rebase-apply/onto', 'REBASE_APPLY_ONTO'],
];

/**
 * A go after a D12 recovery: a merge/rebase the phone left in progress was captured by the
 * tolerant snapshot as `refs/handsfree/snap/<old-trip>/<cid>/inprogress/<NAME>`. Once every
 * one of its heads sits in such a ref, the operation's leftovers are cleared so the laptop's S
 * can land (and the next preflight passes). A head NOT captured refuses: recover first.
 */
async function clearCapturedInProgress(run: ProcessRunner, repoRoot: string): Promise<string[]> {
  const cleared: string[] = [];
  const captured = new Map<string, Set<string>>();
  for (const [ref, oid] of Object.entries(await readRefs(run, repoRoot, ['refs/handsfree/snap/']))) {
    const m = /\/inprogress\/([A-Z_0-9]+)$/.exec(ref);
    if (!m) continue;
    const name = m[1].replace(/_\d+$/, '');
    if (!captured.has(name)) captured.set(name, new Set());
    captured.get(name)!.add(oid);
  }
  for (const w of await listWorktrees(run, repoRoot)) {
    if (w.bare || !existsSync(w.path)) continue;
    const gitDir = (await gitOut(run, w.path, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim();
    const busy = IN_PROGRESS_LEFTOVERS.filter((f) => existsSync(join(gitDir, f)));
    if (busy.length === 0) continue;
    for (const [file, name] of IN_PROGRESS_HEAD_FILES) {
      let lines: string[] = [];
      try { lines = readFileSync(join(gitDir, file), 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(l)); } catch { continue; }
      for (const oid of lines) {
        if (!captured.get(name)?.has(oid)) {
          throw new HandsfreeRefusal('in_progress', `${laptopSafe(w.path)}: ${name} ${oid.slice(0, 12)} was never recovered; run the recovery (a tolerant snapshot) first`);
        }
      }
    }
    for (const f of busy) rmSync(join(gitDir, f), { recursive: true, force: true });
    // The unmerged index goes with it (its stages are in the recovery refs; S replaces it).
    if ((await gitOut(run, w.path, ['ls-files', '-u', '-z'])).length > 0) {
      const head = await runGit(run, w.path, ['rev-parse', '-q', '--verify', 'HEAD^{tree}'], { allowFail: true });
      const tree = head.code === 0 ? head.stdout.toString().trim() : (await gitOut(run, w.path, ['mktree'], { input: Buffer.alloc(0) })).trim();
      await runGit(run, w.path, ['read-tree', tree]);
    }
    cleared.push(w.path);
  }
  return cleared;
}

function laptopSafe(p: string): string {
  return p.split(sep).slice(-2).join('/');
}

// ─── ops ────────────────────────────────────────────────────────────────────

async function opState(base: WorkerBase, p: Record<string, unknown>): Promise<unknown> {
  const run = workerGitRunner(base);
  const root = absPath(p.root, 'root');
  const kind = rootKind(p.rootKind);
  const home = absPath(p.home, 'home');
  if (p.want === 'repo') {
    const trip = assertTripId(str(p.trip, 'trip'));
    const snap = await snapshotRepo(run, root, {
      trip, side: 'cloud', writeRefs: false,
      checkoutIdFor: checkoutIdFor(base),
      checkoutFilter: (abs) => isUnder(home, abs),
    });
    return { kind: 'repo', snapshot: toLaptopSnapshot(base, snap), baseTips: await baseTips(run, root) };
  }
  const sel = await selectRoot(run, root, kind, includes(p.include));
  const refused = [...sel.refused];
  const m = await buildManifest(root, sel.entries, undefined, refused);
  return { kind: 'files', manifest: manifestToJSON(m) };
}

/** Write a payload stream into a file in the worker's own dir (git fetch needs a file). */
async function spool(payload: NodeJS.ReadableStream, dir: string, suffix: string): Promise<{ path: string; size: number }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `in-${randomBytes(8).toString('hex')}${suffix}`);
  const ws = createWriteStream(path, { mode: 0o600 });
  let size = 0;
  payload.on('data', (c: Buffer) => { size += c.length; });
  payload.pipe(ws);
  await finished(ws);
  return { path, size };
}

async function opGitReceive(base: WorkerBase, p: Record<string, unknown>, payload: NodeJS.ReadableStream): Promise<unknown> {
  const run = workerGitRunner(base);
  const trip = assertTripId(str(p.trip, 'trip'));
  const repoRoot = absPath(p.repoRoot, 'repoRoot');
  const home = absPath(p.home, 'home');
  const go = p.go as GoManifest;
  const snap = parseRepoSnapshot(p.snapshot, trip);
  const tripDir = join(base.workDir, 'trips', trip);

  // A first trip: the repository does not exist in the cloud yet.
  if (!hasGitDir(repoRoot)) {
    if (existsSync(join(repoRoot, '.git'))) throw new WorkerOpError('bad_repo', `${repoRoot}/.git is not a directory`);
    mkdirSync(repoRoot, { recursive: true, mode: 0o2775 });
    await runGit(run, repoRoot, ['init', '-q', `--object-format=${snap.objectFormat}`]);
  }
  const fmt = await objectFormat(run, repoRoot);
  if (fmt !== snap.objectFormat) throw new WorkerOpError('bad_repo', `object format ${fmt} != ${snap.objectFormat}`);
  const gitSpec = parseGitDirSpec({ info: p.info, remotes: p.remotes });
  await regenerateGitDir(run, repoRoot, fmt, gitSpec);

  let fetched: Record<string, string> = {};
  if (p.hasBundle === true) {
    const spooled = await spool(payload, join(base.workDir, 'incoming'), '.bundle');
    try {
      fetched = await fetchBundle(run, repoRoot, spooled.path, { trip, acceptRemotes: true });
    } finally {
      rmSync(spooled.path, { force: true });
    }
  } else {
    payload.resume();
  }

  // Every incoming checkout must be a root of the laptop's go manifest (AC10 on this side too).
  const localCheckouts: Record<string, string> = {};
  for (const c of snap.checkouts) {
    const spec = go.roots.find((r) => r.rootId === c.checkoutId);
    if (!spec || (spec.kind !== 'repo' && spec.kind !== 'worktree' && spec.kind !== 'vault')) {
      throw new WorkerOpError('bad_snapshot', `checkout ${c.checkoutId} is not a root of this trip`);
    }
    const local = localPathOf(base, spec.absPath);
    if (!isUnder(home, local)) throw new WorkerOpError('bad_snapshot', `checkout ${c.checkoutId} is outside the cloud home`);
    if (c.isMain) {
      if (resolve(local) !== resolve(repoRoot)) throw new WorkerOpError('bad_snapshot', 'the main checkout is not this root');
    } else if (!existsSync(join(local, '.git'))) {
      mkdirSync(dirname(local), { recursive: true, mode: 0o2775 });
      if (existsSync(local) && readdirSync(local).length > 0) throw new WorkerOpError('bad_snapshot', `worktree destination ${local} is not empty`);
      rmSync(local, { recursive: true, force: true });
      const commit = c.head.oid ?? (await gitOut(run, repoRoot, ['rev-parse', `refs/handsfree/incoming/${trip}/handsfree/snap/${trip}/${c.checkoutId}/index`])).trim();
      await addWorktreeNoCheckout(run, repoRoot, local, commit);
    }
    localCheckouts[c.checkoutId] = local;
  }

  // The cloud's CURRENT state is the start of the diff (the phone may have kept working after
  // an Abandon); a merge/rebase it left that the recovery captured is cleared first.
  await clearCapturedInProgress(run, repoRoot);
  const receiverStart = await snapshotRepo(run, repoRoot, {
    trip, side: 'cloud', writeRefs: false, tolerant: true,
    checkoutIdFor: checkoutIdFor(base),
    checkoutFilter: (abs) => isUnder(home, abs),
  });
  const plan = await planRepoApply(run, {
    repoPath: repoRoot, trip, incoming: snap, fetched,
    receiverStart: { ...receiverStart, tolerant: false }, receiverNow: null,
    localCheckouts, policy: 'overwrite', strict: false,
  });
  const handlers = gitOpHandlers(run, { tripDir });
  for (const op of plan.ops) {
    const h = handlers[op.kind];
    if (!h) throw new WorkerOpError('bad_plan', `no handler for ${op.kind}`, 500);
    const full: JournalOp = { ...op, state: 'pending' };
    if (h.isDone && await h.isDone(full)) continue;
    await h.apply(full);
  }
  await applyRemoteRefs(run, repoRoot, snap.remoteRefs ?? {});

  // The cloud's own snapshot of what it now holds: equal ids = AC2. Its snap refs become the
  // base the next bundle is cut against.
  const resnap = await snapshotRepo(run, repoRoot, {
    trip, side: 'cloud', writeRefs: true,
    checkoutIdFor: checkoutIdFor(base),
    checkoutFilter: (abs) => isUnder(home, abs),
  });
  await setBaseRefs(run, repoRoot, await baseRefsFor(run, repoRoot, resnap));
  return { snapshotId: snapshotId(resnap) };
}

/** `refs/handsfree/base/*` = every ref of the agreed snapshot + its snap commits. */
async function baseRefsFor(run: ProcessRunner, repoRoot: string, s: RepoSnapshot): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [r, oid] of Object.entries(s.refs)) out[`${BASE_REF_PREFIX}/${r.slice('refs/'.length)}`] = oid;
  const snaps = await readRefs(run, repoRoot, [snapRefPrefix(s.trip) + '/']);
  for (const [r, oid] of Object.entries(snaps)) out[`${BASE_REF_PREFIX}/snap/${r.slice(snapRefPrefix(s.trip).length + 1)}`] = oid;
  return out;
}

const EMPTY_PACK_CACHE: { buf: Buffer | null } = { buf: null };

async function emptyPack(): Promise<Buffer> {
  if (EMPTY_PACK_CACHE.buf) return EMPTY_PACK_CACHE.buf;
  const pt = new PassThrough();
  const chunks: Buffer[] = [];
  pt.on('data', (c: Buffer) => chunks.push(c));
  await writePack(pt, { root: '/', entries: [] });
  EMPTY_PACK_CACHE.buf = Buffer.concat(chunks);
  return EMPTY_PACK_CACHE.buf;
}

function maxBytesOf(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new WorkerOpError('bad_request', 'maxBytes is required', 400);
  return v as number;
}

async function opFilesReceive(base: WorkerBase, p: Record<string, unknown>, payload: NodeJS.ReadableStream): Promise<unknown> {
  const run = workerGitRunner(base);
  const trip = assertTripId(str(p.trip, 'trip'));
  const root = absPath(p.root, 'root');
  const rootId = str(p.rootId, 'rootId');
  const kind = rootKind(p.rootKind);
  const incoming: Manifest = manifestFromJSON(p.expected);
  const maxBytes = maxBytesOf(p.maxBytes);
  mkdirSync(root, { recursive: true, mode: 0o2775 });

  const sel = await selectRoot(run, root, kind, includes(p.include));
  const refusedNow: Array<{ path: string; reason: string }> = [...sel.refused];
  const now = await buildManifest(root, sel.entries, undefined, refusedNow);
  const plan = planMirror(now, incoming);
  const tripDir = join(base.workDir, 'trips', trip);
  let stream: NodeJS.ReadableStream;
  if (p.hasPack === true) stream = payload;
  else {
    payload.resume();
    const pt = new PassThrough();
    pt.end(await emptyPack());
    stream = pt;
  }
  const res = await applyPack(() => stream, {
    root, plan, expected: now, incoming,
    conflictsDir: conflictsDir(tripDir, rootId),
    backup: new BackupStore(backupDir(tripDir, rootId)),
    policy: 'overwrite',
    maxBytes,
  });
  const refused = [...res.refused, ...res.conflicts];
  // The digest of what the root now holds in the expected set (the laptop computes the same
  // over `expected` minus refused).
  const after = await buildManifest(root, manifestToJSON(incoming).map((e) => ({ path: e.path, type: e.type })), undefined, []);
  const refusedSet = new Set(refused.map((r) => r.path));
  const landed = [...after.values()].filter((e) => !refusedSet.has(e.path));
  return { refused, digest: manifestDigest(landed) };
}

async function opGlobal(base: WorkerBase, p: Record<string, unknown>, payload: NodeJS.ReadableStream): Promise<unknown> {
  const home = absPath(p.home, 'home');
  const maxBytes = maxBytesOf(p.maxBytes);
  mkdirSync(home, { recursive: true });
  const spooled = await spool(payload, join(base.workDir, 'incoming'), '.pack');
  try {
    // Pass 1: the pack's own entries are its manifest (the global set is one-way and only
    // ever ADDS or replaces what it carries; it never mirrors the whole home).
    const incoming: Manifest = new Map();
    const deletions: string[] = [];
    await readPack(createReadStream(spooled.path), async (rec) => {
      if (rec.kind === 'delete') deletions.push(rec.path);
      else incoming.set(rec.entry.path, rec.entry);
    }, { maxBytes });
    const current = await buildManifest(home, [...incoming.values()].map((e) => ({ path: e.path, type: e.type })), undefined, []);
    const plan = { write: [...incoming.keys()].sort(), delete: deletions.sort(), conflicts: [], refused: [] };
    const res = await applyPack(() => createReadStream(spooled.path), {
      root: home, plan, expected: current, incoming,
      conflictsDir: join(base.workDir, 'global', 'conflicts'),
      backup: new BackupStore(join(base.workDir, 'global', `backup-${Date.now()}`)),
      policy: 'overwrite',
      maxBytes,
    });
    if (base.mirrorPrefix) remapVaultsForMirror(home, base.mirrorPrefix);
    return { written: res.written.length, refused: res.refused };
  } finally {
    rmSync(spooled.path, { force: true });
  }
}

/** Test seam only: the carried vaults.json names laptop paths; the mirror keeps them under a prefix. */
function remapVaultsForMirror(home: string, prefix: string): void {
  const file = join(home, '.dreamcontext', 'vaults.json');
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, 'utf-8')); } catch { return; }
  const fix = (v: unknown) => {
    if (v && typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string') {
      const o = v as { path: string };
      if (!o.path.startsWith(prefix + sep)) o.path = join(prefix, resolve(o.path));
    }
  };
  if (Array.isArray(data)) data.forEach(fix);
  else if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.vaults)) d.vaults.forEach(fix);
    else Object.values(d).forEach(fix);
  }
  writeFileSync(file, JSON.stringify(data, null, 2));
}

async function opPreflight(base: WorkerBase, p: Record<string, unknown>): Promise<unknown> {
  const run = workerGitRunner(base);
  const home = absPath(p.home, 'home');
  const repos = Array.isArray(p.repos) ? p.repos : [];
  const problems: Array<{ rootId: string; checkout: string; kind: string; detail: string; path?: string }> = [];
  for (const r of repos as Array<{ rootId: unknown; root: unknown }>) {
    const root = absPath(r.root, 'root');
    if (!hasGitDir(root)) continue;
    await regenerateGitDir(run, root, await objectFormat(run, root), parseGitDirSpec((r as { git?: { info?: unknown; remotes?: unknown } }).git ?? {}));
    for (const w of await listWorktrees(run, root)) {
      if (w.bare || w.prunable || !existsSync(w.path) || !isUnder(home, w.path)) continue;
      for (const pr of await gitPreflight(run, w.path, { side: 'cloud' })) {
        problems.push({ rootId: String(r.rootId), checkout: laptopPathOf(base, w.path), kind: pr.kind, detail: pr.detail, ...(pr.path ? { path: laptopPathOf(base, pr.path) } : {}) });
      }
    }
  }
  return { problems };
}

async function opSnapshotRepo(base: WorkerBase, p: Record<string, unknown>, out: NodeJS.WritableStream): Promise<unknown> {
  const run = workerGitRunner(base);
  const trip = assertTripId(str(p.trip, 'trip'));
  const repoRoot = absPath(p.repoRoot, 'repoRoot');
  const home = absPath(p.home, 'home');
  const knownTips = Array.isArray(p.knownTips) ? p.knownTips.filter((t): t is string => typeof t === 'string' && /^[0-9a-f]{40,64}$/.test(t)) : [];
  const goRootIds = new Set(Array.isArray(p.goRootIds) ? p.goRootIds.filter((x): x is string => typeof x === 'string') : []);
  await regenerateGitDir(run, repoRoot, await objectFormat(run, repoRoot), parseGitDirSpec((p.git ?? {}) as { info?: unknown; remotes?: unknown }));
  const snap = await snapshotRepo(run, repoRoot, {
    trip, side: 'cloud', writeRefs: true, tolerant: p.tolerant === true,
    checkoutIdFor: checkoutIdFor(base),
    checkoutFilter: (abs) => isUnder(home, abs),
  });
  const bundle = await createBundle(run, repoRoot, { refs: snapshotBundleRefs(snap), knownTips, out });
  const worktreesAdded = snap.checkouts.filter((c) => !c.isMain && !goRootIds.has(c.checkoutId)).map((c) => laptopPathOf(base, c.path));
  return { snapshot: toLaptopSnapshot(base, snap), worktreesAdded, bundleCreated: bundle.created };
}

async function opSnapshotFiles(base: WorkerBase, p: Record<string, unknown>, out: NodeJS.WritableStream): Promise<unknown> {
  const run = workerGitRunner(base);
  const root = absPath(p.root, 'root');
  const kind = rootKind(p.rootKind);
  const atGo: Manifest = manifestFromJSON(p.atGo ?? []);
  const sel = await selectRoot(run, root, kind, includes(p.include));
  const refused = [...sel.refused];
  const now = await buildManifest(root, sel.entries, atGo, refused);
  const d = diffManifests(atGo, now);
  const send: ManifestEntry[] = [...d.added, ...d.changed].map((path) => now.get(path)!).filter(Boolean);
  let packCreated = false;
  if (send.length > 0 || d.deleted.length > 0) {
    try {
      await writePack(out, { root, entries: send, deletions: d.deleted, end: true });
      packCreated = true;
    } catch (err) {
      throw new WorkerOpError('pack_failed', (err as Error).message);
    }
  } else {
    out.end();
  }
  return { manifest: manifestToJSON(now), refused, packCreated };
}

async function opWipeSecrets(base: WorkerBase, p: Record<string, unknown>): Promise<unknown> {
  const run = workerGitRunner(base);
  const roots = Array.isArray(p.roots) ? p.roots as Array<{ root: unknown; rootKind: unknown; include?: unknown }> : [];
  let wiped = 0;
  const failed: string[] = [];
  for (const r of roots) {
    const root = absPath(r.root, 'root');
    const sel = await selectRoot(run, root, rootKind(r.rootKind), includes(r.include));
    for (const e of sel.entries) {
      if (!isSecretClass(e.path)) continue;
      try {
        rmSync(join(root, ...e.path.split('/')), { force: true });
        wiped++;
      } catch {
        failed.push(e.path);
      }
    }
  }
  return { wiped, failed };
}

export interface ScopeProcess { pid: number; pgid: number; cwd: string }

/** Every process of THIS uid with its group and cwd (Linux /proc; ps + lsof elsewhere). */
export function listOwnProcesses(): ScopeProcess[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const out: ScopeProcess[] = [];
  if (existsSync('/proc/self/stat')) {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (lstatSync(`/proc/${name}`).uid !== uid) continue;
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        out.push({ pid: Number(name), pgid: Number(rest[2]), cwd: readlinkSync(`/proc/${name}/cwd`) });
      } catch { /* gone, or not ours */ }
    }
    return out;
  }
  let table = '';
  try { table = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,uid='], { encoding: 'utf-8', timeout: 10_000 }); } catch { return out; }
  const mine = new Map<number, number>();
  for (const line of table.split('\n')) {
    const [pid, pgid, u] = line.trim().split(/\s+/).map(Number);
    if (pid && u === uid) mine.set(pid, pgid);
  }
  if (mine.size === 0) return out;
  let lsof = '';
  try {
    lsof = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', [...mine.keys()].join(',')], { encoding: 'utf-8', timeout: 20_000 });
  } catch (err) {
    lsof = String((err as { stdout?: string }).stdout ?? ''); // lsof exits 1 when some pid vanished
  }
  let pid = 0;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && mine.has(pid)) out.push({ pid, pgid: mine.get(pid)!, cwd: line.slice(1) });
  }
  return out;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * D22 in the cloud: cut every process (of this uid, dcuser) whose cwd is inside one of the
 * roots, whether or not it descends from a chat: each found process group gets SIGTERM, then
 * SIGKILL after the grace even when its leader already exited, until every found process is
 * gone. The worker's own process and group never match.
 */
async function opCutScope(p: Record<string, unknown>): Promise<unknown> {
  const roots = (Array.isArray(p.roots) ? p.roots : []).map((r) => absPath(r, 'roots[]'));
  const graceMs = Number.isSafeInteger(p.graceMs) && (p.graceMs as number) > 0 ? Math.min(p.graceMs as number, 60_000) : 5_000;
  const procs = listOwnProcesses();
  const ownPgid = procs.find((x) => x.pid === process.pid)?.pgid ?? -1;
  const found = procs.filter((x) => x.pid !== process.pid && x.pgid !== ownPgid && roots.some((r) => isUnder(r, x.cwd)));
  if (found.length === 0) return { cut: [] };
  const groups = [...new Set(found.map((x) => x.pgid).filter((g) => g > 1 && g !== ownPgid))];
  const signal = (sig: NodeJS.Signals) => {
    for (const g of groups) { try { process.kill(-g, sig); } catch { /* gone */ } }
    for (const x of found) { try { process.kill(x.pid, sig); } catch { /* gone */ } }
  };
  const waitGone = async (ms: number) => {
    const until = Date.now() + ms;
    while (found.some((x) => alive(x.pid))) {
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  };
  signal('SIGTERM');
  if (!(await waitGone(graceMs))) {
    signal('SIGKILL');
    await waitGone(graceMs);
  }
  return { cut: found.map((x) => x.pid).sort((a, b) => a - b) };
}

/** The trip marker at the mirror root (trip id + root ids): its absence means trip_lost. */
async function opMarker(p: Record<string, unknown>): Promise<unknown> {
  const file = absPath(p.file, 'file');
  if (p.action === 'write') {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(p.data ?? {}), { mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, file);
    return { written: true };
  }
  try {
    if (!lstatSync(file).isFile()) return { present: false };
    const data = JSON.parse(readFileSync(file, 'utf-8')) as { tripId?: unknown };
    return { present: true, tripId: typeof data.tripId === 'string' ? data.tripId : null };
  } catch {
    return { present: false };
  }
}

/** Reads of 0600 dcuser transcripts for the phone's chat routes (dcserver cannot open them). */
async function opRead(p: Record<string, unknown>): Promise<unknown> {
  switch (p.kind) {
    case 'past-sessions': {
      const { computeChatSessions } = await import('./routes/agent-chat-sessions.js');
      return computeChatSessions(str(p.contextRoot, 'contextRoot'), p.query as Record<string, string>);
    }
    case 'task-progress': {
      const { computeTaskProgress } = await import('./routes/agent-shelf.js');
      return computeTaskProgress(str(p.contextRoot, 'contextRoot'), String((p.query as Record<string, string>)?.slug ?? ''));
    }
    case 'session-facts': {
      const { computeSessionFacts } = await import('./routes/agent-shelf.js');
      return computeSessionFacts(str(p.contextRoot, 'contextRoot'), p.query as Record<string, string>);
    }
    case 'teammates': {
      const { computeTeammates } = await import('./routes/agent-teammates.js');
      return computeTeammates(str(p.contextRoot, 'contextRoot'), p.query as Record<string, string>);
    }
    case 'teammate-history': {
      const { computeTeammateHistory } = await import('./routes/agent-teammates.js');
      return computeTeammateHistory(str(p.contextRoot, 'contextRoot'), p.query as Record<string, string>);
    }
    case 'agent-file': {
      const { cloudFileRead } = await import('./routes/agent-chat.js');
      const q = (p.query ?? {}) as Record<string, string>;
      const max = Number(q.maxBytes);
      return cloudFileRead(str(p.contextRoot, 'contextRoot'), str(q.path, 'path'), q.want === 'meta' ? 'meta' : 'read', Number.isSafeInteger(max) && max > 0 ? Math.min(max, 64 * 1024 * 1024) : 512 * 1024);
    }
    case 'board-assets': {
      const { computeBoardAssetsCloud } = await import('./routes/agent-chat.js');
      try {
        return await computeBoardAssetsCloud(str(p.contextRoot, 'contextRoot'), str((p.query as Record<string, string>)?.path, 'path'));
      } catch (err) {
        const e = err as { code?: string; status?: number; message: string };
        throw new WorkerOpError(e.code ?? 'not_found', e.message, e.status ?? 404);
      }
    }
    case 'bg-output': {
      const { computeBackgroundOutput, sanitizeBackgroundTaskId } = await import('./routes/agent-chat.js');
      const { sanitizeUuid } = await import('./routes/agent-spawn-shared.js');
      const q = (p.query ?? {}) as Record<string, string>;
      const taskId = sanitizeBackgroundTaskId(q.taskId ?? null);
      const claudeId = sanitizeUuid(q.claudeId ?? null);
      if (!taskId || !claudeId) throw new WorkerOpError('bad_request', 'taskId and claudeId are required', 400);
      return computeBackgroundOutput(str(p.contextRoot, 'contextRoot'), taskId, claudeId);
    }
    case 'usage-limits': {
      const { readUsageLimits } = await import('../lib/claude-usage.js');
      const { assertConfinedConfigDir } = await import('../lib/claude-accounts.js');
      return readUsageLimits(assertConfinedConfigDir(str(p.configDir, 'configDir')));
    }
    default:
      throw new WorkerOpError('bad_request', 'unknown read kind', 400);
  }
}

/** The account sandbox (D13), built by the existing ensureSandbox as dcuser (the entrypoint's
 *  `claude-login` calls this before `claude auth login`). */
async function opEnsureSandbox(p: Record<string, unknown>): Promise<unknown> {
  const { ensureSandbox } = await import('../lib/claude-account-sandbox.js');
  const r = ensureSandbox(absPath(p.configDir, 'configDir'));
  return { configDir: r.configDir, created: r.created };
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;

/** Which lockfile a root has and its hash (read as dcuser: a planted symlink never makes
 *  dcserver read anything). */
async function opLockfileHash(p: Record<string, unknown>): Promise<unknown> {
  const root = absPath(p.root, 'root');
  for (const name of LOCKFILES) {
    const f = join(root, name);
    try {
      if (!lstatSync(f).isFile()) continue;
      const fd = openSync(f, 'r');
      closeSync(fd);
      return { lockfile: name, sha256: createHash('sha256').update(readFileSync(f)).digest('hex') };
    } catch { /* absent */ }
  }
  return { lockfile: null, sha256: null };
}

/** Exposed for the route module's ref existence checks. */
export { BASE_REF_PREFIX };
