import { describe, expect, it } from 'vitest';
import { runDuration, trimFailureEcho } from '../../dashboard/src/components/agents/agentRunState';

/**
 * A run's state as the #agents channel draws it: the duration wording a running row's live
 * timer shares with a finished row, and the failure row that stops repeating the reason its
 * thread's root already shows (C11).
 */

describe('runDuration', () => {
  it('speaks the runner\'s own wording', () => {
    expect(runDuration(41_000)).toBe('41s');
    expect(runDuration(252_000)).toBe('4m 12s');
    expect(runDuration(240_000)).toBe('4m');
    expect(runDuration(0)).toBe('0s');
  });

  it('says nothing for a run that never reported a length, and never goes negative', () => {
    expect(runDuration(null)).toBeNull();
    expect(runDuration(Number.NaN)).toBeNull();
    expect(runDuration(-5_000)).toBe('0s');
  });
});

describe('trimFailureEcho', () => {
  const REASON = 'Could not reach the analytics API: 401 Unauthorized.';

  it('keeps only the new fact when the root already carries the reason', () => {
    expect(trimFailureEcho(`Failed after 3s: ${REASON}`, REASON)).toBe('Failed after 3s');
  });

  it('does the same for a timeout, and tolerates spacing and a missing full stop', () => {
    expect(trimFailureEcho('Timed out after 1m 5s: the site  never answered.', 'the site never answered'))
      .toBe('Timed out after 1m 5s');
  });

  it('leaves a different reason exactly as the server wrote it', () => {
    const row = `Failed after 3s: ${REASON}`;
    expect(trimFailureEcho(row, 'Something else went wrong.')).toBe(row);
  });

  it('leaves the row whole when there is no root text to echo (an ask thread)', () => {
    const row = `Failed after 3s: ${REASON}`;
    expect(trimFailureEcho(row, null)).toBe(row);
    expect(trimFailureEcho(row, '')).toBe(row);
  });

  it('leaves rows that are not a failure sentence alone', () => {
    expect(trimFailureEcho('Finished in 5s.', 'Finished in 5s.')).toBe('Finished in 5s.');
    expect(trimFailureEcho('Failed after 3s', REASON)).toBe('Failed after 3s');
  });
});
