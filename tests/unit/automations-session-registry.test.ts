/**
 * Machine-local automation → session bindings.
 *
 * This file exists because every OTHER place a session id can be read from is
 * writable by someone else — `automations/cache/<slug>.json` is brain-synced, a
 * Telegram message body is a stranger's text, a tab roster is a file on disk.
 * Resuming a session runs with `bypassPermissions`, so the binding recorded at
 * the HOME boundary is the authority and everything else is an assertion.
 *
 * Every assertion below points the same way: the failure direction is "not
 * resumable". An automation that cannot be resumed is a nuisance; one that
 * resumes a session someone else chose is a compromise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  automationSessionsPath,
  foreignRunEvidence,
  isAutomationBoundSession,
  latestBoundSession,
  readAutomationSession,
  recordAutomationSession,
  retireAutomationSession,
} from '../../src/lib/automations/session-registry.js';
import { writeAutomationCache, automationCachePath } from '../../src/lib/automations/store.js';
import type { AutomationCache, AutomationManifest, RunEvent } from '../../src/lib/automations/types.js';

let home: string;
/** Real "now" rather than a fixed calendar date: the TTL is enforced on READ as
 *  well as on write, so a hard-coded stamp would quietly expire the fixtures of
 *  this suite three months after it was written. */
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-sessreg-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('recording and reading', () => {
  it('round-trips a binding', () => {
    expect(recordAutomationSession('digest', 'sess-abc', home, NOW)).toBe(true);
    expect(readAutomationSession('digest', 'sess-abc', home)).toBe('sess-abc');
  });

  it('lives in ~/.dreamcontext — the same boundary as the approval registry', () => {
    expect(automationSessionsPath('digest', home)).toBe(
      join(home, '.dreamcontext', 'automations', 'digest.sessions.json'),
    );
  });

  it('is written 0600 — it names a resumable bypassPermissions session', () => {
    recordAutomationSession('digest', 'sess-abc', home, NOW);
    expect(statSync(automationSessionsPath('digest', home)).mode & 0o777).toBe(0o600);
  });

  it('a session this machine never recorded is NOT resumable', () => {
    // The planted/synced case: an id lifted from a brain-synced cache record, or
    // typed into a Telegram message, resolves to nothing.
    recordAutomationSession('digest', 'sess-abc', home, NOW);
    expect(readAutomationSession('digest', 'sess-never-recorded', home)).toBeNull();
  });

  it('refuses to record a session id that is not path-safe, and writes nothing', () => {
    expect(recordAutomationSession('digest', '../../etc/passwd', home, NOW)).toBe(false);
    expect(recordAutomationSession('digest', null, home, NOW)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  it('keeps several sessions for one automation — the store is plural on purpose', () => {
    // Telegram answers the latest run and the app reopens past runs as tabs, so
    // unlike the card bindings it replaces, this file holds more than one.
    recordAutomationSession('digest', 'sess-a', home, NOW - 2 * DAY_MS);
    recordAutomationSession('digest', 'sess-b', home, NOW);
    expect(readAutomationSession('digest', 'sess-a', home)).toBe('sess-a');
    expect(readAutomationSession('digest', 'sess-b', home)).toBe('sess-b');
  });
});

describe('the capability is scoped to one automation', () => {
  it('a session recorded under one slug is not readable under another', () => {
    // THE test for the isolation property: otherwise a lower-privilege
    // automation could resume a more privileged one's conversation.
    recordAutomationSession('weekly-report', 'sess-abc', home, NOW);
    expect(readAutomationSession('digest', 'sess-abc', home)).toBeNull();
    expect(readAutomationSession('weekly-report', 'sess-abc', home)).toBe('sess-abc');
  });

  it('a binding that claims a different slug than the file it sits in is inert', () => {
    // The file-level half of the same property: moving or renaming a bindings
    // file must not let its contents borrow the new name's authority.
    const path = automationSessionsPath('digest', home);
    mkdirSync(join(home, '.dreamcontext', 'automations'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        'sess-borrowed': { sessionId: 'sess-borrowed', slug: 'weekly-report', at: new Date(NOW).toISOString() },
      }),
      'utf-8',
    );
    expect(readAutomationSession('digest', 'sess-borrowed', home)).toBeNull();
  });

  it('inherits the reserved-slug list rather than keeping its own copy', () => {
    // `isSafeAutomationSlug` is imported from the store, not reimplemented, so a
    // name reserved for a sibling directory is refused here the moment it is
    // added there. A local copy of the rule would silently drift out of date.
    for (const reserved of ['cache', 'output', 'review', 'hitl']) {
      expect(recordAutomationSession(reserved, 'sess-abc', home, NOW)).toBe(false);
      expect(readAutomationSession(reserved, 'sess-abc', home)).toBeNull();
    }
    expect(readdirSync(home)).toEqual([]);
  });

  it('refuses a traversal slug everywhere, and writes no file anywhere', () => {
    // `<slug>` is a PATH SEGMENT here, unlike the single fixed filename this
    // store replaces — so the slug validator is load-bearing, not decorative.
    expect(recordAutomationSession('../../etc/passwd', 'sess-abc', home, NOW)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    expect(readAutomationSession('../../etc/passwd', 'sess-abc', home)).toBeNull();
    expect(latestBoundSession('../../etc/passwd', home)).toBeNull();
    expect(() => retireAutomationSession('../../etc/passwd', 'sess-abc', home)).not.toThrow();
    expect(() => automationSessionsPath('../../etc/passwd', home)).toThrow(/unsafe slug/);
    expect(existsSync(join(home, '.dreamcontext'))).toBe(false);
  });
});

describe('latestBoundSession', () => {
  it('returns the NEWEST binding — an inbound message answers the latest run', () => {
    recordAutomationSession('digest', 'sess-old', home, NOW - 3 * DAY_MS);
    recordAutomationSession('digest', 'sess-mid', home, NOW - 2 * DAY_MS);
    recordAutomationSession('digest', 'sess-new', home, NOW - DAY_MS);
    expect(latestBoundSession('digest', home)).toBe('sess-new');
  });

  it('is null when the automation has never bound a session', () => {
    expect(latestBoundSession('digest', home)).toBeNull();
  });

  it('does not reach across automations', () => {
    recordAutomationSession('weekly-report', 'sess-other', home, NOW);
    expect(latestBoundSession('digest', home)).toBeNull();
  });
});

describe('isAutomationBoundSession — the reverse lookup', () => {
  it('finds the owning slug across several automations', () => {
    // The WS resume handler has a uuid and no slug, and must be able to ask this
    // unconditionally — a gate the caller can skip by omitting a hint is not a gate.
    recordAutomationSession('digest', 'sess-a', home, NOW);
    recordAutomationSession('weekly-report', 'sess-b', home, NOW);
    expect(isAutomationBoundSession('sess-a', home)).toBe('digest');
    expect(isAutomationBoundSession('sess-b', home)).toBe('weekly-report');
  });

  it('is null for an id no automation on this machine recorded', () => {
    recordAutomationSession('digest', 'sess-a', home, NOW);
    expect(isAutomationBoundSession('sess-from-a-synced-cache', home)).toBeNull();
  });

  it('is null — never a throw — when nothing has ever run on this machine', () => {
    expect(isAutomationBoundSession('sess-a', home)).toBeNull();
  });

  it('ignores files whose name is not a safe slug rather than crashing the scan', () => {
    const dir = join(home, '.dreamcontext', 'automations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'Not A Slug.sessions.json'),
      JSON.stringify({ 'sess-x': { sessionId: 'sess-x', slug: 'Not A Slug', at: new Date(NOW).toISOString() } }),
      'utf-8',
    );
    writeFileSync(join(dir, 'unrelated.txt'), 'ignore me', 'utf-8');
    recordAutomationSession('digest', 'sess-a', home, NOW);
    expect(isAutomationBoundSession('sess-x', home)).toBeNull();
    expect(isAutomationBoundSession('sess-a', home)).toBe('digest');
  });
});

describe('retirement — a capability should not outlive what it was for', () => {
  it('removes exactly one binding and leaves its siblings intact', () => {
    recordAutomationSession('digest', 'sess-a', home, NOW);
    recordAutomationSession('digest', 'sess-b', home, NOW);
    retireAutomationSession('digest', 'sess-a', home, NOW);
    expect(readAutomationSession('digest', 'sess-a', home)).toBeNull();
    expect(readAutomationSession('digest', 'sess-b', home)).toBe('sess-b');
  });

  it('does not reach into another automation', () => {
    recordAutomationSession('digest', 'sess-a', home, NOW);
    recordAutomationSession('weekly-report', 'sess-a', home, NOW);
    retireAutomationSession('digest', 'sess-a', home, NOW);
    expect(readAutomationSession('weekly-report', 'sess-a', home)).toBe('sess-a');
  });

  it('retiring something unknown is a no-op, never a throw', () => {
    expect(() => retireAutomationSession('digest', 'sess-never', home, NOW)).not.toThrow();
    recordAutomationSession('digest', 'sess-a', home, NOW);
    expect(() => retireAutomationSession('digest', 'sess-never', home, NOW)).not.toThrow();
    expect(readAutomationSession('digest', 'sess-a', home)).toBe('sess-a');
  });
});

describe('the file cannot grow forever, and cannot take the subsystem down', () => {
  it('prunes bindings past the TTL on the next write', () => {
    recordAutomationSession('digest', 'sess-old', home, NOW - 200 * DAY_MS);
    recordAutomationSession('digest', 'sess-new', home, NOW);
    // Asserted against the FILE, not a read: the read path filters aged-out
    // entries too, so only the bytes on disk prove the prune actually happened.
    const onDisk = JSON.parse(readFileSync(automationSessionsPath('digest', home), 'utf-8'));
    expect(Object.keys(onDisk)).toEqual(['sess-new']);
  });

  it('an aged-out binding is not resumable even if nothing has written since', () => {
    // The predecessor pruned only on write, which made the TTL nominal: an
    // automation that stops running never writes again, so its last session
    // would stay resumable forever. Enforced on read here, so the bound is real.
    recordAutomationSession('digest', 'sess-old', home, NOW - 200 * DAY_MS);
    expect(readAutomationSession('digest', 'sess-old', home)).toBeNull();
    expect(latestBoundSession('digest', home)).toBeNull();
    expect(isAutomationBoundSession('sess-old', home)).toBeNull();
  });

  it('an unreadable bindings file degrades to "nothing is resumable", never a throw', () => {
    // Fail-safe direction: refusing to resume is recoverable; throwing would take
    // down the runner and the tick with it.
    mkdirSync(join(home, '.dreamcontext', 'automations'), { recursive: true });
    writeFileSync(automationSessionsPath('digest', home), 'not json at all', 'utf-8');
    expect(readAutomationSession('digest', 'sess-a', home)).toBeNull();
    expect(latestBoundSession('digest', home)).toBeNull();
    expect(isAutomationBoundSession('sess-a', home)).toBeNull();
    expect(() => recordAutomationSession('digest', 'sess-a', home, NOW)).not.toThrow();
    expect(readAutomationSession('digest', 'sess-a', home)).toBe('sess-a');
  });

  it('drops individual entries that are malformed rather than failing the file', () => {
    const stamp = new Date(NOW).toISOString();
    mkdirSync(join(home, '.dreamcontext', 'automations'), { recursive: true });
    writeFileSync(
      automationSessionsPath('digest', home),
      JSON.stringify({
        'sess-ok': { sessionId: 'sess-ok', slug: 'digest', at: stamp },
        'sess-bad-id': { sessionId: '../../nope', slug: 'digest', at: stamp },
        'sess-mismatched-key': { sessionId: 'sess-something-else', slug: 'digest', at: stamp },
        'sess-unparseable-at': { sessionId: 'sess-unparseable-at', slug: 'digest', at: 'whenever' },
        'sess-not-an-object': 'nope',
      }),
      'utf-8',
    );
    expect(readAutomationSession('digest', 'sess-ok', home)).toBe('sess-ok');
    expect(readAutomationSession('digest', 'sess-bad-id', home)).toBeNull();
    expect(readAutomationSession('digest', 'sess-mismatched-key', home)).toBeNull();
    // An `at` that will not parse means something other than this code wrote the
    // entry — inert is the only safe reading of that.
    expect(readAutomationSession('digest', 'sess-unparseable-at', home)).toBeNull();
    expect(readAutomationSession('digest', 'sess-not-an-object', home)).toBeNull();
  });
});

describe('foreignRunEvidence — the approve-time duplicate warning', () => {
  // A separate contextRoot per test: the evidence reads the BRAIN-synced cache
  // (`automations/cache/<slug>.json`), which lives under the project, not home.
  let contextRoot: string;
  beforeEach(() => {
    contextRoot = mkdtempSync(join(tmpdir(), 'dc-foreign-'));
  });
  afterEach(() => {
    rmSync(contextRoot, { recursive: true, force: true });
  });

  const manifest = (over: Partial<AutomationManifest> = {}): AutomationManifest =>
    ({ slug: 'digest', shared: true, ...over }) as AutomationManifest;

  const event = (over: Partial<RunEvent> = {}): RunEvent => ({
    firedAt: new Date(NOW).toISOString(),
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
    status: 'ok',
    durationMs: 1000,
    outputPath: null,
    error: null,
    exitCode: 0,
    sessionId: null,
    costUsd: null,
    numTurns: null,
    permissionDenials: 0,
    ...over,
  });

  const cacheWith = (history: RunEvent[]): AutomationCache => ({
    slug: 'digest',
    lastRunAt: history[0]?.startedAt ?? null,
    lastFireAt: history[0]?.firedAt ?? null,
    status: history[0]?.status ?? null,
    durationMs: null,
    outputPath: null,
    error: null,
    exitCode: null,
    history,
  });

  it('a run whose session this machine never recorded is evidence of another machine', () => {
    writeAutomationCache(contextRoot, 'digest', cacheWith([event({ sessionId: 'sess-theirs' })]));
    const evidence = foreignRunEvidence(contextRoot, manifest(), home, NOW);
    expect(evidence).toEqual({ count: 1, lastAt: new Date(NOW).toISOString() });
  });

  it('a run this machine recorded itself is NOT foreign', () => {
    recordAutomationSession('digest', 'sess-ours', home, NOW);
    writeAutomationCache(contextRoot, 'digest', cacheWith([event({ sessionId: 'sess-ours' })]));
    expect(foreignRunEvidence(contextRoot, manifest(), home, NOW)).toEqual({ count: 0, lastAt: null });
  });

  it('returns null for a private manifest — a private cache never syncs, so "foreign" cannot exist', () => {
    // A wiped or aged-out binding store must not misread local history as a
    // machine that does not exist.
    writeAutomationCache(contextRoot, 'digest', cacheWith([event({ sessionId: 'sess-unbound' })]));
    expect(foreignRunEvidence(contextRoot, manifest({ shared: false }), home, NOW)).toBeNull();
  });

  it('reads `shared` strict-true, exactly as publishing does', () => {
    writeAutomationCache(contextRoot, 'digest', cacheWith([event({ sessionId: 'sess-unbound' })]));
    expect(foreignRunEvidence(contextRoot, manifest({ shared: 'yes' as unknown as boolean }), home, NOW)).toBeNull();
  });

  it('no cache at all is zero evidence, not an error', () => {
    expect(foreignRunEvidence(contextRoot, manifest(), home, NOW)).toEqual({ count: 0, lastAt: null });
  });

  it('events that never spawned (sessionId null) say nothing about where they happened', () => {
    writeAutomationCache(contextRoot, 'digest', cacheWith([event({ sessionId: null, status: 'blocked' })]));
    expect(foreignRunEvidence(contextRoot, manifest(), home, NOW)).toEqual({ count: 0, lastAt: null });
  });

  it('events older than the binding TTL are unattributable, never counted as foreign', () => {
    // A local run that old has had its binding legitimately expire — counting
    // it would warn an operator about their own machine's history.
    const old = new Date(NOW - 91 * DAY_MS).toISOString();
    writeAutomationCache(contextRoot, 'digest', cacheWith([event({ sessionId: 'sess-ancient', startedAt: old })]));
    expect(foreignRunEvidence(contextRoot, manifest(), home, NOW)).toEqual({ count: 0, lastAt: null });
  });

  it('counts every recent foreign run and reports the newest', () => {
    recordAutomationSession('digest', 'sess-ours', home, NOW);
    const newest = new Date(NOW - 1 * DAY_MS).toISOString();
    const older = new Date(NOW - 3 * DAY_MS).toISOString();
    writeAutomationCache(
      contextRoot,
      'digest',
      cacheWith([
        event({ sessionId: 'sess-ours' }),
        event({ sessionId: 'sess-theirs-1', startedAt: newest }),
        event({ sessionId: 'sess-theirs-2', startedAt: older }),
      ]),
    );
    expect(foreignRunEvidence(contextRoot, manifest(), home, NOW)).toEqual({ count: 2, lastAt: newest });
  });

  it('a planted `__proto__` session id reads as foreign, never as ours', () => {
    writeAutomationCache(contextRoot, 'digest', cacheWith([event({ sessionId: '__proto__' })]));
    expect(foreignRunEvidence(contextRoot, manifest(), home, NOW)?.count).toBe(1);
  });

  it('a malformed synced cache degrades to zero evidence, never a throw', () => {
    mkdirSync(join(contextRoot, 'automations', 'cache'), { recursive: true });
    writeFileSync(automationCachePath(contextRoot, 'digest'), JSON.stringify({ slug: 'digest', history: 'nope' }), 'utf-8');
    expect(foreignRunEvidence(contextRoot, manifest(), home, NOW)).toEqual({ count: 0, lastAt: null });
    writeFileSync(automationCachePath(contextRoot, 'digest'), JSON.stringify({ slug: 'digest', history: [null, 'x'] }), 'utf-8');
    expect(foreignRunEvidence(contextRoot, manifest(), home, NOW)).toEqual({ count: 0, lastAt: null });
  });
});
