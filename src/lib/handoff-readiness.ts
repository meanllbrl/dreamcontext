/**
 * handoff-readiness — the gate both handoffs pass through before a fresh session is
 * told to pick a task up cold.
 *
 * A fresh session inherits NOTHING but the task file. So a handoff that leaves the task
 * thin is not a small loss: the next session re-derives, guesses, or quietly re-plans.
 * Both handoffs used to trust the handing-off agent to have written everything down:
 *
 *   CONTEXT handoff (`tasks handoff`) — the protocol was two commands, `tasks log` then
 *     `tasks handoff`, and the second one never checked the first had run. `handoff` with
 *     no note was even tested as a supported shape ("the handoff itself is the signal"),
 *     so an agent under context pressure could pin a task whose latest changelog entry was
 *     days old, and the banner would send the fresh session to read it.
 *   DEVELOP handoff (Plan → Develop button) — the Plan briefing lists the inserts, but the
 *     button opens a Develop session whatever the task holds.
 *
 * The fix is the same shape for both: a PURE check over the task text that names each gap
 * in terms the agent can act on, and a caller that REFUSES while any gap remains. Nothing
 * here writes; the callers own the refusal.
 */

import { countCheckboxes, isPlaceholderLine } from './markdown.js';

/** One thing the handoff is missing, phrased as the fix. */
export interface HandoffGap {
  /** The field or task section at fault (`--done`, `acceptance_criteria`, …). */
  field: string;
  problem: string;
}

// ─── Context handoff: the state the handing-off session must write ────────────

/**
 * The six parts of a context handoff, in the order they are written into the entry.
 *
 * `minChars` separates two kinds of field. `done` and `next` are the handoff — a fresh
 * session cannot continue without them, so they must be a real sentence. The other four
 * are REQUIRED TO BE ANSWERED but may honestly be "none": a session can have made no
 * decisions, and forcing prose there only teaches the agent to write filler. What the
 * gate buys is that "none" is a choice the agent made, not a part it forgot.
 */
export const HANDOFF_FIELDS = [
  { key: 'done', flag: '--done', label: 'Done', minChars: 30, hint: 'what is finished, with the evidence (tests run, criteria ticked)' },
  { key: 'next', flag: '--next', label: 'Next', minChars: 30, hint: 'the exact next step and what remains after it' },
  { key: 'decisions', flag: '--decisions', label: 'Decisions', minChars: 1, hint: 'choices made this session and why, or none' },
  { key: 'learned', flag: '--learned', label: 'Learned', minChars: 1, hint: 'traps, surprises, dead ends, or none' },
  { key: 'style', flag: '--style', label: 'Working style', minChars: 1, hint: 'how you are working: commands, test loop, what the user asked for, or none' },
  { key: 'files', flag: '--files', label: 'Open files', minChars: 1, hint: 'the files in flight, with line anchors, or none' },
] as const;

export type HandoffFieldKey = typeof HANDOFF_FIELDS[number]['key'];
export type HandoffFields = Partial<Record<HandoffFieldKey, string>>;

const clean = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/** Every missing or too-thin field. Empty means the handoff may proceed. */
export function contextHandoffGaps(fields: HandoffFields): HandoffGap[] {
  const gaps: HandoffGap[] = [];
  for (const f of HANDOFF_FIELDS) {
    const value = clean(fields[f.key]);
    if (!value) {
      gaps.push({ field: f.flag, problem: `missing — ${f.hint}` });
    } else if (value.length < f.minChars) {
      gaps.push({ field: f.flag, problem: `too thin (${value.length} chars; a fresh session needs at least ${f.minChars}) — ${f.hint}` });
    }
  }
  return gaps;
}

/**
 * The changelog entry the handoff writes. ONE entry carrying every part, because the
 * banner and the Chat rotation prompt both send the fresh session to "the latest
 * changelog entry" — split across two entries, the second would hide the first.
 */
export function renderHandoffEntry(date: string, fields: HandoffFields, note?: string): string {
  const lines = [`### ${date} - Handoff`];
  for (const f of HANDOFF_FIELDS) lines.push(`- **${f.label}:** ${clean(fields[f.key])}`);
  const extra = clean(note);
  if (extra) lines.push(`- **Note:** ${extra}`);
  return lines.join('\n');
}

// ─── Develop handoff: the plan the task must carry ────────────────────────────

/** The task sections the Develop gate reads — a subset of `TaskData`. */
export interface DevelopReadinessInput {
  acceptance_criteria?: string | null;
  technical_details?: string | null;
}

/** A section's real lines: no HTML comments, no template skeleton, no blanks. */
function realLines(body: string | null | undefined): string[] {
  return (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !isPlaceholderLine(l));
}

/** A path-shaped token: `dir/file`, or a name with a code-ish extension. */
const PATH_RE = /[\w.@-]+\/[\w./@-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|rs|go|swift|kt|java|rb|sh|yml|yaml|toml|sql)\b/;

/**
 * What a Develop session needs from the task it is handed, per the Plan briefing's own
 * step 6: testable criteria, the agreed validation method, and a file-by-file plan.
 *
 * Constraints are deliberately NOT required — a plan can honestly have none, and this
 * gate refuses; it must never refuse a complete plan.
 */
export function developHandoffGaps(task: DevelopReadinessInput): HandoffGap[] {
  const gaps: HandoffGap[] = [];
  const criteria = realLines(task.acceptance_criteria).join('\n');
  if (countCheckboxes(criteria).total === 0) {
    gaps.push({ field: 'acceptance_criteria', problem: 'no testable criteria — insert at least one "- [ ]" criterion' });
  }
  if (!/validation method\s*:/i.test(criteria)) {
    gaps.push({ field: 'acceptance_criteria', problem: 'no "Validation method: <tests | manual checklist>" criterion — the method the user chose' });
  }
  const plan = realLines(task.technical_details);
  if (plan.length === 0) {
    gaps.push({ field: 'technical_details', problem: 'empty — insert the file-by-file plan' });
  } else if (!plan.some((l) => PATH_RE.test(l))) {
    gaps.push({ field: 'technical_details', problem: 'names no file — the plan must point at exact paths' });
  }
  return gaps;
}

/** The gaps as indented lines, for a CLI refusal or an alert. */
export function formatGaps(gaps: HandoffGap[]): string {
  return gaps.map((g) => `  - ${g.field}: ${g.problem}`).join('\n');
}
