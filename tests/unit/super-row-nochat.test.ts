/**
 * The drawer's Super Agent row on a project with no chat (task codex-tarzi-yeni-kabuk W2-A, D6,
 * flagged F2): it starts a chat FIRST and hands over once that tab is in the roster, in that
 * order; a spawn that fails hands nothing over; the starter chat runs `auto` even where the
 * project remembers `bypass`, through the one documented exemption, and never writes the
 * remembered mode. The surface's wiring is pinned by source, since `AgentSurface` cannot mount
 * in a unit test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planSuperRow, runSuperRow, SUPER_ROW_SPAWN } from '../../dashboard/src/components/sleepy/super/superRow.js';

const surface = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/sleepy/AgentSurface.tsx', import.meta.url)), 'utf-8');

describe('what a Super row click does', () => {
  it('shows the stage when handed over, hands over when there is a chat, starts one first when there is none', () => {
    expect(planSuperRow({ enabled: true, hasChat: false, canSpawn: true })).toBe('show-stage');
    expect(planSuperRow({ enabled: false, hasChat: true, canSpawn: true })).toBe('hand-over');
    expect(planSuperRow({ enabled: false, hasChat: false, canSpawn: true })).toBe('spawn-then-hand-over');
    expect(planSuperRow({ enabled: false, hasChat: false, canSpawn: false })).toBe('unavailable');
  });

  it('spawns, waits for the roster, then hands over, in that order', async () => {
    const calls: string[] = [];
    await runSuperRow('spawn-then-hand-over', {
      showStage: () => calls.push('stage'),
      spawnChat: () => { calls.push('spawn'); return 'tab-1'; },
      whenRegistered: async (id) => { calls.push(`registered:${id}`); },
      handOver: async () => { calls.push('handOver'); },
    });
    expect(calls).toEqual(['spawn', 'registered:tab-1', 'handOver']);
  });

  it('a failed spawn leaves no hand-over', async () => {
    const calls: string[] = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      await runSuperRow('spawn-then-hand-over', {
        showStage: () => calls.push('stage'),
        spawnChat: () => { throw new Error('no claude'); },
        whenRegistered: async () => { calls.push('registered'); },
        handOver: async () => { calls.push('handOver'); },
      });
    } finally { console.warn = warn; }
    expect(calls).toEqual([]);
  });

  it('the starter is a chat in auto, exempt from the remembered bypass', () => {
    expect(SUPER_ROW_SPAWN).toEqual({ kind: 'chat', bypass: false, explicitBypass: true });
  });
});

describe('the surface wiring', () => {
  it('the exempt launch reaches spawn as bp=false with explicitBypass (param 11) = true', () => {
    expect(surface).toMatch(/launch\s*\?\s*spawn\(launch\.bypass, undefined, false, kind, '', '', true, '', false, '', true\)/);
    // spawn's own rule: explicitBypass uses `bp` verbatim, the remembered mode only otherwise.
    expect(surface).toMatch(/const effectiveBypass = explicitBypass \? bp : chatPermissionModeRef\.current === 'bypass';/);
  });

  it('the Super row spawns through that launch and never writes the remembered mode', () => {
    const at = surface.indexOf("intent.kind === 'super'");
    expect(at).toBeGreaterThan(0);
    const block = surface.slice(at, surface.indexOf('// Open on the last chat (6b)', at));
    expect(block).toMatch(/addSession\(SUPER_ROW_SPAWN\.kind, \{ bypass: SUPER_ROW_SPAWN\.bypass, explicitBypass: SUPER_ROW_SPAWN\.explicitBypass \}\)/);
    expect(block).not.toMatch(/changeChatPermissionMode|setChatPermissionMode/);
  });

  it('the roster entry keeps the session\'s own bypass, so a relaunch restores it in auto', () => {
    const at = surface.indexOf('const spawnAndRegister = useCallback(');
    const block = surface.slice(at, surface.indexOf('const addSession = useCallback(', at));
    expect(block).toMatch(/bypass: s\.bypass/);
  });

  it('a second Super-row press while the first still runs only shows the stage (never the "back" path)', () => {
    const at = surface.indexOf("intent.kind === 'super'");
    const block = surface.slice(at, surface.indexOf('// Open on the last chat (6b)', at));
    const guard = block.indexOf('if (superBusyRef.current || flightRunRef.current?.run.active || superRowBusyRef.current) {');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(block.indexOf('planSuperRow('));
    expect(block).toMatch(/superRowBusyRef\.current = true;\s*void runSuperRow\(plan, \{/);
    expect(block).toMatch(/\}\)\.finally\(\(\) => \{ superRowBusyRef\.current = false; \}\);/);
  });

  it('open-on-restore yields to a page the window was opened for or already went to', () => {
    expect(surface).toMatch(/if \(navigatedRef\.current \|\| openedForLink\(\)\) \{ openedOnRestoreThisWindow = true; return; \}/);
    expect(surface).toMatch(/useInstanceEvent\('dreamcontext-navigate', \(\) => \{\s*navigatedRef\.current = true;/);
    // The link flag survives App.tsx stripping `&open=` (it is marked before the strip).
    expect(surface).toMatch(/const openedForLink = wasOpenedForLink;/);
    const app = readFileSync(fileURLToPath(new URL('../../dashboard/src/App.tsx', import.meta.url)), 'utf-8');
    expect(app).toMatch(/if \(initialLink !== null\) \{\s*markOpenedForLink\(\);/);
  });

  it('a drawer intent waits for the restored tabs and the Super record before it acts', () => {
    expect(surface).toMatch(/const ready = caps !== null && settingsReady && hydratedRef\.current && superKnownRef\.current;/);
  });
});
