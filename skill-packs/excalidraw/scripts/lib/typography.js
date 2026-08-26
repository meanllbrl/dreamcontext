// typography.js — the one place that knows how text MEASURES, WRAPS, and gets EMPHASISED.
//
// Why this file exists (the readability bug it fixes):
// boards used to render every word in Excalifont (fontFamily 5) at 15px on a 1.25 line height, in one
// undifferentiated block. A nine-line paragraph of handwriting with no leading and no emphasis is not
// a diagram, it is a wall — you cannot scan it, you can only slog through it. Three defaults changed:
//
//   FONT   hand-drawn → Nunito (fontFamily 6). Hand-drawn is for the DRAWING; anything meant to be
//          READ is set in a real UI sans. Identifiers/paths go to Cascadia (3), a true monospace.
//   SIZE   body 15 → 17. Below ~16px a bounded measure just makes the reader lean in.
//   LEAD   1.25 → 1.6 for body copy. Leading is what lets the eye find the next line.
//
// ...and one capability was added: EMPHASIS. Excalidraw has no rich text — an element has exactly one
// font, one size, one colour. The trick this file uses is to leave the paragraph as a SINGLE text
// element and paint the emphasis BEHIND it as geometry (a marker band, an underline, a code chip).
// That keeps `## Text Elements` one clean paragraph per block, so dreamcontext's recall still extracts
// readable prose instead of a confetti of styled word-fragments.
//
// MEASUREMENT IS MEASURED, NOT GUESSED. The advance tables below were produced by
// `scripts/diagrams/calibrate-excalidraw-fonts.mjs` (headless Chromium, the real font files
// Excalidraw ships, canvas measureText). A summed advance lands within 0.5% of the browser's own
// measurement of a line; the flat 0.58 constant this replaces was off by up to 30% depending on how
// much of the line was uppercase — which is exactly how labels used to spill out of their boxes.

// ---------- font registry ----------
// Excalidraw FONT_FAMILY ids. 5/6 need a modern Obsidian Excalidraw plugin (they are the plugin's own
// "Hand-drawn" / "Normal"); 3 is the long-standing code font.
const FONT = { sans: 6, hand: 5, code: 3 };
const FONT_ALIAS = {
  sans: 6, normal: 6, body: 6, nunito: 6, ui: 6,
  hand: 5, handdrawn: 5, 'hand-drawn': 5, sketch: 5, excalifont: 5,
  code: 3, mono: 3, cascadia: 3,
};
// Resolve `font:` (alias string or raw Excalidraw id) to an id. Unknown ⇒ the readable default.
function fontId(f) {
  if (typeof f === 'number' && isFinite(f)) return f;
  if (typeof f === 'string') {
    const k = FONT_ALIAS[f.toLowerCase()];
    if (k) return k;
  }
  return FONT.sans;
}

// ---------- line heights ----------
// Excalidraw's own default is 1.25, which is display leading, not reading leading.
const LH = {
  body: 1.6,    // paragraphs, callout copy, bullet items — the readable default
  compact: 1.4, // dense side notes, table cells, annotations
  tight: 1.25,  // labels inside a shape, axis ticks, chips — single-line-ish text
  title: 1.2,   // display type; big glyphs need less relative leading
};
// Height of a text element. THE INVARIANT: whoever emits a text element must derive its height with
// the SAME lineHeight it puts on the element, or Excalidraw draws the lines somewhere the layout did
// not reserve, and the next block lands on top of it.
function textH(lineCount, fontSize, lh) {
  return Math.round(lineCount * fontSize * (lh || LH.tight));
}

// ---------- measured glyph advances (multiples of fontSize) ----------
// Generated: node scripts/diagrams/calibrate-excalidraw-fonts.mjs
// Format is "advance": "every char with that advance" — compact, and still diffable by eye.
const ADVANCE_GROUPS = {
  6: { // Nunito — the body default
    '0.226': "'", '0.233': '!,.:;·‚‘’', '0.237': 'iıîíìï', '0.241': 'j', '0.261': ' ',
    '0.262': 'IÎÍÌÏ', '0.270': '|', '0.278': 'İ', '0.290': '/\\', '0.301': 'l', '0.324': '[]',
    '0.326': '()', '0.331': 'J', '0.340': 'f', '0.358': 't', '0.361': '`{}', '0.365': 'r',
    '0.373': '°', '0.405': '"„“”', '0.427': '-', '0.447': '?', '0.451': '*', '0.453': '«»',
    '0.465': 'cç', '0.466': 'z', '0.483': 's', '0.500': '_ş–', '0.508': 'k', '0.517': 'yÿ',
    '0.518': 'v', '0.524': '•', '0.530': 'x', '0.533': 'aâáàäãå', '0.534': 'eéèë', '0.548': 'L',
    '0.549': '≈≠≤≥', '0.551': 'F§', '0.556': 'ğ₺†‡', '0.560': 'oöóòõø', '0.565': 'uüûúù',
    '0.572': 'hnñ', '0.586': 'EÉÈË', '0.587': 'bdpq', '0.590': 'g', '0.593': 'Z', '0.596': '¶',
    '0.600': '0123456789#$+<=>^~±×÷€£', '0.601': 'Y', '0.607': 'T', '0.618': 'S', '0.624': 'ß',
    '0.634': 'K', '0.637': 'P', '0.645': '↑↓', '0.655': 'X', '0.667': 'Ş', '0.673': 'R',
    '0.675': 'CÇ', '0.679': 'B', '0.694': 'V', '0.700': '…', '0.701': '&', '0.729': 'G',
    '0.731': 'UÜÛÚÙ', '0.733': 'AÂÁÀÄÅ', '0.741': 'NÑ', '0.747': 'D', '0.764': 'H',
    '0.771': 'OQÖÓÒÕØ', '0.778': 'Ğ', '0.815': '©®', '0.844': 'w', '0.858': 'M', '0.861': 'm',
    '0.862': 'æ', '0.911': 'œ', '0.916': '⇒', '0.931': '™', '0.933': '%', '0.947': '@',
    '0.984': 'Æ', '1.000': '—→←', '1.049': 'Œ', '1.104': 'W',
  },
  5: { // Excalifont — the hand-drawn face
    '0.200': '·', '0.218': "'", '0.225': 'l', '0.239': '‚', '0.244': 'iıîíìï', '0.257': ',',
    '0.264': ':', '0.267': '‘', '0.274': '.', '0.278': 'İ', '0.298': ';', '0.299': '|',
    '0.304': '’', '0.314': '!', '0.328': 'j', '0.371': '"', '0.400': ' ', '0.402': ')',
    '0.411': '-', '0.412': 'r“°', '0.427': '1', '0.428': '„”', '0.441': '(', '0.466': '?',
    '0.472': '[', '0.497': ']f', '0.500': 'ş', '0.504': 'c{ç', '0.508': 'üûúù', '0.510': '^',
    '0.522': 'ÿ•', '0.525': '*v', '0.526': 'nñ', '0.530': 'y', '0.533': 'k', '0.537': 'ep',
    '0.539': 'q', '0.542': 'âáàäãå', '0.543': 'Ls', '0.544': '}', '0.545': 'IÎÍÌÏ', '0.548': 'u',
    '0.549': '≈≠≤≥†', '0.550': '+<=>±×÷', '0.551': 'éèë', '0.553': 't', '0.555': 'bg',
    '0.556': 'ğ₺§‡', '0.558': '7', '0.561': '/öóòõ', '0.564': 'Y', '0.567': 'h', '0.569': 'J',
    '0.572': 'z', '0.573': 'Hß', '0.576': 'a', '0.585': '4', '0.589': '\\', '0.591': 'x',
    '0.592': 'V', '0.600': '`o', '0.605': 'd', '0.608': '3', '0.613': 'K', '0.617': 'ø',
    '0.618': '5', '0.622': 'S', '0.628': 'X', '0.629': '9CÇ', '0.632': 'NÑ', '0.636': '8',
    '0.640': '6', '0.643': '¶', '0.645': '↑↓', '0.649': '«', '0.650': '®', '0.661': 'F',
    '0.663': 'm', '0.664': '0', '0.667': 'Ş', '0.668': '»', '0.669': '~', '0.670': '_',
    '0.676': 'AÂÁÀÄÅ', '0.693': 'w', '0.698': 'P', '0.700': '2', '0.702': '–', '0.707': 'EÉÈË',
    '0.709': '…', '0.710': '£', '0.713': '€', '0.718': '&', '0.721': '$', '0.730': 'UÜÛÚÙ',
    '0.736': 'R', '0.761': 'B', '0.766': 'M', '0.767': 'OÖÓÒÕ', '0.768': 'Q', '0.772': 'Ø',
    '0.778': 'Ğ', '0.780': 'DG', '0.783': '#', '0.786': 'W', '0.829': '@', '0.832': 'Z',
    '0.857': 'T', '0.858': '©', '0.909': 'æ', '0.916': '⇒', '0.920': 'œ', '0.928': '%',
    '0.935': '—', '1.000': '→←', '1.028': 'Æ™', '1.210': 'Œ',
  },
  3: { '0.586': null }, // Cascadia — monospace: every covered glyph is 0.586 (see MONO below)
};
const MONO = { 3: 0.586 };

// advance lookup: Map<fontId, Map<char, advance>>
const TABLES = new Map();
for (const [fam, groups] of Object.entries(ADVANCE_GROUPS)) {
  const m = new Map();
  for (const [adv, chars] of Object.entries(groups)) {
    if (chars == null) continue;
    for (const ch of chars) m.set(ch, Number(adv));
  }
  TABLES.set(Number(fam), m);
}

// Glyphs no table covers (CJK, emoji, arrows beyond the common few) render roughly square.
function isWideGlyph(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2190 && code <= 0x21ff) ||
    (code >= 0x2300 && code <= 0x23ff) || (code >= 0x25a0 && code <= 0x27bf) ||
    (code >= 0x2b00 && code <= 0x2bff) || (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x1f000 && code <= 0x1faff) || (code >= 0x1f1e6 && code <= 0x1f1ff)
  );
}

function advance(ch, fam) {
  const id = fontId(fam);
  const t = TABLES.get(id);
  if (t) { const a = t.get(ch); if (a != null) return a; }
  if (MONO[id] != null && !isWideGlyph(ch.codePointAt(0))) return MONO[id];
  return isWideGlyph(ch.codePointAt(0)) ? 1.05 : (MONO[id] != null ? MONO[id] : 0.56);
}

function glyphW(ch, fontSize, fam) { return fontSize * advance(ch, fam); }
function measureText(s, fontSize, fam) {
  let w = 0;
  for (const ch of String(s)) w += glyphW(ch, fontSize, fam);
  return w;
}
// Widest logical line of a (possibly multi-line) string.
function widestLine(s, fontSize, fam) {
  let w = 0;
  for (const l of String(s).split('\n')) w = Math.max(w, measureText(l, fontSize, fam));
  return w;
}

// ---------- wrapping ----------
// Greedy word-wrap to a pixel width that ALSO reports, per output line, the [start,end) slice of the
// input it came from. The index map is what makes emphasis possible: a `==span==` given in input
// coordinates has to be located in the wrapped, laid-out line to be painted behind.
// Honors existing \n, preserves a logical line's leading indent on every line it wraps into (hanging
// indents survive), and hard-breaks a single word wider than the box (long URLs, table names).
const EPS = 0.5; // sub-pixel slack; see the hard-break branch below for why this is not cosmetic
function wrapLines(text, fontSize, width, fam) {
  const src = String(text);
  const out = [];
  let pos = 0;
  for (const logical of src.split('\n')) {
    const lineStart = pos;
    pos += logical.length + 1; // +1 for the \n we split on
    const indent = (logical.match(/^[ \t]*/) || [''])[0];
    const avail = Math.max(1, width - measureText(indent, fontSize, fam));
    const body = logical.slice(indent.length);
    const bodyOffset = lineStart + indent.length;
    if (!body.trim()) { out.push({ text: '', start: lineStart, end: lineStart, indent: '' }); continue; }

    // tokenize into words with their absolute index ranges
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(body))) words.push({ w: m[0], start: bodyOffset + m.index, end: bodyOffset + m.index + m[0].length });

    // A line's text is always a CONTIGUOUS SLICE of the source, never words re-joined with ' '.
    // Re-joining looks equivalent and isn't: it collapses runs of whitespace, so a bullet's "•  "
    // gutter came back as "• " after the builder re-wrapped the already-baked text — silently
    // shifting every character on that line ~4px left of where the emphasis geometry was placed.
    let cur = null; // { start, end }
    const textOf = (c) => src.slice(c.start, c.end);
    const push = () => { if (cur) { out.push({ text: textOf(cur), start: cur.start, end: cur.end, indent }); cur = null; } };
    for (const tok of words) {
      let word = tok.w, wStart = tok.start;
      // a word wider than the whole measure: chop it into box-width pieces.
      // EPS matters more than it looks. A caller that sizes a column as `measure(cell) + pad*2` and
      // then wraps to `colW - pad*2` is doing (a + p) - p in floating point, which can land a hair
      // BELOW `a` — and a single word one ten-thousandth of a pixel too wide takes this branch and
      // ships as "Paywal / l". Overflowing by a sub-pixel is invisible; chopping a word is not.
      while (measureText(word, fontSize, fam) > avail + EPS) {
        let acc = '';
        for (const ch of word) { if (acc && measureText(acc + ch, fontSize, fam) > avail) break; acc += ch; }
        push();
        out.push({ text: acc, start: wStart, end: wStart + acc.length, indent });
        word = word.slice(acc.length); wStart += acc.length;
        if (!word) break;
      }
      if (!word) continue;
      if (!cur) { cur = { start: wStart, end: wStart + word.length }; continue; }
      const candEnd = wStart + word.length;
      if (measureText(src.slice(cur.start, candEnd), fontSize, fam) > avail) {
        push();
        cur = { start: wStart, end: candEnd };
      } else {
        cur.end = candEnd;
      }
    }
    push();
  }
  return out;
}

// The string form: text with the wrap baked in as \n. Baking matters — a width-set text element with
// no hard newlines gets re-flowed by the renderer into one over-wide line.
function wrapToWidth(text, fontSize, width, fam) {
  return wrapLines(text, fontSize, width, fam).map((l) => l.indent + l.text).join('\n');
}

// ---------- inline emphasis markup ----------
// `**strong**`  → the phrase is underlined in the block's accent colour
// `==mark==`    → a highlighter band is painted behind the phrase
// `` `code` ``  → a soft chip is painted behind the phrase (identifiers, paths, table names)
//
// The markers are STRIPPED from the emitted text: the element carries clean prose, the emphasis is
// geometry behind it. Nested markers are not supported (and not needed).
// ONE scan, so span offsets are only ever expressed in the output string's coordinates — a second
// pass over already-rewritten text is where this kind of parser normally goes wrong.
const MARKUP_RE = /==([^=\n]+)==|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
function parseMarkup(src) {
  const input = String(src);
  let out = '', last = 0, m;
  const spans = [];
  MARKUP_RE.lastIndex = 0;
  while ((m = MARKUP_RE.exec(input))) {
    out += input.slice(last, m.index);
    const kind = m[1] != null ? 'mark' : m[2] != null ? 'strong' : 'code';
    const inner = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3];
    spans.push({ start: out.length, end: out.length + inner.length, kind });
    out += inner;
    last = m.index + m[0].length;
  }
  out += input.slice(last);
  return { text: out, spans };
}
function hasMarkup(s) { MARKUP_RE.lastIndex = 0; return MARKUP_RE.test(String(s)); }

// Emphasis colours. Deliberately soft: the band must sit UNDER the words, not shout over them.
const EMPHASIS = {
  mark: '#ffec99',     // highlighter yellow
  markStroke: '#f2cc4b',
  code: '#f1f3f5',     // code chip
  codeStroke: '#dee2e6',
  strong: '#1971c2',   // underline
};

// A highlighter is invisible on a surface its own colour. The default mark (#ffec99) IS the palette's
// yellow fill, and the default code chip (#f1f3f5) is a shade off the gray fill — so `==…==` inside a
// yellow callout and `` `…` `` inside a gray one rendered as nothing at all. Nothing catches that: the
// element is there, the geometry is right, the audit is clean, and the emphasis is simply gone.
// So a builder that knows what it is painting ON passes that fill here and gets a colour that shows.
const MARK_CHOICES = ['#ffec99', '#ffd8a8', '#a5d8ff', '#b2f2bb', '#d0bfff'];
const CODE_CHOICES = ['#f1f3f5', '#dee2e6', '#e9ecef', '#f8f9fa'];
function rgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function colorDist(a, b) {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return Infinity;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
// First candidate far enough from `bg` to actually read; falls back to the most distant one.
function contrastPick(bg, choices, minDist = 48) {
  if (!bg || bg === 'transparent') return choices[0];
  for (const c of choices) if (colorDist(bg, c) >= minDist) return c;
  return choices.slice().sort((a, b) => colorDist(bg, b) - colorDist(bg, a))[0];
}
// Emphasis colours adjusted for the surface they sit on.
function emphasisOn(bgFill) {
  return {
    markColor: contrastPick(bgFill, MARK_CHOICES),
    codeColor: contrastPick(bgFill, CODE_CHOICES, 18),
  };
}

// Turn input-coordinate spans into the rectangles/underlines that sit behind a wrapped block.
// `lines` come from wrapLines(), so each carries the input slice it renders — that is what lets a
// span be located after wrapping. Returns ElementSpec[] to be pushed BEFORE the text element.
function spanDecorations(o) {
  const {
    x = 0, y = 0, lines = [], spans = [], fontSize = 17, font = FONT.sans, lh = LH.body,
    align = 'left', width = 0, strongColor = EMPHASIS.strong, markColor = EMPHASIS.mark,
    codeColor = EMPHASIS.code, group,
  } = o;
  if (!spans.length) return [];
  const fam = fontId(font);
  const lineH = fontSize * lh;
  const out = [];
  lines.forEach((ln, i) => {
    if (!ln.text) return;
    const indentW = measureText(ln.indent || '', fontSize, fam);
    const lineW = measureText(ln.text, fontSize, fam) + indentW;
    const lx = align === 'center' ? x + (width - lineW) / 2
      : align === 'right' ? x + width - lineW
      : x;
    const top = y + i * lineH;
    for (const s of spans) {
      const from = Math.max(s.start, ln.start);
      const to = Math.min(s.end, ln.end);
      if (to <= from) continue;
      const pre = ln.text.slice(0, from - ln.start);
      const seg = ln.text.slice(from - ln.start, to - ln.start);
      if (!seg) continue;
      const sx = lx + indentW + measureText(pre, fontSize, fam);
      const sw = measureText(seg, fontSize, fam);
      if (s.kind === 'strong') {
        // sit the rule just below the baseline of THIS line
        const uy = top + lineH * 0.5 + fontSize * 0.46;
        // roughness 0 is not a style choice: rough.js OVERSHOOTS a sketchy line's endpoints, and an
        // underline that runs a few px past its phrase reads as underlining the punctuation after it.
        out.push({ type: 'line', points: [[sx, uy], [sx + sw, uy]], strokeColor: strongColor, strokeWidth: 2, roughness: 0, group });
      } else {
        const pad = s.kind === 'code' ? 3 : 2;
        const bandH = fontSize * 1.08;
        out.push({
          type: 'rectangle',
          x: sx - pad, y: top + (lineH - bandH) / 2,
          width: sw + pad * 2, height: bandH,
          strokeColor: s.kind === 'code' ? EMPHASIS.codeStroke : 'transparent',
          backgroundColor: s.kind === 'code' ? codeColor : markColor,
          fillStyle: 'solid', strokeWidth: 1, roughness: 0, roundness: true, group,
        });
      }
    }
  });
  return out;
}

// ---------- the block primitive everything else is built on ----------
let _tbg = 0;
// One paragraph → decorations + ONE text element. Returns { els, w, h, lineCount }.
// `width` is a MAXIMUM: the block reports the width it actually used, so callers can hug their copy.
function textBlock(o) {
  const {
    x = 0, y = 0, text = '', width = 620, fontSize = 17, font = 'sans', color = '#1e1e1e',
    align = 'left', lh = LH.body, markup = true, group = undefined,
    strongColor = EMPHASIS.strong, markColor = EMPHASIS.mark, codeColor = EMPHASIS.code,
    fit = true, bullet = null,
  } = o;
  const fam = fontId(font);
  const parsed = markup && hasMarkup(text) ? parseMarkup(text) : { text: String(text), spans: [] };
  // A bullet is applied AFTER markup parsing and OUTSIDE the wrapped text, so the marker prefix never
  // shifts the span offsets and continuation lines hang under the first word rather than under the
  // bullet. The hanging indent is spaces chosen to match the bullet's real measured width.
  const bw = bullet ? measureText(bullet, fontSize, fam) : 0;
  const lines = wrapLines(parsed.text, fontSize, Math.max(20, width - bw), fam);
  if (bullet) {
    const spaceW = Math.max(1, measureText(' ', fontSize, fam));
    const hang = ' '.repeat(Math.max(1, Math.round(bw / spaceW)));
    lines.forEach((l, i) => { l.indent = (i === 0 ? bullet : hang) + (l.indent || ''); });
  }
  const used = fit
    ? Math.min(width, Math.max(1, Math.ceil(Math.max(...lines.map((l) => measureText(l.indent + l.text, fontSize, fam)), 1))))
    : width;
  const baked = lines.map((l) => l.indent + l.text).join('\n');
  const h = textH(lines.length, fontSize, lh);
  // A decorated block is ONE unit: the bands belong to their words. Grouping them also tells the
  // build-time auditors that a chip touching the chip beside it is intentional, not a collision.
  const g = group != null ? group : (parsed.spans.length ? `tb${++_tbg}` : undefined);
  const els = spanDecorations({ x, y, lines, spans: parsed.spans, fontSize, font: fam, lh, align, width: used, strongColor, markColor, codeColor, group: g });
  els.push({ type: 'text', x, y, text: baked, fontSize, color, width: used, align, fontFamily: fam, lineHeight: lh, group: g });
  return { els, w: used, h, lineCount: lines.length };
}

module.exports = {
  FONT, FONT_ALIAS, fontId, LH, textH, EMPHASIS, emphasisOn, contrastPick,
  advance, glyphW, measureText, widestLine, isWideGlyph,
  wrapLines, wrapToWidth,
  parseMarkup, hasMarkup, spanDecorations, textBlock,
};
