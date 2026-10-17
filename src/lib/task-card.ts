import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { foldEntryTexts, splitEntryTexts } from './task-journal.js';

/**
 * The task CARD standard, as code.
 *
 * A card is `state/<slug>.md`: frontmatter + Why, Acceptance Criteria,
 * Constraints & Decisions, Technical Details, Notes. It carries NO
 * `## Changelog` (history is the journal, see task-journal.ts) and NO template
 * HTML comments. `splitCard` takes any task file apart into byte segments so a
 * migration can prove it lost nothing: the segments of kind card/journal/
 * stripped concatenate back to the original bytes exactly; `added` segments are
 * the only new bytes (the `(evidence: legacy)` marks on old ticked criteria).
 */

/** Card ceiling (chars): `tasks insert` refuses past it, doctor warns. */
export const CARD_CEILING = 12_000;
/** Why should stay a short paragraph (doctor warns past it). */
export const WHY_SOFT_LIMIT = 600;
/** Names past this are slugs pretending to be names (doctor warns). */
export const NAME_SOFT_LIMIT = 80;

/**
 * The HTML comments the old task templates scaffolded. Only these are
 * stripped; a comment a person wrote (a mermaid node tag, a note) stays.
 */
export const TEMPLATE_COMMENT_RES: readonly RegExp[] = [
  /^<!--\s*What problem does this solve\?[\s\S]*-->$/,
  /^<!--\s*Other sections \(User Stories[\s\S]*-->$/,
  /^<!--\s*LIFO[:\s][\s\S]*-->$/,
];

export function isTemplateComment(line: string): boolean {
  const t = line.trim();
  return TEMPLATE_COMMENT_RES.some((re) => re.test(t));
}

export type SegmentKind = 'card' | 'journal' | 'stripped' | 'added';
export interface CardSegment {
  kind: SegmentKind;
  text: string;
}

export interface SplitCard {
  segments: CardSegment[];
  /** The new card bytes (card + added segments). */
  card: string;
  /** The Changelog body moved out verbatim (journal segments). */
  journal: string;
  /** Bytes dropped: `## Changelog` headings, template comments, surplus blank lines. */
  stripped: string;
  /** Bytes added: the `(evidence: legacy)` marks. */
  added: string;
  hadChangelog: boolean;
  templateComments: number;
  legacyTicks: number;
}

const FENCE_RE = /^\s*(```|~~~)/;
const H2_RE = /^##\s+(.+?)\s*$/;
const TICKED_RE = /^(\s*[-*+]\s+\[[xX]\]\s+.*?)(\s*)$/;
const EVIDENCE_RE = /\(evidence:\s*[^)]+\)\s*$/;

/**
 * Take a task file apart. `markLegacyTicks` appends ` (evidence: legacy)` to
 * every ticked Acceptance Criteria line that names no evidence (migration only);
 * `keepTemplateComments` moves only the Changelog (a sync base must stay what the remote holds).
 */
export function splitCard(raw: string, opts: { markLegacyTicks?: boolean; keepTemplateComments?: boolean } = {}): SplitCard {
  const segs: CardSegment[] = [];
  const push = (kind: SegmentKind, text: string) => {
    if (!text) return;
    const last = segs[segs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segs.push({ kind, text });
  };

  // Frontmatter is card bytes, untouched.
  let bodyStart = 0;
  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const close = raw.indexOf('\n---', 3);
    if (close !== -1) {
      const eol = raw.indexOf('\n', close + 4);
      bodyStart = eol === -1 ? raw.length : eol + 1;
    }
  }
  push('card', raw.slice(0, bodyStart));

  // Body as lines WITH their terminators, so concatenation is exact.
  const body = raw.slice(bodyStart);
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  let inFence = false;
  let section = '';
  let hadChangelog = false;
  let templateComments = 0;
  let legacyTicks = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bare = line.replace(/\r?\n$/, '');
    if (FENCE_RE.test(bare)) {
      inFence = !inFence;
      push(section === 'changelog' ? 'journal' : 'card', line);
      continue;
    }
    const h2 = !inFence ? H2_RE.exec(bare) : null;
    if (h2) {
      section = h2[1].toLowerCase().replace(/[^a-z0-9]/g, '') === 'changelog' ? 'changelog' : h2[1].toLowerCase();
      if (section === 'changelog') {
        hadChangelog = true;
        push('stripped', line);
        continue;
      }
      push('card', line);
      continue;
    }
    if (!inFence && !opts.keepTemplateComments && isTemplateComment(bare)) {
      templateComments++;
      push('stripped', line);
      // The blank line that only existed to separate the comment goes with it.
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === '' && section !== 'changelog') {
        push('stripped', lines[++i]);
      }
      continue;
    }
    if (section === 'changelog') {
      push('journal', line);
      continue;
    }
    if (
      opts.markLegacyTicks &&
      !inFence &&
      section === 'acceptance criteria' &&
      TICKED_RE.test(bare) &&
      !EVIDENCE_RE.test(bare)
    ) {
      const m = TICKED_RE.exec(bare)!;
      legacyTicks++;
      push('card', m[1]);
      push('added', ' (evidence: legacy)');
      push('card', line.slice(m[1].length));
      continue;
    }
    push('card', line);
  }

  // A card that ends in a run of blank lines (where the Changelog used to
  // follow) keeps one newline; the surplus is stripped, not lost.
  let lastCardAt = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].kind === 'card' || segs[i].kind === 'added') { lastCardAt = i; break; }
  }
  if (hadChangelog && lastCardAt >= 0 && segs[lastCardAt].kind === 'card') {
    const text = segs[lastCardAt].text;
    const m = /\n(?:[ \t\r]*\n)+$/.exec(text);
    if (m) {
      segs.splice(
        lastCardAt, 1,
        { kind: 'card', text: text.slice(0, m.index + 1) },
        { kind: 'stripped', text: text.slice(m.index + 1) },
      );
    }
  }

  const join = (...kinds: SegmentKind[]) => segs.filter((s) => kinds.includes(s.kind)).map((s) => s.text).join('');
  return {
    segments: segs,
    card: join('card', 'added'),
    journal: join('journal'),
    stripped: join('stripped'),
    added: join('added'),
    hadChangelog,
    templateComments,
    legacyTicks,
  };
}

/** True when a card still carries a `## Changelog` section (outside fences). */
export function cardHasChangelog(raw: string): boolean {
  let inFence = false;
  for (const line of raw.split('\n')) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (!inFence && /^##\s+changelog\s*$/i.test(line.trim())) return true;
  }
  return false;
}

/**
 * The CONTINUOUS fold: a card found carrying `## Changelog` (an old CLI, a
 * frozen app, an old merge driver, a pull) has it moved into the journal —
 * deduped by copy count, never dropped — and the section removed. The caller
 * holds the task's file lock. Returns how many entries the journal gained, or
 * null when the card had nothing to fold.
 */
export function foldCardChangelog(taskFile: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(taskFile, 'utf-8');
  } catch {
    return null;
  }
  if (!cardHasChangelog(raw)) return null;
  const split = splitCard(raw);
  // Journal first: a crash between the two writes leaves the entries in BOTH
  // places, which the next fold collapses by copy count — never in neither.
  const added = foldEntryTexts(dirname(taskFile), basename(taskFile, '.md'), splitEntryTexts(split.journal));
  writeFileSync(taskFile, split.card, 'utf-8');
  return added;
}
