/**
 * Curated markdown compressors for the SessionStart snapshot's demotion ladder.
 *
 * The ladder's founding rule is that a section demotes through CURATED renders,
 * never a positional slice — a raw cut is exactly the harness behaviour the
 * budget module exists to prevent. These are the transforms that make a curated
 * render possible for prose the snapshot does not control: a project's soul,
 * user and memory files, which grow to tens of KB of bullet lists on a mature
 * vault and are the single largest term in the snapshot.
 *
 * The strategy is to keep every item's TITLE and drop its RATIONALE. A rule the
 * agent can still see by name, next to the path of the file that holds its full
 * text, is recoverable; a rule that vanished is not.
 *
 * Two properties are load-bearing and are covered by tests here because other
 * suites depend on them:
 *
 *   1. HEADING LINES PASS THROUGH VERBATIM AT EVERY RUNG. A block built from
 *      heading lines is therefore incompressible, which is how the snapshot
 *      test fixtures force the ladder to its floors without any opt-in feature.
 *   2. A LEADING YAML FRONTMATTER BLOCK IS STRIPPED before compressing. Every
 *      core file opens with one; it matches no structural branch below and would
 *      otherwise be swept into the paragraph path and mangled. A `---` that is
 *      NOT leading frontmatter is a thematic break and passes through verbatim.
 *
 * Pure string -> string. No I/O, no dependency on the snapshot builder or the
 * budget module (both of which depend on this one).
 */

/** Compression aggressiveness for one ladder rung. */
export interface CompressOptions {
  /** Char budget for a single list item / table row, after its title. */
  itemChars: number;
  /** Char budget for a single paragraph or blockquote line. */
  paraChars: number;
  /**
   * Keep only each item's TITLE — its bold lead, else its first clause — and
   * drop the sentence remainder entirely. The deepest rung.
   */
  titleOnly?: boolean;
}

/** `1.` / `1)` are as much a list as `- ` — the largest live soul uses them. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s/;
const THEMATIC_BREAK = /^\s*-{3,}\s*$/;
const BLOCKQUOTE = /^(\s*>)\s?(.*)$/;
const TABLE_ROW = /^(\s*)(\|.*)$/;
const FENCE = /^\s*```/;

/**
 * A leading YAML frontmatter block, LF or CRLF. Anchored at position 0 only —
 * a `---` further down the file is a thematic break, not frontmatter.
 */
const LEADING_FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** A `**bold**` lead, with the punctuation that usually follows it consumed. */
const BOLD_LEAD = /^(\*\*[^*]+?\*\*)\s*[-:—]?\s*/;

/**
 * First-clause split for title-only mode. Deliberately does NOT split on a bare
 * `.` — that mangles version numbers (`v0.18.0`) and abbreviations (`e.g.`). The
 * `:` split requires trailing whitespace (or end of string) for the same reason:
 * a scheme-relative URL (`https://tilki.app`) carries a colon with no space
 * after it, and splitting there is how an early prototype turned a project's
 * flagship product line into `Flagship: **kitUP** (https`. Titles in these files
 * are always written `Name: rest`, so the space is a reliable discriminator.
 * The `{8,}` floor keeps a leading `a: b` from collapsing to `a`.
 */
const FIRST_CLAUSE = /^(.{8,}?)(?::\s|:$| — | - )/;

/** Sentence boundary. Lookbehind keeps the terminating punctuation attached. */
const SENTENCE_END = /(?<=[.!?])(\s|$)/;

/** Strip a leading frontmatter block. A non-leading `---` is left alone. */
function stripLeadingFrontmatter(text: string): string {
  return text.replace(LEADING_FRONTMATTER, '');
}

/**
 * Cut at the last word boundary that fits and mark the elision. Used only for
 * PROSE remainders — never for a title, a slug, or any other identifier the
 * agent needs to be able to act on.
 */
export function capAtWordBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;
  if (cap <= 1) return '…';
  const cut = text.lastIndexOf(' ', cap - 1);
  const head = cut > 0 ? text.slice(0, cut) : text.slice(0, cap - 1);
  return `${head.trimEnd()}…`;
}

/**
 * Compress one item's body to its title plus (unless `titleOnly`) as much of its
 * first sentence as fits.
 *
 * A `**bold**` lead is the item's NAME and is kept whole even when it alone
 * exceeds `cap` — a half-printed rule name is worse than a long one, because the
 * agent cannot match it back to the file.
 *
 * Exported because callers outside a markdown block need the same rule: the
 * demoted knowledge index compresses each pinned entry's `description` field
 * with it, so a pin line and a soul bullet elide identically.
 */
export function shrinkBody(raw: string, cap: number, titleOnly: boolean): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') return '';

  const bold = BOLD_LEAD.exec(text);
  const lead = bold ? bold[1] : '';
  const rest = bold ? text.slice(bold[0].length) : text;

  if (titleOnly) {
    if (lead) return lead;
    const clause = FIRST_CLAUSE.exec(text);
    return capAtWordBoundary(clause ? clause[1].trim() : text, cap);
  }

  const boundary = rest.search(SENTENCE_END);
  const sentence = boundary === -1 ? rest : rest.slice(0, boundary + 1).trim();
  if (!lead) return capAtWordBoundary(sentence, cap);

  const room = Math.max(0, cap - lead.length - 1);
  const tail = capAtWordBoundary(sentence, room);
  return tail === '' || tail === '…' ? lead : `${lead} ${tail}`;
}

/**
 * Compress a markdown block through one ladder rung.
 *
 * Structure survives; prose shrinks. Headings, thematic breaks and (outside
 * title-only mode) fenced code pass through verbatim. List items keep their
 * original marker and indentation, so an ordered list stays numbered and a
 * nested list stays nested. Continuation lines fold into the item they belong
 * to before it is compressed.
 */
export function compressMarkdownBlock(text: string, opts: CompressOptions): string {
  const titleOnly = opts.titleOnly === true;
  const lines = stripLeadingFrontmatter(text).split('\n');
  const out: string[] = [];

  let itemBody: string | null = null;
  let itemIndent = '';
  let itemMarker = '';
  let paragraph: string[] = [];
  let fence: string[] | null = null;

  const flushItem = (): void => {
    if (itemBody === null) return;
    const body = shrinkBody(itemBody, opts.itemChars, titleOnly);
    out.push(`${itemIndent}${itemMarker} ${body}`.trimEnd());
    itemBody = null;
  };
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const body = shrinkBody(paragraph.join(' '), opts.paraChars, titleOnly);
    if (body !== '') out.push(body);
    paragraph = [];
  };
  const flushBoth = (): void => {
    flushItem();
    flushParagraph();
  };

  for (const line of lines) {
    if (FENCE.test(line)) {
      if (fence === null) {
        flushBoth();
        fence = [line];
      } else {
        fence.push(line);
        // A fence is verbatim or it is a placeholder — never a partial listing.
        if (titleOnly) out.push(`\`(code block, ${fence.length - 2} lines — see the source file)\``);
        else out.push(...fence);
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.push(line);
      continue;
    }

    if (HEADING.test(line) || THEMATIC_BREAK.test(line)) {
      flushBoth();
      out.push(line);
      continue;
    }

    const quote = BLOCKQUOTE.exec(line);
    if (quote) {
      flushBoth();
      out.push(`${quote[1]} ${capAtWordBoundary(quote[2].trim(), opts.paraChars)}`.trimEnd());
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushBoth();
      itemIndent = item[1];
      itemMarker = item[2];
      itemBody = item[3];
      continue;
    }

    const row = TABLE_ROW.exec(line);
    if (row) {
      flushBoth();
      out.push(`${row[1]}${shrinkBody(row[2], opts.itemChars, titleOnly)}`.trimEnd());
      continue;
    }

    if (line.trim() === '') {
      flushBoth();
      out.push('');
      continue;
    }

    // Anything else continues the item in progress (indented or not), else it is
    // paragraph prose.
    if (itemBody !== null) itemBody += ` ${line.trim()}`;
    else paragraph.push(line.trim());
  }

  if (fence !== null) out.push(...fence); // unterminated fence: keep it, lose nothing
  flushBoth();

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Keep as many WHOLE rendered items as fit `budget` chars, then hand the
 * remainder to `more` for a named-count tail.
 *
 * This is the byte-aware primitive the ladder was missing: rungs used to cap
 * ITEM COUNTS, so a 20-decision brain and a 200-decision brain landed in wildly
 * different envelopes at the same rung.
 *
 * An item is never split — the tail reports what was omitted and how to get it
 * back. At least one item is always emitted for a non-empty input, so a single
 * oversized item degrades to "one item over budget", never to "nothing".
 */
export function packToCharBudget<T>(
  items: T[],
  render: (item: T) => string,
  budget: number,
  more: (rest: T[]) => string | null,
): string[] {
  if (items.length === 0) return [];

  const kept: string[] = [];
  let used = 0;
  let index = 0;
  for (const item of items) {
    const line = render(item);
    const cost = line.length + 1; // the '\n' that joins it
    if (kept.length > 0 && used + cost > budget) break;
    kept.push(line);
    used += cost;
    index++;
  }

  const rest = items.slice(index);
  if (rest.length === 0) return kept;

  const tail = more(rest);
  if (tail !== null) kept.push(tail);
  return kept;
}

/** Group digits so a size in the provenance footer is readable at a glance. */
function withThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Render a core file (soul, user, …) for a compressed ladder rung, with an
 * honest provenance footer.
 *
 * The footer is the contract that makes compression acceptable: without it the
 * agent cannot tell a compressed soul from a short one. It says what survived,
 * what did not, where the full text is, and which command diagnoses the bloat —
 * in ~135 chars, because it is paid TWICE (soul + user) out of the same budget
 * the compression exists to defend. The longer explanation it used to carry is
 * already in the over-budget banner whenever one is shown, and in `doctor`
 * otherwise, so spending ~250 chars per file to repeat it was net negative.
 *
 * `totalLines` is no longer rendered (chars are what the budget spends) but stays
 * in the signature: it is part of the provenance the callers already compute.
 */
export function compressedCoreFile(
  body: string,
  relPath: string,
  totalChars: number,
  totalLines: number,
  opts: CompressOptions,
): string {
  void totalLines;
  const compressed = compressMarkdownBlock(body, opts);
  const footer =
    '_Compressed for budget — titles kept, rationale dropped. Full text: '
    + `\`${relPath}\` (${withThousands(totalChars)} chars). \`dreamcontext doctor\`._`;
  return compressed === '' ? footer : `${compressed}\n\n${footer}`;
}
