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

import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { countCheckboxes, isPlaceholderLine } from './markdown.js';
import { waveChildren, waveCount, type WaveChildInput } from './task-parent.js';

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
export function developHandoffGaps(
  task: DevelopReadinessInput,
  drawingExists?: (relPath: string) => boolean,
): HandoffGap[] {
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
  } else if (!plan.some((l) => PATH_RE.test(scan(l)))) {
    gaps.push({ field: 'technical_details', problem: 'names no file — the plan must point at exact paths' });
  }
  gaps.push(...outcomeApprovalGaps(task, drawingExists));
  return gaps;
}

// ─── Develop handoff: the outcome the owner agreed to (UX/UI plans) ───────────

/**
 * The owner agrees the outcome BEFORE any build (soul; owner 2026-11-08, task
 * plan-modu-once-anlar-…): a plan that changes what a user does carries a UX flow he said
 * yes to, and a plan that changes a screen carries a static drawing he approved. Briefing
 * text alone is forgotten, so the Develop gate asks for the RECORD of that yes, as plain
 * lines in technical_details that the Plan session writes after the owner's answer:
 *
 *   UX/UI change: none | ux | ui
 *   Owner-approved outcome: <what he said yes to, in a sentence>
 *   Approved drawing: <project-relative path to the draft html>
 *
 * The declaration is optional so an older plan with no UI file stays ready (no re-block at
 * the default); when it is absent, the scope is read off the plan's own paths, so a plan
 * that edits a screen cannot slip past by not mentioning it. `none` is an explicit answer
 * and is never refused.
 */
export type OutcomeScope = 'none' | 'ux' | 'ui';

// A label may be bold either way (`**Label**:` or `**Label:**`), and a value may be backticked.
const label = (name: string) => `^[-*\\s]*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*`;
const SCOPE_RE = new RegExp(`${label('UX\\/UI change')}(.*)$`, 'i');
const APPROVED_RE = new RegExp(`${label('Owner-approved outcome')}(.*)$`, 'i');
const DRAWING_RE = new RegExp(`${label('Approved drawing')}\`?([^\`\\s]+)\`?`, 'i');
/** A file a screen is made of: a component, a stylesheet, a page. */
const UI_FILE_RE = /[\w.@/-]+\.(?:tsx|jsx|vue|svelte|css|scss|html)\b/;
const MIN_OUTCOME_CHARS = 20;
/** A real plan line is far shorter; capping it keeps the unanchored path regexes linear. */
const MAX_SCAN = 2000;
const scan = (l: string): string => (l.length > MAX_SCAN ? l.slice(0, MAX_SCAN) : l);

/**
 * The scope a declaration's VALUE names, read whole: the leading run of scope words
 * (`ux/ui`, `ux + ui`, `UX and UI`, the template `none|ux|ui`) is the widest scope it names,
 * so a plan that changes both is UI and a pasted template fails closed. `none` holds only
 * when it is the only scope word. Null when the value names no scope word at all.
 */
function declaredScope(value: string): OutcomeScope | null {
  const words = new Set<string>();
  // Every non-letter separates, so punctuation stuck to a word (`ux.`, `ux-only`, `(ux)`) still reads.
  for (const w of value.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    if (w === 'and') continue;
    if (w !== 'none' && w !== 'ux' && w !== 'ui') break;
    words.add(w);
  }
  if (words.has('ui')) return 'ui';
  if (words.has('ux')) return 'ux';
  return words.has('none') ? 'none' : null;
}

/** What the plan says about its UX/UI scope: declared, or read off its file paths. */
export function outcomeScope(technicalDetails: string | null | undefined): { scope: OutcomeScope; declared: boolean; uiFile?: string } {
  const lines = realLines(technicalDetails).map(scan);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = SCOPE_RE.exec(lines[i]);
    const scope = m ? declaredScope(m[1]) : null;
    if (scope) return { scope, declared: true };
  }
  for (const l of lines) {
    if (DRAWING_RE.test(l)) continue;
    const m = UI_FILE_RE.exec(l);
    if (m) return { scope: 'ui', declared: false, uiFile: m[0] };
  }
  return { scope: 'none', declared: false };
}

/**
 * The gaps of the owner-approval record. `drawingExists` answers whether a project-relative
 * path is a real file inside the project (the caller owns the filesystem and its symlink
 * rule); without it the path is only required, not checked.
 */
export function outcomeApprovalGaps(
  task: DevelopReadinessInput,
  drawingExists?: (relPath: string) => boolean,
): HandoffGap[] {
  const { scope, declared, uiFile } = outcomeScope(task.technical_details);
  if (scope === 'none') return [];
  const lines = realLines(task.technical_details);
  const why = declared ? `the plan declares "UX/UI change: ${scope}"` : `the plan changes a UI file (${uiFile})`;
  const gaps: HandoffGap[] = [];
  const approved = lines.map((l) => APPROVED_RE.exec(l)?.[1]?.trim() ?? '').filter(Boolean).pop() ?? '';
  if (approved.length < MIN_OUTCOME_CHARS) {
    gaps.push({
      field: 'technical_details',
      problem: `${why} but no owner-approved outcome is recorded — show the owner the UX flow (screen, press, what happens, what the system does), and after his yes insert "Owner-approved outcome: <what he agreed to>"`
        + (declared ? '' : ' (a plan that changes no UX/UI: insert "UX/UI change: none")'),
    });
  }
  if (scope === 'ui') {
    const drawing = lines.map((l) => DRAWING_RE.exec(l)?.[1] ?? '').filter(Boolean).pop() ?? '';
    if (!drawing) {
      gaps.push({
        field: 'technical_details',
        problem: `${why} but no approved drawing is recorded — draw the screen as static HTML (draft, not the final version), get the owner's yes on it, then insert "Approved drawing: <project-relative path>"`,
      });
    } else if (drawingExists && !drawingExists(drawing)) {
      gaps.push({
        field: 'technical_details',
        problem: `"Approved drawing: ${drawing}" is not a file inside the project — save the approved html there, or fix the path`,
      });
    }
  }
  return gaps;
}

/**
 * The `drawingExists` both callers pass: a project-relative path (the project is the folder
 * holding `_dream_context/`) that is a real file inside it. Absolute paths, `..` escapes and
 * symlinks are refused (every path reading vault content rejects symlinks: lstat, then
 * realpath-contain).
 */
export function drawingFileCheck(contextRoot: string): (relPath: string) => boolean {
  const projectRoot = dirname(resolve(contextRoot));
  return (relPath: string) => {
    if (!relPath || isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) return false;
    try {
      const abs = resolve(projectRoot, relPath);
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile()) return false;
      const realRoot = realpathSync(projectRoot);
      const real = realpathSync(abs);
      return real === realRoot || real.startsWith(realRoot + sep);
    } catch {
      return false;
    }
  };
}

/**
 * Information for the Develop handoff that never refuses it: a plan of two or more waves on a
 * top-level task with no wave sub-tasks yet. Develop opens them itself (its recipe's case b),
 * and an older plan that already logged `wN green` lines keeps running as it did (case c), so
 * this is a note, never a gap: a gap would refuse every plan written before waves were tasks.
 */
export function developHandoffNotes(
  task: { slug: string; parent_task?: string | null; technical_details?: string | null },
  children: readonly WaveChildInput[],
): string[] {
  if (task.parent_task) return [];
  const waves = waveCount(task.technical_details);
  if (waves < 2 || waveChildren(task, children).length > 0) return [];
  return [
    `the wave map names ${waves} waves and no wave sub-tasks exist yet; Develop opens them: `
      + `dreamcontext tasks create "Wave N: <what it delivers>" --parent ${task.slug} --basis plan --quote "<the WN part>"`,
  ];
}

/** The gaps as indented lines, for a CLI refusal or an alert. */
export function formatGaps(gaps: HandoffGap[]): string {
  return gaps.map((g) => `  - ${g.field}: ${g.problem}`).join('\n');
}
