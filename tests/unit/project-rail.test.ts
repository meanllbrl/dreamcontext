/**
 * Navigation B, W2: the project rail. Badge N is ⌘N (the same list), a click lands the same page
 * in that project at its last item (D3), a drag writes the one `projectOrder` the drawer writes
 * (hidden projects keep their slots), the card sits beside its badge inside the window, and the
 * title bar shows the breadcrumb instead of the "acme ▾" button (D6).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderWithRail, railDropBefore, railOrderAfterDrop, railTarget } from '../../dashboard/src/components/layout/newshell/ProjectRail.js';
import { cardPosition, CARD_WIDTH } from '../../dashboard/src/components/layout/newshell/ProjectCard.js';

const src = (p: string) => readFileSync(join(__dirname, '../../dashboard/src', p), 'utf8');

describe('a badge click (D3)', () => {
  const last = (v: string, p: string) => (v === 'pocket-ledger' && p === 'whiteboards' ? null : v === 'pocket-ledger' && p === 'tasks' ? { id: 'ship-beta', label: 'Ship beta' } : null);
  const never = () => false;

  it('on a page: the same page in that project, at the last item opened there', () => {
    expect(railTarget('pocket-ledger', 'acme', { page: 'tasks', chat: false }, last, never))
      .toEqual({ kind: 'place', place: { vault: 'pocket-ledger', kind: 'page', page: 'tasks', id: 'ship-beta', label: 'Ship beta' } });
  });

  it('no item remembered: the page itself (its own open item or its list)', () => {
    expect(railTarget('pocket-ledger', 'acme', { page: 'whiteboards', chat: false }, last, never))
      .toEqual({ kind: 'place', place: { vault: 'pocket-ledger', kind: 'page', page: 'whiteboards', id: null, label: null } });
  });

  it('on Chat, Settings, a page the device cannot show, or before anything was shown: the switch carry', () => {
    expect(railTarget('pocket-ledger', 'acme', { page: 'tasks', chat: true }, last, never)).toEqual({ kind: 'switch' });
    expect(railTarget('pocket-ledger', 'acme', { page: 'settings', chat: false }, last, never)).toEqual({ kind: 'switch' });
    expect(railTarget('pocket-ledger', 'acme', { page: 'whiteboards', chat: false }, last, (p) => p === 'whiteboards')).toEqual({ kind: 'switch' });
    expect(railTarget('pocket-ledger', 'acme', null, last, never)).toEqual({ kind: 'switch' });
  });

  it('the active badge does nothing', () => {
    expect(railTarget('acme', 'acme', { page: 'tasks', chat: false }, last, never)).toEqual({ kind: 'none' });
  });
});

describe('dragging a badge', () => {
  const rects = ['acme', 'pocket-ledger', 'northwind'].map((name, i) => ({ name, start: i * 48, size: 40 }));

  it('lands before the badge whose middle it is above; past the last one, at the end', () => {
    expect(railDropBefore(rects, 5, 'northwind')).toBe('acme');
    expect(railDropBefore(rects, 60, 'acme')).toBe('pocket-ledger');
    expect(railDropBefore(rects, 200, 'acme')).toBeNull();
  });

  it('moves the one name and nothing else', () => {
    expect(railOrderAfterDrop(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(railOrderAfterDrop(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
  });

  it('writes the full projectOrder: hidden projects keep their slots', () => {
    expect(orderWithRail(['a', 'h', 'b', 'c'], ['h'], ['c', 'a', 'b'])).toEqual(['c', 'h', 'a', 'b']);
  });
});

describe('the card beside its badge', () => {
  it('sits right of the badge, its top on the badge, and inside the window', () => {
    expect(cardPosition({ top: 100, right: 56 }, 300, { width: 1440, height: 900 })).toEqual({ left: 64, top: 92 });
    expect(cardPosition({ top: 800, right: 56 }, 300, { width: 1440, height: 900 }).top).toBe(900 - 300 - 8);
    expect(cardPosition({ top: 100, right: 1400 }, 300, { width: 1440, height: 900 }).left).toBe(1440 - CARD_WIDTH - 8);
  });
});

describe('wiring (source)', () => {
  const chrome = src('components/layout/WindowChrome.tsx');

  it('the rail is the ⌘1-9 list: projectOrder minus the hidden ones', () => {
    expect(chrome).toMatch(/const railProjects = useMemo\(\(\) => projectOrder\.filter\(\(n\) => !drawerHidden\.includes\(n\)\)/);
    expect(chrome).toMatch(/projectOrderRef\.current\.filter\(\(n\) => !drawerHiddenRef\.current\.includes\(n\)\)\[Number\(e\.key\) - 1\]/);
  });

  it('the rail is a window component, left of the page rail, and its drag writes the drawer\'s order', () => {
    expect(chrome.indexOf('<ProjectRail projects={railItems}')).toBeLessThan(chrome.indexOf('<div className="ns-rail-slot"'));
    expect(chrome).toMatch(/reorder\(orderWithRail\(projectOrderRef\.current, drawerHiddenRef\.current, names\)\)/);
  });

  it('the title bar shows the breadcrumb, not the picker button; ⌘P still anchors on it', () => {
    const bar = src('components/layout/newshell/TitleBar.tsx');
    expect(bar).not.toContain('ns-picker-btn');
    expect(bar).toContain('data-testid="ns-crumb"');
    expect(bar).toMatch(/anchor=\{pickerRef\.current\}/);
  });

  it('a mounted project polls its facts while the rail is on, the Super stage keeps the drawer-only flag', () => {
    const inst = src('ProjectInstance.tsx');
    expect(inst).toContain('drawerVisible={drawerVisible || railOn}');
    expect(inst).toContain('<AgentSurface stageBesideDrawer={drawerVisible}');
  });

  it('the floating chat drawer starts right of BOTH rails: the project rail sets its width on .ns-body', () => {
    const drawerCss = src('components/layout/newshell/ChatDrawer.css');
    const shellCss = src('components/layout/newshell/NewShell.css');
    expect(drawerCss).toContain('left: calc(var(--ns-prail-w, 0px) + var(--space-13));');
    expect(shellCss).toContain('.ns-body[data-prail="column"] { --ns-prail-w: 64px; }');
    expect(chrome).toContain(`data-prail={phoneStrip ? undefined : 'column'}`);
  });

  it('the phone strip scrolls under a finger: its badges pan, and a moving finger never reorders', () => {
    expect(src('components/layout/newshell/NewShell.css')).toMatch(/\.ns-prail\[data-layout="strip"\] \.ns-prail-badge \{[^}]*touch-action: pan-x;/);
    expect(src('components/layout/newshell/ProjectRail.tsx')).toMatch(/if \(strip\) \{[\s\S]{0,200}press\.current = null;\s*return;\s*\}\s*p\.dragging = true;/);
  });
});
