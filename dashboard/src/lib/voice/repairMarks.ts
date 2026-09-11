/**
 * WHERE THE CORRECTOR'S REPAIRS SIT IN THE TEXT — so they can be drawn ON the words instead
 * of listed beside them.
 *
 * ── WHY THIS IS WORTH A MODULE ──────────────────────────────────────────────────────────
 * The confirmation step is the safety control of the whole voice mode: a machine-altered
 * sentence is never sent on the owner's behalf without them seeing what changed. What it was
 * ASKING of them, though, was arithmetic — `Changed Dremontext → dreamcontext +2 more` is a
 * list, and the reader has to map each entry back onto a sentence sitting a few pixels above
 * it, then decide. An underline under the repaired word asks nothing: the position IS the
 * mapping.
 *
 * ── WHY THE POSITIONS COME FROM THE SERVER ──────────────────────────────────────────────
 * `changedOps` throws the `equal` ops away, so the list the client receives has no positional
 * information left in it at all — and re-deriving it by searching for the word is wrong the
 * moment a sentence repeats one ("task'ı sil, sonra task'ı yeniden aç"). The alignment walk
 * already knows the index; it now carries it (`AlignOp.at`).
 *
 * ── WHAT IS NOT MARKED, AND WHY THAT IS NOT A GAP ───────────────────────────────────────
 * A DELETE has nothing on screen to underline — the word is gone. Inventing a mark for it
 * (tinting the gap, or the following word) would tell the reader that a word they can see
 * was touched, which is the one thing a confirmation must never do. Deletions are reported
 * in words instead; see the composer's residual note.
 */

/** One aligned change, as the composer receives it from `/api/agent/voice/correct`. */
export interface RepairOp {
  kind: 'equal' | 'substitute' | 'insert' | 'delete';
  from: string;
  to: string;
  similarity?: number;
  /** Token index of `to` in the corrected text — see `AlignOp.at` in `src/lib/voice/align.ts`. */
  at?: number;
}

/** A character range in the DRAFT that the corrector wrote. */
export interface RepairMark {
  start: number;
  end: number;
  /** What was actually heard, for the note. `''` for an inserted word — nothing was heard. */
  from: string;
  /** Drawn harder. A replacement far from what was spoken is worth a second look; the
   *  distance decides how LOUDLY, never whether (see `align.ts`'s header). */
  far: boolean;
}

/** Below this, a substitution is drawn harder. Matches the threshold the old chip row used,
 *  so the loudness rule did not silently change when its presentation did. */
export const FAR_SIMILARITY = 0.6;

/** Every whitespace-separated token of `text`, with where it starts. */
export function tokenSpans(text: string): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ text: m[0], index: m.index });
  return out;
}

/**
 * The marks to draw over `draft`, given the corrected text and its changed ops.
 *
 * `draft` is not always `corrected`: a transcript that arrived while the owner was typing is
 * APPENDED to what they wrote, so the corrected sentence sits at an offset. Locating it with
 * `indexOf` handles both cases with one rule — and a draft that no longer contains it (the
 * owner edited the sentence) yields NO marks, which is the correct answer rather than a
 * fallback: marks computed against text that has moved would point at the wrong words, and a
 * confirmation that points at the wrong word is worse than one that points at nothing.
 */
export function repairMarks(draft: string, corrected: string, ops: readonly RepairOp[]): RepairMark[] {
  if (!draft || !corrected || ops.length === 0) return [];
  const base = draft.lastIndexOf(corrected);
  if (base < 0) return [];

  const spans = tokenSpans(corrected);
  const marks: RepairMark[] = [];
  for (const op of ops) {
    // Only the ops that PUT a word on screen can be marked. See the header on deletes.
    if (op.kind !== 'substitute' && op.kind !== 'insert') continue;
    if (typeof op.at !== 'number') continue;
    const span = spans[op.at];
    if (!span) continue;
    marks.push({
      start: base + span.index,
      end: base + span.index + span.text.length,
      from: op.from,
      far: (op.similarity ?? 1) < FAR_SIMILARITY,
    });
  }
  marks.sort((a, b) => a.start - b.start);
  // Overlaps cannot happen from a well-formed alignment (one op per corrected token), but a
  // stale `at` from an older server would produce them, and two marks over one range renders
  // as a doubled box. Dropping the later one keeps the picture honest either way.
  return marks.filter((m, i) => i === 0 || m.start >= marks[i - 1].end);
}

/** What was heard, for the words that were replaced — the note under the field. Insertions
 *  are excluded: nothing was heard for them, so "heard: (nothing)" would be noise. */
export function heardWords(ops: readonly RepairOp[]): string[] {
  return ops.filter((o) => o.kind === 'substitute' && o.from).map((o) => o.from);
}

/** Words the corrector REMOVED. They have no position on screen, so they are said in words. */
export function droppedWords(ops: readonly RepairOp[]): string[] {
  return ops.filter((o) => o.kind === 'delete' && o.from).map((o) => o.from);
}

export interface DraftSegment {
  text: string;
  mention?: boolean;
  /** Set on a segment that the corrector wrote. */
  repair?: boolean;
  far?: boolean;
}

/**
 * Split already-segmented draft text again at the repair boundaries.
 *
 * Layered rather than merged into `mentionSegments` on purpose: mentions are a property of
 * what the owner TYPED and repairs are a property of what the machine CHANGED. They are
 * computed by different code for different reasons and they can overlap (a corrected `@peer`
 * is entirely possible), so the mention pass keeps its own rules and this one subdivides
 * whatever it produced.
 */
export function applyRepairSegments(
  segments: readonly { text: string; mention: boolean }[],
  marks: readonly RepairMark[],
): DraftSegment[] {
  if (marks.length === 0) return segments.map((s) => ({ text: s.text, mention: s.mention }));
  const out: DraftSegment[] = [];
  let at = 0;
  for (const seg of segments) {
    const segStart = at;
    const segEnd = at + seg.text.length;
    at = segEnd;
    let cursor = segStart;
    for (const mark of marks) {
      if (mark.end <= cursor || mark.start >= segEnd) continue;
      const from = Math.max(cursor, mark.start);
      const to = Math.min(segEnd, mark.end);
      if (from > cursor) out.push({ text: seg.text.slice(cursor - segStart, from - segStart), mention: seg.mention });
      out.push({
        text: seg.text.slice(from - segStart, to - segStart),
        mention: seg.mention,
        repair: true,
        far: mark.far,
      });
      cursor = to;
    }
    if (cursor < segEnd) out.push({ text: seg.text.slice(cursor - segStart), mention: seg.mention });
  }
  return out;
}
