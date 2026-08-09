/**
 * Machine-local card → session bindings.
 *
 * This file exists because a review card lives in the PROJECT directory while
 * the session it names is a capability. The binding recorded here is the
 * authority; the card is only an assertion. Everything below protects that
 * distinction, and the direction of every failure is "not resumable", because a
 * card that cannot be approved is a nuisance and a card that resumes the wrong
 * session is a compromise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cardBindingsPath,
  forgetCardSession,
  readCardSession,
  recordCardSession,
} from '../../src/lib/automations/card-registry.js';

let home: string;
const NOW = Date.parse('2026-08-04T10:00:00.000Z');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-cardreg-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('recording and reading', () => {
  it('round-trips a binding', () => {
    expect(recordCardSession('rev_1', 'digest', 'sess-abc', home, NOW)).toBe(true);
    expect(readCardSession('rev_1', 'digest', home)).toBe('sess-abc');
  });

  it('is written 0600 — it names a resumable bypassPermissions session', () => {
    recordCardSession('rev_1', 'digest', 'sess-abc', home, NOW);
    expect(statSync(cardBindingsPath(home)).mode & 0o777).toBe(0o600);
  });

  it('lives in ~/.dreamcontext — the same boundary as the approval registry', () => {
    expect(cardBindingsPath(home)).toBe(join(home, '.dreamcontext', 'automations-cards.json'));
  });

  it('an unknown card is NOT resumable — which is what a planted card looks like', () => {
    expect(readCardSession('rev_never_recorded', 'digest', home)).toBeNull();
  });

  it('refuses to record a session id that is not path-safe', () => {
    expect(recordCardSession('rev_1', 'digest', '../../etc/passwd', home, NOW)).toBe(false);
    expect(recordCardSession('rev_2', 'digest', null, home, NOW)).toBe(false);
    expect(readCardSession('rev_1', 'digest', home)).toBeNull();
  });

  it('a binding cannot be borrowed under a different automation', () => {
    // Otherwise moving a card file into another slug's directory would let it
    // resume a session that belongs to a different, possibly more privileged job.
    recordCardSession('rev_1', 'digest', 'sess-abc', home, NOW);
    expect(readCardSession('rev_1', 'weekly-report', home)).toBeNull();
  });
});

describe('forgetting', () => {
  it('drops a binding so the capability does not outlive the decision', () => {
    recordCardSession('rev_1', 'digest', 'sess-abc', home, NOW);
    forgetCardSession('rev_1', home, NOW);
    expect(readCardSession('rev_1', 'digest', home)).toBeNull();
  });

  it('forgetting an unknown card is a no-op, never a throw', () => {
    expect(() => forgetCardSession('nope', home, NOW)).not.toThrow();
  });

  it('leaves other bindings alone', () => {
    recordCardSession('rev_1', 'digest', 'sess-a', home, NOW);
    recordCardSession('rev_2', 'digest', 'sess-b', home, NOW);
    forgetCardSession('rev_1', home, NOW);
    expect(readCardSession('rev_2', 'digest', home)).toBe('sess-b');
  });
});

describe('the file cannot grow forever, and cannot take the subsystem down', () => {
  it('prunes bindings past the TTL on the next write', () => {
    const ancient = NOW - 200 * 24 * 60 * 60 * 1000;
    recordCardSession('rev_old', 'digest', 'sess-old', home, ancient);
    expect(readCardSession('rev_old', 'digest', home)).toBe('sess-old');
    recordCardSession('rev_new', 'digest', 'sess-new', home, NOW);
    expect(readCardSession('rev_old', 'digest', home)).toBeNull();
    expect(readCardSession('rev_new', 'digest', home)).toBe('sess-new');
  });

  it('an unreadable bindings file degrades to "nothing is resumable", never a throw', () => {
    // Fail-safe direction: refusing every card is recoverable; throwing would
    // take down the runner and the tick with it.
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(cardBindingsPath(home), 'not json at all', 'utf-8');
    expect(readCardSession('rev_1', 'digest', home)).toBeNull();
    expect(() => recordCardSession('rev_1', 'digest', 'sess-abc', home, NOW)).not.toThrow();
  });

  it('drops individual entries that are malformed rather than failing the file', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(
      cardBindingsPath(home),
      JSON.stringify({
        good: { sessionId: 'sess-ok', slug: 'digest', at: new Date(NOW).toISOString() },
        bad: { sessionId: '../../nope', slug: 'digest', at: new Date(NOW).toISOString() },
        alsoBad: 'not an object',
      }),
      'utf-8',
    );
    expect(readCardSession('good', 'digest', home)).toBe('sess-ok');
    expect(readCardSession('bad', 'digest', home)).toBeNull();
    expect(readCardSession('alsoBad', 'digest', home)).toBeNull();
  });
});
