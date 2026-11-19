/**
 * The board's Sync button: what it says for every sync outcome (syncOutcome.ts), that every
 * key it can say exists in English and Turkish, and that the page mounts it where the retired
 * Agents toggle was.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncOutcome, fillOutcome } from '../../dashboard/src/pages/whiteboards/syncOutcome.js';
import type { BrainSyncResult } from '../../dashboard/src/hooks/useBrainStatus.js';

const ROOT = join(__dirname, '..', '..');
const I18N = readFileSync(join(ROOT, 'dashboard/src/context/I18nContext.tsx'), 'utf8');
const PAGE = readFileSync(join(ROOT, 'dashboard/src/pages/WhiteboardsPage.tsx'), 'utf8');
const BUTTON = readFileSync(join(ROOT, 'dashboard/src/pages/whiteboards/BoardSyncButton.tsx'), 'utf8');

const base = (over: Partial<BrainSyncResult>): BrainSyncResult => ({ action: 'noop', pulledUpdates: 0, scrub: { blocks: [], warns: [] }, ...over });
const keys = (r: BrainSyncResult | null) => syncOutcome(r).lines.map((l) => l.key);

describe('syncOutcome', () => {
  it('a clean sync: up to date, synced, synced with what came in', () => {
    expect(syncOutcome(base({ action: 'noop' }))).toEqual({ tone: 'ok', lines: [{ key: 'whiteboard.sync.upToDate' }] });
    expect(keys(base({ action: 'pushed' }))).toEqual(['whiteboard.sync.synced']);
    expect(syncOutcome(base({ action: 'pulled', pulledUpdates: 3 })).lines).toEqual([{ key: 'whiteboard.sync.syncedIn', vars: { n: 3 } }]);
  });

  it('a waiting team merge: the boards went, the rest waits for sleep, counted', () => {
    const o = syncOutcome(base({ action: 'awaiting-agent', boards: { sent: 1, received: 2, waiting: 0 }, awaitingSleep: 4 }));
    expect(o.tone).toBe('warn');
    expect(o.lines).toEqual([{ key: 'whiteboard.sync.boardsSynced' }, { key: 'whiteboard.sync.sleepMany', vars: { n: 4 } }]);
    expect(keys(base({ action: 'already-awaiting-agent', boards: { sent: 0, received: 0, waiting: 0 }, awaitingSleep: 1 })))
      .toEqual(['whiteboard.sync.boardsUpToDate', 'whiteboard.sync.sleepOne']);
    expect(keys(base({ action: 'awaiting-agent', boards: { sent: 1, received: 0, waiting: 2 } })))
      .toEqual(['whiteboard.sync.boardsSynced', 'whiteboard.sync.boardsWait']);
    expect(keys(base({ action: 'code-conflict', boards: { sent: 1, received: 0, waiting: 0 }, codeConflicts: ['src/a.ts'] })))
      .toEqual(['whiteboard.sync.boardsSynced', 'whiteboard.sync.codeWait']);
  });

  it('the exchange did not run or stopped: never "up to date" (review r1)', () => {
    expect(keys(base({ action: 'awaiting-agent', awaitingSleep: 1 }))).toEqual(['whiteboard.sync.boardsNotSent', 'whiteboard.sync.sleepOne']);
    const signedOut = syncOutcome(base({ action: 'already-awaiting-agent', boards: { sent: 0, received: 0, waiting: 0, stopped: 'no-session' } }));
    expect(signedOut).toMatchObject({ tone: 'bad', settings: true, lines: [{ key: 'whiteboard.sync.boardsSignIn' }] });
    expect(syncOutcome(base({ action: 'awaiting-agent', boards: { sent: 0, received: 1, waiting: 0, stopped: 'secret' } })))
      .toMatchObject({ tone: 'bad', lines: [{ key: 'whiteboard.sync.boardsSecret' }] });
    expect(keys(base({ action: 'awaiting-agent', boards: { sent: 0, received: 0, waiting: 0, stopped: 'no-git' } }))).toEqual(['whiteboard.sync.boardsNotSent']);
    expect(syncOutcome(base({ action: 'awaiting-agent', boards: { sent: 0, received: 0, waiting: 0, trashed: 2 } })).lines)
      .toContainEqual({ key: 'whiteboard.sync.boardsTrashed', vars: { n: 2 } });
  });

  it('the board exchange failed: red, with its reason', () => {
    const o = syncOutcome(base({ action: 'awaiting-agent', boards: { sent: 0, received: 0, waiting: 0, error: 'fetch failed' }, awaitingSleep: 2 }));
    expect(o.tone).toBe('bad');
    expect(o.lines[0]).toEqual({ key: 'whiteboard.sync.boardsFailed', vars: { reason: 'fetch failed' } });
  });

  it('errors and off states say what to do, sign-in ones with the way to Settings', () => {
    expect(syncOutcome(base({ action: 'error', failure: { kind: 'auth', recovery: 'reconnect-github', message: 'x' } }))).toEqual({ tone: 'bad', lines: [{ key: 'whiteboard.sync.signIn' }], settings: true });
    expect(syncOutcome(base({ action: 'error', failure: { kind: 'network', recovery: 'wait-online', message: 'offline' } })).lines[0]).toEqual({ key: 'whiteboard.sync.failed', vars: { reason: 'offline' } });
    expect(syncOutcome(base({ action: 'no-remote', failure: { kind: 'no-token', recovery: 'reconnect-github', message: 'no token' } })).settings).toBe(true);
    expect(keys(base({ action: 'no-remote' }))).toEqual(['whiteboard.sync.noRemote']);
    expect(syncOutcome(base({ action: 'disabled' })).settings).toBe(true);
    expect(keys(base({ action: 'locked' }))).toEqual(['whiteboard.sync.locked']);
    expect(keys(base({ action: 'skipped-in-tree' }))).toEqual(['whiteboard.sync.inTree']);
    expect(syncOutcome(base({ action: 'blocked-scrub', scrub: { blocks: [{ file: '.env', line: 1, rule: 'r', severity: 'BLOCK', excerpt: 'x' }], warns: [] } })).lines[0].vars).toEqual({ file: '.env' });
    expect(keys(base({ action: 'user-merge-in-progress' }))).toEqual(['whiteboard.sync.userMerge']);
    expect(keys(base({ action: 'detached-head' }))).toEqual(['whiteboard.sync.detached']);
    expect(syncOutcome(base({ action: 'app-data-held', note: 'App data waits.' })).lines[0]).toEqual({ key: 'whiteboard.sync.note', vars: { note: 'App data waits.' } });
    expect(syncOutcome(null).tone).toBe('bad');
  });

  it('fillOutcome fills placeholders and keeps a $ as text', () => {
    expect(fillOutcome('{n} files wait', { n: 2 })).toBe('2 files wait');
    expect(fillOutcome('Failed: {reason}', { reason: 'a $& b' })).toBe('Failed: a $& b');
    expect(fillOutcome('{missing}', {})).toBe('{missing}');
  });
});

describe('the Sync button copy', () => {
  const trStart = I18N.indexOf('const TR_PARTIAL');
  const en = I18N.slice(0, trStart);
  const tr = I18N.slice(trStart);
  const SAID = [...new Set([...readFileSync(join(ROOT, 'dashboard/src/pages/whiteboards/syncOutcome.ts'), 'utf8').matchAll(/'(whiteboard\.sync\.\w+)'/g), ...BUTTON.matchAll(/'(whiteboard\.sync\.\w+)'/g)].map((m) => m[1]))];

  it('every key the button can say is in English and Turkish, with no em dash', () => {
    expect(SAID.length).toBeGreaterThan(20);
    for (const k of SAID) {
      expect(en, `English is missing ${k}`).toContain(`'${k}':`);
      expect(tr, `Turkish is missing ${k}`).toContain(`'${k}':`);
    }
    for (const m of I18N.matchAll(/'(whiteboard\.sync\.\w+)':\s*'((?:[^'\\]|\\.)*)'/g)) expect(m[2], m[1]).not.toContain('—');
  });

  it('the button marks itself alive on every mount (StrictMode remounts)', () => {
    expect(BUTTON).toMatch(/useEffect\(\(\) => \{\s*alive\.current = true;/);
  });

  it('the page mounts the Sync button and no agents panel or toggle', () => {
    expect(PAGE).toContain('<BoardSyncButton ref={setToggleEl}');
    expect(PAGE).not.toMatch(/BoardAgentPanel|agentPanelState|wbp-agent-toggle|AgentsGlyph/);
    // Flushes the canvas first, syncs in auto mode, then re-reads the open board.
    expect(BUTTON.indexOf('await flushAndWait()')).toBeGreaterThan(-1);
    expect(BUTTON.indexOf('await flushAndWait()')).toBeLessThan(BUTTON.indexOf("mutateAsync('auto')"));
    expect(BUTTON.indexOf("mutateAsync('auto')")).toBeLessThan(BUTTON.indexOf('await refresh()'));
  });
});
