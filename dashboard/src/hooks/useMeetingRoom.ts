import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

/**
 * The Meeting Room's live state — polling, not a socket.
 *
 * The room's writes all happen server-side (headless runs appending into a
 * thread file), so the UI only ever needs to READ, and how fast it reads is
 * dictated by whether anything is happening: every ~2s while any participant is
 * thinking (an answer can land any moment), backing off to ~10s when the active
 * thread is quiet, and STOPPING once no thread is active — a closed room has
 * nothing left to say until the user posts again, and every user action
 * refreshes immediately anyway.
 */

export type MeetingRunState = 'idle' | 'thinking' | 'replied' | 'passed' | 'error';

export interface MeetingParticipant {
  name: string;
  whatItIs: string;
  state: MeetingRunState;
  error?: string;
  runs: number;
}

export interface MeetingMessage {
  id: string;
  author: string;
  authorKind: 'user' | 'agent' | 'system';
  body: string;
  createdAt: string;
  root?: boolean;
}

export interface MeetingThread {
  id: string;
  title: string;
  createdAt: string;
  closedAt: string | null;
  participants: MeetingParticipant[];
  messages: MeetingMessage[];
  mentionRuns: number;
}

export interface MeetingThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  closedAt: string | null;
}

export interface MeetingRosterEntry {
  name: string;
  whatItIs: string;
}

export interface MeetingState {
  active: MeetingThread | null;
  threads: MeetingThreadSummary[];
  roster: MeetingRosterEntry[];
}

const THINKING_POLL_MS = 2_000;
const IDLE_POLL_MS = 10_000;

export interface UseMeetingRoom {
  state: MeetingState | null;
  error: string | null;
  /** True while a post/reply/close request is in flight. */
  busy: boolean;
  refresh: () => Promise<void>;
  post: (body: string) => Promise<MeetingThread | null>;
  reply: (body: string) => Promise<void>;
  close: () => Promise<void>;
  /** Fetch one (possibly archived) thread for the history rail. */
  fetchThread: (id: string) => Promise<MeetingThread | null>;
}

export function useMeetingRoom(open: boolean): UseMeetingRoom {
  const [state, setState] = useState<MeetingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The poll loop reads the freshest state through a ref — a stale closure over
  // `state` would keep polling at the cadence of the render it was created in.
  const stateRef = useRef<MeetingState | null>(null);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<MeetingState>('/meeting/state');
      setState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // A stopped loop must RESTART when a post opens a new thread, and the effect
  // re-running on the active thread's identity is what restarts it.
  const activeId = state?.active?.id ?? null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      const s = stateRef.current;
      const active = s?.active ?? null;
      // Closed (or never-opened) room: stop — user actions refresh explicitly.
      if (s && !active) return;
      const thinking = active?.participants.some((p) => p.state === 'thinking') ?? false;
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, thinking ? THINKING_POLL_MS : IDLE_POLL_MS);
    };

    void refresh().then(schedule);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, refresh, activeId]);

  const post = useCallback(async (body: string): Promise<MeetingThread | null> => {
    setBusy(true);
    try {
      const res = await api.post<{ thread: MeetingThread }>('/meeting/post', { body });
      await refresh();
      return res.thread;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const reply = useCallback(async (body: string): Promise<void> => {
    setBusy(true);
    try {
      await api.post('/meeting/reply', { body });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const close = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post('/meeting/close', {});
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const fetchThread = useCallback(async (id: string): Promise<MeetingThread | null> => {
    try {
      const res = await api.get<{ thread: MeetingThread }>(`/meeting/thread/${encodeURIComponent(id)}`);
      return res.thread;
    } catch {
      return null;
    }
  }, []);

  return { state, error, busy, refresh, post, reply, close, fetchThread };
}
