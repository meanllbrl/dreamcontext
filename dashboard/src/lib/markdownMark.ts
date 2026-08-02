import { marked, type Tokens, type TokenizerAndRendererExtension } from 'marked';

/**
 * `==highlighted==` → `<mark>` — the highlighter pen a long answer needs.
 *
 * WHY: bold is the only emphasis markdown gives an agent, and it is already doing structural
 * work (a term, a label, a warning word). In a long answer — a review report, a findings list —
 * everything ends up bold and nothing stands out; the owner's report (08-02) is that the
 * important parts are hard to FIND, not hard to read. A marker stroke is a different channel:
 * bold says "this is a term", a highlight says "your eye goes here first".
 *
 * The syntax is the one people already know from Obsidian / Notion / Bear, so it costs the
 * agent nothing to learn and degrades to literal `==text==` anywhere else (a task doc opened
 * in another editor still reads fine).
 *
 * Registration is GLOBAL, on purpose: `marked` is a singleton and every markdown surface in the
 * dashboard shares it (chat answers, task bodies, council transcripts). One import of this
 * module — `markdownBlocks.ts`, which every render path already goes through — arms all of
 * them, and `styles/global.css` styles bare `mark` for the same reason.
 *
 * SAFETY: the extension emits a `<mark>` element and nothing else; the caller still runs the
 * whole rendered block through DOMPurify (`mark` and `class` are in its default allowlist).
 */

/**
 * Deliberately conservative, because `==` is also just two characters people type:
 *   • `(?=[^\s=])` — no space or `=` after the opener, so `a == b`, `x ===  y` and `====` in
 *     prose are never a highlight
 *   • `[^\s=]` before the closer — same on the other end, and it forbids the empty `====`
 *
 * It DOES cross a soft line break, and that is a decision rather than an oversight: an agent
 * hard-wraps prose at ~100 columns, so the highlights worth painting — a whole load-bearing
 * clause — routinely straddle one. A single-line rule would have dropped exactly those and
 * left the marker for short phrases only. The blast radius stays small anyway: inline
 * tokenizing runs per BLOCK, so the most an unbalanced `==` can reach is the end of its own
 * paragraph, and it needs a second non-space-adjacent `==` in that paragraph to match at all.
 *
 * Code spans need no special case: marked tokenizes a backticked run BEFORE this extension
 * ever sees the position, so `` `if (a == b)` `` stays code.
 */
const MARK_RE = /^==(?=[^\s=])([\s\S]*?[^\s=])==/;

/**
 * The pens. Yellow is the default and says ATTENTION; the other two say what KIND of
 * attention, which is the thing a single-colour marker cannot do — `==FAIL==` in yellow marks
 * the word without saying it is bad (owner report 08-02).
 *
 * The colour rides on one character right after the opener, so an unrendered `==!FAIL==` still
 * reads as "!FAIL" rather than as markup. The trailing `(?=[a-zA-Z])` is what keeps ordinary
 * prose out: `==+1 to that==` and `==!== ` are not pens, they are text — a highlight has to
 * start with a WORD to be coloured.
 */
const PENS: Record<string, string> = { '!': 'mark-alarm', '+': 'mark-good' };
const PEN_RE = /^([!+])(?=[a-zA-Z])/;

const markExtension: TokenizerAndRendererExtension = {
  name: 'mark',
  level: 'inline',
  // Where marked should stop chunking plain text and try this extension again. Getting this
  // wrong doesn't corrupt output, it just means a highlight deep in a paragraph is missed.
  start(src: string) {
    const i = src.indexOf('==');
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = MARK_RE.exec(src);
    if (!m) return undefined;
    const pen = PEN_RE.exec(m[1]);
    const text = pen ? m[1].slice(1) : m[1];
    return {
      type: 'mark',
      raw: m[0],
      text,
      pen: pen ? PENS[pen[1]] : '',
      // Inline-tokenized, so a highlight can carry a link, code or bold inside it.
      tokens: this.lexer.inlineTokens(text),
    };
  },
  renderer(token: Tokens.Generic) {
    const cls = typeof token.pen === 'string' && token.pen ? ` class="${token.pen}"` : '';
    return `<mark${cls}>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
  },
};

marked.use({ extensions: [markExtension] });

/** Exported for the tests — the module's real job is the side effect above. */
export const MARK_EXTENSION_NAME = markExtension.name;
