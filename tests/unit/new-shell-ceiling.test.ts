/**
 * D3 (task codex-tarzi-yeni-kabuk W1, AC 5/5b): the window's ceiling as the new shell shows it.
 * A 7th pick evicts the oldest idle project (never the active one, never one that has not said
 * it is idle); all six live means a refusal; the notices use the new wording; ⌘1-9 follow the
 * picker's order; a project another window holds brings that window forward before any ceiling.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chill, liveInstanceCount, oldestEvictable } from '../../dashboard/src/components/layout/instanceCeiling.js';
import { mergeProjectOrder, moveProject } from '../../dashboard/src/components/layout/newshell/projectOrder.js';

const roll = (alive: number) => ({ worst: 'ended', live: alive, alive, waiting: 0, asking: 0, working: 0, idle: 0, flagged: 0 }) as any;
const proj = (vault: string, alive: number | null, cold = false) => ({ vault, instanceId: vault, cold, rollup: alive === null ? null : roll(alive) });

describe('the ceiling', () => {
  const six = [proj('a', 0), proj('b', 1), proj('c', 0), proj('d', null), proj('e', 2), proj('f', 1)];
  it('six live instances', () => expect(liveInstanceCount(six)).toBe(6));
  it('a 7th pick evicts the oldest IDLE project, never the active one', () => {
    expect(oldestEvictable(six, ['a'])?.vault).toBe('c');
    expect(oldestEvictable(six, [])?.vault).toBe('a');
  });
  it('an unpublished rollup is never read as idle', () => {
    expect(oldestEvictable([proj('d', null)], [])).toBeNull();
  });
  it('all six busy: nothing to evict, the pick is refused', () => {
    expect(oldestEvictable([proj('a', 1), proj('b', 1), proj('c', 1), proj('d', 1), proj('e', 1), proj('f', 1)], [])).toBeNull();
  });
  it('an evicted project keeps its row (cold), its instance goes', () => {
    const next = chill(six, 'c');
    expect(next.find((p) => p.vault === 'c')).toMatchObject({ cold: true, rollup: null });
    expect(liveInstanceCount(next)).toBe(5);
  });
});

describe('the picker order (⌘1-9)', () => {
  it('keeps the owner\'s order, appends new projects, drops gone ones', () => {
    expect(mergeProjectOrder(['globex', 'acme', 'gone'], ['acme', 'globex', 'initech'])).toEqual(['globex', 'acme', 'initech']);
    expect(mergeProjectOrder(null, ['acme', 'globex'])).toEqual(['acme', 'globex']);
  });
  it('a drag puts the project in the target\'s place', () => {
    expect(moveProject(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveProject(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });
});

describe('the chrome wiring (source)', () => {
  const chrome = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'layout', 'WindowChrome.tsx'), 'utf-8');
  it('another window\'s project comes forward before the ceiling is consulted', () => {
    const add = chrome.slice(chrome.indexOf('const addTab = useCallback'));
    expect(add.indexOf('findWindowForVault(vault)')).toBeGreaterThan(-1);
    expect(add.indexOf('findWindowForVault(vault)')).toBeLessThan(add.indexOf('MAX_LIVE_INSTANCES'));
  });
  it('the new shell says the new notices', () => {
    expect(chrome).toContain("tRef.current('shell.notice.evicted').replace('{name}', victim.vault)");
    expect(chrome).toContain("tRef.current('shell.notice.ceiling')");
  });
  it('⌘1-9 pick projectOrder[i] through addTab, and the new shell mounts no ProjectSwitcher', () => {
    expect(chrome).toContain('projectOrderRef.current[Number(e.key) - 1]');
    const newBranch = chrome.slice(chrome.indexOf('if (newShell) {\n    return ('), chrome.indexOf('  return (\n    <ChromeContext.Provider value={chrome}>\n      <ChromeSlotsProvider value={chromeSlots}>\n      <div className="window-chrome" data-remote'));
    expect(newBranch).not.toContain('<ProjectSwitcher');
    expect(newBranch).toContain('<TitleBar');
  });
});
