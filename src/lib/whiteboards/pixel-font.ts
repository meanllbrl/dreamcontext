/**
 * The pixel font `whiteboard render` writes text with: 5×7 capitals in an 11-row cell (two
 * rows above for accents on capitals, seven for the body, two below for descenders), six
 * pixels of advance. It is a layout proof, not typography: it shows WHERE text sits, how it
 * wraps and whether it fits its box, with no font file and no browser.
 *
 * Accented letters are composed: a character is split with NFD into a base glyph and its
 * combining marks, so Turkish ç ğ ö ş ü İ (and é, â, ñ, …) come out of the ASCII table.
 * `ı` has its own glyph. Anything else draws as a hollow box.
 */

export const FONT_COLS = 5;
export const FONT_ADVANCE = 6;
export const FONT_ROWS = 11;
/** Row of the cell where the 7-row capital body starts (rows 0-1 hold accents on capitals). */
const BODY = 2;

/**
 * Glyph blocks: `chars` and nine body rows (cap height 7 + 2 descender rows), each row the
 * glyphs side by side, 5 columns each, separated by one space. `#` is ink.
 */
const BLOCKS: { chars: string; rows: string[] }[] = [
  {
    chars: 'ABCDEFGHIJKLM',
    rows: [
      '.###. ####. .###. ####. ##### ##### .###. #...# .###. ..### #...# #.... #...#',
      '#...# #...# #...# #...# #.... #.... #...# #...# ..#.. ...#. #..#. #.... ##.##',
      '#...# #...# #.... #...# #.... #.... #.... #...# ..#.. ...#. #.#.. #.... #.#.#',
      '##### ####. #.... #...# ####. ####. #.### ##### ..#.. ...#. ##... #.... #.#.#',
      '#...# #...# #.... #...# #.... #.... #...# #...# ..#.. ...#. #.#.. #.... #...#',
      '#...# #...# #...# #...# #.... #.... #...# #...# ..#.. #..#. #..#. #.... #...#',
      '#...# ####. .###. ####. ##### #.... .###. #...# .###. .##.. #...# ##### #...#',
    ],
  },
  {
    chars: 'NOPQRSTUVWXYZ',
    rows: [
      '#...# .###. ####. .###. ####. .#### ##### #...# #...# #...# #...# #...# #####',
      '#...# #...# #...# #...# #...# #.... ..#.. #...# #...# #...# #...# #...# ....#',
      '##..# #...# #...# #...# #...# #.... ..#.. #...# #...# #...# .#.#. .#.#. ...#.',
      '#.#.# #...# ####. #...# ####. .###. ..#.. #...# #...# #.#.# ..#.. ..#.. ..#..',
      '#..## #...# #.... #.#.# #.#.. ....# ..#.. #...# #...# #.#.# .#.#. ..#.. .#...',
      '#...# #...# #.... #..#. #..#. ....# ..#.. #...# .#.#. #.#.# #...# ..#.. #....',
      '#...# .###. #.... .##.# #...# ####. ..#.. .###. ..#.. .#.#. #...# ..#.. #####',
    ],
  },
  {
    chars: 'abcdefghijklm',
    rows: [
      '..... #.... ..... ....# ..... ..##. ..... #.... ..#.. ...#. #.... .##.. .....',
      '..... #.... ..... ....# ..... .#..# ..... #.... ..... ..... #.... ..#.. .....',
      '.###. ####. .###. .#### .###. .#... .#### #.##. .##.. ..##. #..#. ..#.. ##.#.',
      '....# #...# #.... #...# #...# ###.. #...# ##..# ..#.. ...#. #.#.. ..#.. #.#.#',
      '.#### #...# #.... #...# ##### .#... #...# #...# ..#.. ...#. ##... ..#.. #.#.#',
      '#...# #...# #...# #...# #.... .#... #...# #...# ..#.. ...#. #.#.. ..#.. #.#.#',
      '.#### ####. .###. .#### .###. .#... .#### #...# .###. ...#. #..#. .###. #.#.#',
      '..... ..... ..... ..... ..... ..... ....# ..... ..... #..#. ..... ..... .....',
      '..... ..... ..... ..... ..... ..... .###. ..... ..... .##.. ..... ..... .....',
    ],
  },
  {
    chars: 'nopqrstuvwxyz',
    rows: [
      '..... ..... ..... ..... ..... ..... .#... ..... ..... ..... ..... ..... .....',
      '..... ..... ..... ..... ..... ..... .#... ..... ..... ..... ..... ..... .....',
      '#.##. .###. ####. .#### #.##. .#### ###.. #...# #...# #...# #...# #...# #####',
      '##..# #...# #...# #...# ##..# #.... .#... #...# #...# #...# .#.#. #...# ...#.',
      '#...# #...# #...# #...# #.... .###. .#... #...# #...# #.#.# ..#.. #...# ..#..',
      '#...# #...# #...# #...# #.... ....# .#..# #..## .#.#. #.#.# .#.#. #...# .#...',
      '#...# .###. ####. .#### #.... ####. ..##. .##.# ..#.. .#.#. #...# .#### #####',
      '..... ..... #.... ....# ..... ..... ..... ..... ..... ..... ..... ....# .....',
      '..... ..... #.... ....# ..... ..... ..... ..... ..... ..... ..... .###. .....',
    ],
  },
  {
    chars: '0123456789',
    rows: [
      '.###. ..#.. .###. ##### ...#. ##### ..##. ##### .###. .###.',
      '#...# .##.. #...# ...#. ..##. #.... .#... ....# #...# #...#',
      '#..## ..#.. ....# ..#.. .#.#. ####. #.... ...#. #...# #...#',
      '#.#.# ..#.. ...#. ...#. #..#. ....# ####. ..#.. .###. .####',
      '##..# ..#.. ..#.. ....# ##### ....# #...# .#... #...# ....#',
      '#...# ..#.. .#... #...# ...#. #...# #...# .#... #...# ...#.',
      '.###. .###. ##### .###. ...#. .###. .###. .#... .###. .##..',
    ],
  },
  {
    chars: ' !"#$%&\'()*+,-./',
    rows: [
      '..... ..#.. .#.#. .#.#. ..#.. ##... .##.. ..#.. ...#. .#... ..... ..... ..... ..... ..... .....',
      '..... ..#.. .#.#. .#.#. .#### ##..# #..#. ..#.. ..#.. ..#.. ..#.. ..#.. ..... ..... ..... ....#',
      '..... ..#.. ..... ##### #.#.. ...#. #.#.. ..... .#... ...#. #.#.# ..#.. ..... ..... ..... ...#.',
      '..... ..#.. ..... .#.#. .###. ..#.. .#... ..... .#... ...#. .###. ##### ..... .###. ..... ..#..',
      '..... ..#.. ..... ##### ..#.# .#... #.#.# ..... .#... ...#. #.#.# ..#.. ..... ..... ..... .#...',
      '..... ..... ..... .#.#. ####. #..## #..#. ..... ..#.. ..#.. ..#.. ..#.. ..... ..... ..... #....',
      '..... ..#.. ..... .#.#. ..#.. ...## .##.# ..... ...#. .#... ..... ..... .##.. ..... .##.. .....',
      '..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..#.. ..... ..... .....',
      '..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... .#... ..... ..... .....',
    ],
  },
  {
    chars: ':;<=>?@[\\]^_`{|}~',
    rows: [
      '..... ..... ...#. ..... .#... .###. .###. .###. ..... .###. ..#.. ..... .#... ...## ..#.. ##... .....',
      '..... ..... ..#.. ..... ..#.. #...# #...# .#... #.... ...#. .#.#. ..... ..#.. ..#.. ..#.. ..#.. .....',
      '..... ..... .#... ##### ...#. ....# ....# .#... .#... ...#. #...# ..... ..... ..#.. ..#.. ..#.. .#...',
      '.##.. .##.. #.... ..... ....# ...#. .##.# .#... ..#.. ...#. ..... ..... ..... .#... ..#.. ...#. #.#.#',
      '..... ..... .#... ##### ...#. ..#.. #.#.# .#... ...#. ...#. ..... ..... ..... ..#.. ..#.. ..#.. ...#.',
      '..... ..... ..#.. ..... ..#.. ..... #.#.# .#... ....# ...#. ..... ..... ..... ..#.. ..#.. ..#.. .....',
      '.##.. .##.. ...#. ..... .#... ..#.. .###. .###. ..... .###. ..... ..... ..... ...## ..#.. ##... .....',
      '..... ..#.. ..... ..... ..... ..... ..... ..... ..... ..... ..... ##### ..... ..... ..... ..... .....',
      '..... .#... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... ..... .....',
    ],
  },
  {
    chars: 'ı•—→←↑↓…·×✓',
    rows: [
      '..... ..... ..... ..... ..... ..#.. ..#.. ..... ..... ..... .....',
      '..... ..... ..... ..#.. ..#.. .###. ..#.. ..... ..... ..... ....#',
      '.##.. ..... ..... ...#. .#... #.#.# ..#.. ..... ..... #...# ...#.',
      '..#.. .###. ##### ##### ##### ..#.. ..#.. ..... ..#.. .#.#. #.#..',
      '..#.. .###. ..... ...#. .#... ..#.. #.#.# ..... ..... ..#.. .#...',
      '..#.. .###. ..... ..#.. ..#.. ..#.. .###. ..... ..... .#.#. .....',
      '.###. ..... ..... ..... ..... ..#.. ..#.. #.#.# ..... #...# .....',
    ],
  },
];

/** Characters drawn as another one. */
const ALIASES: Record<string, string> = {
  '‘': "'", '’': "'", '‚': ',', '“': '"', '”': '"', '„': '"', '«': '<', '»': '>', '–': '—', '−': '-',
  ' ': ' ', '\t': ' ', ' ': ' ', ' ': ' ', '▸': '→', '►': '→', '⇒': '→', '✔': '✓', '∙': '·',
};

/** Combining marks: two rows above the body (or, for `below`, the two descender rows). */
const MARKS: Record<string, { rows: [string, string]; below?: true }> = {
  '̀': { rows: ['.#...', '..#..'] },
  '́': { rows: ['...#.', '..#..'] },
  '̂': { rows: ['..#..', '.#.#.'] },
  '̃': { rows: ['.##.#', '#.##.'] },
  '̆': { rows: ['#...#', '.###.'] },
  '̇': { rows: ['..#..', '.....'] },
  '̈': { rows: ['.#.#.', '.....'] },
  '̊': { rows: ['..#..', '.#.#.'] },
  '̧': { rows: ['..#..', '.##..'], below: true },
  '̨': { rows: ['...#.', '....#'], below: true },
};

const MISSING = ['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#####'];

/** char → its 11 cell rows as bit masks (bit 4 = leftmost column). */
const GLYPHS = new Map<string, number[]>();

function maskOf(row: string): number {
  let m = 0;
  for (let c = 0; c < FONT_COLS; c++) if (row[c] === '#') m |= 1 << (FONT_COLS - 1 - c);
  return m;
}

function cellOf(body: readonly string[]): number[] {
  const cell = new Array<number>(FONT_ROWS).fill(0);
  body.forEach((row, i) => { cell[BODY + i] = maskOf(row); });
  return cell;
}

for (const block of BLOCKS) {
  [...block.chars].forEach((ch, gi) => {
    const body = block.rows.map((row) => row.slice(gi * (FONT_COLS + 1), gi * (FONT_COLS + 1) + FONT_COLS));
    GLYPHS.set(ch, cellOf(body));
  });
}

const composed = new Map<string, number[]>();

/** The 11 rows of `ch` as bit masks: a table glyph, an accented letter, or the hollow box. */
export function glyphCell(ch: string): number[] {
  const direct = GLYPHS.get(ALIASES[ch] ?? ch);
  if (direct) return direct;
  const hit = composed.get(ch);
  if (hit) return hit;
  const [baseCh, ...marks] = [...ch.normalize('NFD')];
  // An accent on i/j sits where its dot was.
  const base = GLYPHS.get(marks.some((m) => !MARKS[m]?.below) && (baseCh === 'i' || baseCh === 'j') ? (baseCh === 'i' ? 'ı' : 'j') : baseCh);
  let cell: number[];
  if (!base || marks.length === 0 || marks.some((m) => !MARKS[m])) {
    cell = cellOf(MISSING);
  } else {
    cell = [...base];
    // A capital or an ascender has ink in its top body rows: its accent goes above them.
    const tall = cell[BODY] !== 0 || cell[BODY + 1] !== 0;
    for (const m of marks) {
      const mark = MARKS[m];
      const at = mark.below ? BODY + 7 : tall ? 0 : BODY;
      cell[at] |= maskOf(mark.rows[0]);
      cell[at + 1] |= maskOf(mark.rows[1]);
    }
  }
  composed.set(ch, cell);
  return cell;
}

/**
 * Horizontal ink runs of one line of text, in font pixels: `[x0, x1, row]` with `row` in
 * 0..10 of the cell. The line is `chars × 6 - 1` pixels wide.
 */
export function lineRuns(text: string): { runs: [number, number, number][]; width: number } {
  const chars = [...text];
  const runs: [number, number, number][] = [];
  chars.forEach((ch, i) => {
    const cell = glyphCell(ch);
    const left = i * FONT_ADVANCE;
    for (let row = 0; row < FONT_ROWS; row++) {
      const m = cell[row];
      if (m === 0) continue;
      let c = 0;
      while (c < FONT_COLS) {
        if (!(m & (1 << (FONT_COLS - 1 - c)))) { c++; continue; }
        const start = c;
        while (c < FONT_COLS && m & (1 << (FONT_COLS - 1 - c))) c++;
        runs.push([left + start, left + c, row]);
      }
    }
  });
  return { runs, width: Math.max(0, chars.length * FONT_ADVANCE - 1) };
}
