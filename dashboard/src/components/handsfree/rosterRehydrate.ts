/**
 * The agent surface's roster PUT protocol, as PURE decisions (AgentSurface calls these;
 * `tests/unit/handsfree-roster-rehydrate.test.ts` covers them).
 *
 * The stored roster carries a `generation`. Every PUT names the generation it was based on
 * (`baseGeneration`); a stale one gets 409 `roster_stale`, and the surface then RE-HYDRATES
 * from the stored roster instead of sending its old body again.
 */

/** The PUT body: the payload plus the generation it was based on (omitted before any GET). */
export function withBaseGeneration<T extends object>(payload: T, generation: number | undefined): T & { baseGeneration?: number } {
  return generation === undefined ? payload : { ...payload, baseGeneration: generation };
}

/** The generation a GET (or a PUT's 200) answered, or undefined for a server without one. */
export function generationOf(body: unknown): number | undefined {
  const g = (body as { generation?: unknown } | null)?.generation;
  return typeof g === 'number' && Number.isInteger(g) && g >= 0 ? g : undefined;
}

export type PutOutcome =
  | { kind: 'adopt'; generation: number | undefined }
  /** 409 roster_stale: re-hydrate from the stored roster; the old body is NEVER re-sent. */
  | { kind: 'rehydrate' }
  /** Anything else (423 while away, a network error): best-effort, nothing to do now. */
  | { kind: 'ignore' };

export function putOutcome(r: { ok: true; body: unknown } | { ok: false; status: number; code: string }): PutOutcome {
  if (r.ok) return { kind: 'adopt', generation: generationOf(r.body) };
  if (r.status === 409 && r.code === 'roster_stale') return { kind: 'rehydrate' };
  return { kind: 'ignore' };
}

/** A tab on screen (only the fields this decision reads). */
export interface OpenTabLike { claudeId: string; title: string }
/** A stored roster entry (only the fields this decision reads). */
export interface SavedTabLike { sessionId?: string; title: string }

/**
 * What Mac mode's phone restores from its stored roster: ONLY the chats the Mac runs right now
 * (`live`, the `/agent/live-chats` answer), which the restore then adopts passively with no
 * spawn. A restore used to `--resume` every stored tab, so opening the phone started a `claude`
 * on the Mac for each chat it had ever opened (six at once in the owner's report, 2026-10-17,
 * the oldest from the day before) and listed them all as open. A stored tab that is not running
 * stays a closed chat, under Kapalı, and opens only on a tap. A draining conversation is not
 * adoptable, an entry with no conversation id has nothing to adopt, and `live: null` (the Mac
 * did not answer) restores nothing: the list still shows the Mac's running chats.
 */
export function phoneRestorable<S extends { sessionId?: string }>(
  saved: readonly S[],
  live: { chats: ReadonlyArray<{ conversationId: string }>; draining?: readonly string[] } | null,
): S[] {
  if (!live) return [];
  const draining = new Set(live.draining ?? []);
  const running = new Set(live.chats.map((c) => c.conversationId).filter((id) => !draining.has(id)));
  return saved.filter((m) => !!m.sessionId && running.has(m.sessionId));
}

/**
 * The stored phone tabs a restore could not judge because the Mac did not answer
 * `live-chats`, carried on every save until a restore can: an unreachable Mac must not read as
 * "every chat closed", so a save never deletes their title, mode or agent (pattern
 * a-delete-is-never-inferred-from-absence). Each conversation once; one now on screen is the
 * screen's to write; placement and the GET-only `bound` are dropped.
 */
export function carriedUnrestored<S extends { sessionId?: string; pane?: number; active?: boolean; bound?: boolean }>(
  unrestored: readonly S[],
  onScreen: ReadonlySet<string>,
): Omit<S, 'pane' | 'active' | 'bound'>[] {
  const seen = new Set<string>();
  const out: Omit<S, 'pane' | 'active' | 'bound'>[] = [];
  for (const m of unrestored) {
    if (!m.sessionId || onScreen.has(m.sessionId) || seen.has(m.sessionId)) continue;
    seen.add(m.sessionId);
    const { pane: _pane, active: _active, bound: _bound, ...entry } = m;
    out.push(entry);
  }
  return out;
}

/**
 * Merge the stored roster into the tabs on screen:
 *  - `fresh`: stored entries with no tab here yet (started on the phone, or restored on launch),
 *    each conversation at most once (no duplicate ids); entries without a conversation id pass;
 *  - `open`: the tabs on screen, every one KEPT (laptop-only tabs included), with the stored
 *    title adopted on a re-hydrate (a title renamed on the phone); null when nothing changed.
 */
export function mergeStoredRoster<O extends OpenTabLike, S extends SavedTabLike>(
  open: readonly O[],
  saved: readonly S[],
  o: { adoptTitles: boolean },
): { fresh: S[]; open: O[] | null } {
  const onScreen = new Set(open.map((m) => m.claudeId));
  const seen = new Set<string>();
  const fresh: S[] = [];
  for (const m of saved) {
    if (!m.sessionId) { fresh.push(m); continue; }
    if (onScreen.has(m.sessionId) || seen.has(m.sessionId)) continue;
    seen.add(m.sessionId);
    fresh.push(m);
  }
  if (!o.adoptTitles) return { fresh, open: null };
  const titles = new Map<string, string>();
  for (const m of saved) if (m.sessionId && !titles.has(m.sessionId)) titles.set(m.sessionId, m.title);
  const changed = open.some((m) => titles.has(m.claudeId) && titles.get(m.claudeId) !== m.title);
  return { fresh, open: changed ? open.map((m) => (titles.has(m.claudeId) ? { ...m, title: titles.get(m.claudeId) as string } : m)) : null };
}
