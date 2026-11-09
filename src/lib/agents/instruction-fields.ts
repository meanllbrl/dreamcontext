import type { ApprovalPayloadFields } from '../automations/types.js';

/**
 * WHICH SIDE OF THE LINE EACH MEMBER FIELD SITS ON. The one place that says it.
 *
 *  - `instruction`: text that tells the member how to do the job it already has. The Super Agent
 *    may change it from its own session (`super team amend`), the member stays approved, and the
 *    change leaves a trace the owner can undo.
 *  - `authority`: anything that widens what the member may touch, where its work lands, who sees
 *    it, when it runs alone, or that removes a human gate. Only the owner changes these; a change
 *    from anywhere else keeps asking.
 *
 * Pure: no I/O, importable by the server, the CLI and the tests alike.
 */
export type FieldSide = 'instruction' | 'authority';

/**
 * Every approval-hashed field, classified. `satisfies` makes this exhaustive against the review
 * list at compile time, and `instruction-fields.test.ts` holds it against what
 * `canonicalApprovalPayload` really hashes: a field added to the hash fails until someone decides
 * which side it is on. Anything not listed here is `authority`.
 *
 * `outputInstructions` is text, and still `authority`: it says where else the output goes.
 * `readTools` is which MCP tools a light job may use: it widens what the member reaches, so only the owner changes it.
 * `app` is the app a job belongs to: it decides which app's brief the run gets.
 * `mode` is hashed but not in the review list: `sched` is what lets a member run alone.
 */
export const HASHED_FIELD_SIDE = {
  prompt: 'instruction',
  soul: 'instruction',
  job: 'instruction',
  outputInstructions: 'authority',
  model: 'authority',
  effort: 'authority',
  timeoutMinutes: 'authority',
  outputDir: 'authority',
  learning: 'authority',
  review: 'authority',
  flow: 'authority',
  whiteboard: 'authority',
  autonomy: 'authority',
  readTools: 'authority',
  tool: 'authority',
  app: 'authority',
  boardOnly: 'authority',
  appTools: 'authority',
  // super-rutin: a Super turn and a Telegram outflow are the owner's to grant.
  target: 'authority',
  reply: 'authority',
  mode: 'authority',
} as const satisfies Record<keyof ApprovalPayloadFields | 'mode', FieldSide>;

/**
 * What the approval hash does not cover, and so what no amendment can reach either. Each has its
 * own owner verb. Named here so the table in the docs is this file, not a second opinion.
 */
export const UNHASHED_AUTHORITY_FIELDS = ['schedule', 'enabled', 'shared', 'notify', 'catchupHours', 'tools', 'permissions'] as const;

/** Never authority: how a member is drawn and remembered. Unhashed, free to change. */
export const UNHASHED_NEUTRAL_FIELDS = ['title', 'photo', 'face', 'reportsTo', 'team', 'pattern'] as const;

export type InstructionField = {
  [K in keyof typeof HASHED_FIELD_SIDE]: (typeof HASHED_FIELD_SIDE)[K] extends 'instruction' ? K : never;
}[keyof typeof HASHED_FIELD_SIDE];

/** The fields an amendment may write. Derived from the table, so it cannot drift from it. */
export const INSTRUCTION_FIELDS = (Object.keys(HASHED_FIELD_SIDE) as (keyof typeof HASHED_FIELD_SIDE)[])
  .filter((f) => HASHED_FIELD_SIDE[f] === 'instruction') as readonly InstructionField[];

/** True for an amendable field. Anything unknown is `authority`: the safe side. */
export function isInstructionField(field: string): field is InstructionField {
  return Object.prototype.hasOwnProperty.call(HASHED_FIELD_SIDE, field)
    && HASHED_FIELD_SIDE[field as keyof typeof HASHED_FIELD_SIDE] === 'instruction';
}

// ─── Widening: which way a change moves a member's reach (plan-r10 1e) ───────

/**
 * Who makes a member change, as the approval rule reads it:
 *  - `owner`: the owner himself, in the app (an owner-page route) or at his own CLI;
 *  - `super`: the Super Agent through its token (`super team amend`), which already talks to him;
 *  - `session`: an in-app chat session (a Claude session, a member's conversation): someone he talks to;
 *  - `agent`: a process that never talks to him (a member's own run, a routine, a Super or member
 *    child): its risky text waits for the one card (`localWriteStamps`).
 */
export type MemberActor = 'owner' | 'super' | 'session' | 'agent';

/** The env keys of a process that never talks to the owner. */
export const BACKGROUND_ENVS = ['DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_MEMBER_CREW', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_SUPER_CREW'] as const;

/**
 * The actor of a CLI process, read from its environment. `self` names the member a member run
 * belongs to (`DREAMCONTEXT_AGENT_SELF` or `DREAMCONTEXT_MEMBER_CREW`): from inside it only that
 * member may be edited without the card.
 */
export function memberActorFromEnv(env: NodeJS.ProcessEnv = process.env): { actor: MemberActor; self: string | null } {
  if (BACKGROUND_ENVS.some((k) => env[k] !== undefined)) {
    const self = (env.DREAMCONTEXT_AGENT_SELF ?? env.DREAMCONTEXT_MEMBER_CREW ?? '').trim();
    return { actor: 'agent', self: self || null };
  }
  if (env.CLAUDECODE !== undefined || env.DREAMCONTEXT_AGENT_CHAT !== undefined) return { actor: 'session', self: null };
  return { actor: 'owner', self: null };
}

/**
 * THE stamp rule for a write this Mac makes (owner 2026-11-07: only what arrives from outside asks).
 * Whoever writes it here, the owner, his Super Agent, an in-app session, a member's own run or a
 * global agent, the result is approved as it is written: no card. A file that came by git (a
 * teammate's new or changed member, routine or instruction) still asks once, because no local write
 * stamped what it says.
 *
 * The one exception is the injection guard: text a process that never talks to the owner (`agent`:
 * a run, a routine, the Super Agent's crew, a member's crew) wrote with one of the signs
 * `amendmentRisks` names (a new address, a command, a secret path, a hidden character...) waits for
 * his one card. That text was read somewhere, not given by him. Widening no longer holds a local write.
 */
export function localWriteStamps(actor: MemberActor, risks: readonly string[]): boolean {
  return actor !== 'agent' || risks.length === 0;
}

/** The shape `widensAuthority` reads: the review fields of a target (`approvalFields`), plus the
 *  hashed `mode`, the unhashed `enabled`, `fallbackTools` and where the member lives. Any key the
 *  direction table below does not name counts as widening when it moved (default-deny). */
export interface WidenView {
  [field: string]: unknown;
  scope?: 'project' | 'global';
}

/** What a member created from nothing is judged against (critic r8-2-2): no read tools, balanced,
 *  review off, mode call, no destination, no board, no app, Claude. Learning is exempt at create. */
export const CREATE_BASELINE: Readonly<WidenView> = {
  prompt: '', soul: '', job: '', outputInstructions: '', model: null, effort: null, timeoutMinutes: null,
  outputDir: null, learning: null, review: 'off', flow: null, whiteboard: null, autonomy: 'balanced',
  readTools: '', tool: null, app: '', appTools: '', mode: 'call', enabled: true, fallbackTools: [], boardOnly: false,
};

/** Moving these never widens reach: cost, wording, drawing. */
const NEUTRAL = new Set(['prompt', 'soul', 'job', 'model', 'effort', 'timeoutMinutes', 'title', 'photo', 'face', 'team', 'reportsTo', 'pattern', 'scope']);
const AUTONOMY_ORDER = ['ask', 'balanced', 'free'];

function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
function textOf(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : v === null || v === undefined ? '' : JSON.stringify(v);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** A flow widens when it gains a node or loses a human gate. Unreadable = widening. */
function flowWidens(prev: unknown, next: unknown): boolean {
  const nodes = (f: unknown): { id: string; kind: string }[] | null => {
    if (f === null || f === undefined) return [];
    const n = (f as { nodes?: unknown }).nodes;
    return Array.isArray(n) ? n.map((x) => ({ id: String((x as { id?: unknown }).id ?? ''), kind: String((x as { kind?: unknown }).kind ?? '') })) : null;
  };
  const a = nodes(prev);
  const b = nodes(next);
  if (!a || !b) return true;
  const had = new Set(a.map((x) => x.id));
  if (b.some((x) => !had.has(x.id))) return true;
  const gates = (l: { kind: string }[]) => l.filter((x) => /hitl/i.test(x.kind)).length;
  return gates(b) < gates(a);
}

/**
 * Which hashed or authority fields this change WIDENS, sorted; [] when it only narrows, keeps or
 * rewords. Since 2026-11-07 it no longer decides a stamp (`localWriteStamps` does): it names what a
 * change made on this Mac widened on the trace row the owner reads (`agents amendments`). A create
 * (`prev` null) is judged against {@link CREATE_BASELINE}, learning exempt.
 *
 *  readTools added; autonomy toward free; tool or fallbackTools changed; outputDir or
 *  outputInstructions to a new destination; whiteboard removed or moved to another board; the board
 *  limit (`boardOnly`) lifted; app
 *  changed; a flow node added or a human gate removed; review turned off; mode call -> sched;
 *  learning turned on; `enabled` off -> on by anyone but the owner; ANY change by a background
 *  process (`agent`) to a GLOBAL member (it runs in every project), a global member created by one.
 *  A field this list does not name counts when it moved (default-deny).
 */
export function widensAuthority(prev: WidenView | null, next: WidenView, actor: MemberActor): string[] {
  const create = prev === null;
  const before: WidenView = prev ?? CREATE_BASELINE;
  const out = new Set<string>();
  const keys = new Set([...Object.keys(before), ...Object.keys(next)]);
  for (const k of keys) {
    if (NEUTRAL.has(k)) continue;
    if (!(k in next)) continue;
    const a = before[k];
    const b = next[k];
    if (same(a, b)) continue;
    switch (k) {
      case 'readTools':
      case 'appTools': { const had = new Set(listOf(a)); if (listOf(b).some((x) => !had.has(x))) out.add(k); break; }
      case 'fallbackTools': if (!same(listOf(a), listOf(b))) out.add(k); break;
      case 'autonomy': if (AUTONOMY_ORDER.indexOf(String(b ?? 'balanced')) > AUTONOMY_ORDER.indexOf(String(a ?? 'balanced'))) out.add(k); break;
      case 'tool': if ((a ?? null) !== (b ?? null)) out.add(k); break;
      case 'outputDir': if (b !== null && b !== undefined && b !== '') out.add(k); break;
      case 'outputInstructions': if (textOf(b) && textOf(b) !== textOf(a)) out.add(k); break;
      case 'whiteboard': if (a !== null && a !== undefined && a !== '') out.add(k); break;
      // Lifting the board limit widens; adding it narrows.
      case 'boardOnly': if (a === true && b !== true) out.add(k); break;
      case 'app': out.add(k); break;
      case 'flow': if (flowWidens(a, b)) out.add(k); break;
      case 'review': if (b === 'off' && a !== 'off') out.add(k); break;
      case 'mode': if (b === 'sched') out.add(k); break;
      case 'learning': if (!create && b === true && a !== true) out.add(k); break;
      case 'enabled': if (actor !== 'owner' && b === true && a === false) out.add(k); break;
      default: out.add(k);
    }
  }
  // A member every project runs: a background process's change waits for him (the binding: only a
  // process that never talks to him). The owner's, Super's (refused as `amend_global` anyway) and
  // an in-app session's do not.
  if (actor === 'agent' && (next.scope === 'global' || before.scope === 'global')) {
    const moved = create || [...keys].some((k) => k !== 'scope' && k in next && !same(before[k], next[k]));
    if (moved) out.add('global');
  }
  return [...out].sort();
}
