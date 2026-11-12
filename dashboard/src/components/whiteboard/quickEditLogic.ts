/**
 * The board writing field's "Hızlı düzenle" decisions (task tahta-hizli-duzenle, plan r4
 * Decisions 1, 8, 12, 16; C1, C3), kept pure so root vitest pins them: which mode the field is
 * in, when a drag over the canvas becomes an empty region, what scope a quick edit sends, and
 * which line the field shows for a job. `BoardSuperField.tsx` and `WhiteboardCanvas.tsx` wire
 * them to the screen.
 */

// ── the mode switch (Decision 1: default quick, last pick remembered per machine) ─────────────

export type FieldMode = 'quick' | 'super';
export const FIELD_MODE_KEY = 'dreamcontext.whiteboard.fieldMode';

type ModeStore = Pick<Storage, 'getItem' | 'setItem'>;

export function readFieldMode(store: ModeStore | null | undefined): FieldMode {
  try { return store?.getItem(FIELD_MODE_KEY) === 'super' ? 'super' : 'quick'; } catch { return 'quick'; }
}

export function writeFieldMode(store: ModeStore | null | undefined, mode: FieldMode): void {
  try { store?.setItem(FIELD_MODE_KEY, mode); } catch { /* private mode: the pick lasts this page */ }
}

/** The mode the field really runs: Super's segment needs Super on; quick needs a Claude account.
 *  With neither, the pick stands and the send is disabled with the reason. */
export function effectiveMode(picked: FieldMode, superOn: boolean, quickOk: boolean): FieldMode {
  if (picked === 'super' && !superOn && quickOk) return 'quick';
  if (picked === 'quick' && !quickOk && superOn) return 'super';
  return picked;
}

// ── the empty region (Decision 12) ───────────────────────────────────────────────────────────

/** Scene [x, y, w, h], rounded. */
export type Region = [number, number, number, number];

/** The smallest drag that becomes a region, in SCREEN px each way. */
export const REGION_MIN_PX = 24;
/** A pointer that moved less than this (screen px) was a click. */
export const CLICK_SLOP_PX = 4;

export interface DragEnd {
  /** Scene coordinates where the pointer went down and where it came up. */
  origin: { x: number; y: number };
  end: { x: number; y: number };
  zoom: number;
  tool: string;
  /** Selected after the up settled. */
  selectedCount: number;
  /** The pointer went down on an element (a move, a resize). */
  hitElement: boolean;
}

export type DragOutcome = { kind: 'region'; region: Region } | { kind: 'click' } | { kind: 'none' };

/** What a finished pointer gesture means for the region: a new one, a plain click (clears it), or
 *  nothing (another tool, a shape selected, a move). */
export function dragOutcome(d: DragEnd): DragOutcome {
  if (d.tool !== 'selection' || d.hitElement || d.selectedCount > 0) return { kind: 'none' };
  const zoom = Number.isFinite(d.zoom) && d.zoom > 0 ? d.zoom : 1;
  const dx = Math.abs(d.end.x - d.origin.x) * zoom;
  const dy = Math.abs(d.end.y - d.origin.y) * zoom;
  if (dx < CLICK_SLOP_PX && dy < CLICK_SLOP_PX) return { kind: 'click' };
  if (dx < REGION_MIN_PX || dy < REGION_MIN_PX) return { kind: 'none' };
  const x = Math.min(d.origin.x, d.end.x);
  const y = Math.min(d.origin.y, d.end.y);
  return { kind: 'region', region: [Math.round(x), Math.round(y), Math.round(Math.abs(d.end.x - d.origin.x)), Math.round(Math.abs(d.end.y - d.origin.y))] };
}

/** "Alan · 210×190". */
export function regionChipText(region: Region, t: (key: string) => string): string {
  return t('whiteboard.quick.regionChip').replace('{w}', String(region[2])).replace('{h}', String(region[3]));
}

/** The request's `area` (C1): `{x, y, w, h}`, sizes held to the route's 8..20000. */
export function areaOf(region: Region | null): { x: number; y: number; w: number; h: number } | null {
  if (!region) return null;
  const clamp = (v: number) => Math.min(20000, Math.max(8, v));
  return { x: region[0], y: region[1], w: clamp(region[2]), h: clamp(region[3]) };
}

// ── the scope a quick edit sends (C3: selection + bound text + group members, with identities) ──

export interface ScopeElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  groupIds?: readonly string[];
  containerId?: string | null;
}

/** The server's cap (QUICK_SCOPE_MAX). The 12-id cap of the Super wire does not apply here. */
export const QUICK_SCOPE_MAX = 150;

export interface QuickScope { ids: string[]; identities: Record<string, string> }

const outerGroup = (el: ScopeElement): string | null => {
  const g = Array.isArray(el.groupIds) ? el.groupIds.filter((x) => typeof x === 'string') : [];
  return g.length ? g[g.length - 1] : null;
};

/** The selection grown the server's one way (`expandScope`): each selected live element, every
 *  member of its outermost group, a text's container, a container's bound text; each with the
 *  identity this page holds (`version:versionNonce`). Null for an empty selection. */
export function quickEditScope(elements: readonly ScopeElement[], selectedIds: readonly string[]): QuickScope | null {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => { if (!seen.has(id) && byId.has(id)) { seen.add(id); out.push(id); } };
  for (const id of selectedIds) add(id);
  if (out.length === 0) return null;
  const groups = new Set<string>();
  for (const id of [...out]) { const g = outerGroup(byId.get(id)!); if (g) groups.add(g); }
  if (groups.size) for (const el of live) { const g = outerGroup(el); if (g && groups.has(g)) add(el.id); }
  for (const id of [...out]) {
    const el = byId.get(id)!;
    if (el.type === 'text' && typeof el.containerId === 'string') add(el.containerId);
  }
  for (const el of live) if (typeof el.containerId === 'string' && seen.has(el.containerId)) add(el.id);
  const identities: Record<string, string> = {};
  for (const id of out) { const el = byId.get(id)!; identities[id] = `${el.version}:${el.versionNonce}`; }
  return { ids: out, identities };
}

// ── the job, as the field shows it ───────────────────────────────────────────────────────────

export type QuickJobState = 'queued' | 'running' | 'applying' | 'done' | 'failed' | 'stopped';

export interface QuickJobView {
  state: QuickJobState;
  startedAt: string;
  reply?: string;
  notBoard?: boolean;
  outOfScope?: boolean;
  edit?: { id: string; added: number; changed: number; skipped: string[] };
  skipped?: string[];
  elements?: Array<{ id: string } & Record<string, unknown>>;
  /** A failed job's reason; worded here, never the server's prose (review r1). */
  code?: string;
  error?: string;
  /** The answer asked for changes and none could be made. */
  nothing?: boolean;
  /** Asked-for changes that could not be made beside the ones that were. */
  dropped?: number;
}

/** The server's failure codes the field words itself; any other code reads as the generic line. */
const FAIL_CODES = new Set(['spawn', 'timeout', 'limit', 'unreadable', 'too_big', 'refused', 'write']);
export const failKey = (code: string | undefined): string => (code && FAIL_CODES.has(code) ? `whiteboard.quick.err.${code}` : 'whiteboard.quick.failed');

/** An undo refusal, in the owner's words (key under whiteboard.quick.*). */
export function undoRefusalKey(code: string): string {
  if (code === 'not_latest') return 'whiteboard.quick.undoNotLatest';
  if (code === 'not_found') return 'whiteboard.quick.undoGone';
  return 'whiteboard.quick.failed';
}

export const isTerminal = (s: QuickJobState): boolean => s === 'done' || s === 'failed' || s === 'stopped';

/** What the field's bottom line shows. */
export type QuickLine =
  | { kind: 'running'; seconds: number }
  | { kind: 'done'; reply: string; editId: string | null; skipped: number; dropped: number }
  | { kind: 'nothing'; reply: string }
  | { kind: 'notBoard'; reply: string }
  | { kind: 'outOfScope'; reply: string }
  | { kind: 'failed'; text: string }
  | { kind: 'stopped' }
  | { kind: 'undone'; skipped: number };

/** A finished job's line. A done edit that wrote nothing and was not refused reads as done with
 *  no Geri al. */
export function lineOfJob(job: QuickJobView, t: (key: string) => string): QuickLine {
  if (job.state === 'stopped') return { kind: 'stopped' };
  if (job.state === 'failed') return { kind: 'failed', text: t(failKey(job.code)) };
  const reply = (job.reply ?? '').trim();
  if (job.notBoard) return { kind: 'notBoard', reply: reply || t('whiteboard.quick.notBoard') };
  if (job.outOfScope) return { kind: 'outOfScope', reply: reply || t('whiteboard.quick.outOfScope') };
  if (job.nothing) return { kind: 'nothing', reply: t('whiteboard.quick.nothing') };
  return { kind: 'done', reply: reply || t('whiteboard.quick.doneDefault'), editId: job.edit?.id ?? null, skipped: (job.edit?.skipped ?? job.skipped ?? []).length, dropped: job.dropped ?? 0 };
}

/** The ids an applied edit ADDED: what it wrote that the scene did not hold before. */
export function addedIds(written: readonly { id: string; isDeleted?: unknown }[], before: ReadonlySet<string>): string[] {
  return written.filter((e) => !before.has(e.id) && e.isDeleted !== true).map((e) => e.id);
}

/** The refusal a start answered with, in the owner's words (key under whiteboard.quick.*). */
export function startRefusalKey(status: number, code: string): string {
  if (code === 'busy' || status === 409) return 'whiteboard.quick.busy';
  if (code === 'rate' || status === 429) return 'whiteboard.quick.rate';
  if (code === 'scope_too_big' || status === 413) return 'whiteboard.quick.tooBig';
  if (code === 'no_claude' || status === 412) return 'whiteboard.quick.noClaude';
  if (status === 404) return 'whiteboard.field.deleted';
  return 'whiteboard.quick.failed';
}
