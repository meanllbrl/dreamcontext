import chalk from 'chalk';
import { slugify } from './id.js';
import {
  RoundVerdicts,
  Verdict,
  VerdictOption,
  convergence,
  leadingStance,
} from './council.js';

/**
 * Chamber board renderer (Council v2). Pure function over data extracted from
 * verdicts.json + debate frontmatter — no filesystem access, unit-testable.
 * With `plain: true` (or non-TTY callers) the output contains zero ANSI codes.
 */

export interface ChamberBoardInput {
  debateId: string;
  topic: string;
  round: number;
  roundsPlanned: number;
  phase: string;
  options: VerdictOption[];
  /** Roster from debate frontmatter — personas without a verdict still get a row. */
  roster: string[];
  /** Verdicts of the round being rendered. */
  current: RoundVerdicts;
  /** Verdicts of the previous round, or null when there is none. */
  previous: RoundVerdicts | null;
}

export interface RenderChamberBoardOptions {
  plain?: boolean;
}

const MAX_INNER_WIDTH = 96;
const BAR_CELLS = 10;

type ColorFn = (s: string) => string;

const STANCE_PALETTE: ColorFn[] = [
  chalk.cyan,
  chalk.magentaBright,
  chalk.yellow,
  chalk.green,
  chalk.blue,
  chalk.red,
];

interface Seg {
  text: string;
  color?: ColorFn;
}

function segWidth(segs: Seg[]): number {
  return segs.reduce((n, s) => n + s.text.length, 0);
}

function renderSegs(segs: Seg[], plain: boolean): string {
  return segs.map((s) => (plain || !s.color ? s.text : s.color(s.text))).join('');
}

/**
 * 10-cell conviction bar: ▓ filled, ░ empty.
 */
export function convictionBar(conviction: number, cells: number = BAR_CELLS): string {
  const clamped = Math.max(0, Math.min(100, conviction));
  const filled = Math.max(0, Math.min(cells, Math.round((clamped / 100) * cells)));
  return '▓'.repeat(filled) + '░'.repeat(cells - filled);
}

/**
 * Shift marker vs the previous round:
 * `↑ A→B` stance change · `↓ 78→45` conviction drop ≥10 · `=` stable · `·` no prior round.
 */
export function shiftMarker(prev: Verdict | null | undefined, cur: Verdict): string {
  if (!prev) return '·';
  if (prev.stance !== cur.stance) return `↑ ${prev.stance}→${cur.stance}`;
  if (prev.conviction - cur.conviction >= 10) return `↓ ${prev.conviction}→${cur.conviction}`;
  return '=';
}

function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max === 1) return '…';
  return text.slice(0, max - 1) + '…';
}

/**
 * Stable color per option key: cycle the palette in options order; stances not
 * in the option set get palette slots after the registered ones (first-seen).
 */
function stanceColors(options: VerdictOption[], stances: string[]): Map<string, ColorFn> {
  const map = new Map<string, ColorFn>();
  let i = 0;
  for (const o of options) {
    map.set(o.key, STANCE_PALETTE[i % STANCE_PALETTE.length]);
    i++;
  }
  for (const s of stances) {
    if (!map.has(s)) {
      map.set(s, STANCE_PALETTE[i % STANCE_PALETTE.length]);
      i++;
    }
  }
  return map;
}

function optionLabel(options: VerdictOption[], key: string): string | null {
  const o = options.find((opt) => opt.key === key);
  return o ? o.label : null;
}

export function renderChamberBoard(
  input: ChamberBoardInput,
  opts: RenderChamberBoardOptions = {},
): string {
  const plain = opts.plain ?? false;
  const dim: ColorFn = chalk.dim;
  const bold: ColorFn = chalk.bold;

  const current = input.current ?? {};
  const previous = input.previous;
  const entries = Object.entries(current);
  const colors = stanceColors(input.options, entries.map(([, v]) => v.stance));

  const conv = convergence(current);
  const leading = leadingStance(current);
  const prevConv = previous && Object.keys(previous).length > 0 ? convergence(previous) : null;

  // ── Row ordering: conviction desc, then slug ──
  const sorted = entries.slice().sort((a, b) => b[1].conviction - a[1].conviction || a[0].localeCompare(b[0]));
  const missing = (input.roster ?? []).filter((slug) => !current[slug]);

  const slugWidth = Math.max(
    0,
    ...sorted.map(([slug]) => slug.length),
    ...missing.map((slug) => slug.length),
  );
  const stanceWidth = Math.max(1, ...sorted.map(([, v]) => v.stance.length));
  const shiftWidth = Math.max(
    1,
    ...sorted.map(([slug, v]) => shiftMarker(previous?.[slug], v).length),
  );

  const lines: Seg[][] = [];

  // ── Convergence line ──
  if (entries.length > 0) {
    const leadLabel = leading !== null ? optionLabel(input.options, leading) : null;
    const leadText =
      leading !== null ? ` → ${leading}${leadLabel ? ` (${leadLabel})` : ''}` : '';
    const convSegs: Seg[] = [
      { text: 'CONVERGENCE ', color: bold },
      { text: convictionBar(conv), color: leading !== null ? colors.get(leading) : undefined },
      { text: ` ${conv}%` },
      { text: leadText, color: leading !== null ? colors.get(leading) : undefined },
    ];
    if (prevConv !== null) {
      const delta = conv - prevConv;
      convSegs.push({ text: `   Δ ${delta >= 0 ? '+' : ''}${delta}`, color: dim });
    }
    lines.push(convSegs);
    lines.push([]);
  } else {
    lines.push([{ text: '(no verdicts yet for this round)', color: dim }]);
  }

  // ── Persona rows ──
  const fixedWidth = 2 + slugWidth + 2 + stanceWidth + 1 + BAR_CELLS + 1 + 3 + 2 + shiftWidth + 2;
  const headlineBudget = Math.max(8, MAX_INNER_WIDTH - fixedWidth - 2);

  for (const [slug, v] of sorted) {
    const marker = shiftMarker(previous?.[slug], v);
    const headline = truncate(v.headline ?? '', headlineBudget);
    lines.push([
      { text: '⬥ ', color: dim },
      { text: slug.padEnd(slugWidth) },
      { text: '  ' },
      { text: v.stance.padEnd(stanceWidth), color: colors.get(v.stance) },
      { text: ' ' },
      { text: convictionBar(v.conviction), color: colors.get(v.stance) },
      { text: ` ${String(v.conviction).padStart(3)}` },
      { text: `  ${marker.padEnd(shiftWidth)}`, color: dim },
      { text: headline ? `  "${headline}"` : '' },
    ]);
  }
  for (const slug of missing) {
    lines.push([
      { text: '⬥ ', color: dim },
      { text: slug.padEnd(slugWidth), color: dim },
      { text: '  (no verdict yet)', color: dim },
    ]);
  }

  // ── Options tally ──
  const tallyKeys: string[] = [];
  for (const o of input.options) tallyKeys.push(o.key);
  for (const [, v] of sorted) {
    if (!tallyKeys.includes(v.stance)) tallyKeys.push(v.stance);
  }
  if (tallyKeys.length > 0) {
    lines.push([]);
    const tallySegs: Seg[] = [{ text: 'OPTIONS  ', color: bold }];
    tallyKeys.forEach((key, idx) => {
      const votes = sorted.filter(([, v]) => v.stance === key);
      const count = votes.length;
      const sum = votes.reduce((s, [, v]) => s + v.conviction, 0);
      const label = optionLabel(input.options, key) ?? key;
      if (idx > 0) tallySegs.push({ text: '   ' });
      tallySegs.push({ text: `${key} `, color: colors.get(key) });
      tallySegs.push({ text: `${label} (${count} · ${sum})` });
    });
    lines.push(tallySegs);
  }

  // ── Frame ──
  const title = ` COUNCIL · ${truncate(slugify(input.topic) || input.debateId, 44)} `;
  const status = ` round ${input.round}/${input.roundsPlanned} · ${input.phase} `;
  const inner = Math.min(
    MAX_INNER_WIDTH,
    Math.max(segWidth([{ text: title }, { text: status }]) + 12, ...lines.map(segWidth)),
  );

  const out: string[] = [];
  const headFill = Math.max(0, inner + 2 - title.length - status.length - 8);
  out.push(
    renderSegs(
      [
        { text: '╭────', color: dim },
        { text: title, color: bold },
        { text: '─'.repeat(4), color: dim },
        { text: status, color: dim },
        { text: '─'.repeat(headFill), color: dim },
        { text: '╮', color: dim },
      ],
      plain,
    ),
  );
  for (const segs of lines) {
    const pad = Math.max(0, inner - segWidth(segs));
    out.push(
      renderSegs(
        [{ text: '│ ', color: dim }, ...segs, { text: ' '.repeat(pad) }, { text: ' │', color: dim }],
        plain,
      ),
    );
  }
  out.push(renderSegs([{ text: `╰${'─'.repeat(inner + 2)}╯`, color: dim }], plain));

  return out.join('\n');
}
