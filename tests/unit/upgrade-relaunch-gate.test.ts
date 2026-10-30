/**
 * An update never closes the app on its own: the owner clicks Relaunch (2026-10-29). A click
 * while the server reports a live tab at work (chat-park.ts `countWorkingAgents`, served on
 * /api/health as `agentsWorking`) opens an inline confirm first (relaunchGate.ts).
 *
 * The "never on its own" half is checked against the banner's SOURCE: root vitest runs under
 * plain Node (no jsdom) and the banner is a React module with a CSS import. The rendered strip
 * is checked in a real Chromium by `scripts/verify/upgrade-relaunch-banner.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TERMINAL_WORKING_RECENT_MS, countWorkingAgents, type Parkable } from '../../src/server/chat-park.js';
import { relaunchClick } from '../../dashboard/src/components/layout/relaunchGate.js';

const BANNER = readFileSync(
  join(__dirname, '../../dashboard/src/components/layout/UpgradeRelaunchBanner.tsx'),
  'utf8',
);
/** The banner's code with comments stripped, so prose about the old countdown cannot match. */
const CODE = BANNER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const tab = (over: Partial<Parkable> = {}): Parkable => ({
  id: Math.random().toString(36).slice(2),
  kind: 'chat',
  projectRoot: '/tmp/fictional-project',
  exempt: () => null,
  busy: () => false,
  asking: () => false,
  backgroundTasks: () => 0,
  idleSince: () => 0,
  focusedAt: () => 0,
  park: async () => 'parked',
  ...over,
});

describe('countWorkingAgents', () => {
  it('counts a running turn, a waiting question and background work; idle tabs are free', () => {
    expect(countWorkingAgents([tab(), tab()])).toBe(0);
    expect(countWorkingAgents([tab({ busy: () => true }), tab()])).toBe(1);
    expect(countWorkingAgents([tab({ asking: () => true })])).toBe(1);
    // The reported case: the turn ended but a background shell and sub-agents still run.
    expect(countWorkingAgents([tab({ backgroundTasks: () => 3 }), tab()])).toBe(1);
  });

  it('a terminal counts only while it shows a sign of life, so a stale hook state never holds forever', () => {
    const NOW = 50_000_000;
    const quiet = () => ({ readable: true, at: 0, subagentAt: 0 });
    // Turn running: the TUI redrew a second ago.
    expect(countWorkingAgents([tab({ kind: 'terminal', busy: () => true, idleSince: () => NOW - 1_000 })], NOW, quiet)).toBe(1);
    // "Not ready" after an Esc / before the first prompt / no hooks, and silent: free.
    expect(countWorkingAgents([tab({ kind: 'terminal', busy: () => true, idleSince: () => NOW - TERMINAL_WORKING_RECENT_MS - 1 })], NOW, quiet)).toBe(0);
    // Silent screen but a sub-agent is still writing its transcript: working.
    expect(countWorkingAgents(
      [tab({ kind: 'terminal', busy: () => true, idleSince: () => 0 })], NOW,
      () => ({ readable: true, at: NOW - 5_000, subagentAt: NOW - 5_000 }),
    )).toBe(1);
    // Hook says ready: free whatever the screen does.
    expect(countWorkingAgents([tab({ kind: 'terminal', busy: () => false, idleSince: () => NOW })], NOW, quiet)).toBe(0);
  });

  it('a tab whose probe throws counts as working (never kill what we cannot read)', () => {
    expect(countWorkingAgents([tab({ busy: () => { throw new Error('gone'); } })])).toBe(1);
  });
});

describe('relaunchClick', () => {
  it('asks first while any agent works, relaunches straight away when none does', () => {
    expect(relaunchClick(2)).toBe('confirm');
    expect(relaunchClick(1)).toBe('confirm');
    expect(relaunchClick(0)).toBe('relaunch');
  });

  it('an older server that does not report the count relaunches on the click', () => {
    expect(relaunchClick(undefined)).toBe('relaunch');
    expect(relaunchClick(null)).toBe('relaunch');
  });
});

describe('the update banner never relaunches on its own', () => {
  it('has no countdown: no ticking timer, no seconds-left state', () => {
    expect(CODE).not.toMatch(/COUNTDOWN_SECONDS|secondsLeft|setSecondsLeft/);
    expect(CODE).not.toMatch(/setInterval\s*\(/);
    // The one timer left is the stuck-relaunch safety net, which only runs AFTER a click.
    const timers = CODE.match(/setTimeout\s*\(/g) ?? [];
    expect(timers.length).toBe(1);
    expect(CODE).toMatch(/if \(!relaunching\) return;\s*const id = setTimeout\(/);
  });

  it('doRelaunch is reached only from a button the owner clicks', () => {
    expect(CODE).toMatch(/doRelaunch\(\)/);
    // Cut out the two click paths: inline onClick handlers, and onRelaunchClick (the
    // Relaunch button's handler). Nothing else may call it — no effect, no timer.
    const click = CODE.indexOf('const onRelaunchClick = useCallback(');
    expect(click).toBeGreaterThan(-1);
    const clickEnd = CODE.indexOf('}, [', click);
    const rest = (CODE.slice(0, click) + CODE.slice(clickEnd))
      .replace(/onClick=\{\(\) => void doRelaunch\(\)\}/g, '');
    expect(rest).not.toMatch(/doRelaunch\(\)/);
    expect(CODE).toMatch(/onClick=\{\(\) => void onRelaunchClick\(\)\}/);
    for (const effect of CODE.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/g) ?? []) {
      expect(effect).not.toMatch(/doRelaunch|onRelaunchClick/);
    }
  });

  it('the confirm is inline, never a browser dialog (a no-op in WKWebView)', () => {
    expect(CODE).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\s*\(/);
    expect(CODE).toMatch(/upgradeRelaunch\.confirm/);
    expect(CODE).toMatch(/upgradeRelaunch\.anyway/);
  });
});
