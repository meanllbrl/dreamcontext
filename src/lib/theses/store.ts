import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter, updateFrontmatterFields } from '../frontmatter.js';
import { today, generateId, slugify } from '../id.js';
import { getInsight, listInsights } from '../lab/store.js';
import { getObjective, listObjectives } from '../objectives-store.js';
import { deriveConfidence } from './confidence.js';
import {
  THESIS_STATUSES,
  THESIS_KINDS,
  EVIDENCE_VERDICTS,
  EVIDENCE_SOURCES,
  PREDICTION_STANDINGS,
  ThesisError,
  type ThesisManifest,
  type ThesisStatus,
  type ThesisKind,
  type Prediction,
  type PredictionStanding,
  type EvidenceEvent,
  type EvidenceVerdict,
  type EvidenceSource,
  type ChangelogEntry,
} from './types.js';

/**
 * Thesis store — mirrors lab/store.ts (markdown-first: one manifest per thesis
 * under `_dream_context/theses/<slug>.md`, no cache). Reads are LENIENT (a
 * malformed sub-block degrades to a safe default / a skip, never throws —
 * mirrors readInsightFile); writes are STRICT (throw ThesisError).
 *
 * Evidence + predictions live in frontmatter (structured, arithmetic-friendly).
 * The understanding changelog lives in the body as a `## Understanding
 * changelog` section (LIFO — newest entry first) parsed/serialized by
 * `parseChangelog`/`serializeChangelog` below; the server reuses both.
 * `confidence` is persisted for convenience but ALWAYS recomputed from the
 * evidence ledger on read (`readThesisFile`), so a stale/hand-edited value can
 * never linger.
 */

const CHANGELOG_HEADING = '## Understanding changelog';
const MAX_RAW_CHANGELOG_ENTRIES = 10;
const CONDENSED_COUNT_RE = /Condensed summary of (\d+) earlier cycle/;

export function thesesDir(contextRoot: string): string {
  return join(contextRoot, 'theses');
}
export function thesisPath(contextRoot: string, slug: string): string {
  return join(thesesDir(contextRoot), `${slug}.md`);
}

/** Kebab-case, path-safe thesis slug (same shape insight/objective slugs use). */
export function isSafeThesisSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && !slug.includes('--') && !slug.endsWith('-');
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function dedupeStrings(arr: string[]): string[] {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

function toThesisStatus(v: unknown): ThesisStatus {
  const s = typeof v === 'string' ? v.trim() : '';
  return (THESIS_STATUSES as readonly string[]).includes(s) ? (s as ThesisStatus) : 'draft';
}

function toThesisKind(v: unknown): ThesisKind {
  const s = typeof v === 'string' ? v.trim() : '';
  return (THESIS_KINDS as readonly string[]).includes(s) ? (s as ThesisKind) : 'observational';
}

/** LENIENT prediction parse: an entry with no text is dropped, never fatal. */
function parsePredictions(v: unknown): Prediction[] {
  if (!Array.isArray(v)) return [];
  const out: Prediction[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!text) continue;
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : generateId('pred');
    const standing = (PREDICTION_STANDINGS as readonly string[]).includes(String(r.standing))
      ? (r.standing as PredictionStanding)
      : 'untested';
    out.push({ id, text, standing });
  }
  return out;
}

/** LENIENT evidence parse: an entry with an unrecognised verdict is dropped. */
function parseEvidence(v: unknown): EvidenceEvent[] {
  if (!Array.isArray(v)) return [];
  const out: EvidenceEvent[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const verdict = (EVIDENCE_VERDICTS as readonly string[]).includes(String(r.verdict))
      ? (r.verdict as EvidenceVerdict)
      : null;
    if (!verdict) continue;
    const source = (EVIDENCE_SOURCES as readonly string[]).includes(String(r.source))
      ? (r.source as EvidenceSource)
      : 'external';
    out.push({
      date: typeof r.date === 'string' && r.date.trim() ? r.date.trim() : today(),
      cycle: typeof r.cycle === 'number' && Number.isFinite(r.cycle) ? r.cycle : null,
      source,
      ref: strOrNull(r.ref),
      verdict,
      note: typeof r.note === 'string' ? r.note.trim() : '',
      quantitative: r.quantitative === true,
    });
  }
  return out;
}

// ─── Understanding changelog (body-embedded, LIFO) ──────────────────────────

function changelogHeader(e: ChangelogEntry): string {
  if (e.condensed) return `### CONDENSED · ${e.when}`;
  if (e.cycle === null) return `### MANUAL · ${e.when}`;
  return `### CYCLE ${e.cycle} · ${e.when}`;
}

/**
 * Extract the `## Understanding changelog` section (if any) from a thesis
 * body and parse its entries, newest-first (file order = display order).
 * Malformed sub-headings are skipped defensively — this must never throw.
 */
export function parseChangelog(body: string): ChangelogEntry[] {
  const idx = body.indexOf(CHANGELOG_HEADING);
  if (idx === -1) return [];
  const afterHeading = body.slice(idx + CHANGELOG_HEADING.length);
  // Split ONLY on the three known entry headers — a `### ` line inside an
  // entry's own free text (agents paste markdown) must not open a new block,
  // or the tail of that entry would be silently dropped as "unrecognised".
  const blocks = afterHeading
    .split(/\n(?=### (?:CYCLE \d+|MANUAL|CONDENSED) · \d{4}-\d{2}-\d{2}[ \t]*(?:\n|$))/)
    .map((b) => b.trim())
    .filter(Boolean);
  const entries: ChangelogEntry[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0]!.trim();
    const text = lines.slice(1).join('\n').trim();
    const cycleMatch = header.match(/^### CYCLE (\d+) · (\d{4}-\d{2}-\d{2})$/);
    const manualMatch = header.match(/^### MANUAL · (\d{4}-\d{2}-\d{2})$/);
    const condensedMatch = header.match(/^### CONDENSED · (\d{4}-\d{2}-\d{2})$/);
    if (cycleMatch) {
      entries.push({ cycle: Number(cycleMatch[1]), condensed: false, when: cycleMatch[2]!, text });
    } else if (manualMatch) {
      entries.push({ cycle: null, condensed: false, when: manualMatch[1]!, text });
    } else if (condensedMatch) {
      entries.push({ cycle: null, condensed: true, when: condensedMatch[1]!, text });
    }
    // else: an unrecognised sub-heading (hand-edited) — skip, never fatal.
  }
  return entries;
}

/**
 * Render the `## Understanding changelog` section for a (already-reconciled)
 * entries list, newest-first. Inverse of `parseChangelog` — round-trips
 * exactly: `parseChangelog(serializeChangelog(entries)) === entries`.
 * Empty input renders no section at all (an absent heading, not an empty one).
 */
export function serializeChangelog(entries: ChangelogEntry[]): string {
  if (entries.length === 0) return '';
  const blocks = entries.map((e) => `${changelogHeader(e)}\n${e.text}`);
  return `${CHANGELOG_HEADING}\n\n${blocks.join('\n\n')}\n`;
}

/** Split a thesis body into its free prose and its parsed changelog entries. */
function splitBody(body: string): { prose: string; entries: ChangelogEntry[] } {
  const idx = body.indexOf(CHANGELOG_HEADING);
  if (idx === -1) return { prose: body.trim(), entries: [] };
  return { prose: body.slice(0, idx).trimEnd(), entries: parseChangelog(body) };
}

function joinBody(prose: string, entries: ChangelogEntry[]): string {
  const section = serializeChangelog(entries);
  if (!section) return prose;
  return prose ? `${prose}\n\n${section}` : section;
}

/** How many cycles a (possibly hand-edited) condensed entry claims to summarize. */
function condensedCountOf(entry: ChangelogEntry): number {
  const m = entry.text.match(CONDENSED_COUNT_RE);
  return m ? Number(m[1]) : 1;
}

function mergeCondensedEntries(condensedEntries: ChangelogEntry[], overflowCount: number, when: string): ChangelogEntry {
  const priorCount = condensedEntries.reduce((sum, e) => sum + condensedCountOf(e), 0);
  const total = priorCount + overflowCount;
  return {
    cycle: null,
    condensed: true,
    when,
    text: `Condensed summary of ${total} earlier cycle${total === 1 ? '' : 's'}.`,
  };
}

/**
 * Enforce the anti-bloat cap: keep the newest 10 raw (non-condensed) entries
 * verbatim; anything older collapses into a single CONDENSED entry (merged
 * with any prior CONDENSED entry so the running count never resets).
 */
function reconcileChangelog(entries: ChangelogEntry[], when: string): ChangelogEntry[] {
  const raw = entries.filter((e) => !e.condensed);
  const condensed = entries.filter((e) => e.condensed);
  if (raw.length <= MAX_RAW_CHANGELOG_ENTRIES) {
    if (condensed.length === 0) return raw;
    if (condensed.length === 1) return [...raw, condensed[0]!];
    // Defensive: more than one CONDENSED entry (hand-edited) — merge them, no new overflow.
    return [...raw, mergeCondensedEntries(condensed, 0, condensed[0]!.when)];
  }
  const kept = raw.slice(0, MAX_RAW_CHANGELOG_ENTRIES);
  const overflow = raw.slice(MAX_RAW_CHANGELOG_ENTRIES);
  return [...kept, mergeCondensedEntries(condensed, overflow.length, when)];
}

// ─── Read ────────────────────────────────────────────────────────────────

export function readThesisFile(filePath: string): ThesisManifest {
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  const slug = basename(filePath, '.md');
  const evidence = parseEvidence(data.evidence);
  const { confidence } = deriveConfidence(evidence);
  return {
    slug,
    claim: typeof data.claim === 'string' && data.claim.trim() ? data.claim.trim() : slug,
    status: toThesisStatus(data.status),
    kind: toThesisKind(data.kind),
    confidence,
    created_by: data.created_by === 'sleep-learn' ? 'sleep-learn' : 'user',
    predictions: parsePredictions(data.predictions),
    evidence,
    insights: toStringArray(data.insights),
    objectives: toStringArray(data.objectives),
    related_tasks: toStringArray(data.related_tasks),
    related_workflows: toStringArray(data.related_workflows),
    blocked_on_instrumentation: data.blocked_on_instrumentation === true,
    blocked_metric: strOrNull(data.blocked_metric),
    cycles_checked: Number.isFinite(Number(data.cycles_checked)) ? Number(data.cycles_checked) : 0,
    checked_at: strOrNull(data.checked_at),
    promoted_to: strOrNull(data.promoted_to),
    created_at: typeof data.created_at === 'string' && data.created_at.trim() ? data.created_at : today(),
    updated_at: typeof data.updated_at === 'string' && data.updated_at.trim() ? data.updated_at : today(),
    path: filePath,
    body: content.trim(),
    changelog: parseChangelog(content),
  };
}

/** All theses, sorted by slug (stable). Missing directory → empty list. */
export function listTheses(contextRoot: string): ThesisManifest[] {
  const dir = thesesDir(contextRoot);
  if (!existsSync(dir)) return [];
  const files = fg.sync('*.md', { cwd: dir, absolute: true }).sort();
  const out: ThesisManifest[] = [];
  for (const file of files) {
    try {
      out.push(readThesisFile(file));
    } catch {
      // skip a manifest that won't even parse as frontmatter
    }
  }
  return out;
}

export function getThesis(contextRoot: string, slug: string): ThesisManifest | null {
  const path = thesisPath(contextRoot, slug);
  if (!isSafeThesisSlug(slug) || !existsSync(path)) return null;
  try {
    return readThesisFile(path);
  } catch {
    return null;
  }
}

// ─── Link target validation (no shared listTasks() — mirrors roadmap-model.ts) ──

/** Task slugs are just `state/*.md` filenames (mirrors roadmap-model.ts's loadTaskRefs). */
function listTaskSlugs(contextRoot: string): string[] {
  const stateDir = join(contextRoot, 'state');
  if (!existsSync(stateDir)) return [];
  return fg.sync('*.md', { cwd: stateDir }).map((f) => basename(f, '.md'));
}

export type ThesisLinkKind = 'insight' | 'objective' | 'task';

function linkField(kind: ThesisLinkKind): 'insights' | 'objectives' | 'related_tasks' {
  if (kind === 'insight') return 'insights';
  if (kind === 'objective') return 'objectives';
  return 'related_tasks';
}

function assertLinkTargetExists(contextRoot: string, kind: ThesisLinkKind, target: string): void {
  if (kind === 'insight') {
    if (!getInsight(contextRoot, target)) throw new ThesisError(`Unknown insight: ${target}`);
  } else if (kind === 'objective') {
    if (!getObjective(contextRoot, target)) throw new ThesisError(`Unknown objective: ${target}`);
  } else if (!listTaskSlugs(contextRoot).includes(target)) {
    throw new ThesisError(`Unknown task: ${target}`);
  }
}

function assertLinkTargetsExist(contextRoot: string, kind: ThesisLinkKind, targets: string[]): void {
  for (const t of targets) assertLinkTargetExists(contextRoot, kind, t);
}

// ─── Create / edit ──────────────────────────────────────────────────────────

export interface CreateThesisInput {
  slug?: string;
  claim: string;
  kind?: ThesisKind;
  createdBy?: 'user' | 'sleep-learn';
  /** Pre-registered prediction texts (each becomes an `untested` Prediction). */
  predictions?: string[];
  insights?: string[];
  objectives?: string[];
  relatedTasks?: string[];
  /** Promote straight to `open` — requires ≥1 prediction (draft→open gate). */
  open?: boolean;
}

export function createThesis(contextRoot: string, input: CreateThesisInput): ThesisManifest {
  const claim = input.claim?.trim();
  if (!claim) throw new ThesisError('A thesis claim is required.');

  const slug = (input.slug?.trim() || slugify(claim)).trim();
  if (!isSafeThesisSlug(slug)) {
    throw new ThesisError(`Invalid thesis slug "${slug}" — use kebab-case (e.g. compressing-memories-improves-recall).`);
  }
  const path = thesisPath(contextRoot, slug);
  if (existsSync(path)) throw new ThesisError(`Thesis already exists: ${slug}`);

  const predictionTexts = (input.predictions ?? []).map((t) => t.trim()).filter(Boolean);
  const predictions: Prediction[] = predictionTexts.map((text) => ({
    id: generateId('pred'),
    text,
    standing: 'untested' as PredictionStanding,
  }));
  if (input.open && predictions.length === 0) {
    throw new ThesisError('Promoting to open requires at least one pre-registered prediction — pass a prediction.');
  }

  const insights = dedupeStrings(input.insights ?? []);
  const objectives = dedupeStrings(input.objectives ?? []);
  const relatedTasks = dedupeStrings(input.relatedTasks ?? []);
  assertLinkTargetsExist(contextRoot, 'insight', insights);
  assertLinkTargetsExist(contextRoot, 'objective', objectives);
  assertLinkTargetsExist(contextRoot, 'task', relatedTasks);

  const now = today();
  const frontmatter: Record<string, unknown> = {
    claim,
    status: (input.open ? 'open' : 'draft') as ThesisStatus,
    kind: input.kind ?? 'observational',
    confidence: 0.5,
    created_by: input.createdBy ?? 'user',
    predictions,
    evidence: [],
    insights,
    objectives,
    related_tasks: relatedTasks,
    related_workflows: [],
    blocked_on_instrumentation: false,
    blocked_metric: null,
    cycles_checked: 0,
    checked_at: null,
    promoted_to: null,
    created_at: now,
    updated_at: now,
  };

  mkdirSync(thesesDir(contextRoot), { recursive: true });
  writeFrontmatter(path, frontmatter, '');
  return readThesisFile(path);
}

export function addPrediction(contextRoot: string, slug: string, text: string): ThesisManifest {
  const manifest = getThesis(contextRoot, slug);
  if (!manifest) throw new ThesisError(`Thesis not found: ${slug}`);
  const t = text?.trim();
  if (!t) throw new ThesisError('Prediction text is required.');
  const predictions = [...manifest.predictions, { id: generateId('pred'), text: t, standing: 'untested' as PredictionStanding }];
  updateFrontmatterFields(manifest.path, { predictions, updated_at: today() });
  return readThesisFile(manifest.path);
}

export interface AddEvidenceInput {
  verdict: EvidenceVerdict;
  source: EvidenceSource;
  ref?: string | null;
  note?: string;
  cycle?: number | null;
  quantitative?: boolean;
  /** Override the recorded date; defaults to today(). */
  date?: string;
}

/** Appends to the (oldest-first) evidence ledger and recomputes confidence. */
export function addEvidence(contextRoot: string, slug: string, input: AddEvidenceInput): ThesisManifest {
  const manifest = getThesis(contextRoot, slug);
  if (!manifest) throw new ThesisError(`Thesis not found: ${slug}`);
  if (!(EVIDENCE_VERDICTS as readonly string[]).includes(input.verdict)) {
    throw new ThesisError(`verdict must be one of: ${EVIDENCE_VERDICTS.join(', ')}.`);
  }
  if (!(EVIDENCE_SOURCES as readonly string[]).includes(input.source)) {
    throw new ThesisError(`source must be one of: ${EVIDENCE_SOURCES.join(', ')}.`);
  }
  const event: EvidenceEvent = {
    date: input.date?.trim() || today(),
    cycle: input.cycle ?? null,
    source: input.source,
    ref: input.ref?.trim() || null,
    verdict: input.verdict,
    note: input.note?.trim() ?? '',
    quantitative: input.quantitative === true,
  };
  const evidence = [...manifest.evidence, event];
  const { confidence } = deriveConfidence(evidence);
  updateFrontmatterFields(manifest.path, {
    evidence,
    confidence,
    cycles_checked: manifest.cycles_checked + 1,
    checked_at: event.date,
    updated_at: today(),
  });
  return readThesisFile(manifest.path);
}

export interface SetStatusInput {
  /** Indices into the CURRENT evidence[] array cited for a manual flip. */
  citations?: number[];
  predictionStandings?: Record<string, PredictionStanding>;
  /** Bypass the citation gate — the sleep-learn agent/data-driven path. */
  force?: boolean;
}

/**
 * Flip a thesis's status. `draft→open` requires ≥1 prediction (hard gate). A
 * MANUAL flip to validated/invalidated requires ≥1 cited evidence index unless
 * `force` (the agent/data-driven path — the ≥3-evidence + prediction-check
 * gate is enforced by the caller, e.g. sleep-learn's prompt contract).
 */
export function setStatus(
  contextRoot: string,
  slug: string,
  status: ThesisStatus,
  input: SetStatusInput = {},
): ThesisManifest {
  const manifest = getThesis(contextRoot, slug);
  if (!manifest) throw new ThesisError(`Thesis not found: ${slug}`);
  if (!(THESIS_STATUSES as readonly string[]).includes(status)) {
    throw new ThesisError(`status must be one of: ${THESIS_STATUSES.join(', ')}.`);
  }
  if (status === 'open' && manifest.predictions.length === 0) {
    throw new ThesisError('Promoting to open requires at least one pre-registered prediction.');
  }
  const isFlip = status === 'validated' || status === 'invalidated';
  if (isFlip && !input.force) {
    const citations = input.citations ?? [];
    if (citations.length === 0) {
      throw new ThesisError('A manual flip to validated/invalidated must cite at least one evidence entry.');
    }
    const outOfRange = citations.filter((i) => i < 0 || i >= manifest.evidence.length);
    if (outOfRange.length > 0) {
      throw new ThesisError(
        `Citation index out of range: ${outOfRange.join(', ')} (evidence has ${manifest.evidence.length} entries).`,
      );
    }
  }

  let predictions = manifest.predictions;
  if (input.predictionStandings) {
    const byId = new Map(predictions.map((p) => [p.id, p]));
    for (const [id, standing] of Object.entries(input.predictionStandings)) {
      if (!byId.has(id)) throw new ThesisError(`Unknown prediction id "${id}".`);
      if (!(PREDICTION_STANDINGS as readonly string[]).includes(standing)) {
        throw new ThesisError(`Prediction standing must be one of: ${PREDICTION_STANDINGS.join(', ')}.`);
      }
    }
    const standings = input.predictionStandings;
    predictions = predictions.map((p) => (p.id in standings ? { ...p, standing: standings[p.id]! } : p));
  }

  updateFrontmatterFields(manifest.path, { status, predictions, updated_at: today() });
  return readThesisFile(manifest.path);
}

export function linkThesis(contextRoot: string, slug: string, kind: ThesisLinkKind, target: string): ThesisManifest {
  const manifest = getThesis(contextRoot, slug);
  if (!manifest) throw new ThesisError(`Thesis not found: ${slug}`);
  const t = target?.trim();
  if (!t) throw new ThesisError('A link target slug is required.');
  assertLinkTargetExists(contextRoot, kind, t);
  const field = linkField(kind);
  const current = manifest[field];
  if (current.includes(t)) return manifest; // idempotent no-op
  updateFrontmatterFields(manifest.path, { [field]: [...current, t], updated_at: today() });
  return readThesisFile(manifest.path);
}

export function unlinkThesis(contextRoot: string, slug: string, kind: ThesisLinkKind, target: string): ThesisManifest {
  const manifest = getThesis(contextRoot, slug);
  if (!manifest) throw new ThesisError(`Thesis not found: ${slug}`);
  const field = linkField(kind);
  const t = target?.trim();
  updateFrontmatterFields(manifest.path, { [field]: manifest[field].filter((s) => s !== t), updated_at: today() });
  return readThesisFile(manifest.path);
}

export interface AppendChangelogEntryInput {
  text: string;
  /** Sleep cycle number, or omit/null for a manual (awake) entry. */
  cycle?: number | null;
  /** Mark this entry as an already-condensed summary (rare — normally computed). */
  condensed?: boolean;
}

/**
 * Append a per-cycle reasoning entry to the body-embedded understanding
 * changelog (newest-first) and enforce the anti-bloat cap: newest 10 raw
 * entries kept verbatim, anything older collapsed into one CONDENSED entry.
 */
export function appendChangelogEntry(
  contextRoot: string,
  slug: string,
  input: AppendChangelogEntryInput,
): ThesisManifest {
  const manifest = getThesis(contextRoot, slug);
  if (!manifest) throw new ThesisError(`Thesis not found: ${slug}`);
  const text = input.text?.trim();
  if (!text) throw new ThesisError('Changelog entry text is required.');

  const when = today();
  const newEntry: ChangelogEntry = {
    cycle: input.condensed ? null : input.cycle ?? null,
    condensed: input.condensed === true,
    when,
    text,
  };
  const reconciled = reconcileChangelog([newEntry, ...manifest.changelog], when);
  const { prose } = splitBody(manifest.body);
  const body = joinBody(prose, reconciled);

  const { data } = readFrontmatter(manifest.path);
  writeFrontmatter(manifest.path, { ...data, updated_at: today() }, body);
  return readThesisFile(manifest.path);
}

/** Set (non-empty metric) or clear (null/empty) the instrumentation-blocked flag. */
export function setBlocked(contextRoot: string, slug: string, metric: string | null): ThesisManifest {
  const manifest = getThesis(contextRoot, slug);
  if (!manifest) throw new ThesisError(`Thesis not found: ${slug}`);
  const m = metric?.trim() || null;
  updateFrontmatterFields(manifest.path, {
    blocked_on_instrumentation: m !== null,
    blocked_metric: m,
    updated_at: today(),
  });
  return readThesisFile(manifest.path);
}

export interface PromoteThesisInput {
  /** Path (relative to context root) of the knowledge doc this thesis promoted into. */
  knowledgePath: string;
  /** Retire the thesis (leave a pointer) once promoted. */
  retire?: boolean;
}

export function promoteThesis(contextRoot: string, slug: string, input: PromoteThesisInput): ThesisManifest {
  const manifest = getThesis(contextRoot, slug);
  if (!manifest) throw new ThesisError(`Thesis not found: ${slug}`);
  const knowledgePath = input.knowledgePath?.trim();
  if (!knowledgePath) throw new ThesisError('A knowledge path is required to promote a thesis.');
  updateFrontmatterFields(manifest.path, {
    promoted_to: knowledgePath,
    status: input.retire ? 'retired' : manifest.status,
    updated_at: today(),
  });
  return readThesisFile(manifest.path);
}
