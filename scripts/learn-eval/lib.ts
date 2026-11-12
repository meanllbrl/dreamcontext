/**
 * Shared helpers for the learning-loop evals (plan `ogrenme-dongusu`, section "Evals", gate G-pos).
 *
 * Everything here is pure or touches only paths it is handed, so the unit test can import it
 * without side effects. The owner's real turns never enter the repo: they live under
 * `~/.dreamcontext/eval-frozen/learn-202611/` (0700), written by `freeze.ts`, read by the others.
 *
 * Spend: every script that calls a model goes through {@link SpendGuard}. It refuses a run until
 * the estimate has been printed ({@link SpendGuard.announce}), and refuses any run that could take
 * the shared ledger (`spend.jsonl`, all scripts together) over the cap: `DREAMCONTEXT_EVAL_MAX_USD`,
 * default 60, never above the owner's hard cap of 60 (plan D14).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../../src/lib/recall.js';

export const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The real home, captured at import: scripts later point HOME at a fake one (so `deliverForTurn`
 * and the stores read the scratch), and the frozen dir, the results and the ledger must not move.
 */
export const REAL_HOME = homedir();
export const REPO = resolve(HERE, '..', '..');

// ─── Paths ──────────────────────────────────────────────────────────────────

export const FROZEN_NAME = 'learn-202611';

/** The frozen eval dir. `home` is injectable: tests never touch the real one. */
export function frozenDir(home: string = REAL_HOME): string {
  return join(home, '.dreamcontext', 'eval-frozen', FROZEN_NAME);
}

export function spendLedgerPath(home: string = REAL_HOME): string {
  return join(frozenDir(home), 'spend.jsonl');
}

export function resultsDir(home: string = REAL_HOME): string {
  return join(frozenDir(home), 'results');
}

/** Create a dir owner-only (0700), its parents too. */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

/** Write a file owner-only (0600) inside a private dir. */
export function writePrivate(file: string, text: string): void {
  ensurePrivateDir(dirname(file));
  writeFileSync(file, text, { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

/** A regular file inside `root` (no symlink on the leaf, realpath contained), else null. */
export function containedFile(root: string, rel: string): string | null {
  const p = resolve(root, rel);
  try {
    if (lstatSync(p).isSymbolicLink()) return null;
    const real = realpathSync(p);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return real;
  } catch {
    return null;
  }
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function stamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

// ─── Args ───────────────────────────────────────────────────────────────────

export interface ParsedArgs { flags: Record<string, string | true>; rest: string[] }

/** `--a b --c --d=e x` → flags {a:'b', c:true, d:'e'}, rest ['x']. A leading `--` is skipped. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
      else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

export function flagNum(f: ParsedArgs['flags'], k: string, dflt: number): number {
  const v = f[k];
  if (typeof v !== 'string') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function flagStr(f: ParsedArgs['flags'], k: string, dflt: string): string {
  const v = f[k];
  return typeof v === 'string' ? v : dflt;
}

// ─── Spend guard ────────────────────────────────────────────────────────────

/** The owner's approved hard cap for these evals (plan D14). */
export const HARD_CAP_USD = 60;

/** `DREAMCONTEXT_EVAL_MAX_USD` when it is a positive number, default 60, never above the hard cap. */
export function capFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DREAMCONTEXT_EVAL_MAX_USD);
  if (!Number.isFinite(n) || n <= 0) return HARD_CAP_USD;
  return Math.min(n, HARD_CAP_USD);
}

export interface SpendLine { at: string; script: string; run: string; usd: number }

/** Sum of every line of the shared ledger; a torn or foreign line is skipped. */
export function spentSoFar(ledgerPath: string): number {
  let text = '';
  try { text = readFileSync(ledgerPath, 'utf-8'); } catch { return 0; }
  let sum = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Partial<SpendLine>;
      if (typeof v.usd === 'number' && Number.isFinite(v.usd) && v.usd > 0) sum += v.usd;
    } catch { /* torn */ }
  }
  return sum;
}

export interface SpendPlan {
  script: string;
  runs: number;
  /** What one run is expected to cost. */
  perRunEstimateUsd: number;
  /** What one run may cost at most (the `--max-budget-usd` handed to the CLI). */
  perRunMaxUsd: number;
}

export interface SpendCheck { ok: boolean; reason?: string }

/**
 * The one gate in front of every model call. Order is enforced: announce (prints the estimate
 * and what the ledger already holds), then check before each run, then record what it cost.
 */
export class SpendGuard {
  private announced = false;
  readonly capUsd: number;
  readonly ledgerPath: string;
  readonly plan: SpendPlan;
  private log: (s: string) => void;

  constructor(opts: { plan: SpendPlan; ledgerPath: string; capUsd?: number; log?: (s: string) => void }) {
    this.plan = opts.plan;
    this.ledgerPath = opts.ledgerPath;
    this.capUsd = Math.min(opts.capUsd ?? capFromEnv(), HARD_CAP_USD);
    this.log = opts.log ?? ((s) => console.log(s));
  }

  get spent(): number { return spentSoFar(this.ledgerPath); }

  /** Print the estimate. Returns the text printed. */
  announce(): string {
    const total = this.plan.runs * this.plan.perRunEstimateUsd;
    const spent = this.spent;
    const lines = [
      `ESTIMATE ${this.plan.script}: ${this.plan.runs} model runs x about $${this.plan.perRunEstimateUsd.toFixed(2)} = about $${total.toFixed(2)} (each run capped at $${this.plan.perRunMaxUsd.toFixed(2)}).`,
      `Ledger: $${spent.toFixed(2)} already spent by all learn evals; cap $${this.capUsd.toFixed(2)} (DREAMCONTEXT_EVAL_MAX_USD, never above $${HARD_CAP_USD}).`,
    ];
    if (spent + total > this.capUsd) lines.push(`Warning: the estimate does not fit under the cap; runs stop at the first one that could cross it.`);
    const text = lines.join('\n');
    this.log(text);
    this.announced = true;
    return text;
  }

  /** May the next run start? Refused before the estimate is printed, and when it could cross the cap. */
  check(nextMaxUsd: number = this.plan.perRunMaxUsd): SpendCheck {
    if (!this.announced) return { ok: false, reason: 'no estimate printed yet: call announce() first' };
    const spent = this.spent;
    if (spent + nextMaxUsd > this.capUsd) {
      return { ok: false, reason: `spent $${spent.toFixed(2)} + this run up to $${nextMaxUsd.toFixed(2)} would cross the cap $${this.capUsd.toFixed(2)}` };
    }
    return { ok: true };
  }

  record(usd: number, run: string): void {
    const line: SpendLine = { at: new Date().toISOString(), script: this.plan.script, run, usd: Number.isFinite(usd) && usd > 0 ? usd : 0 };
    ensurePrivateDir(dirname(this.ledgerPath));
    appendFileSync(this.ledgerPath, JSON.stringify(line) + '\n', { encoding: 'utf-8', mode: 0o600 });
  }
}

// ─── Claude runs ────────────────────────────────────────────────────────────

/** Never Fable for these evals (plan, lane brief). */
export const EVAL_MODEL = 'opus';

export interface ClaudeResult {
  ok: boolean;
  result: string;
  costUsd: number;
  sessionId: string;
  durationMs: number;
  isError: boolean;
  stdout: string;
  stderr: string;
}

/** Parse `claude -p --output-format json` stdout (one JSON object; tolerate a stream). */
export function parseClaudeJson(stdout: string): { result: string; costUsd: number; sessionId: string; isError: boolean } {
  const tryObj = (s: string): Record<string, unknown> | null => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; } };
  let obj = tryObj(stdout.trim());
  if (!obj || Array.isArray(obj)) {
    obj = null;
    for (const line of stdout.split('\n').reverse()) {
      const v = tryObj(line.trim());
      if (v && v.type === 'result') { obj = v; break; }
    }
  }
  if (!obj) return { result: '', costUsd: 0, sessionId: '', isError: true };
  return {
    result: typeof obj.result === 'string' ? obj.result : '',
    costUsd: Number(obj.total_cost_usd ?? 0) || 0,
    sessionId: typeof obj.session_id === 'string' ? obj.session_id : '',
    isError: obj.is_error === true,
  };
}

/** Environment without the calling session's Claude and dreamcontext variables. */
export function cleanEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith('CLAUDE') || k.startsWith('DREAMCONTEXT_') || k === 'CODEX_THREAD_ID') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/** Run `claude` once, guarded. The guard has been checked by the caller; this records the cost. */
export function runClaude(args: string[], opts: { cwd: string; env: Record<string, string>; guard: SpendGuard; run: string; timeoutMs?: number; claudeBin?: string }): Promise<ClaudeResult> {
  const c = opts.guard.check();
  if (!c.ok) return Promise.reject(new Error(`spend guard: ${c.reason}`));
  const started = Date.now();
  return new Promise((res) => {
    const child = spawn(opts.claudeBin ?? 'claude', args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf-8'); });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, opts.timeoutMs ?? 20 * 60_000);
    const done = (code: number | null): void => {
      clearTimeout(timer);
      const p = parseClaudeJson(out);
      opts.guard.record(p.costUsd, opts.run);
      res({ ok: code === 0 && !p.isError, result: p.result, costUsd: p.costUsd, sessionId: p.sessionId, durationMs: Date.now() - started, isError: p.isError, stdout: out, stderr: err });
    };
    child.on('error', () => done(-1));
    child.on('close', (code) => done(code));
  });
}

export interface EvalArgs {
  prompt: string;
  settings: string;
  maxUsd: number;
  /** Built-in tool set, comma separated ("Read,Glob,Grep"); omitted = default set. */
  tools?: string;
  allowed?: readonly string[];
  permissionMode?: 'default' | 'auto' | 'dontAsk' | 'acceptEdits' | 'bypassPermissions';
  persist?: boolean;
  sessionId?: string;
  resume?: string;
  skills?: boolean;
  /** Which setting sources load besides --settings (default: project only, so his user hooks stay out). */
  settingSources?: string;
}

/**
 * The one argv every eval run uses: `claude -p … --model opus --output-format json --settings …`
 * (flags checked against `claude --help`, 2026-11-13). Never Fable.
 */
export function evalClaudeArgs(o: EvalArgs): string[] {
  const a = ['-p', o.prompt, '--model', EVAL_MODEL, '--output-format', 'json', '--settings', o.settings,
    '--setting-sources', o.settingSources ?? 'project', '--strict-mcp-config', '--max-budget-usd', o.maxUsd.toFixed(2),
    '--permission-mode', o.permissionMode ?? 'dontAsk'];
  if (o.tools !== undefined) a.push('--tools', o.tools);
  if (o.allowed?.length) a.push('--allowedTools', o.allowed.join(','));
  if (!o.skills) a.push('--disable-slash-commands');
  if (!o.persist && !o.resume) a.push('--no-session-persistence');
  if (o.sessionId) a.push('--session-id', o.sessionId);
  if (o.resume) a.push('--resume', o.resume);
  return a;
}

/** Absolute path of the real `claude`, resolved once. */
export function whichClaude(): string {
  const r = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf-8' });
  const p = (r.stdout || '').trim();
  return p || 'claude';
}

// ─── Frozen data model ──────────────────────────────────────────────────────

export type Proj = 'D' | 'T' | 'X';
export type TurnKind = 'typed' | 'answer';

/** One owner turn of the measured week, as frozen. `own` is his words only. */
export interface FrozenTurn { n: number; at: string; sid: string; proj: Proj; surf: string; kind: TurnKind; own: string }

/** A hand-labelled cluster (measurement 2). `group` A behaviour, B product, T Tilki product. */
export interface FrozenCluster { id: string; group: string; scope: string; rule: string; turns: number[]; landing: string }

/** One of the 68 sayings of an already written rule (measurement 3). */
export interface FrozenRepeat {
  cid: string; n: number; at: string; sid: string; proj: Proj; surf: string;
  /** C in context, C-list in context as a listing, N not in context, U unknown. */
  g: string; act: string; where: string;
  /** Measurement 3 field: characters of tool output between the rule's text and the answer, when known. */
  charsBetween: number | null;
}

export interface FrozenChildBrief { cid: string; brief: string }

export function projOf(slug: string): Proj {
  if (/dreamcontext-brain/.test(slug)) return 'D';
  if (/tilki/i.test(slug)) return 'T';
  return 'X';
}

export function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf-8')) as T;
}

export interface Frozen {
  turns: FrozenTurn[];
  clusters: FrozenCluster[];
  repeats: FrozenRepeat[];
  childBriefs: FrozenChildBrief[];
  dispatch: Array<{ cid: string; prompt: string }>;
  replay: Array<{ text: string; source: string }>;
  tilkiPatternsDir: string | null;
}

/** Read what `freeze.ts` derived. Throws with a plain message when nothing is frozen yet. */
export function loadFrozen(home: string = REAL_HOME): Frozen {
  const dir = frozenDir(home);
  const d = join(dir, 'derived');
  if (!existsSync(join(d, 'turns.json'))) throw new Error(`Nothing frozen at ${dir}. Run scripts/learn-eval/freeze.ts first.`);
  const opt = <T>(name: string, dflt: T): T => (existsSync(join(d, name)) ? loadJson<T>(join(d, name)) : dflt);
  const tp = join(dir, 'raw', 'tilki-patterns');
  return {
    turns: loadJson<FrozenTurn[]>(join(d, 'turns.json')),
    clusters: loadJson<FrozenCluster[]>(join(d, 'clusters.json')),
    repeats: opt<FrozenRepeat[]>('repeats.json', []),
    childBriefs: opt<FrozenChildBrief[]>('child-briefs.json', []),
    dispatch: opt<Array<{ cid: string; prompt: string }>>('dispatch.json', []),
    replay: opt<Array<{ text: string; source: string }>>('replay.json', []),
    tilkiPatternsDir: existsSync(tp) ? tp : null,
  };
}

export const FIXTURE_PATH = join(REPO, 'eval', 'learn', 'fixture.synthetic.json');

export interface SyntheticFixture {
  synthetic: true;
  project: string;
  person: string;
  turns: FrozenTurn[];
  clusters: FrozenCluster[];
  repeats: FrozenRepeat[];
  childBriefs: FrozenChildBrief[];
  machine: string[];
}

/** The synthetic fixture in the same shape as the frozen set (for --fixture runs and the unit test). */
export function loadFixture(path: string = FIXTURE_PATH): Frozen & { machine: string[]; fixture: SyntheticFixture } {
  const f = loadJson<SyntheticFixture>(path);
  return {
    turns: f.turns, clusters: f.clusters, repeats: f.repeats, childBriefs: f.childBriefs,
    dispatch: [], replay: f.machine.map((text) => ({ text, source: 'machine' })), tilkiPatternsDir: null,
    machine: f.machine, fixture: f,
  };
}

// ─── Occasions and the E2b denominator ──────────────────────────────────────

export interface DenominatorRow { id: string; occasions: number; typed: number; answers: number; included: boolean; why: string }

/**
 * Which clusters E2b can be held to: typed on two or more occasions, where an occasion is the
 * turn's live session id (`sid`, plan C3). Card answers never reach the ledger (D15), so they are
 * left out of the count and named in `why`.
 */
export function e2bDenominator(clusters: readonly FrozenCluster[], turns: readonly FrozenTurn[]): DenominatorRow[] {
  const byN = new Map(turns.map((t) => [t.n, t]));
  return clusters.map((c) => {
    const ts = c.turns.map((n) => byN.get(n)).filter((t): t is FrozenTurn => !!t);
    const typed = ts.filter((t) => t.kind === 'typed');
    const answers = ts.length - typed.length;
    const occ = new Set(typed.map((t) => t.sid)).size;
    const allOcc = new Set(ts.map((t) => t.sid)).size;
    let why = '';
    if (occ >= 2) why = `typed on ${occ} occasions`;
    else if (typed.length === 0) why = `card answers only (${answers}): not a ledger write point (D15)`;
    else if (allOcc >= 2) why = `typed on ${occ} occasion; the other occasions are card answers (D15)`;
    else why = `one occasion only (${typed.length} typed turn${typed.length === 1 ? '' : 's'} in one session)`;
    if (c.turns.length !== ts.length) why += `; ${c.turns.length - ts.length} cited turn(s) missing from the frozen turns`;
    return { id: c.id, occasions: occ, typed: typed.length, answers, included: occ >= 2, why };
  });
}

export type RepeatBucket = 'in-context' | 'unknown' | 'never-written' | 'quick-edit' | 'knowledge-file' | 'in-scope';

/**
 * Criterion 8's split of the 68 sayings. Not in context (N): never written (criterion 6), the
 * quick-edit agent (out of scope), a knowledge file (the memory plan), else in scope (10 expected).
 */
export function repeatBucket(r: Pick<FrozenRepeat, 'g' | 'where'>): RepeatBucket {
  if (r.g === 'C' || r.g === 'C-list') return 'in-context';
  if (r.g !== 'N') return 'unknown';
  const w = r.where.toLowerCase();
  if (/never written/.test(w)) return 'never-written';
  if (/fast-edit|quick-edit/.test(w)) return 'quick-edit';
  if (/knowledge file/.test(w)) return 'knowledge-file';
  return 'in-scope';
}

/** The turn that would have taught a cluster's rule: its earliest typed turn (else earliest turn). */
export function teachingTurn(c: FrozenCluster, byN: ReadonlyMap<number, FrozenTurn>): FrozenTurn | null {
  const ts = c.turns.map((n) => byN.get(n)).filter((t): t is FrozenTurn => !!t).sort((a, b) => a.at.localeCompare(b.at));
  return ts.find((t) => t.kind === 'typed') ?? ts[0] ?? null;
}

// ─── Phrase coverage (plan C6, D7) ──────────────────────────────────────────

export type IdfTable = Map<string, number> & { docs?: number };

/** BM25-style IDF over `docs`, tokenised with recall's own `tokenize()`. */
export function buildIdf(docs: readonly string[]): { idf: (t: string) => number; docs: number } {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(tokenize(d))) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const idf = (t: string): number => {
    const f = df.get(t) ?? 0;
    return Math.log(1 + (N - f + 0.5) / (f + 0.5));
  };
  return { idf, docs: N };
}

export interface Coverage { mass: number; distinct: number; phraseTerms: number }

/** Share of a phrase's IDF mass the job text covers, and how many distinct content terms. */
export function coverage(job: string, phrase: string, idf: (t: string) => number): Coverage {
  const P = [...new Set(tokenize(phrase))];
  if (P.length === 0) return { mass: 0, distinct: 0, phraseTerms: 0 };
  const J = new Set(tokenize(job));
  let num = 0; let den = 0; let distinct = 0;
  for (const t of P) {
    const w = idf(t);
    den += w;
    if (J.has(t)) { num += w; distinct++; }
  }
  return { mass: den > 0 ? num / den : 0, distinct, phraseTerms: P.length };
}

/** Best coverage over a rule's phrases that has at least two distinct terms (C6). */
export function bestCoverage(job: string, phrases: readonly string[], idf: (t: string) => number): number {
  let best = 0;
  for (const p of phrases) {
    const c = coverage(job, p, idf);
    if (c.distinct >= 2 && c.mass > best) best = c.mass;
  }
  return best;
}

export const T_CANDIDATES = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

/** Cut a string to at most `max` chars at a word boundary, one line, no tag brackets (C1 text shape). */
export function shapeText(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').replace(/[<>]/g, (m) => (m === '<' ? '(' : ')')).replace(/[—–]/g, ',').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim();
}

/** Deterministic PRNG (mulberry32), for samples and filler. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample<T>(xs: readonly T[], k: number, seed: number): T[] {
  const r = prng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a.slice(0, k);
}

// ─── Scratch vaults and the learn CLI ───────────────────────────────────────

export const EVAL_EMAIL = 'eval-owner@example.invalid';

export interface Scratch { dir: string; home: string; bin: string; cli: string; vaults: Partial<Record<Proj, string>> }

/** The env a dreamcontext call runs with: fake HOME, no agent session, a fictional git identity. */
export function dcEnv(s: Scratch, extra: Record<string, string> = {}): Record<string, string> {
  return cleanEnv({
    HOME: s.home,
    GIT_CONFIG_GLOBAL: join(s.home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${s.bin}:${process.env.PATH ?? ''}`,
    ...extra,
  });
}

export function dc(s: Scratch, cwd: string, args: string[], extra: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [s.cli, ...args], { cwd, env: dcEnv(s, extra), encoding: 'utf-8', timeout: 120_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * A scratch dir with a fake HOME, a `dreamcontext` shim that always runs THIS checkout's build
 * under that HOME, and one initialised vault per project asked for.
 */
export function makeScratch(dir: string, projects: readonly Proj[], cli: string = join(REPO, 'dist', 'index.js')): Scratch {
  const home = ensurePrivateDir(join(dir, 'home'));
  const bin = ensurePrivateDir(join(dir, 'bin'));
  writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = Eval Owner\n\temail = ${EVAL_EMAIL}\n[init]\n\tdefaultBranch = main\n`);
  const shim = join(bin, 'dreamcontext');
  writeFileSync(shim, `#!/bin/sh\nHOME=${JSON.stringify(home)} GIT_CONFIG_GLOBAL=${JSON.stringify(join(home, '.gitconfig'))} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
  chmodSync(shim, 0o755);
  const meDir = ensurePrivateDir(join(home, '.dreamcontext', 'me'));
  if (!existsSync(join(meDir, 'me.json'))) writePrivate(join(meDir, 'me.json'), JSON.stringify({ emails: [EVAL_EMAIL] }) + '\n');
  const s: Scratch = { dir, home, bin, cli, vaults: {} };
  const names: Record<Proj, string> = { D: 'lumen-ledger', T: 'harbor-notes', X: 'quill-yard' };
  for (const p of projects) {
    const proj = join(dir, names[p]);
    mkdirSync(proj, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: proj, env: dcEnv(s) });
    dc(s, proj, ['init', '-y', '--name', names[p], '--description', 'Synthetic eval vault', '--platforms', 'claude']);
    s.vaults[p] = proj;
  }
  return s;
}

/**
 * Point every hook command in a vault's `.claude/settings*.json` at the shim, so a hook that
 * Claude (running under the REAL home, for its auth) starts still writes only the fake HOME.
 */
export function pinHooksToShim(s: Scratch, proj: string): number {
  let changed = 0;
  for (const name of ['settings.json', 'settings.local.json']) {
    const f = join(proj, '.claude', name);
    if (!existsSync(f)) continue;
    let j: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    try { j = JSON.parse(readFileSync(f, 'utf-8')); } catch { continue; }
    for (const groups of Object.values(j.hooks ?? {})) {
      for (const g of groups) for (const h of g.hooks ?? []) {
        if (typeof h.command !== 'string') continue;
        const next = h.command.replace(/^(?:npx\s+(?:-y\s+)?)?(?:\S*\/)?dreamcontext(?=\s|$)/, join(s.bin, 'dreamcontext'));
        if (next !== h.command) { h.command = next; changed++; }
      }
    }
    writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  }
  return changed;
}

export interface Receipt { id: string; status: string; scope: string; owner: string }

/** Line 1 `LEARNED <id> <status> <scope>`, line 2 his line (C1); `--json` output is read too. */
export function parseReceipt(stdout: string): Receipt | null {
  const t = stdout.trim();
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    const rec = (j.record ?? j) as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : typeof j.id === 'string' ? j.id : '';
    if (id) {
      return {
        id,
        status: String(rec.status ?? j.status ?? ''),
        scope: String(rec.scope ?? j.scope ?? ''),
        owner: String(j.owner ?? j.line ?? j.receipt ?? ''),
      };
    }
  } catch { /* text form */ }
  const lines = t.split('\n');
  const i = lines.findIndex((l) => /^LEARNED \S+ \S+ \S+/.test(l.trim()));
  if (i < 0) return null;
  const [, id, status, scope] = lines[i]!.trim().split(/\s+/);
  return { id: id!, status: status!, scope: scope!, owner: (lines[i + 1] ?? '').trim() };
}

export interface SeedRule { key: string; scope: 'me' | 'project'; proj: Proj; text: string; headline: string; quote: string; at?: string }
export interface SeededRule extends SeedRule { id: string; status: string; error?: string }

/**
 * Write rules into the stores the way D11's list would (through the real `learn` CLI, then `keep`
 * from a shell outside any agent session). A CLI that is not there yet returns every rule with an
 * error: the "before" numbers are then measured with empty stores, which is today's state.
 */
export function seedRules(s: Scratch, rules: readonly SeedRule[]): SeededRule[] {
  const out: SeededRule[] = [];
  for (const r of rules) {
    const cwd = s.vaults[r.proj] ?? Object.values(s.vaults)[0]!;
    const args = ['learn', r.text, '--scope', r.scope, '--quote', r.quote, '--headline', r.headline, '--new'];
    if (r.at) args.push('--at', r.at);
    const res = dc(s, cwd, args);
    const rc = parseReceipt(res.stdout);
    if (!rc) { out.push({ ...r, id: '', status: '', error: (res.stderr || res.stdout).trim().split('\n')[0] || `exit ${res.code}` }); continue; }
    let status = rc.status;
    if (status === 'proposed') {
      const k = dc(s, cwd, ['learn', 'keep', rc.id]);
      if (k.code === 0) status = 'active';
    }
    out.push({ ...r, id: rc.id, status });
  }
  return out;
}

/** The 41 clusters as D11's list would write them, taught from each cluster's first saying. */
export function clusterSeeds(clusters: readonly FrozenCluster[], turns: readonly FrozenTurn[]): SeedRule[] {
  const byN = new Map(turns.map((t) => [t.n, t]));
  return clusters.map((c) => {
    const teach = teachingTurn(c, byN);
    const proj: Proj = c.scope.startsWith('T') ? 'T' : 'D';
    return {
      key: c.id,
      scope: c.group === 'A' ? 'me' : 'project',
      proj,
      text: shapeText(c.rule, 240),
      headline: shapeText(c.rule, 60),
      quote: shapeText(teach?.own ?? c.rule, 120),
    };
  });
}

// ─── Delivery adapter (C6) ──────────────────────────────────────────────────

export type Surface = 'owner' | 'child' | 'dispatch' | 'finished' | 'act' | 'machine';
export interface DeliveryLike { always: string[]; moment: string[]; matched: string[]; chars: number; considered: number }
export type DeliverFn = (root: string, input: Record<string, unknown> & { surface: Surface }) => DeliveryLike;

/** The raw hook input each surface would carry. */
export function hookInput(surface: Surface, text: string, cwd: string, sessionId = 'eval-session'): Record<string, unknown> & { surface: Surface } {
  if (surface === 'dispatch') {
    return { surface, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'helper', prompt: text, subagent_type: 'general-purpose' }, cwd, session_id: sessionId };
  }
  if (surface === 'act') {
    return { surface, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: text }, cwd, session_id: sessionId };
  }
  return { surface, hook_event_name: 'UserPromptSubmit', prompt: text, cwd, session_id: sessionId };
}

/** Did a delivery carry this rule? By id first, then by its headline. */
export function delivered(d: DeliveryLike, id: string, headline: string): boolean {
  const lines = [...d.always, ...d.moment, ...d.matched];
  return lines.some((l) => (id && l.includes(id)) || (headline.length >= 12 && l.includes(headline)));
}

/** Import `deliverForTurn` AFTER HOME points at the fake home (some modules read it at import). */
export async function loadDeliver(home: string): Promise<{ deliver: DeliverFn | null; error?: string }> {
  process.env.HOME = home;
  try {
    const m = await import('../../src/lib/rules-delivery.js') as { deliverForTurn?: DeliverFn };
    if (typeof m.deliverForTurn !== 'function') return { deliver: null, error: 'rules-delivery.ts has no deliverForTurn' };
    return { deliver: m.deliverForTurn };
  } catch (e) {
    return { deliver: null, error: `rules-delivery.ts not loadable: ${(e as Error).message}` };
  }
}

// ─── E6: the loaded session (position.ts) ───────────────────────────────────

/** The fictional project of every synthetic text here. */
export const FICTIONAL = { project: 'Lumen Ledger', person: 'Ada Kestrel' } as const;

export interface ReportRule { key: 'verdict' | 'nodash' | 'nopath'; text: string }

/** Three report rules a generic answer breaks, each scored mechanically (no judge model). */
export const E6_RULES: readonly ReportRule[] = [
  { key: 'verdict', text: 'Every report to me opens with one word alone on its first line: TAMAM when the work is fine, SORUN when it is not.' },
  { key: 'nodash', text: 'Never use a long dash (em dash or en dash) anywhere in a message to me; use a comma, a colon or a new sentence.' },
  { key: 'nopath', text: 'Never put a file path or a file name in a report to me; say what the thing is in plain words.' },
];

/** The control: a rule that does not belong in a report. Applying it there is "over-applied". */
export const E6_CONTROL = { key: 'control', text: 'When you write a git commit message, end it with the line "Signed: Lumen".', marker: 'Signed: Lumen' } as const;

export type ErrorType = 'obeyed' | 'unaware' | 'misapplied';

export function scoreVerdict(answer: string): ErrorType {
  const lines = answer.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = (lines[0] ?? '').replace(/[*_#`>]/g, '').trim();
  if (/^(TAMAM|SORUN)[.!:]?$/.test(first)) return 'obeyed';
  if (lines.slice(0, 3).some((l) => /\b(TAMAM|SORUN)\b/.test(l))) return 'misapplied';
  return 'unaware';
}

export function scoreNoDash(answer: string): ErrorType {
  if (answer.includes('—')) return 'unaware';
  if (answer.includes('–')) return 'misapplied';
  return 'obeyed';
}

const PATH_RE = /(?:^|[\s(`'"])(?:\.{0,2}\/)?[\w.-]+\/[\w./-]*[\w-]/m;
const FILE_RE = /\b[\w-]+\.(?:log|md|ts|tsx|js|mjs|json|txt|yml|yaml|spec)\b/i;

export function scoreNoPath(answer: string): ErrorType {
  if (PATH_RE.test(answer)) return 'unaware';
  if (FILE_RE.test(answer)) return 'misapplied';
  return 'obeyed';
}

export function scoreRule(key: ReportRule['key'], answer: string): ErrorType {
  return key === 'verdict' ? scoreVerdict(answer) : key === 'nodash' ? scoreNoDash(answer) : scoreNoPath(answer);
}

export function overApplied(answer: string): boolean {
  return answer.includes(E6_CONTROL.marker);
}

/** 26 more rules about other moments, so the start block holds 30 like the plan's loaded session. */
export const E6_OTHER_RULES: readonly string[] = [
  'Plan big work as one task; never open a task for a one-line fix.',
  'Run the full test suite once per release cut, never again after it passed.',
  'Clean up scratch worktrees and stray processes when a job ends.',
  'Before a publish, check the registry login first.',
  'Ask before deleting anything outside the project folder.',
  'Pick the model by the job: a small one only for read-only research.',
  'Reuse the existing component instead of writing a second one.',
  'Show a drawing of a new screen before building it.',
  'Keep the agenda fresh: no stale or duplicate items.',
  'Never hand a decision back to me that you can make yourself.',
  'Write tests next to the code they cover.',
  'Keep commit subjects under 72 characters.',
  'Never push to the main branch without my word.',
  'Name branches after the task, in kebab case.',
  'Store secrets only in the keychain, never in a file.',
  'Use the project font scale; never hard-code a size.',
  'When a job is blocked on a permission, say so at once.',
  'Prefer one small change over a rewrite.',
  'Put dates in reports as day and month, never as a timestamp.',
  'Read the inbox history before concluding about a customer.',
  'Do not schedule anything at night.',
  'Keep a changelog line for every user-facing change.',
  'Never open things on the stage I did not ask for.',
  'Load the drawing skill before any diagram.',
  'Give me a link and a login when something is ready to try.',
  'Translate user-facing text into both languages the app ships.',
];

/** A Super-like opening briefing for the loaded session (synthetic, fixed). */
export function e6Briefing(): string {
  return [
    `# Super Agent briefing: ${FICTIONAL.project}`,
    '',
    `You are the Super Agent of ${FICTIONAL.project}, a small bookkeeping app. ${FICTIONAL.person} owns it and talks to you here.`,
    'You plan, read, and report; you do not edit code in this session.',
    'Children build in their own worktrees; you read their logs and report to the owner.',
    'The nightly build writes its logs under logs/. The owner reads your report on a phone between meetings.',
    '',
    '## How this project works',
    '- One release cut per batch of work.',
    '- Builders report through their logs; the Super reads them and tells the owner what happened.',
    '- The owner decides releases; the Super prepares the facts.',
  ].join('\n');
}

/** The session start block: briefing plus 30 rules (3 report rules, the control, 26 others). */
export function e6StartBlock(): string {
  const rules = [
    ...E6_OTHER_RULES.slice(0, 9),
    E6_RULES[0]!.text,
    ...E6_OTHER_RULES.slice(9, 15),
    E6_CONTROL.text,
    E6_RULES[1]!.text,
    ...E6_OTHER_RULES.slice(15, 22),
    E6_RULES[2]!.text,
    ...E6_OTHER_RULES.slice(22),
  ];
  return `${e6Briefing()}\n\n## His preferences (${rules.length})\n${rules.map((r, i) => `- [r${String(i + 1).padStart(2, '0')}] ${r}`).join('\n')}\n`;
}

/** P1: the "Before you answer him:" lines next to his turn (report rules only, short form). */
export function e6P1Block(): string {
  return `Before you answer him:\n${E6_RULES.map((r) => `- ${r.text}`).join('\n')}`;
}

/** The P2 forced pass (arm C): one check of the first answer against the report rules. */
export function e6P2Prompt(): string {
  return `Check your last answer to me against these report rules. If one was broken, send one corrected version of the whole answer; if none was, reply only with OK.\n${E6_RULES.map((r) => `- ${r.text}`).join('\n')}`;
}

/** Twelve owner jobs (4 per rule) that each need every log read and end in a report to him. */
export const E6_JOBS: readonly string[] = [
  'Gece derlemesi kırıldı. logs/ altındaki bütün dosyaları baştan sona oku ve bana hangi testin neden kırıldığını anlat.',
  'logs/ klasöründeki derleme kayıtlarının hepsini oku. Dün geceki derlemede ne ters gitti, kısaca rapor ver.',
  'Bütün logs/ dosyalarını tek tek oku; hangi adım başarısız oldu ve sebebi ne, bana yaz.',
  'Gece işi bitti mi? logs/ altındaki kayıtların tamamını oku ve durumu bana bildir.',
  'Read every file under logs/ in full and tell me which test broke the nightly build and why.',
  'Go through all the build logs in logs/, every one, and report what failed last night.',
  'I need a status report: read all of logs/ and tell me whether the release can go out.',
  'Read each log in logs/ completely and report to me what the nightly run found.',
  'logs/ altında on kayıt var, hepsini oku. Sürüm çıkabilir mi, bana rapor et.',
  'Derleme kayıtlarının hepsini oku ve bana hangi modülün sorun çıkardığını söyle.',
  'Read all ten logs in logs/ and give me the short version of what went wrong.',
  'Tüm logs/ dosyalarını oku; kırılan test hangisi, düzeltmek için ne gerekir, bana anlat.',
];

/** The frozen synthetic filler: 10 build logs, about 250,000 characters, one failing test inside. */
export function e6Filler(totalChars = 250_000, files = 10): Array<{ name: string; text: string }> {
  const r = prng(20261113);
  const modules = ['ledger', 'invoice', 'reconcile', 'export', 'auth', 'currency', 'report', 'import', 'audit', 'sync'];
  const verbs = ['compiled', 'linked', 'bundled', 'checked', 'cached', 'resolved', 'hashed', 'scanned'];
  const per = Math.floor(totalChars / files);
  const out: Array<{ name: string; text: string }> = [];
  for (let f = 0; f < files; f++) {
    const mod = modules[f % modules.length]!;
    const lines: string[] = [`# nightly build ${FICTIONAL.project}, stage ${f + 1} of ${files}, module ${mod}`];
    let len = lines[0]!.length + 1;
    let k = 0;
    while (len < per) {
      const v = verbs[Math.floor(r() * verbs.length)]!;
      const ms = Math.floor(r() * 900) + 10;
      const line = f === 6 && k === 400
        ? `FAIL src/${mod}/rounding.spec.ts > rounds half-cents to even: expected 10.42 received 10.41 (the currency table was loaded before the locale)`
        : `[${String(k).padStart(5, '0')}] ok src/${mod}/part-${Math.floor(r() * 90) + 10}.ts ${v} in ${ms}ms`;
      lines.push(line);
      len += line.length + 1;
      k++;
    }
    out.push({ name: `build-${String(f + 1).padStart(2, '0')}.log`, text: lines.join('\n') + '\n' });
  }
  return out;
}

export function fillerDigest(files: ReadonlyArray<{ name: string; text: string }>): string {
  return sha256(files.map((f) => `${f.name}\n${f.text}`).join('\u0000'));
}

/** Paths the scratch runs must never read: the real brains and checkouts, the real home stores. */
export function denyRules(home: string = REAL_HOME): string[] {
  const dirs = [join(home, 'projects'), join(home, '.claude-worktrees'), join(home, '.dreamcontext'), join(home, '.ssh'), join(home, 'Documents'), join(home, 'Desktop')];
  return dirs.flatMap((d) => [`Read(/${d}/**)`, `Edit(/${d}/**)`, `Write(/${d}/**)`]);
}

/** Markdown table helper. */
export function table(head: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function pct(k: number, n: number): string {
  return n === 0 ? 'n/a' : `${k}/${n} (${Math.round((100 * k) / n)}%)`;
}

/** Files under a dir (non-recursive, regular files only, no symlinks). */
export function listFiles(dir: string, re: RegExp = /./): string[] {
  try {
    return readdirSync(dir).filter((n) => re.test(n)).map((n) => join(dir, n)).filter((p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } });
  } catch { return []; }
}

export function slugOfFile(p: string): string {
  return basename(p).replace(/\.md$/, '');
}
