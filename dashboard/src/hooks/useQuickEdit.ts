/**
 * The board's quick edit over HTTP (C1): whether it can run here, start, poll the job every
 * 300 ms until it ends, stop, undo, and the board's latest undoable edit (so "Geri al" survives a
 * reload). The decisions live in components/whiteboard/quickEditLogic.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../context/VaultContext';
import { RequestError } from '../api/client';
import { isTerminal, type QuickJobView, type QuickScope } from '../components/whiteboard/quickEditLogic';

export type QuickStatus = { ok: true } | { ok: false; reason: 'no_claude'; text: string };

export const QUICK_POLL_MS = 300;

export interface QuickStartBody {
  text: string;
  scope: QuickScope | null;
  area: { x: number; y: number; w: number; h: number } | null;
}

export type QuickStart = { ok: true; job: string } | { ok: false; status: number; code: string; message: string };

export interface LastEdit { id: string; reply: string; at: string; undone: boolean }

const enc = encodeURIComponent;

export function useQuickEdit(board: string) {
  const api = useApi();
  const [status, setStatus] = useState<QuickStatus | null>(null);
  const boardRef = useRef(board);
  boardRef.current = board;

  const refreshStatus = useCallback(async () => {
    try { setStatus(await api.get<QuickStatus>('/whiteboards/quick-edit/status')); } catch { /* keep the last read */ }
  }, [api]);

  // On mount and whenever the window comes back to the front (a sign-in may have happened).
  useEffect(() => {
    void refreshStatus();
    const onFocus = () => { void refreshStatus(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshStatus]);

  const start = useCallback(async (body: QuickStartBody): Promise<QuickStart> => {
    try {
      const r = await api.post<{ job: string }>(`/whiteboards/${enc(board)}/quick-edit`, body);
      return { ok: true, job: r.job };
    } catch (err) {
      const e = err as RequestError;
      return { ok: false, status: e.status ?? 0, code: e.code ?? '', message: e.message };
    }
  }, [api, board]);

  /** Poll until the job ends (or `signal` aborts). Each read is handed to `onRead`. */
  const follow = useCallback(async (job: string, onRead: (v: QuickJobView) => void, signal: { stopped: boolean }): Promise<QuickJobView | null> => {
    const slug = board;
    for (;;) {
      if (signal.stopped || boardRef.current !== slug) return null;
      let view: QuickJobView;
      try {
        view = await api.get<QuickJobView>(`/whiteboards/${enc(slug)}/quick-edit/${enc(job)}`);
      } catch (err) {
        const e = err as RequestError;
        if (e.status === 404) return null;
        await new Promise((r) => setTimeout(r, QUICK_POLL_MS));
        continue;
      }
      if (signal.stopped) return null;
      onRead(view);
      if (isTerminal(view.state)) return view;
      await new Promise((r) => setTimeout(r, QUICK_POLL_MS));
    }
  }, [api, board]);

  const stop = useCallback(async (job: string): Promise<QuickJobView | null> => {
    try { return await api.post<QuickJobView>(`/whiteboards/${enc(board)}/quick-edit/${enc(job)}/stop`, {}); } catch { return null; }
  }, [api, board]);

  const undo = useCallback(async (edit: string): Promise<{ ok: true; elements: Array<{ id: string } & Record<string, unknown>>; skipped: string[] } | { ok: false; code: string; message: string }> => {
    try {
      const r = await api.post<{ elements: Array<{ id: string } & Record<string, unknown>>; skipped: string[] }>(`/whiteboards/${enc(board)}/quick-edit/${enc(edit)}/undo`, {});
      return { ok: true, elements: r.elements, skipped: r.skipped };
    } catch (err) {
      const e = err as RequestError;
      return { ok: false, code: e.code ?? '', message: e.message };
    }
  }, [api, board]);

  const last = useCallback(async (): Promise<LastEdit | null> => {
    try {
      const r = await api.get<{ edit?: LastEdit }>(`/whiteboards/${enc(board)}/quick-edit/last`);
      return r.edit && !r.edit.undone ? r.edit : null;
    } catch { return null; }
  }, [api, board]);

  return { status, refreshStatus, start, follow, stop, undo, last };
}
