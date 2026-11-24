/**
 * Owner 2026-11-23: on dreamcontext he pressed Tilki; Tilki's Super row read "Off", and pressing it
 * folded Tilki and left him on dreamcontext. Two causes: the press on a row of the project being
 * prepared counted as input and cancelled the move (the row folded under the pointer), and a
 * project still loading published its Super as off before its record was read.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDrawerRows, type DrawerProjectInput } from '../../dashboard/src/components/layout/newshell/drawerModel';
import { isMovePress } from '../../dashboard/src/lib/revealGate';

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf-8');
const project = (name: string, o: Partial<DrawerProjectInput> = {}): DrawerProjectInput => ({
  name, logo: false, logoStamp: null, mounted: false, asleep: false, otherWindow: false, rollup: null, ...o,
});
const superOf = (r: { children: Array<{ kind: string; on?: boolean }> }) => r.children.find((c) => c.kind === 'super') as { on: boolean };

describe('the Super row of a project still loading', () => {
  it('a mounted project whose record is not read yet does not read as off', () => {
    const [, b] = buildDrawerRows({
      projects: [project('a', { mounted: true }), project('b', { mounted: true })], activeVault: 'a', expanded: ['b'],
      facts: { b: { superSelected: false, chatOpen: false, team: [] } }, fanout: {},
    });
    expect(superOf(b).on).toBe(true);
  });
  it('a read that says off still says off', () => {
    const [r] = buildDrawerRows({
      projects: [project('b', { mounted: true })], activeVault: 'b', expanded: ['b'],
      facts: { b: { superOn: false, superSelected: false, chatOpen: false, team: [] } }, fanout: {},
    });
    expect(superOf(r).on).toBe(false);
    const [far] = buildDrawerRows({ projects: [project('c')], activeVault: null, expanded: ['c'], facts: {}, fanout: { c: { tabs: 0, superOn: false, team: [] } } });
    expect(superOf(far).on).toBe(false);
  });
  it('the surface sends no on/off before its record is read, and the bridge passes the silence on', () => {
    expect(src('dashboard/src/components/sleepy/AgentSurface.tsx')).toContain('...(superKnown ? { superOn } : {})');
    const bridge = src('dashboard/src/components/layout/newshell/DrawerFactsBridge.tsx');
    expect(bridge).toContain('useState<DrawerSurfaceState>({ superSelected: false })');
    expect(bridge).toContain('...(surface.superOn !== undefined ? { superOn: surface.superOn } : {})');
  });
});

describe('a press on a row of the project being prepared', () => {
  it('is a move (data-move), so it never cancels the prepare and folds the project under the pointer', () => {
    expect(src('dashboard/src/components/layout/newshell/ChatDrawer.tsx'))
      .toContain('data-testid="drawer-project-body" data-move={row.active ? undefined : \'true\'}');
  });
  it('retargets that prepare instead of jumping in before the project is ready', () => {
    const chrome = src('dashboard/src/components/layout/WindowChrome.tsx');
    const tracked = chrome.slice(chrome.indexOf('const trackedIntent = useCallback'), chrome.indexOf('queueDrawerIntentRef.current = trackedIntent'));
    expect(tracked).toContain("const prepare = vault !== activeRef.current && gate.current()?.vault === vault;");
    expect(tracked).toContain('prepare ? { prepare: true, moveId: id } : undefined');
    expect(tracked).toContain('stampInput();');
  });
});

describe('showing or hiding the sidebar while a project lands (the 390 case)', () => {
  /** A stand-in element: `closest` answers for the given selectors only. */
  const el = (closest: string[], matches: string[] = []) => ({
    closest: (s: string) => (closest.includes(s) ? {} : null),
    matches: (s: string) => matches.includes(s),
  }) as unknown as EventTarget;
  it('a primary press on the sidebar button or the scrim is no input (inside them too)', () => {
    expect(isMovePress(el(['[data-sidebar-toggle]']), 0)).toBe(true);
    expect(isMovePress(el(['[data-sidebar-toggle]']), 2)).toBe(false);
    expect(isMovePress(el([]), 0)).toBe(false);
  });
  it('the title-bar button and the floating scrim carry the mark; the ⌘B key stamps its event', () => {
    expect(src('dashboard/src/components/layout/newshell/TitleBar.tsx')).toMatch(/data-testid="ns-drawer-toggle"[\s\S]{0,200}data-sidebar-toggle="true"/);
    const chrome = src('dashboard/src/components/layout/WindowChrome.tsx');
    expect(chrome).toContain('<div className="ns-drawer-scrim" data-sidebar-toggle="true" onClick={closeOverlay}');
    expect(chrome).toMatch(/key === 'b' && !editable\) \{[\s\S]{0,200}stampInput\(\);[\s\S]{0,80}setDrawerToggleNonce/);
  });
});
