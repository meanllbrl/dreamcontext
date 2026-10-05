/**
 * The agent surface's roster against a hands-free Return, as PURE decisions (AgentSurface calls
 * these; `tests/unit/handsfree-roster-rehydrate.test.ts` covers them).
 *
 * The stored roster carries a `generation` that only a Return's merge bumps. Every PUT names
 * the generation it was based on (`baseGeneration`); a PUT from before a merge gets 409
 * `roster_stale`, and the surface then RE-HYDRATES from the stored roster instead of sending its
 * old body again. The laptop coming home (away/returning -> home) re-hydrates too, so sessions
 * started on the phone appear, and a tab change made here while PUTs were refused (the lock)
 * gives way to the merged roster.
 */

export type HandsfreePhaseLike = 'home' | 'going' | 'away' | 'returning' | null;

/** The away/returning -> home edge (the first status read, null -> home, is not one). */
export function rehydrateOnPhase(prev: HandsfreePhaseLike, next: HandsfreePhaseLike): boolean {
  return next === 'home' && (prev === 'away' || prev === 'returning');
}

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
