import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg } from 'node:os';
import { basename, join } from 'node:path';
import { readFrontmatter } from '../frontmatter.js';
import { executeClaudeDetached, type ClaudeExecution } from '../automations/runner.js';
import { readEvalSet, readRound, roundSourceCtx } from './fixtures.js';
import { agentDefinitionHash, prepareScratch, type ScratchOptions, type ScratchVault } from './scratch.js';
import type { OutputFold, OutputPattern, OutputTask, RoundOutput } from './score.js';
import { sleepEvalRoot, type FixtureRound } from './types.js';

/**
 * `sleep eval run`: replay each round of the frozen set through the real sleep-tasks
 * specialist, one round at a time, in its own scratch vault, and keep only what it changed.
 * Scoring is separate (score.ts), so a run made before the owner finished labelling is
 * scored later against the finished labels.
 */

export const ROUND_TIMEOUT_MS = 45 * 60 * 1000;
const LOAD_SAMPLE_MS = 30_000;
/** Wait for a quiet machine before a round, at most this long, then run anyway (recorded). */
const QUIET_WAIT_MS = 10 * 60 * 1000;

export interface LoadSample {
  load1: number;
  cores: number;
  freeMemMb: number;
}

export function sampleLoad(): LoadSample {
  return { load1: Number(loadavg()[0].toFixed(2)), cores: cpus().length, freeMemMb: Math.round(freemem() / 1048576) };
}

export interface RoundRun {
  round: string;
  status: 'ok' | 'failed' | 'timeout' | 'tainted';
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  load: { before: LoadSample; peak: LoadSample; after: LoadSample; waitedMs: number };
  exitCode: number | null;
  costUsd: number | null;
  turns: number | null;
  /** Real-brain files the round touched (by slug) that changed during it: must be empty. */
  escaped: string[];
  /** How many real-brain files the tripwire compared. */
  checked?: number;
  /** The specialist + skills this round ran with (`agentDefinitionHash`). */
  agentHash?: string;
  note?: string;
}

export interface RunMeta {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  /** The child task this run is the after-measurement of (the close gate reads it). */
  for: string | null;
  /** When rounds were re-run in place (`run --retry`). */
  retriedAt?: string[];
  label: string | null;
  agents: string[];
  model: string | null;
  effort: string | null;
  agentHash: string | null;
  cliVersion: string;
  gitSha: string | null;
  setCreatedAt: string;
  rounds: RoundRun[];
}

export function runsRoot(contextRoot: string): string {
  return join(sleepEvalRoot(contextRoot), 'runs');
}

export function newRunId(now: Date = new Date()): string {
  const iso = now.toISOString();
  return `run-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`;
}

export function readRunMeta(contextRoot: string, runId: string): RunMeta | null {
  const p = join(runsRoot(contextRoot), runId, 'run.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as RunMeta;
  } catch {
    return null;
  }
}

export function writeRunMeta(contextRoot: string, meta: RunMeta): void {
  const dir = join(runsRoot(contextRoot), meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(meta, null, 2) + '\n');
}

export function listRuns(contextRoot: string): RunMeta[] {
  const root = runsRoot(contextRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => readRunMeta(contextRoot, id))
    .filter((m): m is RunMeta => m !== null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function readRoundOutput(contextRoot: string, runId: string, round: string): RoundOutput | null {
  const p = join(runsRoot(contextRoot), runId, round, 'output.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as RoundOutput;
  } catch {
    return null;
  }
}

// ─── The brief (what the sleep orchestrator hands sleep-tasks) ───────────────

export function buildBrief(round: FixtureRound, epoch: string, depth: string, planning: string, taskSlugs: Map<string, string[]>): string {
  const sessions = [...round.sessions]
    .sort((a, b) => a.stopped_at.localeCompare(b.stopped_at))
    .map((s) => `${s.stopped_at}  ${s.session_id}  [${(taskSlugs.get(s.session_id) ?? []).join(',')}]`);
  return [
    'Sleep cycle brief for sleep-tasks.',
    `Epoch: ${epoch}`,
    `Consolidation depth: ${depth}`,
    `Planning version: ${planning || '(none active)'}`,
    '',
    'Sessions since the last sleep, OLDEST → NEWEST (stopped_at, session id, task slugs) — later sessions override earlier ones:',
    ...sessions,
    '',
    'Read each with `dreamcontext transcript distill <session_id>`. Consolidation discipline: prefer updating or',
    'extending an existing task over creating a new one; fold a smaller slice into the task that covers it.',
    'Duplicate tasks are the top failure mode, but a genuinely separate concern still gets its own task.',
    'No user hint. Return your short structured report.',
  ].join('\n');
}

// ─── What changed ────────────────────────────────────────────────────────────

function listMd(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try {
      out.set(basename(f, '.md'), readFileSync(join(dir, f), 'utf-8'));
    } catch {
      /* skip */
    }
  }
  return out;
}

export interface Snapshot {
  tasks: Map<string, string>;
  patterns: Map<string, string>;
}

export function snapshotVault(ctx: string): Snapshot {
  return { tasks: listMd(join(ctx, 'state')), patterns: listMd(join(ctx, 'knowledge', 'patterns')) };
}

/** Body lines before the Changelog, without the frontmatter. */
function bodyLines(md: string): string[] {
  let body = md;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end > 0) body = body.slice(end + 4);
  }
  const cut = body.search(/^## Changelog\b/m);
  if (cut >= 0) body = body.slice(0, cut);
  // Headings are structure, not content: a new `## Notes` section is not a fold by itself.
  return body.split('\n').map((l) => l.trim()).filter((l) => l.length > 10 && !l.startsWith('<!--') && !l.startsWith('#'));
}

export function whySection(md: string): string {
  const m = md.match(/^## Why\s*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  const text = (m ? m[1] : '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 600);
}

function fm(md: string): Record<string, unknown> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, unknown> = {};
  // Enough for name / parent_task / status: a full YAML parse is not needed for a diff.
  let key: string | null = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      out[key] = v === '>-' || v === '|' || v === '>' ? '' : v.replace(/^['"]|['"]$/g, '');
    } else if (key && /^\s+\S/.test(line) && typeof out[key] === 'string') {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

export function diffVault(before: Snapshot, after: Snapshot, round: string, boardNames: Array<{ slug: string; name: string }>): RoundOutput {
  const opened: OutputTask[] = [];
  const folds: OutputFold[] = [];
  for (const [slug, md] of after.tasks) {
    const meta = fm(md);
    const parent = typeof meta.parent_task === 'string' && meta.parent_task && meta.parent_task !== 'null' ? meta.parent_task : null;
    const prev = before.tasks.get(slug);
    if (prev === undefined) {
      opened.push({ slug, name: String(meta.name ?? slug), why: whySection(md), parent });
      continue;
    }
    if (prev === md) continue;
    const had = new Set(bodyLines(prev));
    const added = bodyLines(md).filter((l) => !had.has(l));
    if (added.length > 0) folds.push({ slug, parent, text: added.join('\n').slice(0, 1500) });
  }
  const patterns: OutputPattern[] = [];
  for (const [slug, md] of after.patterns) {
    const prev = before.patterns.get(slug);
    if (prev === md) continue;
    const text = prev === undefined ? md : (() => {
      const had = new Set(prev.split('\n'));
      return md.split('\n').filter((l) => !had.has(l)).join('\n');
    })();
    patterns.push({ path: `knowledge/patterns/${slug}.md`, text: text.slice(0, 4000) });
  }
  return { round, opened, folds, patterns, boardNames };
}

/** Fingerprint (size + mtime) of a real-brain file, or null when it does not exist. */
function fingerprint(p: string): string | null {
  try {
    const st = statSync(p);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Fingerprint every real task file and every real pattern before a round. The WHOLE
 * `state/` directory, not just the round's board: a replay that re-files a task the real
 * sleep filed (same slug, a file that already exists in the real brain) must read as
 * "unchanged", never as an escape.
 */
export function realTouchables(realCtx: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  // Keys in the POSIX spelling the round's `touched` list uses, on every OS.
  for (const sub of ['state', 'knowledge/patterns']) {
    const dir = join(realCtx, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.md')) out.set(`${sub}/${f}`, fingerprint(join(dir, f)));
  }
  return out;
}

/**
 * Did the round write into the REAL brain? Prevention is the permission set (no unscoped
 * Write/Edit, deny rules on the real brain) and the Bash sandbox; this is the tripwire
 * behind them. Of the real files fingerprinted before the round, those whose slug the
 * round itself touched (opened, folded into, or a pattern it wrote) and that changed are
 * an escape. Precise on purpose: the owner keeps working while a run goes, so a change to
 * a task the round never touched proves nothing.
 */
export function findEscapes(realCtx: string, before: Map<string, string | null>, touched: string[]): string[] {
  const hits: string[] = [];
  for (const rel of touched) {
    if (!before.has(rel)) {
      // Not fingerprinted: a NEW real file named after something the round created.
      if (fingerprint(join(realCtx, rel)) !== null) hits.push(rel);
      continue;
    }
    if (fingerprint(join(realCtx, rel)) !== before.get(rel)) hits.push(rel);
  }
  return hits;
}

// ─── Running one round ───────────────────────────────────────────────────────

export interface RunOptions extends Omit<ScratchOptions, 'agents'> {
  agents?: string[];
  rounds?: string[];
  /** Re-run, inside this finished run, every round that is not `ok` (a timeout under load). */
  retry?: string | null;
  /** Per-round ceiling; defaults to ROUND_TIMEOUT_MS. */
  roundTimeoutMs?: number;
  for?: string | null;
  label?: string | null;
  keepScratch?: boolean;
  log?: (line: string) => void;
  /** Injected for tests: replaces the claude spawn. */
  exec?: (args: string[], cwd: string, env: Record<string, string | undefined>) => Promise<ClaudeExecution>;
  /** Injected for tests: replaces `sampleLoad`. */
  load?: () => LoadSample;
  sleep?: (ms: number) => Promise<void>;
  gitSha?: string | null;
}

function agentFrontmatter(path: string): { model: string | null; effort: string | null } {
  try {
    const { data } = readFrontmatter<{ model?: unknown; effort?: unknown }>(path);
    return {
      model: typeof data.model === 'string' ? data.model : null,
      effort: typeof data.effort === 'string' ? data.effort : null,
    };
  } catch {
    return { model: null, effort: null };
  }
}

/** Run the scratch CLI (through the shim) and return stdout; never throws. */
function shimRun(vault: ScratchVault, args: string[]): string {
  try {
    return execFileSync(join(vault.bin, 'dreamcontext'), args, {
      cwd: vault.proj,
      env: scratchEnv(vault),
      encoding: 'utf-8',
      timeout: 5 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stdout?: string };
    return typeof err.stdout === 'string' ? err.stdout : '';
  }
}

/** The child's environment: the shim first on PATH, no session/tab identity leaking in. */
export function scratchEnv(vault: ScratchVault, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('DREAMCONTEXT_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') continue;
    env[k] = v;
  }
  env.PATH = `${vault.bin}:${base.PATH ?? ''}`;
  env.DREAMCONTEXT_SLEEP_EVAL = '1';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return env;
}

const ORCHESTRATION_TOOLS = 'Agent Task Skill Workflow WebFetch WebSearch TaskCreate TaskUpdate TaskStop CronCreate CronDelete SendMessage RemoteTrigger PushNotification EnterWorktree ExitWorktree Monitor';

export function claudeArgs(prompt: string, agent: string, model: string | null, effort: string | null): string[] {
  return [
    '-p', prompt,
    '--agent', agent,
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    // NO Write/Edit here: an unscoped tool name allows it on EVERY path (review 2026-10-16,
    // measured on claude 2.1.300). acceptEdits already approves edits inside the scratch
    // project (the cwd); anything outside is refused for want of an approval nobody gives.
    '--allowedTools', 'Bash Read Glob Grep',
    '--disallowedTools', ORCHESTRATION_TOOLS,
  ];
}

async function waitForQuiet(opts: RunOptions, log: (l: string) => void): Promise<number> {
  const load = opts.load ?? sampleLoad;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = Date.now();
  let waited = 0;
  while (waited < QUIET_WAIT_MS) {
    const l = load();
    if (l.load1 <= l.cores) break;
    if (waited === 0) log(`machine busy (load1 ${l.load1} > ${l.cores} cores): waiting for it to settle`);
    await sleep(60_000);
    waited = Date.now() - start;
  }
  return waited;
}

export async function runRound(contextRoot: string, runId: string, round: FixtureRound, opts: RunOptions): Promise<RoundRun> {
  const log = opts.log ?? (() => {});
  const load = opts.load ?? sampleLoad;
  const agents = opts.agents ?? ['sleep-tasks'];
  const runDir = join(runsRoot(contextRoot), runId, round.id);
  const scratchDir = join(runDir, 'scratch');
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  const waitedMs = await waitForQuiet(opts, log);
  const before = load();
  const startedAt = new Date();
  const vault = prepareScratch(contextRoot, round, scratchDir, { ...opts, agents });

  // Build the index the filing bar's neighbor check reads (only changed chunks embed).
  shimRun(vault, ['embed', 'refresh']);
  const startJson = shimRun(vault, ['sleep', 'start', '--json']);
  let epoch = startedAt.toISOString();
  let depth = 'standard';
  try {
    const parsed = JSON.parse(startJson) as { epoch?: string; depth?: string };
    epoch = parsed.epoch ?? epoch;
    depth = parsed.depth ?? depth;
  } catch { /* the defaults stand */ }
  const planning = shimRun(vault, ['core', 'releases', 'active']).trim().split('\n')[0] ?? '';
  const sleepState = JSON.parse(readFileSync(join(vault.ctx, 'state', '.sleep.json'), 'utf-8')) as { sessions: Array<{ session_id: string; task_slugs: string[] }> };
  const slugs = new Map(sleepState.sessions.map((s) => [s.session_id, s.task_slugs]));
  const brief = buildBrief(round, epoch, depth, planning, slugs);
  let briefing = '';
  try {
    const hook = JSON.parse(shimRun(vault, ['hook', 'subagent-start'])) as { hookSpecificOutput?: { additionalContext?: string } };
    briefing = hook.hookSpecificOutput?.additionalContext ?? '';
  } catch { /* no briefing: the specialist still has its own instructions */ }
  const prompt = briefing ? `${briefing}\n\n---\n\n${brief}` : brief;
  writeFileSync(join(runDir, 'brief.md'), prompt);

  const snapBefore = snapshotVault(vault.ctx);
  // The brain the round was cut from is the one it could escape into.
  const realCtx = roundSourceCtx(contextRoot, round);
  const realBefore = realTouchables(realCtx);
  const boardNames = [...snapBefore.tasks].map(([slug, md]) => ({ slug, name: String(fm(md).name ?? slug) }));

  let peak = before;
  const timer = setInterval(() => {
    const l = load();
    if (l.load1 > peak.load1) peak = l;
  }, LOAD_SAMPLE_MS);
  let exec: ClaudeExecution | null = null;
  let note: string | undefined;
  try {
    for (const agent of agents) {
      const { model, effort } = agentFrontmatter(join(vault.proj, '.claude', 'agents', `${agent}.md`));
      const args = claudeArgs(prompt, agent, model, effort);
      const env = scratchEnv(vault);
      exec = opts.exec
        ? await opts.exec(args, vault.proj, env)
        : await executeClaudeDetached(args, { cwd: vault.proj, env, timeoutMs: opts.roundTimeoutMs ?? ROUND_TIMEOUT_MS, log });
      writeFileSync(join(runDir, `${agent}.stdout.json`), exec.stdout || exec.stderrTail || '');
      if (!exec.spawned || exec.timedOut || exec.exitCode !== 0) break;
    }
  } finally {
    clearInterval(timer);
  }
  const after = load();
  if (after.load1 > peak.load1) peak = after;

  const output = diffVault(snapBefore, snapshotVault(vault.ctx), round.id, boardNames);
  const touched = [
    ...output.opened.map((o) => join('state', `${o.slug}.md`)),
    ...output.folds.map((f) => join('state', `${f.slug}.md`)),
    ...output.patterns.map((p) => p.path),
  ];
  const escaped = findEscapes(realCtx, realBefore, touched);
  let status: RoundRun['status'] = 'ok';
  if (!exec?.spawned || (exec.exitCode !== 0 && !exec.timedOut)) {
    status = 'failed';
    note = exec?.stderrTail?.slice(-400) ?? 'claude did not spawn';
  }
  if (exec?.timedOut) status = 'timeout';
  if (escaped.length > 0) status = 'tainted';
  output.error = status === 'ok' ? null : status;
  const shimLog = existsSync(vault.shimLog) ? readFileSync(vault.shimLog, 'utf-8') : '';
  writeFileSync(join(runDir, 'output.json'), JSON.stringify({ ...output, shim: shimLog.split('\n').filter(Boolean) }, null, 2) + '\n');

  // The cost and turns live in claude's own JSON document on stdout.
  let result: { total_cost_usd?: unknown; num_turns?: unknown } | null = null;
  try {
    result = exec?.stdout ? JSON.parse(exec.stdout) as { total_cost_usd?: unknown; num_turns?: unknown } : null;
  } catch { /* a killed run has no document */ }
  const finishedAt = new Date();
  if (!opts.keepScratch && status === 'ok') rmSync(scratchDir, { recursive: true, force: true });
  return {
    round: round.id,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallMs: finishedAt.getTime() - startedAt.getTime(),
    load: { before, peak, after, waitedMs },
    exitCode: exec?.exitCode ?? null,
    costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
    turns: typeof result?.num_turns === 'number' ? result.num_turns : null,
    escaped,
    checked: touched.length,
    agentHash: vault.agentHash,
    ...(note ? { note } : {}),
  };
}

/** Run every round of the set (or the named ones), sequentially. Stops at a tainted round. */
/**
 * Re-run the rounds of a finished run that did not end `ok` (a timeout on a loaded machine,
 * a failed spawn), in place: the run keeps its id, so it can still become the baseline or
 * the measured run for a sub-task. A tainted round is never retried: an escape voids the run.
 */
export async function retryRounds(contextRoot: string, runId: string, opts: RunOptions): Promise<RunMeta> {
  const set = readEvalSet(contextRoot);
  if (!set) throw new Error('No test set yet.');
  const meta = readRunMeta(contextRoot, runId);
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  if (!meta.finishedAt) throw new Error(`Run ${runId} has not finished; retry it once it has.`);
  if (meta.setCreatedAt !== set.createdAt) throw new Error(`Run ${runId} was made on an older test set; start a new run.`);
  if (meta.rounds.some((r) => r.status === 'tainted')) throw new Error(`Run ${runId} wrote into a real brain; it cannot be repaired, start a new run.`);
  const log = opts.log ?? (() => {});
  // Only the run's own rounds: a run made with --rounds never grows into the whole set.
  const todo = meta.rounds.filter((r) => r.status !== 'ok').map((r) => r.round);
  if (todo.length === 0) return meta;
  // A repaired run must still describe one agent and one CLI, or the gate compares a mix.
  const pinned = meta.agentHash ?? keptAgentHash(contextRoot, meta, todo);
  if (!pinned) throw new Error(`Run ${runId} did not record which agent it ran with; start a new run.`);
  const current = agentDefinitionHash(opts.brainProject, meta.agents);
  if (current !== pinned) throw new Error(`The agent or its skills changed since run ${runId} (${pinned} → ${current}); start a new run.`);
  if (meta.cliVersion !== opts.cliVersion || (meta.gitSha ?? null) !== (opts.gitSha ?? null)) {
    throw new Error(`The CLI changed since run ${runId} (${meta.cliVersion}@${meta.gitSha?.slice(0, 8) ?? '?'} → ${opts.cliVersion}@${opts.gitSha?.slice(0, 8) ?? '?'}); start a new run.`);
  }
  meta.agentHash = pinned;
  meta.finishedAt = null;
  meta.retriedAt = [...(meta.retriedAt ?? []), new Date().toISOString()];
  writeRunMeta(contextRoot, meta);
  for (const id of todo) {
    const round = readRound(contextRoot, id);
    if (!round) continue;
    log(`${id}: ${round.sessions.length} sessions (retry) …`);
    const r = await runRound(contextRoot, meta.id, round, { ...opts, agents: meta.agents });
    meta.rounds = [...meta.rounds.filter((x) => x.round !== id), r]
      .sort((a, b) => set.rounds.indexOf(a.round) - set.rounds.indexOf(b.round));
    writeRunMeta(contextRoot, meta);
    log(`${id}: ${r.status} in ${Math.round(r.wallMs / 1000)}s, load ${r.load.before.load1}→peak ${r.load.peak.load1}${r.costUsd !== null ? `, $${r.costUsd.toFixed(2)}` : ''}`);
    if (r.status === 'tainted') {
      log(`STOPPED: round ${id} wrote into the real brain (${r.escaped.join(', ')}).`);
      break;
    }
  }
  meta.finishedAt = new Date().toISOString();
  writeRunMeta(contextRoot, meta);
  return meta;
}

/**
 * A run made before rounds recorded their agent: read it from a non-ok round's kept scratch
 * vault (only an ok round's scratch is deleted). All kept copies must agree.
 */
function keptAgentHash(contextRoot: string, meta: RunMeta, rounds: string[]): string | null {
  const hashes = new Set(
    meta.rounds.map((r) => r.agentHash).filter((h): h is string => typeof h === 'string'),
  );
  for (const id of rounds) {
    const proj = join(runsRoot(contextRoot), meta.id, id, 'scratch', 'proj');
    if (meta.agents.every((a) => existsSync(join(proj, '.claude', 'agents', `${a}.md`)))) hashes.add(agentDefinitionHash(proj, meta.agents));
  }
  return hashes.size === 1 ? [...hashes][0] : null;
}

export async function runEval(contextRoot: string, opts: RunOptions): Promise<RunMeta> {
  if (opts.retry) return retryRounds(contextRoot, opts.retry, opts);
  const set = readEvalSet(contextRoot);
  if (!set) throw new Error('No test set yet: run `dreamcontext sleep eval build` first.');
  const log = opts.log ?? (() => {});
  const ids = opts.rounds && opts.rounds.length > 0 ? set.rounds.filter((r) => opts.rounds!.includes(r)) : set.rounds;
  const agents = opts.agents ?? ['sleep-tasks'];
  const firstAgent = join(opts.brainProject, '.claude', 'agents', `${agents[0]}.md`);
  const { model, effort } = agentFrontmatter(firstAgent);
  const meta: RunMeta = {
    id: newRunId(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    for: opts.for ?? null,
    label: opts.label ?? null,
    agents,
    model,
    effort,
    agentHash: null,
    cliVersion: opts.cliVersion,
    gitSha: opts.gitSha ?? null,
    setCreatedAt: set.createdAt,
    rounds: [],
  };
  while (existsSync(join(runsRoot(contextRoot), meta.id))) meta.id = `${meta.id}x`;
  writeRunMeta(contextRoot, meta);
  for (const id of ids) {
    const round = readRound(contextRoot, id);
    if (!round) continue;
    log(`${id}: ${round.sessions.length} sessions …`);
    const r = await runRound(contextRoot, meta.id, round, { ...opts, agents });
    meta.agentHash ??= r.agentHash ?? null;
    meta.rounds.push(r);
    writeRunMeta(contextRoot, meta);
    log(`${id}: ${r.status} in ${Math.round(r.wallMs / 1000)}s, load ${r.load.before.load1}→peak ${r.load.peak.load1}${r.costUsd !== null ? `, $${r.costUsd.toFixed(2)}` : ''}`);
    if (r.status === 'tainted') {
      log(`STOPPED: round ${id} wrote into the real brain (${r.escaped.join(', ')}).`);
      break;
    }
  }
  meta.finishedAt = new Date().toISOString();
  writeRunMeta(contextRoot, meta);
  return meta;
}
