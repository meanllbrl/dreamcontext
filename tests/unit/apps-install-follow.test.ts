/**
 * app-ux-genel end review r1: the install follow outlives the Apps page, its outcome is told in
 * plain words, and every request state the server answers has its own line in the CLI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  answerInstall, followInstall, followsOf, installFailureOf, resetInstallFollow, settleInstall, stepFollow, takeInstallOutcomes, type Follow,
} from '../../dashboard/src/components/apps/installFollow.js';
import { sayAnswer, spendable } from '../../src/cli/commands/apps-share.js';

const REPO = 'ornek/hava-notu-app';
const KEY = REPO.toLowerCase();
const at = Date.parse('2026-11-13T10:00:00Z');
const follow = (extra: Partial<Follow> = {}): Follow => ({ name: 'Hava Notu', settings: 2, way: 'claude', at, answeredAt: null, error: null, ...extra });
const since = new Date(at + 100).toISOString();

describe('the install follow (K8): one step per install, whoever is on screen', () => {
  beforeEach(() => resetInstallFollow());

  it('waits while it runs, hands the settings to Claude once it is done', () => {
    expect(stepFollow(KEY, follow(), [{ fullName: REPO, since }], at + 5000)).toEqual({ kind: 'wait' });
    expect(stepFollow(KEY, follow(), [{ fullName: REPO, since, done: { slug: 'hava-notu', settings: 2 } }], at + 5000)).toEqual({ kind: 'handoff', slug: 'hava-notu' });
  });

  it('"I will fill them in" opens its settings sheet; no settings opens its page', () => {
    const done = [{ fullName: REPO, since, done: { slug: 'hava-notu', settings: 2 } }];
    expect(stepFollow(KEY, follow({ way: 'self' }), done, at + 5000)).toEqual({ kind: 'settle', outcome: { kind: 'open', slug: 'hava-notu', sheet: 'config' } });
    const none = [{ fullName: REPO, since, done: { slug: 'hava-notu', settings: 0 } }];
    expect(stepFollow(KEY, follow(), none, at + 5000)).toEqual({ kind: 'settle', outcome: { kind: 'open', slug: 'hava-notu', sheet: null } });
  });

  it('a failed install says it could not be installed and why, never the shared-list message', () => {
    const rows = [{ fullName: REPO, since, done: { error: 'npm_failed', message: 'The packages could not be installed.' } }];
    expect(stepFollow(KEY, follow(), rows, at + 5000)).toEqual({
      kind: 'settle', outcome: { kind: 'failed', fullName: REPO, name: 'Hava Notu', why: 'The packages could not be installed.' },
    });
  });

  it('a request refused before the server listed it settles only on a list read after the answer', () => {
    const f = follow({ answeredAt: at + 1000, error: 'Hava Notu is being installed right now.' });
    expect(stepFollow(KEY, f, [], at + 900)).toEqual({ kind: 'wait' });
    expect(stepFollow(KEY, f, [], at + 1500)).toMatchObject({ kind: 'settle', outcome: { kind: 'failed', why: 'Hava Notu is being installed right now.' } });
    // An older install of the same repo (started before this press) is not this one.
    const older = [{ fullName: REPO, since: new Date(at - 60_000).toISOString() }];
    expect(stepFollow(KEY, f, older, at + 1500)).toMatchObject({ kind: 'settle' });
    // A fast success the list has not caught up with yet is never dropped.
    expect(stepFollow(KEY, follow({ answeredAt: at + 1000 }), [], at + 900)).toEqual({ kind: 'wait' });
  });

  it('a failure is read from one place by any sheet for that repo, until it installs again (review r2)', () => {
    followInstall('acme', REPO, { name: 'Hava Notu', settings: 2, way: 'claude' });
    // The sheet that pressed Install closed; a sheet opened again for the same repo reads the same answer.
    settleInstall('acme', REPO, { kind: 'failed', fullName: REPO, name: 'Hava Notu', why: 'The packages could not be installed.' });
    expect(installFailureOf('acme', REPO.toUpperCase())).toBe('The packages could not be installed.');
    expect(installFailureOf('other', REPO)).toBeNull();
    // The page's note takes the same outcome, never skipped because a sheet is open.
    expect(takeInstallOutcomes('acme')).toEqual([{ kind: 'failed', fullName: REPO, name: 'Hava Notu', why: 'The packages could not be installed.' }]);
    // Pressing Install again clears it.
    followInstall('acme', REPO, { name: 'Hava Notu', settings: 2, way: 'claude' });
    expect(installFailureOf('acme', REPO)).toBeNull();
  });

  it('the store outlives any page: followed, answered, settled, and its outcome taken once', () => {
    followInstall('acme', REPO, { name: 'Hava Notu', settings: 2, way: 'self' });
    expect(followsOf('acme').get(KEY)?.answeredAt).toBeNull();
    answerInstall('acme', REPO, null);
    expect(followsOf('acme').get(KEY)?.answeredAt).not.toBeNull();
    settleInstall('acme', REPO, { kind: 'open', slug: 'hava-notu', sheet: 'config' });
    expect(followsOf('acme').size).toBe(0);
    expect(followsOf('other').size).toBe(0);
    expect(takeInstallOutcomes('acme')).toEqual([{ kind: 'open', slug: 'hava-notu', sheet: 'config' }]);
    expect(takeInstallOutcomes('acme')).toEqual([]);
  });
});

describe('every request state has its own line in the CLI (review r1)', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    process.exitCode = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

  const grant = { id: 'g1', command: 'dreamcontext apps install ornek/hava-notu-app --go --grant g1' };

  it('failed: its reason and the still-good spend command, never "No such request"', () => {
    sayAnswer('r1', { state: 'failed', shown: [], failed: 'install_running', grant });
    const text = out.join('\n');
    expect(text).toContain('The last run did not finish: install_running');
    expect(text).toContain(grant.command);
    expect(text).not.toContain('No such request');
    expect(spendable({ state: 'failed', shown: [], grant })).toBe(true);
  });

  it('running: wait, then check; not an error', () => {
    sayAnswer('r1', { state: 'running', shown: [] });
    const text = out.join('\n');
    expect(text).toContain('It is running now');
    expect(text).toContain('dreamcontext apps grant r1 --wait 110');
    expect(text).not.toContain('No such request');
    expect(process.exitCode).toBeUndefined();
    expect(spendable({ state: 'running', shown: [], grant })).toBe(false);
  });

  it('used in part: says what it held back', () => {
    sayAnswer('r1', { state: 'used', shown: [], stopped: 'MCP servers: posthog' });
    const text = out.join('\n');
    expect(text).toContain('only in part: MCP servers: posthog');
    // No second card is promised: the gate block opens none.
    expect(text).toContain('if none did, tell the owner plainly');
  });
});
