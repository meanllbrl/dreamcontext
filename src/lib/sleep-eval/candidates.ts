import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFrontmatter } from '../frontmatter.js';
import { humanTurnText } from '../transcript-records.js';
import { readRound, sourceDataDir, writeRound } from './fixtures.js';
import {
  LABEL_CATEGORIES,
  sleepEvalRoot,
  type FeedbackBasis,
  type FixtureRound,
  type LabelCategory,
  type LabelItem,
} from './types.js';

/**
 * The label candidates a model proposes for one round: what the owner explicitly asked
 * for, what was dropped, what belongs under an existing task, what belongs to another
 * project, and the corrections the owner keeps repeating. A candidate is only a question;
 * the owner's swipe on the Tasks screen is the answer.
 */

/** One owner message in a round. */
export interface OwnerTurn {
  session: string;
  at: string;
  text: string;
}

const TURN_MIN_CHARS = 15;
const TURN_MAX_CHARS = 900;
const TURNS_BUDGET_CHARS = 45_000;
const BOARD_LINES_MAX = 220;
const MAX_CANDIDATES = 12;

/**
 * What the owner typed in this round's window (after the previous round's consolidation),
 * oldest first. Harness-injected turns, tool results and one-word nudges are dropped.
 * Over budget, every message is shortened evenly rather than the tail being cut off.
 */
export function roundOwnerTurns(contextRoot: string, round: FixtureRound): OwnerTurn[] {
  const dir = join(sleepEvalRoot(contextRoot), 'fixtures', round.id);
  const turns: OwnerTurn[] = [];
  for (const s of round.sessions) {
    const p = join(dir, s.file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const at = typeof rec.timestamp === 'string' ? rec.timestamp : '';
      if (round.previousAt && at && at <= round.previousAt) continue;
      const text = humanTurnText(rec);
      if (!text || text.trim().length < TURN_MIN_CHARS) continue;
      turns.push({ session: s.session_id, at, text: text.trim() });
    }
  }
  turns.sort((a, b) => a.at.localeCompare(b.at));
  const total = turns.reduce((n, t) => n + Math.min(t.text.length, TURN_MAX_CHARS), 0);
  const cap = total > TURNS_BUDGET_CHARS ? Math.max(200, Math.floor(TURN_MAX_CHARS * TURNS_BUDGET_CHARS / total)) : TURN_MAX_CHARS;
  return turns.map((t) => ({ ...t, text: t.text.length > cap ? `${t.text.slice(0, cap)}…` : t.text }));
}

/** `slug — name` for every open task on the round's board. */
export function openBoardLines(contextRoot: string, round: FixtureRound): string[] {
  const boardDir = join(sourceDataDir(contextRoot, round), 'board');
  const lines: string[] = [];
  for (const slug of round.board) {
    const p = join(boardDir, `${slug}.md`);
    if (!existsSync(p)) continue;
    try {
      const { data } = readFrontmatter<{ status?: unknown; name?: unknown }>(p);
      if (data.status === 'completed') continue;
      const name = typeof data.name === 'string' ? data.name.replace(/\s+/g, ' ').slice(0, 140) : slug;
      lines.push(`${slug} — ${name}`);
    } catch {
      /* skip */
    }
  }
  return lines.slice(0, BOARD_LINES_MAX);
}

/**
 * A second, narrower pass for the kinds a general pass under-finds: it asks ONLY for
 * work that was dropped and work that belongs to another project.
 */
const FOCUS_NOTE: Record<string, string> = {
  abandoned: 'work that was proposed or discussed and then dropped, cancelled, rejected or postponed indefinitely',
  'other-project': 'work for a different project, product, client or repository than this one (another app, another brain, a teammate\'s project) that came up here',
};

export function buildCandidatePrompt(turns: OwnerTurn[], boardLines: string[], focus: LabelCategory[] = []): string {
  if (focus.length > 0) {
    return [
      buildCandidatePrompt(turns, boardLines),
      '',
      'FOCUS FOR THIS PASS: return ONLY items of these kinds, and look harder for them than a general pass would:',
      ...focus.map((f) => `- ${f}: ${FOCUS_NOTE[f] ?? f}`),
      'Return [] when there is none. Do not return any other kind.',
    ].join('\n');
  }
  const msgs = turns.map((t, i) => `[${i + 1}] (${t.at.slice(0, 16)}, session ${t.session.slice(0, 8)})\n${t.text}`).join('\n\n');
  return [
    'You are preparing a labelling deck. Below are the messages a project owner typed to coding agents',
    'during one stretch of work, oldest first, and the project\'s open tasks. Propose the items the owner',
    'will confirm or reject, one card each. Find these kinds, only where the messages clearly show them:',
    '',
    '- explicit-ask: the owner directly asked for a piece of work to be done or tracked (not a question, not',
    '  something the agent offered). It deserved its own task.',
    '- sub-detail: work the owner asked for that is a detail or follow-up of one of the OPEN TASKS below;',
    '  set "parent" to that task\'s slug exactly as listed.',
    '- abandoned: work that was proposed or discussed and then dropped, cancelled or postponed indefinitely',
    '  by the owner. A task must NOT be opened for it.',
    '- other-project: work for a different project or repository than this one, raised here. Must not be',
    '  filed in this project.',
    '- style-correction: the owner corrected how the agent writes, works or decides, in a way that is a',
    '  general rule for next time (not a one-off fix). Should become a written pattern.',
    '',
    `Rules: at most ${MAX_CANDIDATES} items, the strongest first; "quote" is copied verbatim from one owner message`,
    '(at most 200 characters); "name" is one plain sentence saying what the work or rule is; "why" is one',
    'sentence of evidence. Write name and why in the language the owner used. Skip anything unclear.',
    'Answer with ONLY a JSON array, no prose:',
    '[{"category":"explicit-ask|sub-detail|abandoned|other-project|style-correction","name":"…","why":"…","quote":"…","message":<n>,"parent":"<slug or null>"}]',
    '',
    'OPEN TASKS:',
    boardLines.join('\n') || '(none)',
    '',
    'OWNER MESSAGES:',
    msgs || '(none)',
  ].join('\n');
}

const BASIS: Record<LabelCategory, FeedbackBasis> = {
  opened: 'unknown',
  'explicit-ask': 'ask',
  'sub-detail': 'ask',
  abandoned: 'discussion',
  'other-project': 'discussion',
  'style-correction': 'discussion',
};

/** Parse the model's answer into label items. Malformed entries are dropped, never guessed. */
export function parseCandidates(
  text: string,
  round: FixtureRound,
  turns: OwnerTurn[],
  boardSlugs: Set<string>,
  opts: { only?: LabelCategory[]; existing?: LabelItem[] } = {},
): LabelItem[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  // Numbering continues after the round's existing items, so an appended pass never reuses an id.
  const counters = new Map<string, number>();
  for (const e of opts.existing ?? []) {
    const n = Number(e.id.split(':').pop());
    if (Number.isFinite(n)) counters.set(e.category, Math.max(counters.get(e.category) ?? 0, n));
  }
  const out: LabelItem[] = [];
  for (const r of raw.slice(0, MAX_CANDIDATES)) {
    if (!r || typeof r !== 'object') continue;
    const c = r as Record<string, unknown>;
    const category = c.category as LabelCategory;
    if (!(LABEL_CATEGORIES as readonly string[]).includes(category) || category === 'opened') continue;
    if (opts.only && opts.only.length > 0 && !opts.only.includes(category)) continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    let parent = typeof c.parent === 'string' && boardSlugs.has(c.parent) ? c.parent : null;
    if (category === 'sub-detail' && !parent) continue;
    if (category !== 'sub-detail') parent = null;
    const msgIdx = typeof c.message === 'number' ? c.message - 1 : -1;
    const n = (counters.get(category) ?? 0) + 1;
    counters.set(category, n);
    out.push({
      id: `${round.id}:${category}:${n}`,
      round: round.id,
      category,
      name: name.slice(0, 240),
      why: typeof c.why === 'string' ? c.why.trim().slice(0, 400) : '',
      quote: typeof c.quote === 'string' ? c.quote.trim().slice(0, 240) : '',
      session: turns[msgIdx]?.session ?? null,
      parent,
      slug: null,
      basis: BASIS[category],
    });
  }
  return out;
}

/** Runs one prompt through a model and returns its text answer. */
export type PromptRunner = (prompt: string) => Promise<string>;

/**
 * Fill a round's candidates. A round that already has candidates is left alone unless
 * `force` (its ids may carry the owner's labels).
 */
export async function extractRoundCandidates(
  contextRoot: string,
  roundId: string,
  run: PromptRunner,
  opts: { force?: boolean; focus?: LabelCategory[] } = {},
): Promise<FixtureRound> {
  const round = readRound(contextRoot, roundId);
  if (!round) throw new Error(`Unknown round: ${roundId}`);
  const focus = opts.focus ?? [];
  if (focus.length === 0 && round.candidates.length > 0 && !opts.force) return round;
  const turns = roundOwnerTurns(contextRoot, round);
  if (turns.length === 0) {
    writeRound(contextRoot, { ...round, candidates: [] });
    return round;
  }
  const answer = await run(buildCandidatePrompt(turns, openBoardLines(contextRoot, round), focus));
  if (focus.length > 0) {
    // A focus pass APPENDS: the round's earlier cards (and the owner's labels on them) stay.
    const added = parseCandidates(answer, round, turns, new Set(round.board), { only: focus, existing: round.candidates });
    const next = { ...round, candidates: [...round.candidates, ...added] };
    writeRound(contextRoot, next);
    return next;
  }
  // A forced re-run numbers past the replaced cards: a label on an old id must never
  // attach itself to a different new card.
  const candidates = parseCandidates(answer, round, turns, new Set(round.board), { existing: round.candidates });
  const next = { ...round, candidates };
  writeRound(contextRoot, next);
  return next;
}
