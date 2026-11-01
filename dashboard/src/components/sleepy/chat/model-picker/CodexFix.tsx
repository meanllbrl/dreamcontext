import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchRunStatus, postFix } from '../../../../hooks/useOnboarding';
import { openExternalUrl } from '../../../../lib/desktop';
import type { FixId } from '../../../../lib/onboardingTypes';

const WORKING: Partial<Record<FixId, string>> = {
  'codex-install': 'Installing Codex…',
  'codex-update': 'Updating Codex…',
  'codex-signin': 'Finish signing in in your browser.',
};
const LABEL: Partial<Record<FixId, string>> = { 'codex-install': 'Install', 'codex-update': 'Update', 'codex-signin': 'Sign in' };

/**
 * The picker's own fix for the Codex row: runs the same recipe as onboarding and `dreamcontext
 * setup`, shows what it is doing, says why when it fails, and refetches the tool list so the
 * models come alive with no restart. A failure stays on this line: Claude chats are not involved.
 */
export function CodexFix({ fix }: { fix: Extract<FixId, 'codex-install' | 'codex-update' | 'codex-signin'> }) {
  const qc = useQueryClient();
  const [state, setState] = useState<'idle' | 'running' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [signInPage, setSignInPage] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const start = async (): Promise<void> => {
    setState('running');
    setError('');
    try {
      const posted = await postFix(fix);
      const runId = posted.ok ? posted.runId : posted.error.code === 'in_progress' ? posted.runId : undefined;
      if (!runId) throw new Error(posted.ok ? 'It did not start.' : posted.error.manual ? `${posted.error.message} ${posted.error.manual}` : posted.error.message);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!alive.current) return;
        const s = await fetchRunStatus(runId);
        if (s.state === 'running') {
          const page = /https:\/\/auth\.openai\.com\/\S+/.exec(s.output)?.[0];
          if (page) setSignInPage(page);
          continue;
        }
        if (s.state === 'done') {
          await qc.invalidateQueries({ queryKey: ['agent-tools'] });
          if (alive.current) setState('idle');
          return;
        }
        throw new Error(s.output.trim().split('\n').slice(-2).join(' ') || 'It did not finish.');
      }
    } catch (err) {
      if (!alive.current) return;
      setError((err as Error).message);
      setState('failed');
    }
  };

  if (state === 'running') {
    return (
      <>
        {' · '}
        <span data-testid="codex-fix-working">{WORKING[fix]}</span>
        {signInPage && <> <button type="button" className="mp-link" data-testid="codex-signin-page" onClick={() => { void openExternalUrl(signInPage); }}>No browser? Open the page</button></>}
      </>
    );
  }
  return (
    <>
      {' · '}
      <button type="button" className="mp-link" data-testid="codex-fix" onClick={() => { void start(); }}>{state === 'failed' ? 'Try again' : LABEL[fix]}</button>
      {state === 'failed' && <span data-testid="codex-fix-error" role="alert"> {error}</span>}
    </>
  );
}
