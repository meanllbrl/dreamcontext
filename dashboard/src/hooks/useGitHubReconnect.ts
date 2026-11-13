import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../context/I18nContext';
import { openExternalUrl } from '../lib/desktop';
import { invalidateAfterSignIn, useDevicePoll, useDeviceStart } from './useBrainStatus';

export type ReconnectPhase = 'idle' | 'starting' | 'waiting' | 'done' | 'error';

/** A generous ceiling; the real bound is the code's own expiry. */
const MAX_POLL_ATTEMPTS = 300;

/**
 * The one GitHub sign-in, started in place from wherever a failure shows (plan D4): the
 * device flow's code is copied, github.com/login/device opens, and the hook polls on the
 * server's interval (honouring `slow_down`). On approval every surface reads the new state
 * and the server starts the queued task-sync drain itself.
 */
export function useGitHubReconnect(onDone?: () => void) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const deviceStart = useDeviceStart();
  const devicePoll = useDevicePoll();
  const [phase, setPhase] = useState<ReconnectPhase>('idle');
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const stopped = useRef(false);

  const stop = useCallback(() => {
    stopped.current = true;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  useEffect(() => () => stop(), [stop]);

  const fail = useCallback((message: string) => { stop(); setPhase('error'); setError(message); }, [stop]);

  const poll = useCallback((sessionId: string, interval: number) => {
    if (stopped.current) return;
    timer.current = setTimeout(async () => {
      if (stopped.current) return;
      attempts.current += 1;
      if (attempts.current > MAX_POLL_ATTEMPTS) { fail(t('brain.auth.device.expired')); return; }
      try {
        const r = await devicePoll.mutateAsync(sessionId);
        if (stopped.current) return;
        switch (r.status) {
          case 'authorized':
            stop(); setPhase('done'); setCode(null);
            invalidateAfterSignIn(queryClient);
            onDone?.();
            return;
          case 'slow_down': poll(sessionId, r.interval); return;
          case 'pending': poll(sessionId, interval); return;
          case 'expired': fail(t('brain.auth.device.expired')); return;
          case 'denied': fail(t('brain.auth.device.denied')); return;
          default: fail(r.message ?? t('brain.auth.device.error'));
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    }, Math.max(1, interval) * 1000);
  }, [devicePoll, fail, onDone, queryClient, stop, t]);

  const start = useCallback(async () => {
    setError(null); setCopied(false); setPhase('starting');
    stopped.current = false; attempts.current = 0;
    try {
      const s = await deviceStart.mutateAsync();
      setCode({ userCode: s.userCode, verificationUri: s.verificationUri });
      setPhase('waiting');
      try { await navigator.clipboard?.writeText(s.userCode); setCopied(true); } catch { /* clipboard blocked: the code stays on screen */ }
      void openExternalUrl(s.verificationUri);
      poll(s.sessionId, s.interval);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }, [deviceStart, fail, poll]);

  const cancel = useCallback(() => { stop(); setPhase('idle'); setCode(null); setError(null); }, [stop]);

  return { phase, code, copied, error, start, cancel };
}
