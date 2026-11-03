import { useEffect, useMemo, useRef } from 'react';
import { pollMs } from '../../../lib/windowActivity';
import type { SuperAskSpec, SuperQueueItem } from '../../../lib/superTypes';
import type { ChatSession } from '../chatSession';
import { publishSuperQuestions, type SuperQuestionView } from './superJobsStore';
import { dropSurveyDraft, surveyDraftKey } from '../chat/surveyDrafts';
import type { SuperId } from '../../../lib/superTypes';
import { superRoute } from './superApi';

/**
 * The hands-free phone's Super Agent questions (owner 2026-10-24: a child's 4-question card the
 * Super escalated reached the phone as a push and prose, never as a card). The phone holds no
 * super record (every `/api/super/*` route is laptop-only) and no child socket, so the laptop's
 * publisher in AgentSurface draws nothing there. This one reads the server's view
 * (`GET /api/agent/super-questions`: each open question with its card, a child's as the child
 * asks it) and publishes it for the phone's mirror of the Super's chat, with the route that
 * answers a child's card through the Mac window (`POST /api/agent/super-answer`).
 *
 * Read on open, every {@link PHONE_QUESTIONS_POLL_MS} while the page is visible, and soon after
 * the mirror's transcript grows (a `queue ask` row landing; never on each streamed token), at most
 * once a second. A child question's draft (keyed by the child's request) is dropped when the
 * question leaves the wire.
 */

export const PHONE_QUESTIONS_POLL_MS = 3_000;
const ON_CHANGE_MIN_MS = 1_000;

/** The server's wire (src/server/routes/super-phone-questions.ts). */
export interface PhoneSuperQuestionWire {
  id: string;
  kind: 'ask' | 'question' | 'permission';
  sessionId: string;
  requestId?: string;
  ownerText?: string;
  createdAt: number;
  card: SuperAskSpec | null;
  /** A permission that waits for the owner: its tool and command (plain text, never HTML). */
  permission?: { tool: string; text: string };
}
export interface PhoneSuperQuestionsWire { session: string | null; questions: PhoneSuperQuestionWire[] }

interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

/** A refusal that means the question is gone (answered elsewhere, taken back): nothing to tap
 *  again. Every other refusal (the Mac window away, a socket down, a timeout, a bad answer)
 *  brings the card back with its picks. */
const STALE = new Set(['stale_request', 'no_such_question', 'no_such_permission', 'not_handed_over', 'not_a_child']);
export function retryableAnswerError(error: string | undefined): boolean {
  return !error || !STALE.has(error);
}

/** The wire as the cards read it: queue items (an `ask` carries its spec) and each child
 *  question's card. Pure. */
export function phoneQuestionItems(wire: PhoneSuperQuestionsWire): { open: SuperQueueItem[]; cards: Map<string, SuperAskSpec | null>; permissions: Map<string, { tool: string; text: string }>; key: string } {
  const open: SuperQueueItem[] = [];
  const cards = new Map<string, SuperAskSpec | null>();
  const permissions = new Map<string, { tool: string; text: string }>();
  for (const q of wire.questions ?? []) {
    if (!q || typeof q.id !== 'string') continue;
    if (q.kind === 'permission') {
      // A permission that waits for him: Allow or Deny on the phone (hands-free, never only the Mac).
      if (!q.requestId || !q.permission || typeof q.permission.tool !== 'string' || typeof q.permission.text !== 'string') continue;
      open.push({
        id: q.id, sessionId: q.sessionId, kind: 'permission', state: 'escalated', createdAt: q.createdAt, requestId: q.requestId,
        ...(q.ownerText ? { ownerText: q.ownerText } : {}),
      });
      permissions.set(q.id, { tool: q.permission.tool, text: q.permission.text });
      continue;
    }
    if (q.kind !== 'ask' && q.kind !== 'question') continue;
    open.push({
      id: q.id, sessionId: q.sessionId, kind: q.kind, state: 'escalated', createdAt: q.createdAt,
      ...(q.requestId ? { requestId: q.requestId } : {}), ...(q.ownerText ? { ownerText: q.ownerText } : {}),
      ...(q.kind === 'ask' && q.card ? { ask: q.card } : {}),
    });
    if (q.kind === 'question') cards.set(q.id, q.card);
  }
  // The same item re-asked under a new request id, or its card appearing, redraws.
  const key = open.map((q) => `${q.id}\u0003${q.requestId ?? ''}\u0003${q.ownerText ?? ''}\u0003${cards.has(q.id) ? (cards.get(q.id) ? 'card' : 'words') : permissions.has(q.id) ? 'permission' : ''}`).join('\u0001');
  return { open, cards, permissions, key };
}

/** How far the mirror's transcript reaches (rows, not streamed text). */
function transcriptLength(s: ChatSession): number {
  const m = s.getModel();
  return m.history.length + m.items.length;
}

export function usePhoneSuperQuestions(opts: {
  enabled: boolean;
  api: Api;
  /** The phone's live chat on a conversation (its mirror of the Super's chat, when open). */
  sessionFor: (claudeId: string) => ChatSession | undefined;
  /** Whose questions (plan-r10 AC9): the super the phone shows, a member's from its Ekip sheet.
   *  Absent = main, every request byte-identical to before. */
  superId?: SuperId;
}): void {
  const { enabled, sessionFor } = opts;
  const superId = opts.superId ?? 'main';
  // A member's questions and answers go through its own door (`?superId=m:<slug>`).
  const base = opts.api;
  const api: Api = useMemo(() => (superId === 'main' ? base : {
    get: <T>(path: string) => base.get<T>(superRoute(path, superId)),
    post: <T>(path: string, body?: unknown) => base.post<T>(superRoute(path, superId), body),
  }), [base, superId]);
  const sessionForRef = useRef(sessionFor);
  sessionForRef.current = sessionFor;

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let published: string | null = null;
    let inFlight = false;
    let lastAt = 0;
    let soon: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let watched: ChatSession | undefined;
    let again = false;
    /** The child questions drawn last read (draft key per item id). */
    let drawn = new Map<string, string>();

    const unpublish = () => { if (published) publishSuperQuestions(published, null); published = null; };
    const watch = (s: ChatSession | undefined) => {
      if (s === watched) return;
      unsubscribe?.();
      watched = s;
      let length = s ? transcriptLength(s) : 0;
      unsubscribe = s ? s.subscribe(() => {
        const n = transcriptLength(s);
        if (n !== length) { length = n; schedule(); }
      }) : null;
    };
    const schedule = () => {
      if (soon || disposed) return;
      soon = setTimeout(() => { soon = null; void read(); }, Math.max(0, lastAt + ON_CHANGE_MIN_MS - Date.now()));
    };
    const read = async (): Promise<void> => {
      if (disposed) return;
      // Asked while a read is out: once more after it, so an answer's refresh is never lost.
      if (inFlight) { again = true; return; }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inFlight = true;
      lastAt = Date.now();
      try {
        const wire = await api.get<PhoneSuperQuestionsWire>('/agent/super-questions');
        if (disposed) return;
        if (!wire?.session) {
          for (const draft of drawn.values()) dropSurveyDraft(draft);
          drawn = new Map();
          unpublish(); watch(undefined); return;
        }
        if (published && published !== wire.session) unpublish();
        const superSession = sessionForRef.current(wire.session);
        watch(superSession);
        const { open, cards, permissions, key } = phoneQuestionItems(wire);
        const now = new Map(open.filter((q) => q.kind === 'question' && q.requestId).map((q) => [q.id, surveyDraftKey(q.sessionId, q.requestId as string)] as const));
        for (const [id, draft] of drawn) if (now.get(id) !== draft) dropSurveyDraft(draft);
        drawn = now;
        const view: SuperQuestionView = {
          open,
          superSession,
          sessionFor: () => undefined,
          remote: {
            cardOf: (id) => cards.get(id) ?? null,
            answer: async (item, body) => {
              try {
                const r = await api.post<{ ok?: boolean; error?: string }>('/agent/super-answer', { item: item.id, requestId: item.requestId, ...body });
                return r?.ok === true ? { ok: true, retry: false } : { ok: false, retry: retryableAnswerError(r?.error) };
              } catch (err) {
                // A 409 says why (stale_request: answered elsewhere; no_window: the Mac window).
                const code = (err as { code?: unknown; error?: unknown })?.code ?? (err as { error?: unknown })?.error;
                return { ok: false, retry: retryableAnswerError(typeof code === 'string' ? code : 'network') };
              } finally { schedule(); }
            },
            permissionOf: (id) => permissions.get(id) ?? null,
            answerPermission: async (item, choice) => {
              try {
                const r = await api.post<{ ok?: boolean; error?: string }>('/agent/super-permission', { item: item.id, requestId: item.requestId, choice });
                return r?.ok === true ? { ok: true, retry: false } : { ok: false, retry: retryableAnswerError(r?.error), ...(r?.error ? { error: r.error } : {}) };
              } catch (err) {
                const code = (err as { code?: unknown; error?: unknown })?.code ?? (err as { error?: unknown })?.error;
                const error = typeof code === 'string' ? code : 'network';
                return { ok: false, retry: retryableAnswerError(error), error };
              } finally { schedule(); }
            },
          },
        };
        published = wire.session;
        publishSuperQuestions(wire.session, view, `${key}\u0004${superSession?.id ?? ''}`);
      } catch {
        // The Mac did not answer this time: what is drawn stays until the next read.
      } finally {
        inFlight = false;
        if (again) { again = false; schedule(); }
      }
    };

    void read();
    // The window's poll cadence (windowActivity.ts), like every other super poll.
    const tick = (): void => { void read(); };
    const timer = setInterval(tick, pollMs(PHONE_QUESTIONS_POLL_MS));
    const onVisible = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      clearInterval(timer);
      if (soon) clearTimeout(soon);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe?.();
      unpublish();
    };
  }, [enabled, api]);
}
