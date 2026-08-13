import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureContextRoot } from './context-path.js';
import { readFrontmatter } from './frontmatter.js';
import { slugify } from './id.js';
import { readJsonArray, readJsonObject, writeJsonArray, writeJsonObject } from './json-file.js';

export const COUNCIL_STATUSES = [
  'created',
  'round_1_running',
  'round_1_complete',
  'round_2_running',
  'round_2_complete',
  'round_3_running',
  'round_3_complete',
  'synthesizing',
  'complete',
] as const;

export interface DebateIndexEntry {
  id: string;
  topic: string;
  status: string;
  rounds_planned: number;
  current_round: number;
  promoted_to_knowledge: string | null;
  created_at: string;
  updated_at: string;
}

export interface DebateFrontmatter {
  id: string;
  topic: string;
  status: string;
  rounds_planned: number;
  current_round: number;
  interrupt_between_rounds: boolean;
  personas: string[];
  options?: VerdictOption[];
  promoted_to_knowledge: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonaFrontmatter {
  name: string;
  model: string;
  aspects: string[];
  round_entries: number;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function getCouncilDir(): string {
  const root = ensureContextRoot();
  return join(root, 'council');
}

/**
 * Assert that `id` is a safe single path segment: no separators, no dots-only,
 * no null bytes. Throws with a clear message otherwise.
 */
function assertSafeSegment(kind: string, id: string): void {
  if (!id || typeof id !== 'string') {
    throw new Error(`Invalid ${kind}: (empty)`);
  }
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`Invalid ${kind}: "${id}" contains a path separator`);
  }
  if (id === '.' || id === '..') {
    throw new Error(`Invalid ${kind}: "${id}"`);
  }
}

/**
 * Belt-and-suspenders: ensure the resolved path is still under the council dir.
 */
function assertWithinCouncil(target: string): string {
  const council = resolve(getCouncilDir());
  const resolved = resolve(target);
  if (resolved !== council && !resolved.startsWith(council + sep)) {
    throw new Error(`Path escapes council directory: ${target}`);
  }
  return resolved;
}

export function getDebateDir(debateId: string): string {
  assertSafeSegment('debate_id', debateId);
  const target = join(getCouncilDir(), debateId);
  return assertWithinCouncil(target);
}

export function getPersonaDir(debateId: string, personaSlug: string): string {
  assertSafeSegment('persona_slug', personaSlug);
  const target = join(getDebateDir(debateId), personaSlug);
  return assertWithinCouncil(target);
}

export function getCouncilIndexPath(): string {
  return join(getCouncilDir(), 'index.json');
}

export function ensureCouncilDir(): string {
  const dir = getCouncilDir();
  mkdirSync(dir, { recursive: true });
  const indexPath = getCouncilIndexPath();
  if (!existsSync(indexPath)) {
    writeJsonArray(indexPath, []);
  }
  return dir;
}

export function ensureDebateExists(debateId: string): string {
  const dir = getDebateDir(debateId);
  if (!existsSync(dir)) {
    throw new Error(`Debate not found: ${debateId}`);
  }
  return dir;
}

export function ensurePersonaExists(debateId: string, personaSlug: string): string {
  ensureDebateExists(debateId);
  const dir = getPersonaDir(debateId, personaSlug);
  if (!existsSync(dir)) {
    throw new Error(`Persona not found in ${debateId}: ${personaSlug}`);
  }
  return dir;
}

export function readDebateFrontmatter(debateId: string): DebateFrontmatter {
  ensureDebateExists(debateId);
  const { data } = readFrontmatter<DebateFrontmatter>(join(getDebateDir(debateId), 'debate.md'));
  return data;
}

export function loadCouncilIndex(): DebateIndexEntry[] {
  const indexPath = getCouncilIndexPath();
  if (!existsSync(indexPath)) return [];
  return readJsonArray<DebateIndexEntry>(indexPath);
}

export function saveCouncilIndex(entries: DebateIndexEntry[]): void {
  writeJsonArray(getCouncilIndexPath(), entries);
}

export function upsertCouncilIndex(entry: DebateIndexEntry): void {
  const entries = loadCouncilIndex();
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx === -1) {
    entries.unshift(entry);
  } else {
    entries[idx] = { ...entries[idx], ...entry };
  }
  saveCouncilIndex(entries);
}

// ─── Templates ──────────────────────────────────────────────────────────────

export function loadTemplate(filename: string): string {
  const candidates = [
    join(__dirname, 'templates', filename),           // bundled: dist/templates/
    join(__dirname, '..', 'templates', filename),     // alt layout
    join(__dirname, '..', 'src', 'templates', filename), // dev fallback
    join(__dirname, '..', '..', 'src', 'templates', filename),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  }
  throw new Error(`Template not found: ${filename}`);
}

// ─── Report parsing & validation ────────────────────────────────────────────

export const REQUIRED_REPORT_SUBSECTIONS = [
  'Executive Summary',
  'Position',
  'Reasoning',
  'Reactions to peers',
  'Open questions',
] as const;

export interface ValidationResult {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Validate that a round entry contains all required ### subsections.
 * Also warns on executive summaries >150 words (soft-warn, does not fail).
 */
export function validateRoundEntry(body: string): ValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  const headings = Array.from(body.matchAll(/^###\s+(.+)$/gm)).map((m) =>
    normalize(m[1]),
  );

  for (const required of REQUIRED_REPORT_SUBSECTIONS) {
    if (!headings.includes(normalize(required))) {
      missing.push(required);
    }
  }

  const execMatch = body.match(
    // `$(?![\s\S])` is end-of-input; JS has no `\Z` (it would read as a literal "Z").
    /^###\s+Executive Summary\s*\n([\s\S]*?)(?=^###\s+|$(?![\s\S]))/m,
  );
  if (execMatch) {
    const words = execMatch[1].trim().split(/\s+/).filter(Boolean).length;
    if (words > 150) {
      warnings.push(`Executive Summary is ${words} words (>150). Consider tightening.`);
    }
  }

  return { ok: missing.length === 0, missing, warnings };
}

/**
 * Extract the Executive Summary text from a single round entry body.
 * Returns null if not found.
 */
export function extractExecutiveSummary(roundBody: string): string | null {
  const match = roundBody.match(
    // `$(?![\s\S])` is end-of-input; JS has no `\Z` (it would read as a literal "Z").
    /^###\s+Executive Summary\s*\n([\s\S]*?)(?=^###\s+|$(?![\s\S]))/m,
  );
  return match ? match[1].trim() : null;
}

/**
 * Parse a persona's report.md into a list of round entries (newest-first, LIFO).
 * Each entry is delimited by a `## Round N — ...` heading.
 */
export interface RoundEntry {
  round: number;
  heading: string;
  body: string;
}

export function parseReportRounds(reportContent: string): RoundEntry[] {
  const lines = reportContent.split('\n');
  const entries: RoundEntry[] = [];
  let current: { round: number; heading: string; start: number } | null = null;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track triple-backtick fences (opening or closing). A line that is
    // *exactly* a fence toggles state; indented fences also count.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = line.match(/^##\s+Round\s+(\d+)\b/i);
    if (match) {
      if (current) {
        entries.push({
          round: current.round,
          heading: current.heading,
          body: lines.slice(current.start + 1, i).join('\n').trim(),
        });
      }
      current = {
        round: Number(match[1]),
        heading: line,
        start: i,
      };
    }
  }

  if (current) {
    entries.push({
      round: current.round,
      heading: current.heading,
      body: lines.slice(current.start + 1).join('\n').trim(),
    });
  }

  return entries;
}

/**
 * Get the executive summary for a given persona + round, if present.
 */
export function getPersonaRoundSummary(
  debateId: string,
  personaSlug: string,
  round: number,
): string | null {
  const reportPath = join(getPersonaDir(debateId, personaSlug), 'report.md');
  if (!existsSync(reportPath)) return null;
  const { content } = readFrontmatter(reportPath);
  const entries = parseReportRounds(content);
  const entry = entries.find((e) => e.round === round);
  if (!entry) return null;
  return extractExecutiveSummary(entry.body);
}

// ─── Verdicts (v2) ──────────────────────────────────────────────────────────

export interface VerdictOption {
  key: string;
  label: string;
}

export interface Verdict {
  stance: string;
  conviction: number;
  headline: string;
  concession?: string;
  at: string;
}

export type RoundVerdicts = Record<string, Verdict>;

export interface VerdictsFile {
  options: VerdictOption[];
  rounds: Record<string, RoundVerdicts>;
}

export function getVerdictsPath(debateId: string): string {
  return join(getDebateDir(debateId), 'verdicts.json');
}

/**
 * Read verdicts.json for a debate. Debates without one (v1 debates) get an
 * empty structure — no command may crash on a missing verdicts file.
 */
export function readVerdicts(debateId: string): VerdictsFile {
  const path = getVerdictsPath(debateId);
  if (!existsSync(path)) return { options: [], rounds: {} };
  const parsed = readJsonObject<Partial<VerdictsFile>>(path);
  return {
    options: Array.isArray(parsed.options) ? parsed.options : [],
    rounds:
      parsed.rounds && typeof parsed.rounds === 'object' && !Array.isArray(parsed.rounds)
        ? parsed.rounds
        : {},
  };
}

export function writeVerdicts(debateId: string, verdicts: VerdictsFile): void {
  writeJsonObject(getVerdictsPath(debateId), verdicts);
}

// ─── Verdicts lock ──────────────────────────────────────────────────────────
// Personas run in parallel and each shells out to `council verdict`, so the
// read-modify-write on verdicts.json must be serialized — otherwise a
// concurrent writer silently drops a sibling's verdict. Same PID-lockfile
// shape as src/lib/marketing/store.ts acquireLock, plus a bounded spin and a
// TTL reclaim for crashed holders.

const VERDICTS_LOCK_SPIN_MS = 25;
const VERDICTS_LOCK_TIMEOUT_MS = 2000;
const VERDICTS_LOCK_STALE_MS = 10_000;

export class VerdictsLockError extends Error {
  constructor(debateId: string) {
    super(
      `Could not lock verdicts.json for ${debateId} — another verdict write is in progress. Retry the same \`council verdict\` command; the verdict was NOT recorded.`,
    );
    this.name = 'VerdictsLockError';
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we lack permission — treat as alive
    return code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getVerdictsLockPath(debateId: string): string {
  return getVerdictsPath(debateId) + '.lock';
}

export interface VerdictsLockOptions {
  /** Max total wait before failing loudly (default 2000ms). */
  timeoutMs?: number;
  /** Retry interval while the lock is held (default 25ms). */
  spinMs?: number;
  /** Locks older than this are reclaimed even if the PID looks alive (default 10s). */
  staleMs?: number;
}

/**
 * Acquire the per-debate verdicts lock; returns a release fn.
 * Spins (bounded) while a live holder has it; reclaims locks whose holder PID
 * is dead or whose file is older than `staleMs`. Throws VerdictsLockError on
 * timeout — a dropped verdict must never be silent.
 */
export async function acquireVerdictsLock(
  debateId: string,
  opts: VerdictsLockOptions = {},
): Promise<() => void> {
  const timeoutMs = opts.timeoutMs ?? VERDICTS_LOCK_TIMEOUT_MS;
  const spinMs = opts.spinMs ?? VERDICTS_LOCK_SPIN_MS;
  const staleMs = opts.staleMs ?? VERDICTS_LOCK_STALE_MS;
  const lockPath = getVerdictsLockPath(debateId);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // Reclaim stale locks: dead holder PID, or a holder that has sat on the
    // lock past the TTL (crashed mid-write with a recycled PID, wedged, …).
    try {
      if (existsSync(lockPath)) {
        const heldPid = Number.parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (!pidAlive(heldPid) || ageMs > staleMs) {
          rmSync(lockPath, { force: true });
        }
      }
    } catch {
      // Racing another reclaimer is fine — the O_EXCL create below decides.
    }

    try {
      const fd = openSync(lockPath, 'wx'); // O_EXCL — loser of the race gets EEXIST
      try {
        writeFileSync(fd, String(process.pid), 'utf-8');
      } finally {
        closeSync(fd);
      }
      return function release(): void {
        try {
          if (Number.parseInt(readFileSync(lockPath, 'utf-8').trim(), 10) === process.pid) {
            rmSync(lockPath, { force: true });
          }
        } catch {
          // best-effort — TTL reclaim covers a failed release
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    if (Date.now() >= deadline) {
      throw new VerdictsLockError(debateId);
    }
    await sleep(spinMs);
  }
}

/**
 * Run `fn` (the WHOLE read→mutate→write of verdicts.json) under the lock.
 * The lock is always released, success or error.
 */
export async function withVerdictsLock<T>(
  debateId: string,
  fn: () => T | Promise<T>,
  opts: VerdictsLockOptions = {},
): Promise<T> {
  const release = await acquireVerdictsLock(debateId, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Parse an `--options "A=Keep sync,B=Drop it"` spec into VerdictOption[].
 * Requires at least two options; keys must be unique (case-insensitive).
 */
export function parseOptionsSpec(spec: string): VerdictOption[] {
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new Error('--options needs at least two comma-separated entries, e.g. "A=Keep sync,B=Drop it".');
  }
  const options: VerdictOption[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    const key = eq > 0 ? part.slice(0, eq).trim() : '';
    const label = eq > 0 ? part.slice(eq + 1).trim() : '';
    if (!key || !label) {
      throw new Error(`Invalid option "${part}". Use KEY=Label, e.g. "A=Keep sync".`);
    }
    const lower = key.toLowerCase();
    if (seen.has(lower)) {
      throw new Error(`Duplicate option key: ${key}`);
    }
    seen.add(lower);
    options.push({ key, label });
  }
  return options;
}

/**
 * Resolve a submitted stance against the option set.
 * - registered options → the stance must match an existing key (case-insensitive).
 * - free-form (no registered options) → first-seen stance strings become dynamic
 *   options (key = slugified stance, label = original string).
 * Returns the canonical key plus the dynamic option to add, if any.
 */
export function resolveStanceKey(
  verdicts: VerdictsFile,
  registered: boolean,
  stanceInput: string,
): { key: string; addedOption: VerdictOption | null } {
  const input = stanceInput.trim();
  if (!input) {
    throw new Error('--stance is required.');
  }
  if (registered) {
    const match = verdicts.options.find((o) => o.key.toLowerCase() === input.toLowerCase());
    if (!match) {
      const listing = verdicts.options.map((o) => `${o.key} (${o.label})`).join(', ');
      throw new Error(`Unknown stance "${input}". Registered options: ${listing}`);
    }
    return { key: match.key, addedOption: null };
  }
  const key = slugify(input).slice(0, 24);
  if (!key) {
    throw new Error(`Invalid stance "${input}".`);
  }
  const existing = verdicts.options.find((o) => o.key === key);
  if (existing) return { key: existing.key, addedOption: null };
  return { key, addedOption: { key, label: input } };
}

// ─── Derived metrics ────────────────────────────────────────────────────────

/**
 * Stance with the max summed conviction. Ties break alphabetically (stable).
 * Null when the round has no verdicts.
 */
export function leadingStance(roundVerdicts: RoundVerdicts | null | undefined): string | null {
  if (!roundVerdicts) return null;
  const sums = new Map<string, number>();
  for (const v of Object.values(roundVerdicts)) {
    sums.set(v.stance, (sums.get(v.stance) ?? 0) + v.conviction);
  }
  let best: string | null = null;
  let bestSum = -1;
  for (const [stance, sum] of [...sums.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (sum > bestSum) {
      best = stance;
      bestSum = sum;
    }
  }
  return best;
}

/**
 * round(100 * sum(conviction on leading stance) / sum(all convictions)).
 * 0 when the round is empty or all convictions are 0.
 */
export function convergence(roundVerdicts: RoundVerdicts | null | undefined): number {
  if (!roundVerdicts) return 0;
  const verdicts = Object.values(roundVerdicts);
  const total = verdicts.reduce((s, v) => s + v.conviction, 0);
  if (verdicts.length === 0 || total === 0) return 0;
  const leading = leadingStance(roundVerdicts);
  const lead = verdicts
    .filter((v) => v.stance === leading)
    .reduce((s, v) => s + v.conviction, 0);
  return Math.round((100 * lead) / total);
}

export interface StanceShift {
  from: string;
  to: string;
  convictionDelta: number;
}

/**
 * Per persona in `cur`: { from, to, convictionDelta } vs the previous round,
 * or null when the persona has no prior-round verdict.
 */
export function stanceShift(
  prev: RoundVerdicts | null | undefined,
  cur: RoundVerdicts,
): Record<string, StanceShift | null> {
  const out: Record<string, StanceShift | null> = {};
  for (const [slug, v] of Object.entries(cur)) {
    const p = prev?.[slug];
    out[slug] = p
      ? { from: p.stance, to: v.stance, convictionDelta: v.conviction - p.conviction }
      : null;
  }
  return out;
}

// ─── Live chamber state (.council-live.json) ────────────────────────────────

export type CouncilLivePhase = 'setup' | 'debate' | 'interlude' | 'synthesis' | 'done';
export type CouncilPersonaLiveState = 'wait' | 'think' | 'done';

export const COUNCIL_LIVE_PHASES: CouncilLivePhase[] = [
  'setup',
  'debate',
  'interlude',
  'synthesis',
  'done',
];

export interface CouncilLivePersona {
  slug: string;
  model?: string;
  state: CouncilPersonaLiveState;
  stance?: string;
  conviction?: number;
  /** Current-round verdict headline, truncated to ~80 chars. Absent without a verdict. */
  headline?: string;
  prevStance?: string;
  prevConviction?: number;
}

export interface CouncilLiveState {
  debate: string;
  topic: string;
  session: string;
  started: string;
  updated: string;
  phase: CouncilLivePhase;
  round: number;
  rounds: number;
  options: VerdictOption[];
  personas: CouncilLivePersona[];
  convergence?: number;
  leading?: string;
}

export function getCouncilLivePath(): string {
  return join(ensureContextRoot(), 'tmp', '.council-live.json');
}

export function readCouncilLive(): CouncilLiveState | null {
  try {
    const path = getCouncilLivePath();
    if (!existsSync(path)) return null;
    return readJsonObject<CouncilLiveState>(path);
  } catch {
    return null;
  }
}

/**
 * Delete the live file. Failures are swallowed — the live file is telemetry,
 * never a gate.
 */
export function clearCouncilLive(): void {
  try {
    rmSync(getCouncilLivePath(), { force: true });
  } catch {
    // telemetry, never a gate
  }
}

/**
 * Write a live state as-is (demo / tests). Failures are swallowed.
 */
export function writeCouncilLiveRaw(state: CouncilLiveState): void {
  try {
    const path = getCouncilLivePath();
    mkdirSync(dirname(path), { recursive: true });
    writeJsonObject(path, state);
  } catch {
    // telemetry, never a gate
  }
}

export interface CouncilLiveUpdate {
  phase?: CouncilLivePhase;
  /** Set every roster persona to this state (e.g. round start → think). */
  setAll?: CouncilPersonaLiveState;
  /** Per-persona overrides (applied on top of setAll / prior states). */
  setPersona?: Record<string, CouncilPersonaLiveState>;
}

/**
 * Refresh _dream_context/tmp/.council-live.json from the debate on disk.
 * Stance/conviction come from the debate's current round in verdicts.json,
 * prev* from the round before. Session stamp from CLAUDE_CODE_SESSION_ID on the
 * debate's FIRST write only; subsequent writes for the same debate preserve it
 * (persona sessions write too, under their own session ids).
 * ALL failures are swallowed — the live file must never gate a command.
 */
export function updateCouncilLive(debateId: string, update: CouncilLiveUpdate = {}): void {
  try {
    const data = readDebateFrontmatter(debateId);
    const verdicts = readVerdicts(debateId);
    const now = new Date().toISOString();
    const prev = readCouncilLive();
    const sameDebate = prev !== null && prev.debate === debateId;
    const round = data.current_round ?? 0;
    const cur = verdicts.rounds[String(round)] ?? {};
    const prior = verdicts.rounds[String(round - 1)] ?? {};

    const prevStates = new Map<string, CouncilPersonaLiveState>();
    if (sameDebate) {
      for (const p of prev.personas ?? []) prevStates.set(p.slug, p.state);
    }

    const personas: CouncilLivePersona[] = (data.personas ?? []).map((slug) => {
      const state: CouncilPersonaLiveState =
        update.setPersona?.[slug] ?? update.setAll ?? prevStates.get(slug) ?? 'wait';
      const entry: CouncilLivePersona = { slug, state };
      try {
        const personaFile = join(getPersonaDir(debateId, slug), 'context-and-persona.md');
        if (existsSync(personaFile)) {
          const { data: pd } = readFrontmatter<PersonaFrontmatter>(personaFile);
          if (pd.model) entry.model = pd.model;
        }
      } catch {
        // model is cosmetic
      }
      const v = cur[slug];
      if (v) {
        entry.stance = v.stance;
        entry.conviction = v.conviction;
        if (v.headline) {
          entry.headline =
            v.headline.length > 80 ? v.headline.slice(0, 79) + '…' : v.headline;
        }
      }
      const pv = prior[slug];
      if (pv) {
        entry.prevStance = pv.stance;
        entry.prevConviction = pv.conviction;
      }
      return entry;
    });

    const state: CouncilLiveState = {
      debate: debateId,
      topic: data.topic,
      // The stamp is the ORCHESTRATOR's conversation id and must survive every
      // later write: persona sessions run `verdict submit` with their OWN
      // CLAUDE_CODE_SESSION_ID, and re-stamping here would scope the chamber
      // panel out of the orchestrator's pane mid-round.
      session: sameDebate ? (prev.session ?? '') : (process.env.CLAUDE_CODE_SESSION_ID ?? ''),
      started: sameDebate && prev.started ? prev.started : now,
      updated: now,
      phase: update.phase ?? (sameDebate ? prev.phase : 'setup'),
      round,
      rounds: data.rounds_planned,
      options: verdicts.options,
      personas,
    };
    if (Object.keys(cur).length > 0) {
      state.convergence = convergence(cur);
      const lead = leadingStance(cur);
      if (lead !== null) state.leading = lead;
    }

    const livePath = getCouncilLivePath();
    mkdirSync(dirname(livePath), { recursive: true });
    writeJsonObject(livePath, state);
  } catch {
    // Live-file writes are telemetry — never a gate.
  }
}

// ─── Stdin ──────────────────────────────────────────────────────────────────

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
