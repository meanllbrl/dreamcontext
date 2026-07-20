import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { updateFrontmatterFields } from '../../lib/frontmatter.js';
import { today } from '../../lib/id.js';
import { readSetupConfig, updateSetupConfig, isLearningEnabled } from '../../lib/setup-config.js';
import {
  thesesDir,
  listTheses,
  getThesis,
  createThesis,
  addPrediction,
  addEvidence,
  setStatus,
  linkThesis,
  unlinkThesis,
  appendChangelogEntry,
  setBlocked,
  promoteThesis,
  type ThesisLinkKind,
} from '../../lib/theses/store.js';
import { deriveConfidence, type ConfidenceBreakdown } from '../../lib/theses/confidence.js';
import {
  ThesisError,
  THESIS_STATUSES,
  THESIS_KINDS,
  EVIDENCE_VERDICTS,
  EVIDENCE_SOURCES,
  type ThesisManifest,
  type ThesisStatus,
  type ThesisKind,
  type EvidenceVerdict,
  type EvidenceSource,
  type PredictionStanding,
} from '../../lib/theses/types.js';

/**
 * Theses (proactive learning layer) HTTP API — mirrors lab.ts/objectives.ts:
 * thin wrappers over the same store the CLI uses. ThesisError from a "not
 * found" message → 404, any other ThesisError → 400 (client-fixable), else 500.
 *
 * Read routes (list/show) work REGARDLESS of `learning.enabled` — the flag is
 * surfaced (`enabled`) so the dashboard can render the off-state, not used to
 * block reads/writes here. This mirrors the CLI's "still callable, just
 * hinted" disabled-layer behavior (see setup-config.ts `isLearningEnabled`).
 */

export interface ThesisView extends Omit<ThesisManifest, 'path' | 'body'> {
  /** ws/wc/supports/contradicts/noSignal — powers the "how is this computed?" popover. */
  confidenceBreakdown: ConfidenceBreakdown;
}

function toThesisView(m: ThesisManifest): ThesisView {
  const { path: _path, body: _body, ...rest } = m;
  return { ...rest, confidenceBreakdown: deriveConfidence(m.evidence) };
}

interface ThesisCandidate {
  claim: string;
  kind: ThesisKind;
  predictions: string[];
}

interface ThesisCandidates {
  note: string;
  items: ThesisCandidate[];
}

/**
 * Reads the meeting-note candidate staging file (`theses/.candidates.json`),
 * written by `dreamcontext theses candidates <file.json>`. Lenient: a missing
 * or malformed file degrades to `null`, never throws — this is a UI hint, not
 * a source of truth.
 */
function readCandidates(contextRoot: string): ThesisCandidates | null {
  const path = join(thesesDir(contextRoot), '.candidates.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const note = typeof parsed.note === 'string' ? parsed.note : '';
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items: ThesisCandidate[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      const claim = typeof r.claim === 'string' ? r.claim.trim() : '';
      if (!claim) continue;
      const kind = (THESIS_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as ThesisKind) : 'observational';
      const predictions = Array.isArray(r.predictions)
        ? r.predictions.map((p) => String(p).trim()).filter(Boolean)
        : [];
      items.push({ claim, kind, predictions });
    }
    return { note, items };
  } catch {
    return null;
  }
}

function toStringArrayField(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    : undefined;
}

function isThesisLinkKind(v: unknown): v is ThesisLinkKind {
  return v === 'insight' || v === 'objective' || v === 'task';
}

/** Maps a store failure to an HTTP response: "not found" messages → 404, else 400. */
function sendThesisError(res: ServerResponse, err: unknown, fallbackCode: string, fallbackMessage: string): void {
  if (err instanceof ThesisError) {
    const notFound = /not found/i.test(err.message);
    sendError(res, notFound ? 404 : 400, notFound ? 'not_found' : fallbackCode, err.message);
    return;
  }
  console.error(`[theses] ${fallbackCode}:`, err);
  sendError(res, 500, fallbackCode, fallbackMessage);
}

/** GET /api/theses — every thesis + the layer's enabled flag + staged meeting-note candidates. */
export async function handleThesesList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const config = readSetupConfig(dirname(contextRoot));
    const theses = listTheses(contextRoot).map(toThesisView);
    sendJson(res, 200, { enabled: isLearningEnabled(config), theses, candidates: readCandidates(contextRoot) });
  } catch (err) {
    console.error('[theses] list failed:', err);
    sendError(res, 500, 'list_failed', 'Failed to read theses.');
  }
}

/**
 * POST /api/theses — create a thesis. Body:
 *   { claim (required), kind?, predictions?, insights?, objectives?, related_tasks?, open?, created_by? }
 * `open: true` without ≥1 prediction throws (draft→open hard gate).
 */
export async function handleThesesCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }
  const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
  if (!claim) {
    sendError(res, 400, 'missing_claim', 'A thesis claim is required.');
    return;
  }
  let kind: ThesisKind | undefined;
  if (body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !(THESIS_KINDS as readonly string[]).includes(body.kind)) {
      sendError(res, 400, 'invalid_kind', `kind must be one of: ${THESIS_KINDS.join(', ')}.`);
      return;
    }
    kind = body.kind as ThesisKind;
  }
  let createdBy: 'user' | 'sleep-learn' | undefined;
  if (body.created_by !== undefined) {
    if (body.created_by !== 'user' && body.created_by !== 'sleep-learn') {
      sendError(res, 400, 'invalid_created_by', 'created_by must be "user" or "sleep-learn".');
      return;
    }
    createdBy = body.created_by;
  }

  try {
    const thesis = createThesis(contextRoot, {
      claim,
      kind,
      createdBy,
      predictions: toStringArrayField(body.predictions),
      insights: toStringArrayField(body.insights),
      objectives: toStringArrayField(body.objectives),
      relatedTasks: toStringArrayField(body.related_tasks),
      open: body.open === true,
    });
    sendJson(res, 201, { thesis: toThesisView(thesis) });
  } catch (err) {
    sendThesisError(res, err, 'create_rejected', 'Failed to create the thesis.');
  }
}

/** GET /api/theses/:slug — full manifest + confidence breakdown + parsed changelog. */
export async function handleThesesShow(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const manifest = getThesis(contextRoot, params.slug);
    if (!manifest) {
      sendError(res, 404, 'not_found', `Thesis not found: ${params.slug}`);
      return;
    }
    const view = toThesisView(manifest);
    sendJson(res, 200, { thesis: view, confidence: view.confidenceBreakdown, changelog: view.changelog });
  } catch (err) {
    console.error('[theses] show failed:', err);
    sendError(res, 500, 'show_failed', 'Failed to read the thesis.');
  }
}

/**
 * PATCH /api/theses/:slug — update authored fields. Body may carry any subset
 * of { claim, kind, blocked: { metric } | null }. The store has no dedicated
 * claim/kind setter (only creation-time + the lifecycle/link/evidence verbs),
 * so this validates inline (mirrors the store's own STRICT-on-write posture)
 * and persists via the shared `updateFrontmatterFields` primitive; `blocked`
 * still routes through the store's `setBlocked`.
 */
export async function handleThesesUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }
  const manifest = getThesis(contextRoot, params.slug);
  if (!manifest) {
    sendError(res, 404, 'not_found', `Thesis not found: ${params.slug}`);
    return;
  }

  try {
    if ('blocked' in body) {
      const blocked = body.blocked;
      if (blocked === null) {
        setBlocked(contextRoot, params.slug, null);
      } else if (
        blocked && typeof blocked === 'object' && !Array.isArray(blocked)
        && typeof (blocked as Record<string, unknown>).metric === 'string'
        && ((blocked as Record<string, unknown>).metric as string).trim()
      ) {
        setBlocked(contextRoot, params.slug, ((blocked as Record<string, unknown>).metric as string).trim());
      } else {
        sendError(res, 400, 'invalid_blocked', 'blocked must be null or { metric: <non-empty string> }.');
        return;
      }
    }

    const fmPatch: Record<string, unknown> = {};
    if ('claim' in body) {
      const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
      if (!claim) {
        sendError(res, 400, 'invalid_claim', 'claim must be a non-empty string.');
        return;
      }
      fmPatch.claim = claim;
    }
    if ('kind' in body) {
      if (typeof body.kind !== 'string' || !(THESIS_KINDS as readonly string[]).includes(body.kind)) {
        sendError(res, 400, 'invalid_kind', `kind must be one of: ${THESIS_KINDS.join(', ')}.`);
        return;
      }
      fmPatch.kind = body.kind;
    }
    if (Object.keys(fmPatch).length > 0) {
      updateFrontmatterFields(manifest.path, { ...fmPatch, updated_at: today() });
    }

    const updated = getThesis(contextRoot, params.slug)!;
    sendJson(res, 200, { thesis: toThesisView(updated) });
  } catch (err) {
    sendThesisError(res, err, 'update_rejected', 'Failed to update the thesis.');
  }
}

/**
 * DELETE /api/theses/:slug — retires the thesis (default) or hard-deletes the
 * manifest file when `?hard=1` is passed. Retiring is not a "flip" (only
 * validated/invalidated require a citation), so no `force`/citation is needed.
 */
export async function handleThesesDelete(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const manifest = getThesis(contextRoot, params.slug);
  if (!manifest) {
    sendError(res, 404, 'not_found', `Thesis not found: ${params.slug}`);
    return;
  }
  const url = new URL(req.url || '', 'http://localhost');
  const hard = url.searchParams.get('hard') === '1';
  try {
    if (hard) {
      unlinkSync(manifest.path);
      sendJson(res, 200, { deleted: params.slug, hard: true });
      return;
    }
    const thesis = setStatus(contextRoot, params.slug, 'retired');
    sendJson(res, 200, { thesis: toThesisView(thesis), hard: false });
  } catch (err) {
    sendThesisError(res, err, 'delete_rejected', 'Failed to delete the thesis.');
  }
}

/** POST /api/theses/:slug/predictions { text } — pre-register a falsifiable prediction. */
export async function handleThesesAddPrediction(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  const text = body && typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    sendError(res, 400, 'missing_text', 'A prediction "text" is required.');
    return;
  }
  try {
    const thesis = addPrediction(contextRoot, params.slug, text);
    sendJson(res, 200, { thesis: toThesisView(thesis) });
  } catch (err) {
    sendThesisError(res, err, 'prediction_rejected', 'Failed to add the prediction.');
  }
}

/**
 * POST /api/theses/:slug/evidence { verdict, source, ref?, note?, cycle?, quantitative? }
 * — appends to the (oldest-first) evidence ledger; confidence recomputes.
 */
export async function handleThesesAddEvidence(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }
  const verdict = body.verdict;
  if (typeof verdict !== 'string' || !(EVIDENCE_VERDICTS as readonly string[]).includes(verdict)) {
    sendError(res, 400, 'invalid_verdict', `verdict must be one of: ${EVIDENCE_VERDICTS.join(', ')}.`);
    return;
  }
  const source = body.source;
  if (typeof source !== 'string' || !(EVIDENCE_SOURCES as readonly string[]).includes(source)) {
    sendError(res, 400, 'invalid_source', `source must be one of: ${EVIDENCE_SOURCES.join(', ')}.`);
    return;
  }
  try {
    const thesis = addEvidence(contextRoot, params.slug, {
      verdict: verdict as EvidenceVerdict,
      source: source as EvidenceSource,
      ref: typeof body.ref === 'string' ? body.ref : null,
      note: typeof body.note === 'string' ? body.note : undefined,
      cycle: typeof body.cycle === 'number' && Number.isFinite(body.cycle) ? body.cycle : null,
      quantitative: body.quantitative === true,
    });
    sendJson(res, 200, { thesis: toThesisView(thesis) });
  } catch (err) {
    sendThesisError(res, err, 'evidence_rejected', 'Failed to add the evidence.');
  }
}

/**
 * POST /api/theses/:slug/status { status, citations?, predictionStandings?, force? }
 * — flips lifecycle status. draft→open needs ≥1 prediction (store-enforced). A
 * MANUAL flip to validated/invalidated without `force` needs ≥1 cited evidence
 * index — omitting `citations` on a flip throws, which maps to 400 here.
 */
export async function handleThesesSetStatus(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }
  const status = body.status;
  if (typeof status !== 'string' || !(THESIS_STATUSES as readonly string[]).includes(status)) {
    sendError(res, 400, 'invalid_status', `status must be one of: ${THESIS_STATUSES.join(', ')}.`);
    return;
  }
  const citations = Array.isArray(body.citations)
    ? body.citations.filter((n): n is number => typeof n === 'number')
    : undefined;
  const predictionStandings = body.predictionStandings
    && typeof body.predictionStandings === 'object'
    && !Array.isArray(body.predictionStandings)
    ? (body.predictionStandings as Record<string, PredictionStanding>)
    : undefined;
  try {
    const thesis = setStatus(contextRoot, params.slug, status as ThesisStatus, {
      citations,
      predictionStandings,
      force: body.force === true,
    });
    sendJson(res, 200, { thesis: toThesisView(thesis) });
  } catch (err) {
    sendThesisError(res, err, 'status_rejected', 'Failed to update the status.');
  }
}

/** POST /api/theses/:slug/links { kind: 'insight'|'objective'|'task', slug } — link a target (target must exist). */
export async function handleThesesLink(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  const kind = body?.kind;
  const targetSlug = body && typeof body.slug === 'string' ? body.slug.trim() : '';
  if (!isThesisLinkKind(kind)) {
    sendError(res, 400, 'invalid_kind', 'kind must be one of: insight, objective, task.');
    return;
  }
  if (!targetSlug) {
    sendError(res, 400, 'missing_slug', 'A link target "slug" is required.');
    return;
  }
  try {
    const thesis = linkThesis(contextRoot, params.slug, kind, targetSlug);
    sendJson(res, 200, { thesis: toThesisView(thesis) });
  } catch (err) {
    sendThesisError(res, err, 'link_rejected', 'Failed to add the link.');
  }
}

/** DELETE /api/theses/:slug/links/:kind/:target — unlink (idempotent). */
export async function handleThesesUnlink(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isThesisLinkKind(params.kind)) {
    sendError(res, 400, 'invalid_kind', 'kind must be one of: insight, objective, task.');
    return;
  }
  try {
    const thesis = unlinkThesis(contextRoot, params.slug, params.kind, params.target);
    sendJson(res, 200, { thesis: toThesisView(thesis) });
  } catch (err) {
    sendThesisError(res, err, 'unlink_rejected', 'Failed to remove the link.');
  }
}

/**
 * POST /api/theses/:slug/changelog { text, cycle?, condensed? } — append a
 * per-cycle understanding-changelog entry (LIFO, anti-bloat cap enforced by the store).
 */
export async function handleThesesChangelog(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  const text = body && typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    sendError(res, 400, 'missing_text', 'Changelog "text" is required.');
    return;
  }
  const cycle = body && typeof body.cycle === 'number' && Number.isFinite(body.cycle) ? body.cycle : null;
  const condensed = body?.condensed === true;
  try {
    const thesis = appendChangelogEntry(contextRoot, params.slug, { text, cycle, condensed });
    sendJson(res, 200, { thesis: toThesisView(thesis) });
  } catch (err) {
    sendThesisError(res, err, 'changelog_rejected', 'Failed to append the changelog entry.');
  }
}

/**
 * POST /api/theses/:slug/promote { knowledgePath, retire? } — records the
 * knowledge doc this thesis promoted into; optionally retires it (leaves a
 * pointer). Never writes the knowledge doc itself — that's the decision-ask /
 * sleep-product channel's job.
 */
export async function handleThesesPromote(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  const knowledgePath = body && typeof body.knowledgePath === 'string' ? body.knowledgePath.trim() : '';
  if (!knowledgePath) {
    sendError(res, 400, 'missing_knowledge_path', 'A "knowledgePath" is required to promote a thesis.');
    return;
  }
  try {
    const thesis = promoteThesis(contextRoot, params.slug, { knowledgePath, retire: body?.retire === true });
    sendJson(res, 200, { thesis: toThesisView(thesis) });
  } catch (err) {
    sendThesisError(res, err, 'promote_rejected', 'Failed to promote the thesis.');
  }
}

/** POST /api/learning/enable — flips `learning.enabled` on (the one-command switch). */
export async function handleLearningEnable(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const config = updateSetupConfig(dirname(contextRoot), { learning: { enabled: true } });
    sendJson(res, 200, { enabled: isLearningEnabled(config) });
  } catch (err) {
    console.error('[theses] learning enable failed:', err);
    sendError(res, 500, 'enable_failed', 'Failed to enable the learning layer.');
  }
}

/** POST /api/learning/disable — flips `learning.enabled` off. */
export async function handleLearningDisable(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const config = updateSetupConfig(dirname(contextRoot), { learning: { enabled: false } });
    sendJson(res, 200, { enabled: isLearningEnabled(config) });
  } catch (err) {
    console.error('[theses] learning disable failed:', err);
    sendError(res, 500, 'disable_failed', 'Failed to disable the learning layer.');
  }
}
