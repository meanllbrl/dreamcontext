import { useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { openExternalUrl } from '../../../../lib/desktop';
import { fetchRunStatus, postFix } from '../../../../hooks/useOnboarding';
import type { FixId } from '../../../../lib/onboardingTypes';

type CodexFixId = Extract<FixId, 'codex-install' | 'codex-update' | 'codex-signin' | 'antigravity-install' | 'antigravity-signin'>;

const WORKING: Record<CodexFixId, string> = {
  'codex-install': 'Installing Codex…',
  'codex-update': 'Updating Codex…',
  'codex-signin': 'Finish signing in in your browser.',
  'antigravity-install': 'Installing Antigravity…',
  'antigravity-signin': 'Finish signing in in your browser.',
};
const LABEL: Record<CodexFixId, string> = { 'codex-install': 'Install', 'codex-update': 'Update', 'codex-signin': 'Sign in', 'antigravity-install': 'Install', 'antigravity-signin': 'Sign in' };
const READ_FAILURES_ALLOWED = 3;

interface FixState { running: boolean; error: string; signInPage: string }
const IDLE: FixState = { running: false, error: '', signInPage: '' };

/** Out of React on purpose: the picker unmounts on close, on search and on a rail switch, and the
 *  server's run goes on. Coming back shows the same run, or how it ended. */
const states = new Map<CodexFixId, FixState>();
const listeners = new Set<() => void>();
const stateOf = (fix: CodexFixId): FixState => states.get(fix) ?? IDLE;
function put(fix: CodexFixId, next: Partial<FixState>): void {
  states.set(fix, { ...stateOf(fix), ...next });
  for (const l of listeners) l();
}
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Why the server refused, in words: what it names is what a person can act on. */
function refusal(e: { code: string; message: string; manual?: string; blockedBy?: string[] }): string {
  if (e.blockedBy?.includes('network')) return "You're offline. Connect to the internet and try again.";
  if (e.blockedBy?.includes('npm')) return 'The Node package manager is missing on this computer.';
  return e.manual ? `${e.message} ${e.manual}` : e.message;
}

async function run(fix: CodexFixId, qc: QueryClient): Promise<void> {
  if (stateOf(fix).running) return;
  put(fix, { running: true, error: '', signInPage: '' });
  let error = '';
  try {
    const posted = await postFix(fix);
    const runId = posted.ok ? posted.runId : posted.error.code === 'in_progress' ? posted.runId : undefined;
    if (!runId) throw new Error(posted.ok ? 'It did not start.' : refusal(posted.error));
    let misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await fetchRunStatus(runId).catch(() => null);
      if (!s) {
        if (++misses >= READ_FAILURES_ALLOWED) throw new Error('Lost contact with dreamcontext. Try again.');
        continue;
      }
      misses = 0;
      if (s.state === 'running') {
        const page = /https:\/\/(?:auth\.openai\.com|accounts\.google\.com)\/\S+/.exec(s.output)?.[0];
        // Codex opens its own browser; T3 holds Antigravity's back and hands the page over.
        if (page && fix === 'antigravity-signin' && stateOf(fix).signInPage !== page) void openExternalUrl(page);
        if (page) put(fix, { signInPage: page });
        continue;
      }
      if (s.state === 'done') break;
      if (s.state === 'unknown') throw new Error('dreamcontext restarted during this. Try again.');
      throw new Error(s.output.trim().split('\n').slice(-2).join(' ') || 'It did not finish.');
    }
  } catch (err) {
    error = (err as Error).message;
  }
  put(fix, { running: false, error, signInPage: '' });
  // Every ending: a Node or a Codex may have landed before a later step failed.
  await qc.invalidateQueries({ queryKey: ['agent-tools'] });
}

/**
 * The picker's own fix for the Codex row: the same recipe as onboarding and `dreamcontext setup`.
 * It shows what it is doing, says why when it fails, and refetches the tool list so the models
 * come alive with no restart. A failure stays on this line: Claude chats are not involved.
 */
export function CodexFix({ fix }: { fix: CodexFixId }) {
  const qc = useQueryClient();
  const s = useSyncExternalStore(subscribe, () => stateOf(fix));
  if (s.running) {
    return (
      <>
        {' · '}
        <span data-testid="codex-fix-working" role="status">{WORKING[fix]}</span>
        {s.signInPage && <> <button type="button" className="mp-link" data-testid="codex-signin-page" onClick={() => { void openExternalUrl(s.signInPage); }}>No browser? Open the page</button></>}
      </>
    );
  }
  return (
    <>
      {' · '}
      <button type="button" className="mp-link" data-testid="codex-fix" onClick={() => { void run(fix, qc); }}>{s.error ? 'Try again' : LABEL[fix]}</button>
      {s.error && <span data-testid="codex-fix-error" role="alert"> {s.error}</span>}
    </>
  );
}
