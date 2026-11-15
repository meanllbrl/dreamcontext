import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import toolParity from '../../docs/tool-parity.json' with { type: 'json' };

/**
 * Which agents this Mac works with (plan npmsiz-beta C16) and what an unpicked agent cannot do
 * (C17).
 *
 * The pick record `~/.dreamcontext/agents.json` `{picked: [...]}` has ONE writer,
 * {@link setPickedAgents}. Unpicking never uninstalls an agent or signs it out. No record means
 * an existing user: {@link ensurePickedAgents} derives it once from what is signed in today, so
 * nobody who already works is sent back through setup. Nothing here ever chooses or widens a
 * job's tool: the pick can only add a refusal (D24).
 *
 * `TOOL_GAPS` is COMPUTED from `docs/tool-parity.json` (bundled at build) by {@link computeGaps};
 * there is no hand-written list, so a new gap row in the file appears with no code change.
 * `docs/tool-parity.json` only drives explanation text; `headless-envelope.ts` and
 * `agent-chat.ts` stay the enforcement.
 */

export type AgentId = 'claude' | 'codex' | 'antigravity';
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'antigravity'];
export const AGENT_NAMES: Readonly<Record<AgentId, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export function isAgentId(v: unknown): v is AgentId {
  return v === 'claude' || v === 'codex' || v === 'antigravity';
}

// ─── The pick record ────────────────────────────────────────────────────────────

export function agentsPickPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'agents.json');
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(p); } catch { return null; }
}

/** A valid pick: a non-empty list of known agents, no repeats, kept in {@link AGENT_IDS} order. */
function normalisePick(v: unknown): AgentId[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every(isAgentId)) return null;
  if (new Set(v).size !== v.length) return null;
  return AGENT_IDS.filter((a) => v.includes(a));
}

/**
 * The picked agents, or null when there is no valid record: no file, an unreadable or malformed
 * one, any key but `picked`, an empty or unknown list, a symlinked file or `~/.dreamcontext`.
 * Null is "not decided yet", never "nothing picked": callers go through {@link ensurePickedAgents}.
 */
export function pickedAgents(home: string = homedir()): AgentId[] | null {
  const dir = lstatOrNull(join(home, '.dreamcontext'));
  if (!dir || dir.isSymbolicLink() || !dir.isDirectory()) return null;
  const st = lstatOrNull(agentsPickPath(home));
  if (!st || !st.isFile()) return null;
  try {
    const raw = JSON.parse(readFileSync(agentsPickPath(home), 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const keys = Object.keys(raw);
    if (keys.length !== 1 || keys[0] !== 'picked') return null;
    return normalisePick((raw as { picked: unknown }).picked);
  } catch {
    return null;
  }
}

/**
 * Write the pick: temp file + rename, refusing a symlinked folder, a non-file at the record's
 * path, an empty list, an unknown agent or a repeat. Returns the pick now in effect.
 */
export function setPickedAgents(picked: readonly unknown[], home: string = homedir()): AgentId[] {
  const clean = normalisePick(picked);
  if (!clean) throw new Error('Pick at least one agent: claude, codex or antigravity.');
  const dirPath = join(home, '.dreamcontext');
  const dir = lstatOrNull(dirPath);
  if (dir && (dir.isSymbolicLink() || !dir.isDirectory())) {
    throw new Error(`${dirPath} is not a plain folder; the agent pick was not changed.`);
  }
  if (!dir) mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const file = agentsPickPath(home);
  const existing = lstatOrNull(file);
  if (existing && !existing.isFile()) {
    throw new Error(`${file} is not a plain file; the agent pick was not changed.`);
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify({ picked: clean }) + '\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return pickedAgents(home) ?? clean;
}

export type SignedIn = Readonly<Partial<Record<AgentId, boolean>>>;

/** The pick an existing user already works with: every agent signed in today. Empty = a new user. */
export function derivePick(signedIn: SignedIn): AgentId[] {
  return AGENT_IDS.filter((a) => signedIn[a] === true);
}

export interface EnsuredPick {
  picked: AgentId[] | null;
  /** True when this call derived and wrote the record (an existing user, first run). */
  derived: boolean;
}

/**
 * The pick in effect. With a valid record, that record. Without one, derived ONCE from what is
 * signed in and written, so an existing user is never sent back through setup; a machine with
 * nothing signed in gets no record (a new user picks in setup). A derive that cannot be written
 * still answers with the derived pick.
 */
export function ensurePickedAgents(signedIn: SignedIn, home: string = homedir()): EnsuredPick {
  const current = pickedAgents(home);
  if (current) return { picked: current, derived: false };
  const derived = derivePick(signedIn);
  if (derived.length === 0) return { picked: null, derived: false };
  try {
    return { picked: setPickedAgents(derived, home), derived: true };
  } catch {
    return { picked: derived, derived: true };
  }
}

// ─── C17: computed gaps ─────────────────────────────────────────────────────────

type CellState = 'works' | 'built' | 'partly' | 'missing' | 'impossible' | 'claude-only';
interface CapabilityRow {
  ids: string[];
  kind: string;
  what: string;
  codex: { state: CellState } | CellState;
  antigravity: { state: CellState } | CellState;
}
interface FeatureRow { name: string; claude?: string; codex?: string; note?: string }
export interface ParityDoc {
  features: FeatureRow[];
  capabilities: { rows: CapabilityRow[] };
}

/** Capability kinds whose missing cell is a gap the user can meet. */
const GAP_KINDS = new Set(['mode', 'headless', 'control']);
/** Capability states that mean "this agent cannot run it". */
const GAP_STATES = new Set<string>(['claude-only', 'impossible', 'missing']);
/** The feature-row cell that means a gap. */
const FEATURE_GAP_CELL = 'Claude only';
/** Feature-row cells that mean the agent can run it. */
const FEATURE_WORKS = new Set(['works', 'experimental']);

export interface ToolGap {
  /** The row key: a capability row's first id, or `feature:<name>`. */
  row: string;
  source: 'feature' | 'capability';
  /** Plain English of what the row is (the file's `what` or feature name). */
  what: string;
  /** The agents whose cell for this row works. Claude counts as working on every capability row. */
  worksOn: AgentId[];
}

function stateOf(cell: CapabilityRow['codex']): string {
  return typeof cell === 'string' ? cell : cell?.state;
}

export function featureRowKey(name: string): string {
  return `feature:${name}`;
}

function capabilityWorksOn(r: CapabilityRow): AgentId[] {
  const out: AgentId[] = ['claude'];
  if (!GAP_STATES.has(stateOf(r.codex))) out.push('codex');
  if (!GAP_STATES.has(stateOf(r.antigravity))) out.push('antigravity');
  return out;
}

function featureWorksOn(f: FeatureRow): AgentId[] {
  // Feature rows have no Antigravity column: Antigravity's gaps come from capability rows only.
  const out: AgentId[] = [];
  if (f.claude !== undefined && FEATURE_WORKS.has(f.claude)) out.push('claude');
  if (f.codex !== undefined && FEATURE_WORKS.has(f.codex)) out.push('codex');
  return out;
}

/**
 * Per agent, every gap row: each feature row whose cell for that agent is "Claude only", plus
 * every capability row of kind mode, headless or control whose state for that agent is
 * claude-only, impossible or missing. Claude has no gaps by construction.
 */
export function computeGaps(doc: ParityDoc): Record<AgentId, ToolGap[]> {
  const gaps: Record<AgentId, ToolGap[]> = { claude: [], codex: [], antigravity: [] };
  for (const f of doc.features) {
    const gap: ToolGap = { row: featureRowKey(f.name), source: 'feature', what: f.name, worksOn: featureWorksOn(f) };
    if (f.codex === FEATURE_GAP_CELL) gaps.codex.push(gap);
  }
  for (const r of doc.capabilities.rows) {
    if (!GAP_KINDS.has(r.kind)) continue;
    const gap: ToolGap = { row: r.ids[0], source: 'capability', what: r.what, worksOn: capabilityWorksOn(r) };
    if (GAP_STATES.has(stateOf(r.codex))) gaps.codex.push(gap);
    if (GAP_STATES.has(stateOf(r.antigravity))) gaps.antigravity.push(gap);
  }
  return gaps;
}

/** Every row that is a gap for at least one agent, by row key. */
export function gapRows(doc: ParityDoc): string[] {
  const g = computeGaps(doc);
  return [...new Set([...g.codex, ...g.antigravity].map((x) => x.row))];
}

export const TOOL_GAPS: Readonly<Record<AgentId, readonly ToolGap[]>> = computeGaps(toolParity as unknown as ParityDoc);

/**
 * Where a gap renders. `hidden`: the UI already hides that control on that agent today.
 * `settings-only`: listed in Settings → Tools, no surface of its own. A test fails when a gap
 * row in the file has no entry here.
 */
export type GapSurface =
  | 'super-tab' | 'assistant-card' | 'ai-team' | 'board' | 'tasks'
  | 'chat-mcp' | 'chat-rewind' | 'hidden' | 'settings-only';

export const GAP_SURFACE: Readonly<Record<string, GapSurface>> = {
  [featureRowKey('Super Agent')]: 'super-tab',
  'mode:super': 'super-tab',
  'mode:assistant': 'assistant-card',
  [featureRowKey('AI Team as chat sub-agents')]: 'ai-team',
  'headless:board-agent': 'board',
  'headless:task-step': 'tasks',
  'control:mcp_authenticate': 'chat-mcp',
  'control:rewind_conversation': 'chat-rewind',
  'control:stop_task': 'hidden',
  'headless:builder': 'settings-only',
  'headless:peer': 'settings-only',
  'headless:ask-write': 'settings-only',
};

/** The gaps of the picked agents that a surface shows: a gap only when NO picked agent runs it. */
export function gapsOnSurface(surface: GapSurface, picked: readonly AgentId[], gaps = TOOL_GAPS): ToolGap[] {
  const rows = new Map<string, ToolGap>();
  for (const a of picked) for (const g of gaps[a]) if (GAP_SURFACE[g.row] === surface) rows.set(g.row, g);
  return [...rows.values()].filter((g) => !picked.some((a) => g.worksOn.includes(a)));
}

/** Settings → Tools: every computed gap of every picked agent, once each, with its agent. */
export function pickedGapList(picked: readonly AgentId[], gaps = TOOL_GAPS): Array<ToolGap & { agent: AgentId }> {
  return picked.flatMap((a) => gaps[a].map((g) => ({ ...g, agent: a })));
}

// ─── The sentence ───────────────────────────────────────────────────────────────

export type Lang = 'en' | 'tr';

function joinNames(names: string[], lang: Lang): string {
  const or = lang === 'tr' ? 'veya' : 'or';
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${or} ${names[names.length - 1]}`;
}

/**
 * One plain sentence naming the agents that can run this: "Bu özellik şimdilik Claude Code
 * ister", or "… Claude Code veya Codex ister" when both qualify. Never a command or a raw error.
 */
export function needsAgentSentence(worksOn: readonly AgentId[], lang: Lang): string {
  const names = joinNames(AGENT_IDS.filter((a) => worksOn.includes(a)).map((a) => AGENT_NAMES[a]), lang);
  return lang === 'tr' ? `Bu özellik şimdilik ${names} ister.` : `This feature needs ${names} for now.`;
}

/**
 * The run message for a job whose agent is not picked (its stored tool, absent = Claude): the
 * job does not start. Plain words, never manifest fields or a command.
 */
export function agentNotPickedMessage(tool: AgentId, lang: Lang = 'en'): string {
  const name = AGENT_NAMES[tool];
  return lang === 'tr'
    ? `Bu iş ${name} ile çalışıyor, ama bu Mac'te ${name} seçili değil. Ayarlar > Araçlar'dan ${name} seçilince çalışır.`
    : `This job runs on ${name}, but ${name} is not picked on this Mac. Pick ${name} in Settings > Tools and it runs.`;
}

/**
 * Deny-only: may a job with this stored tool start under this pick? A missing pick (no valid
 * record) never refuses. Never chooses, changes or widens the job's tool.
 */
export function jobAgentPicked(storedTool: string | null | undefined, picked: readonly AgentId[] | null): boolean {
  if (!picked) return true;
  const tool: AgentId = storedTool === 'codex' || storedTool === 'antigravity' ? storedTool : 'claude';
  return picked.includes(tool);
}
