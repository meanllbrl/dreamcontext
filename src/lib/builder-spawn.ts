import { assertNotAppChat } from './apps/chat-store.js';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { BUILDER_NO_BACKGROUND_ENV, TASK_ID_RE, classifyBuilderResult, lastResultObject } from './builder-tools.js';

/**
 * The builder base, its forks and fresh builders: how `dreamcontext builder base|spawn|fork|
 * resume|wait|status` start `claude -p` sessions and keep track of them.
 *
 * Measured 2026-10-11 (task every-piece-of-work-gets-the-lightest-process-…, probe0/):
 * - A fork reads its parent from the prompt cache only when model, effort, system prompt and
 *   tool list are identical to the parent's. 54 of 55 historical misses were an Opus parent
 *   forked as Sonnet. So every session here is started from ONE argv shape, and a fork or a
 *   resume always reuses the identity (model id + effort) recorded when its session began.
 * - A fork is not faster than a fresh builder (a lane is output-bound) and costs about the
 *   same; it pays off only when several lanes share one SMALL base. Hence the 150k cap.
 * - Effort is the wall-time lever: the same lane took 8 min at medium, 10 at high, 19 at xhigh,
 *   and a blind grade ranked medium best (8.5 vs 7.5 xhigh). Builders inherit the owner's
 *   settings effort unless one is passed, so one always is.
 */

/** Environment names a builder must not inherit from the lead's pane. */
export const BUILDER_ENV_UNSET = [
  'DREAMCONTEXT_TAB_SESSION', 'DREAMCONTEXT_SERVER_PID', 'CLAUDE_CODE_SESSION_ID',
  'DREAMCONTEXT_DEFERRED_PROMPT', 'DREAMCONTEXT_CHAT_TAB', 'CLAUDE_EFFORT',
  // The chat's AI Team route (agent-chat.ts): a builder or run a chat starts is no chat.
  'DREAMCONTEXT_TEAM_ROUTE',
] as const;

export const BUILDER_ALLOWED_TOOLS = 'Read Glob Grep Write Edit MultiEdit Bash';
export const BUILDER_PERMISSION_MODE = 'acceptEdits';
/** Resolved to a concrete model id on the first call; forks and resumes reuse that id. */
export const BUILDER_DEFAULT_MODEL = 'opus';
export const BUILDER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type BuilderEffort = typeof BUILDER_EFFORTS[number];
export const BUILDER_DEFAULT_EFFORT: BuilderEffort = 'medium';
/** Past this many context tokens a base makes every fork re-read too much on every turn. */
export const BASE_TOKEN_CAP = 150_000;
/** One `builder wait` call never blocks longer than this (the Bash tool's ceiling is 600 s). */
export const WAIT_SLICE_MAX_S = 540;
/** A live builder whose transcript has not grown for this long is stalled. */
export const STALL_MS = 20 * 60 * 1000;
/** The registry id of the builder base. */
export const BASE_ID = 'base';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,239}$/;

export interface SpawnIdentity { model: string; effort: string }

export type SessionMode =
  | { kind: 'new'; sessionId: string }
  | { kind: 'fork'; from: string; sessionId: string }
  | { kind: 'resume'; sessionId: string };

/**
 * The ONE argv every builder session starts with. Only the session flags differ between a
 * new session, a fork and a resume; nothing here may ever add a tool-list flag (`--tools`,
 * `--disallowedTools`), since a changed tool list is a changed prompt prefix and a cache miss.
 * The session id comes first so a process listing always shows it, the prompt last.
 */
export function builderArgv(prompt: string, mode: SessionMode, id: SpawnIdentity): string[] {
  if (mode.kind !== 'new') assertNotAppChat(mode.kind === 'fork' ? mode.from : mode.sessionId);
  const session = mode.kind === 'new'
    ? ['--session-id', mode.sessionId]
    : mode.kind === 'fork'
      ? ['--resume', mode.from, '--fork-session', '--session-id', mode.sessionId]
      : ['--resume', mode.sessionId];
  return [
    ...session,
    '--model', id.model,
    '--effort', id.effort,
    '--permission-mode', BUILDER_PERMISSION_MODE,
    '--allowedTools', BUILDER_ALLOWED_TOOLS,
    '--output-format', 'json',
    '-p', prompt,
  ];
}

/**
 * The lead's environment minus what would tie the builder to the lead's pane, plus the two
 * variables every builder needs. `cfg` is the RAW CLAUDE_CONFIG_DIR recorded for the session:
 * `-` means unset (the machine's own account) and is never replaced by $HOME/.claude, which
 * would relocate ~/.claude.json and lose the login.
 */
export function builderEnv(parent: NodeJS.ProcessEnv, cfg: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const name of BUILDER_ENV_UNSET) delete env[name];
  if (cfg === '-') delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = cfg;
  env.DREAMCONTEXT_SPAWNED = 'develop';
  const [name, value] = BUILDER_NO_BACKGROUND_ENV.split('=');
  env[name] = value;
  return env;
}

export function rawConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : '-';
}

/** The first line of every builder prompt: who it is, so a fork never thinks it is the lead. */
export function builderFraming(lane: string, slug: string, kind: 'fork' | 'fresh'): string {
  return kind === 'fork'
    ? `You are builder ${lane} of task ${slug}, a fork of its builder base. You are not the lead and no longer the base: from this message on you build only the lane below.`
    : `You are builder ${lane} of task ${slug}.`;
}

export const BASE_FRAMING = (slug: string) =>
  `You are the builder base for task ${slug}. You never build and never edit a file: each fork of you later builds exactly one lane. Your job is the shared exploration, done once for every lane.`;

// ─── registry ────────────────────────────────────────────────────────────────

export type BaseState = 'minting' | 'ready' | 'updating' | 'failed';

export interface SessionRecord {
  sid: string;
  pid: number;
  cfg: string;
  model: string;
  effort: string;
  /** 1 for the first run, +1 per resume. */
  round: number;
  /** The log's size when this round started: only what follows is this round's output. */
  logOffset: number;
  startedAt: string;
  /** The last verdict `wait` handed to the lead, per round, so it is reported once. */
  seen?: { round: number; state: LaneState; detail: string };
}

export interface BaseRecord extends SessionRecord {
  state: BaseState;
  absorbedWave: number;
  /** The wave an in-flight update closes; becomes absorbedWave when it lands. */
  absorbing?: number;
  tokens: number | null;
}

export interface LaneRecord extends SessionRecord {
  lane: string;
  kind: 'fork' | 'fresh';
  /** The base session a fork came from. */
  parent: string | null;
  owns: string[];
}

export interface BuilderRegistry {
  version: 1;
  slug: string;
  base: BaseRecord | null;
  lanes: Record<string, LaneRecord>;
}

export class BuilderInputError extends Error {}

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug) || slug.includes('..')) throw new BuilderInputError(`"${slug}" is not a task slug`);
}

export function assertLane(lane: string): void {
  if (!TASK_ID_RE.test(lane) || lane === BASE_ID) throw new BuilderInputError(`"${lane}" is not a lane id (letters, digits, ".", "_" or "-"; e.g. w1-A)`);
}

export function assertSessionId(sid: string): void {
  if (!UUID_RE.test(sid)) throw new BuilderInputError(`"${sid}" is not a session id`);
}

export function developDir(root: string, slug: string): string {
  assertSlug(slug);
  return join(root, 'tmp', 'develop', slug);
}

export const registryPath = (root: string, slug: string) => join(developDir(root, slug), 'builders.json');
export const logPath = (root: string, slug: string, id: string) => join(developDir(root, slug), `${id}.log`);

export function emptyRegistry(slug: string): BuilderRegistry {
  return { version: 1, slug, base: null, lanes: {} };
}

export function readRegistry(path: string, slug: string): BuilderRegistry {
  if (!existsSync(path)) return emptyRegistry(slug);
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BuilderRegistry>;
  if (parsed.version !== 1 || parsed.slug !== slug || typeof parsed.lanes !== 'object' || parsed.lanes === null) {
    throw new BuilderInputError(`${path} is not this task's builder registry`);
  }
  return { version: 1, slug, base: parsed.base ?? null, lanes: parsed.lanes };
}

export function writeRegistryAtomic(path: string, reg: BuilderRegistry): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 1) + '\n');
  renameSync(tmp, path);
}

/** The wave a lane id names (`w2-A` -> 2), or null. */
export function waveOf(lane: string): number | null {
  const m = /^w(\d+)-/i.exec(lane);
  return m ? Number(m[1]) : null;
}

/** Owned paths, repo-relative and normalized; a path outside the repo is refused. */
export function normalizeOwns(root: string, owns: string[]): string[] {
  const out = new Set<string>();
  for (const raw of owns.flatMap((o) => o.split(',')).map((o) => o.trim()).filter(Boolean)) {
    const abs = isAbsolute(raw) ? normalize(raw) : resolve(root, raw);
    const rel = relative(root, abs).split('\\').join('/').replace(/\/+$/, '');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new BuilderInputError(`"${raw}" is outside the repo`);
    out.add(rel);
  }
  return [...out].sort();
}

/** Owned paths two lanes share: equal paths, or one a directory of the other. */
export function ownsOverlap(a: string[], b: string[]): string[] {
  const hits: string[] = [];
  for (const x of a) for (const y of b) {
    if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) hits.push(x === y ? x : `${x} ~ ${y}`);
  }
  return hits;
}

// ─── liveness, logs, transcripts ─────────────────────────────────────────────

/** Alive = the pid is running AND its command line carries the session id (a reused pid is not). */
export function sessionAlive(pid: number, sid: string, psText: string): boolean {
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+\d+\s+\S+\s+(.+)$/.exec(line);
    if (m && Number(m[1]) === pid) return m[2].includes(sid);
  }
  return false;
}

export function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/** What a log holds past `offset` (this round's output), or null when nothing is there yet. */
export function readLogSince(path: string, offset: number): string | null {
  const size = fileSize(path);
  if (size <= offset) return null;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** The session's transcript under its RECORDED config dir (never the caller's current one). */
export function findTranscript(sid: string, cfg: string, home: string = homedir()): string | null {
  if (!UUID_RE.test(sid)) return null;
  const projects = join(cfg === '-' ? join(home, '.claude') : cfg, 'projects');
  let best: { path: string; mtime: number } | null = null;
  let dirs: string[] = [];
  try { dirs = readdirSync(projects); } catch { return null; }
  for (const d of dirs) {
    const p = join(projects, d, `${sid}.jsonl`);
    try {
      const st = statSync(p);
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    } catch { /* not in this project dir */ }
  }
  return best?.path ?? null;
}

export interface CallUsage { read: number; write: number; input: number; output: number }

/** Every API call of a transcript made at or after `sinceMs` (a fork's copied history is older). */
export function callsSince(transcript: string, sinceMs: number): CallUsage[] {
  const seen = new Set<string>();
  const calls: CallUsage[] = [];
  for (const line of transcript.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let d: { type?: string; timestamp?: string; message?: { id?: string; usage?: Record<string, number> } };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant' || !d.timestamp || !d.message?.usage) continue;
    if (Date.parse(d.timestamp) < sinceMs - 1000) continue;
    const id = d.message.id ?? `${calls.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = d.message.usage;
    calls.push({ read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0, input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 });
  }
  return calls;
}

/** The context a session's last call carried: what its next fork or resume starts from. */
export function contextTokens(calls: CallUsage[]): number | null {
  const last = calls[calls.length - 1];
  return last ? last.read + last.write + last.input : null;
}

/** The first call's cache read share: >= 0.9 means the fork really inherited from cache. */
export function firstCallHit(calls: CallUsage[]): { read: number; write: number; share: number } | null {
  const first = calls[0];
  if (!first) return null;
  return { read: first.read, write: first.write, share: first.read / Math.max(1, first.read + first.write) };
}

/** The concrete model id a finished run used (`opus` resolves to e.g. claude-opus-5-5). */
export function resolvedModel(logText: string | null, fallback: string): string {
  const run = logText ? lastResultObject(logText) : null;
  const usage = run && typeof run.modelUsage === 'object' && run.modelUsage ? Object.keys(run.modelUsage as object) : [];
  return usage.find((m) => m.includes(fallback)) ?? usage[0] ?? fallback;
}

// ─── lane state ──────────────────────────────────────────────────────────────

export type LaneState = 'running' | 'stalled' | 'reported' | 'unfinished' | 'stopped' | 'paused' | 'crashed';

export interface LaneStatus { id: string; state: LaneState; detail: string }

const LIMIT = /usage limit|rate limit|limit reached|out of (?:extra )?usage|try again (?:at|in)\b/i;

export const NEEDS_ATTENTION: readonly LaneState[] = ['stalled', 'unfinished', 'stopped', 'paused', 'crashed'];

/**
 * Where one session stands. `logText` is this round's output only (see `readLogSince`); a
 * base reports with any successful result, a lane only with its `## <lane> report` heading.
 */
export function sessionStatus(
  id: string,
  rec: SessionRecord,
  world: { alive: boolean; logText: string | null; transcriptMtimeMs: number | null; nowMs: number },
): LaneStatus {
  if (world.alive) {
    const since = world.transcriptMtimeMs ?? Date.parse(rec.startedAt);
    const quietMs = world.nowMs - since;
    const ran = Math.round((world.nowMs - Date.parse(rec.startedAt)) / 60000);
    if (quietMs > STALL_MS) return { id, state: 'stalled', detail: `alive ${ran} min, no transcript growth for ${Math.round(quietMs / 60000)} min` };
    return { id, state: 'running', detail: `${ran} min, last activity ${Math.round(quietMs / 1000)} s ago` };
  }
  if (id === BASE_ID) {
    const run = world.logText ? lastResultObject(world.logText) : null;
    if (!run) return { id, state: 'crashed', detail: 'exited without a result' };
    if (run.is_error === true || run.subtype !== 'success') {
      const detail = `${String(run.subtype)}: ${String(run.result ?? '').slice(0, 160)}`;
      return { id, state: LIMIT.test(detail) ? 'paused' : 'stopped', detail };
    }
    return { id, state: 'reported', detail: String(run.result ?? '').split('\n')[0].slice(0, 160) };
  }
  const r = classifyBuilderResult(world.logText, id);
  if (r.verdict === 'missing') return { id, state: 'crashed', detail: 'exited without a result (crashed or killed)' };
  if (r.verdict === 'stopped') return { id, state: LIMIT.test(r.detail) ? 'paused' : 'stopped', detail: r.detail };
  return { id, state: r.verdict, detail: r.detail };
}
