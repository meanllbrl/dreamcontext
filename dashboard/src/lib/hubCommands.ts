import { buildQuestionAnswer } from './chatProtocol';
import { unclearMessage } from '../components/sleepy/chat/surveyAnswers';
import type { PendingItem } from '../components/sleepy/chatSession';
import { HUB_VERBS, type AnswerPending, type HubResult, type HubVerb } from '../../../src/lib/telegram/contract.js';

/**
 * The window's side of the Telegram hub's verbs (`hub_command`, W1 contract A2/B3/P3).
 *
 * `answer_pending` is the SECOND fence after the hub's button integrity: the window answers only a
 * request pending on ITS OWN chat's card, only a permission (allow once or deny, never "always")
 * or an AskUserQuestion, and builds the answer with the same code the Mac card uses
 * (`PermissionCard` sends `item.input` back; `buildQuestionAnswer`; the survey's `unclearMessage`).
 * A plan approval, and every card that is not a pending control request at all (secret, run,
 * checklist, mcp, an agent or automation approval) has no request id here, so it is refused.
 *
 * `html_snapshot` passes the server's page to the shell's sealed webview and hands the PNG slices
 * back (desktop/src-tauri/src/html_snapshot.rs); outside the app it is `unsupported`.
 */

/** Tools whose "allow" is an approval or an answer, never a plain permission. */
const APPROVAL_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion']);

export function isHubVerb(verb: string): verb is HubVerb {
  return (HUB_VERBS as readonly string[]).includes(verb);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function stringMap(v: unknown, maxValue = 4000): Record<string, string> | null {
  if (v === undefined) return {};
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string' || k.length > 2000 || val.length > maxValue) return null;
    out[k] = val;
  }
  return out;
}

/** The args as the contract's tagged union, or null for anything else. */
export function parseAnswerPending(args: unknown): AnswerPending | null {
  if (!isRecord(args)) return null;
  const requestId = str(args.requestId);
  if (!requestId) return null;
  const item = args.item === undefined ? undefined : str(args.item);
  if (item === null) return null;
  if (args.kind === 'permission') {
    return args.choice === 'allow_once' || args.choice === 'deny' ? { kind: 'permission', requestId, choice: args.choice } : null;
  }
  if (args.kind === 'question') {
    const picked = stringMap(args.picked);
    const notes = stringMap(args.notes);
    if (!picked || !notes) return null;
    return { kind: 'question', requestId, ...(item ? { item } : {}), picked, ...(Object.keys(notes).length ? { notes } : {}) };
  }
  if (args.kind === 'unclear') {
    const unclear = typeof args.unclear === 'string' && args.unclear.length <= 4000 ? args.unclear : null;
    return unclear === null ? null : { kind: 'unclear', requestId, ...(item ? { item } : {}), unclear };
  }
  return null;
}

/** What `session.answer` should be called with, or why the hub's answer is refused. */
export type HubAnswerPlan =
  | { ok: true; requestId: string; behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }
  | { ok: false; error: 'bad_args' | 'not_pending' | 'refused_kind' | 'no_choice' | 'unsupported' };

export function planHubAnswer(args: unknown, pending: readonly PendingItem[]): HubAnswerPlan {
  const a = parseAnswerPending(args);
  if (!a) return { ok: false, error: 'bad_args' };
  // `item` names a Super queue / rich-ask item (W5): not a card of this chat's control channel.
  if ('item' in a && a.item) return { ok: false, error: 'unsupported' };
  const entry = pending.find((p) => p.requestId === a.requestId);
  if (!entry) return { ok: false, error: 'not_pending' };
  if (a.kind === 'permission') {
    if (entry.kind !== 'permission') return { ok: false, error: 'refused_kind' };
    // A plan approval or a question whose card did not parse falls back to a permission card on the
    // Mac; from Telegram it is still an approval, never an "allow once".
    if (APPROVAL_TOOLS.has(entry.toolName)) return { ok: false, error: 'refused_kind' };
    return a.choice === 'allow_once'
      // Exactly the Mac card's "Allow": the tool input echoed, no always-allow rule written.
      ? { ok: true, requestId: a.requestId, behavior: 'allow', updatedInput: entry.input }
      : { ok: true, requestId: a.requestId, behavior: 'deny', message: 'Denied by user.' };
  }
  if (entry.kind !== 'question') return { ok: false, error: 'refused_kind' };
  if (a.kind === 'unclear') {
    const first = entry.questions[0]?.question ?? '';
    return { ok: true, requestId: a.requestId, behavior: 'deny', message: unclearMessage(entry.questions, first ? { [first]: { chosen: [], text: a.unclear } } : {}) };
  }
  // Only the card's own questions, only labels that are its options (the hub builds them with
  // `buildQuestionPicks`, which keeps option order and joins a multi-select with ", ").
  const picked: Record<string, string> = {};
  for (const q of entry.questions) {
    const v = a.picked[q.question];
    if (typeof v !== 'string' || !v) continue;
    if (picksMatchOptions(v, q.options.map((o) => o.label), !!q.multiSelect)) picked[q.question] = v;
  }
  if (!Object.keys(picked).length) return { ok: false, error: 'no_choice' };
  const notes = a.notes ? Object.fromEntries(Object.entries(a.notes).filter(([k]) => k in picked)) : undefined;
  return {
    ok: true, requestId: a.requestId, behavior: 'allow',
    updatedInput: buildQuestionAnswer(entry.questions, picked, { input: entry.input, ...(notes && Object.keys(notes).length ? { notes } : {}) }),
  };
}

/**
 * Does `value` name only this question's options? A single choice is one label; a multiSelect is
 * labels in OPTION order joined with ", " (`buildQuestionPicks`), so it is walked label by label in
 * that order: a label that itself contains ", " ("Yes, ship it") still matches.
 */
export function picksMatchOptions(value: string, labels: readonly string[], multiSelect: boolean): boolean {
  if (!multiSelect) return labels.includes(value);
  let rest = value;
  for (const label of labels) {
    if (rest === label) return true;
    if (rest.startsWith(`${label}, `)) rest = rest.slice(label.length + 2);
  }
  return false;
}

/** `html_snapshot` args: the server's page and an optional width. */
export function parseSnapshotArgs(args: unknown): { html: string; width?: number } | null {
  if (!isRecord(args) || typeof args.html !== 'string' || !args.html) return null;
  if (args.html.length > 4 * 1024 * 1024) return null;
  const width = typeof args.width === 'number' && Number.isInteger(args.width) && args.width > 0 && args.width <= 4000 ? args.width : undefined;
  return { html: args.html, ...(width ? { width } : {}) };
}

/** The shell's sealed renderer. Its `Err(code)` comes back as the result's `error`. */
export async function runHtmlSnapshot(args: unknown, invoke: ((cmd: string, a: Record<string, unknown>) => Promise<unknown>) | null): Promise<HubResult> {
  const parsed = parseSnapshotArgs(args);
  if (!parsed) return { ok: false, error: 'bad_args' };
  if (!invoke) return { ok: false, error: 'unsupported' };
  try {
    const out = await invoke('html_snapshot', { html: parsed.html, width: parsed.width ?? null });
    return isRecord(out) && out.ok === true ? (out as HubResult) : { ok: false, error: 'failed' };
  } catch (err) {
    const code = typeof err === 'string' ? err : err instanceof Error ? err.message : 'failed';
    const known = ['unsupported', 'busy', 'rate', 'too_large', 'timeout', 'blank', 'forbidden'];
    return { ok: false, error: known.includes(code) ? code : 'failed' };
  }
}

// ─── super_handover and render_card: answered by the project surface, not the chat ──────────

/** `super_handover` (N5, P4): the project window's own hand-over, adopting nothing. */
export type HubHandover = () => Promise<HubResult>;
let handover: HubHandover | null = null;
/** AgentSurface registers its hand-over while mounted (one surface per window). */
export function setHubHandover(fn: HubHandover | null): void { handover = fn; }
export async function runHubHandover(args: unknown): Promise<HubResult> {
  if (!isRecord(args) || !Array.isArray(args.adopt) || args.adopt.length !== 0) return { ok: false, error: 'bad_args' };
  if (!handover) return { ok: false, error: 'no_window', reason: 'no_window' };
  return handover();
}

/** `render_card` (R5, S2, T4): the stage's insight cards only; set by the Super stage. */
export type HubCardRenderer = (args: unknown) => Promise<HubResult>;
let cardRenderer: HubCardRenderer | null = null;
export function setHubCardRenderer(fn: HubCardRenderer | null): void { cardRenderer = fn; }
export async function runHubRenderCard(args: unknown): Promise<HubResult> {
  if (!cardRenderer) return { ok: false, error: 'not_mounted', reason: 'not_mounted' };
  return cardRenderer(args);
}
