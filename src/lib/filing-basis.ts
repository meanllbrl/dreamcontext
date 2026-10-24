import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { today } from './id.js';
import { isSafeSessionId } from './transcript-locate.js';
import { humanTurnText, isInjectedUserRecord } from './transcript-records.js';
import type { FilingActor } from './task-filing-bar.js';
import { latestWaveMap, waveMapParts } from './task-parent.js';

/**
 * filing-basis — WHO opened a task and WHY, stamped on every create path.
 *
 * Two local-only frontmatter fields (task-backend/local-only.ts):
 *   filed_by:     human | agent | sleep | plan
 *   filing_basis: { kind, quote, session?, at, verified }
 *
 * The task page reads them as its "why was this opened" line ("Sleep opened it · the owner
 * asked: «…»"), and the objection button hides on the owner's own tasks. The CLI
 * (`tasks create`, `tasks basis`) and `POST /api/tasks` call {@link decideFiling}, so the
 * two surfaces cannot disagree about who a caller is.
 *
 * WHO COUNTS AS SLEEP. Exactly the filing bar's rule (task-filing-bar.ts): an explicit
 * `--by sleep`, or a CLI caller that passed NO `--by` while a sleep cycle is live. A caller
 * that names itself (`--by human`, `--by agent`) is taken at its word, and a wave sub-task
 * (`--basis plan` with `--parent`) is a plan's, never sleep's. Over HTTP a request with no
 * `by` is the owner's own form and stays `human` even mid-cycle.
 *
 * WHAT SLEEP MUST SHOW. A new TOP-LEVEL task from sleep only for an owner ask (`ask`, with a
 * quote found in a turn the owner typed) or a defect (`defect`, with evidence found in a tool
 * result). Anything else goes under a parent (`--parent`) or onto an existing task as a
 * criterion. The quote is searched in the cycle's sessions (`state/.sleep.json`) after a
 * Turkish-aware normalization, so «Şunu da ekle» matches "şunu da ekle".
 */

export const FILED_BY = ['human', 'agent', 'sleep', 'plan'] as const;
export type FiledBy = typeof FILED_BY[number];

export const BASIS_KINDS = ['ask', 'defect', 'change', 'bookmark', 'plan', 'note'] as const;
export type BasisKind = typeof BASIS_KINDS[number];

export interface FilingBasis {
  kind: BasisKind;
  quote: string;
  /** The session the quote was found in (never written for a derived note). */
  session?: string;
  /** YYYY-MM-DD the basis was recorded. */
  at: string;
  /** True when the quote/evidence was found in a transcript. */
  verified: boolean;
}

/** A quote must carry at least this much to be checkable at all. */
export const MIN_QUOTE_WORDS = 3;
export const MIN_QUOTE_CHARS = 12;
/** A derived note keeps the start of the Why. */
const NOTE_QUOTE_CHARS = 200;
/** A quote or evidence lands in synced frontmatter that every task list parses: bounded. */
export const MAX_BASIS_CHARS = 2000;

/** Is `quote` (normalized, at least 4 characters) part of a wave of the parent's newest map? */
function quotesWavePart(technicalDetails: string | null | undefined, quote: string): boolean {
  const q = normalizeQuote(quote);
  if (q.length < 4) return false;
  return waveMapParts(latestWaveMap(technicalDetails)).some((p) => normalizeQuote(p.text).includes(q));
}

export function isFiledBy(v: unknown): v is FiledBy {
  return typeof v === 'string' && (FILED_BY as readonly string[]).includes(v);
}

export function isBasisKind(v: unknown): v is BasisKind {
  return typeof v === 'string' && (BASIS_KINDS as readonly string[]).includes(v);
}

/** A stored `filing_basis`, or null when the frontmatter carries none (or junk). */
export function readFilingBasis(raw: unknown): FilingBasis | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isBasisKind(r.kind)) return null;
  return {
    kind: r.kind,
    quote: typeof r.quote === 'string' ? r.quote : '',
    ...(typeof r.session === 'string' && r.session ? { session: r.session } : {}),
    at: typeof r.at === 'string' ? r.at : '',
    verified: r.verified === true,
  };
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * The comparable form of a quote: NFC, Turkish lower case (İ → i, I → ı), dotless ı folded
 * onto i (an English "I" lower-cased in Turkish must still match), quotes and punctuation
 * dropped, whitespace collapsed.
 */
export function normalizeQuote(text: string): string {
  return text
    .normalize('NFC')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Why a quote is too thin to check, or null. Counted on the normalized form. */
export function quoteTooThin(quote: string): string | null {
  const n = normalizeQuote(quote);
  const words = n ? n.split(' ').length : 0;
  if (words < MIN_QUOTE_WORDS || n.length < MIN_QUOTE_CHARS) {
    return `the quote must be the owner's own words, at least ${MIN_QUOTE_WORDS} words and ${MIN_QUOTE_CHARS} characters (got ${words} words, ${n.length} characters)`;
  }
  return null;
}

/** Text of the tool results in one transcript record (machine output, never a person). */
function toolResultText(rec: Record<string, unknown>): string {
  const msg = rec.message as { content?: unknown } | undefined;
  const content = msg && typeof msg === 'object' ? msg.content : rec.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; content?: unknown };
    if (b.type !== 'tool_result') continue;
    if (typeof b.content === 'string') out += b.content + '\n';
    else if (Array.isArray(b.content)) {
      for (const c of b.content) {
        if (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text') {
          out += String((c as { text?: unknown }).text ?? '') + '\n';
        }
      }
    }
  }
  return out;
}

/** Where to look for a quote: the owner's typed turns, or tool results. */
export type SearchIn = 'owner' | 'tools';

/** Does `needle` (already normalized) occur in `path`'s turns of the given kind? Never throws. */
export function transcriptContains(path: string, needle: string, where: SearchIn): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return false;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    let text: string | null;
    if (where === 'owner') {
      text = humanTurnText(rec);
    } else {
      text = isInjectedUserRecord(rec) ? null : toolResultText(rec);
    }
    if (text && normalizeQuote(text).includes(needle)) return true;
  }
  return false;
}

/** The cycle's sessions, from `state/.sleep.json`: `{ id, transcript }`. */
export function cycleSessions(contextRoot: string): Array<{ id: string; transcript: string | null }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(contextRoot, 'state', '.sleep.json'), 'utf-8'));
  } catch {
    return [];
  }
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  const out: Array<{ id: string; transcript: string | null }> = [];
  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    const r = s as { session_id?: unknown; transcript_path?: unknown };
    if (typeof r.session_id !== 'string') continue;
    out.push({ id: r.session_id, transcript: typeof r.transcript_path === 'string' ? r.transcript_path : null });
  }
  return out;
}

/** The awake caller's own transcript (`CLAUDE_CODE_SESSION_ID`), under the active config dir. */
export function currentSessionTranscript(env: NodeJS.ProcessEnv = process.env): { id: string; transcript: string } | null {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!isSafeSessionId(id)) return null;
  const roots = [env.CLAUDE_CONFIG_DIR, join(env.HOME || homedir(), '.claude')].filter((r): r is string => !!r);
  for (const root of roots) {
    const projects = join(root, 'projects');
    let dirs: string[];
    try {
      dirs = readdirSync(projects);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const p = join(projects, d, `${id}.jsonl`);
      if (existsSync(p)) return { id, transcript: p };
    }
  }
  return null;
}

export interface QuoteSearch {
  /** The session it was found in, or null. */
  session: string | null;
  /** Sessions whose transcript could not be read (named in a warning, never a refusal on their own). */
  missing: string[];
  /** How many transcripts were actually read. */
  searched: number;
}

/** Search a quote across sessions. */
export function findQuote(
  sessions: ReadonlyArray<{ id: string; transcript: string | null }>,
  quote: string,
  where: SearchIn,
): QuoteSearch {
  const needle = normalizeQuote(quote);
  const missing: string[] = [];
  let searched = 0;
  for (const s of sessions) {
    if (!s.transcript || !existsSync(s.transcript)) {
      missing.push(s.id);
      continue;
    }
    searched++;
    if (transcriptContains(s.transcript, needle, where)) return { session: s.id, missing, searched };
  }
  return { session: null, missing, searched };
}

// ─── The decision ────────────────────────────────────────────────────────────

export interface FilingInput {
  contextRoot: string;
  /** `cli`: a missing `--by` during a live cycle counts as sleep. `api`: a missing `by` is the owner. */
  surface: 'cli' | 'api';
  /** Raw `--by` / body `by`. */
  by?: string | null;
  /** Raw `--basis` kind. */
  basis?: string | null;
  /** `--quote`: the owner's words (ask), what changed (change), the bookmark (bookmark), the wave part (plan). */
  quote?: string | null;
  /** `--evidence`: the failing output (defect). */
  evidence?: string | null;
  /** The parent slug when this task is a sub-task. */
  parent: string | null;
  /** The parent's Technical Details: a plan claim made during a live cycle is checked against its newest WAVE MAP. */
  parentTechnicalDetails?: string | null;
  /** The task's Why (a derived note quotes its start). */
  why: string;
  /** Is a sleep cycle live? Callers pass `isSleepCycleLive(root)` (task-filing-bar.ts), so this
   *  module stays a leaf the task backend can import. */
  sleepLive: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests: the cycle's sessions. */
  sessions?: ReadonlyArray<{ id: string; transcript: string | null }>;
}

export type FilingDecision =
  | {
      ok: true;
      filedBy: FiledBy;
      basis: FilingBasis | null;
      /** What the filing bar is told (it keeps its own `unknown` hatch wording). */
      barActor: FilingActor;
      /** Lines the caller prints (a derived note, a transcript that could not be read). */
      warnings: string[];
    }
  | { ok: false; code: 'basis_required' | 'top_level_needs_ask' | 'quote_too_thin' | 'quote_not_found' | 'invalid_basis'; message: string };

const ESCAPE = 'Put it under the task it belongs to with --parent <slug>, '
  + 'or add it to that task as a criterion: dreamcontext tasks insert <slug> acceptance_criteria "…".';

/** Who is this caller, and what may they file? Pure apart from reading transcripts. */
export function decideFiling(input: FilingInput): FilingDecision {
  // An unknown `--by` value is no claim at all: it must not slip past the sleep rules.
  const byRaw = (input.by ?? '').trim();
  let by: FiledBy | null = isFiledBy(byRaw) ? byRaw : null;
  const basisRaw = (input.basis ?? '').trim() || null;
  if (basisRaw !== null && !isBasisKind(basisRaw)) {
    return { ok: false, code: 'invalid_basis', message: `--basis must be one of: ${BASIS_KINDS.join(', ')} (got "${basisRaw}").` };
  }
  const kind = basisRaw as BasisKind | null;
  const quote = (input.quote ?? '').trim().slice(0, MAX_BASIS_CHARS);
  const evidence = (input.evidence ?? '').trim().slice(0, MAX_BASIS_CHARS);
  const at = today();
  const warnings: string[] = [];

  if (by === 'human') {
    return { ok: true, filedBy: 'human', basis: null, barActor: 'human', warnings };
  }

  // A wave sub-task: a plan's, never sleep's, and it never needs the bar. During a live sleep
  // cycle the claim must be checkable: the quote is a wave part of the parent's newest WAVE MAP
  // (Develop passes exactly that). Anything else falls through to sleep's rules, so `--basis plan`
  // is never a way past the basis, the bar, the cap or the dedup gates.
  if ((kind === 'plan' || by === 'plan') && input.parent && (!input.sleepLive || quotesWavePart(input.parentTechnicalDetails, quote))) {
    return {
      ok: true,
      filedBy: 'plan',
      basis: { kind: 'plan', quote: quote || input.why.slice(0, NOTE_QUOTE_CHARS), at, verified: false },
      barActor: 'plan',
      warnings,
    };
  }

  // A plan claim that did not hold is no claim: on the CLI during a live cycle it is a caller with
  // no --by (sleep); anywhere else, an agent.
  if (by === 'plan') by = input.surface === 'cli' && input.sleepLive ? null : 'agent';

  if (input.surface === 'api' && by === null) {
    return { ok: true, filedBy: 'human', basis: null, barActor: 'human', warnings };
  }

  const live = input.sleepLive;
  const isSleep = by === 'sleep' || (input.surface === 'cli' && by === null && live);

  if (!isSleep) {
    // An awake agent: the basis is optional and never refuses.
    if (kind === null || kind === 'plan') {
      warnings.push('No --basis given: the task records its Why as the reason it was opened. '
        + 'Pass --basis ask --quote "<the owner\'s words>" when the owner asked for it.');
      return {
        ok: true,
        filedBy: 'agent',
        basis: { kind: 'note', quote: input.why.slice(0, NOTE_QUOTE_CHARS), at, verified: false },
        barActor: by === null ? 'unknown' : 'agent',
        warnings,
      };
    }
    const text = kind === 'defect' ? evidence || quote : quote;
    let session: string | undefined;
    let verified = false;
    // Only the CLI runs inside the caller's own session; the server's session is not the caller's.
    if (input.surface === 'cli' && (kind === 'ask' || kind === 'defect') && text && !quoteTooThin(text)) {
      const own = currentSessionTranscript(input.env);
      if (own) {
        const hit = findQuote([own], text, kind === 'ask' ? 'owner' : 'tools');
        if (hit.session) {
          session = hit.session;
          verified = true;
        }
      }
    }
    return {
      ok: true,
      filedBy: 'agent',
      basis: { kind, quote: text || input.why.slice(0, NOTE_QUOTE_CHARS), ...(session ? { session } : {}), at, verified },
      barActor: by === null ? 'unknown' : 'agent',
      warnings,
    };
  }

  // Sleep. The bar keeps `unknown` for a caller that forgot --by, so its refusals still
  // name the `--by human` hatch for a person working mid-cycle.
  const barActor: FilingActor = by === 'sleep' ? 'sleep' : 'unknown';
  if (kind === null || kind === 'note' || kind === 'plan') {
    return {
      ok: false,
      code: 'basis_required',
      message: 'A task filed during a sleep cycle needs a basis: --basis ask --quote "<the owner\'s words>", '
        + '--basis defect --evidence "<the failing output>", or (under a parent only) --basis change|bookmark --quote "…". '
        + ESCAPE + (by === null ? ' If this is your OWN task and not the cycle\'s, pass `--by human`.' : ''),
    };
  }
  if (!input.parent && kind !== 'ask' && kind !== 'defect') {
    return {
      ok: false,
      code: 'top_level_needs_ask',
      message: `Sleep opens a new top-level task only for an owner ask or a defect (got --basis ${kind}). ${ESCAPE}`,
    };
  }
  const text = kind === 'defect' ? evidence || quote : quote;
  if (kind === 'ask' || kind === 'defect') {
    const thin = quoteTooThin(text);
    if (thin) {
      return {
        ok: false,
        code: 'quote_too_thin',
        message: `--basis ${kind}: ${thin}. Pass ${kind === 'ask' ? '--quote' : '--evidence'} "<verbatim text>".`,
      };
    }
    const sessions = input.sessions ?? cycleSessions(input.contextRoot);
    const hit = findQuote(sessions, text, kind === 'ask' ? 'owner' : 'tools');
    for (const id of hit.missing) warnings.push(`transcript of session ${id} not found; it was not searched`);
    if (!hit.session) {
      return {
        ok: false,
        code: 'quote_not_found',
        message: kind === 'ask'
          ? `The quote was not found in any turn the owner typed in this cycle's sessions (${hit.searched} searched). `
            + 'Quote the owner\'s own words, verbatim; a compaction summary or an agent\'s paraphrase is not an ask. ' + ESCAPE
          : `The evidence was not found in any tool result of this cycle's sessions (${hit.searched} searched). `
            + 'Paste the failing output verbatim. ' + ESCAPE,
      };
    }
    return { ok: true, filedBy: 'sleep', basis: { kind, quote: text, session: hit.session, at, verified: true }, barActor, warnings };
  }
  // change | bookmark, under a parent.
  return {
    ok: true,
    filedBy: 'sleep',
    basis: { kind, quote: text || input.why.slice(0, NOTE_QUOTE_CHARS), at, verified: false },
    barActor,
    warnings,
  };
}

/** The frontmatter a decision writes (`local_fields` of the create). */
export function filingFields(d: Extract<FilingDecision, { ok: true }>): Record<string, unknown> {
  return d.basis ? { filed_by: d.filedBy, filing_basis: d.basis } : { filed_by: d.filedBy };
}
