/**
 * `dreamcontext window <verb>` acts on the CALLER's chat window (task codex-tarzi-yeni-kabuk W3,
 * D8): a chat in a window that is not on screen reads and moves its own window's tabs, never
 * the window the owner is looking at, and never reaches another window's tabs at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWindowVerb, windowState, type WindowVerbDeps, type WindowTab } from '../../dashboard/src/components/sleepy/windowVerbs.js';

const SURFACE = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'AgentSurface.tsx'), 'utf-8');

const tab = (sid: string, over: Partial<WindowTab> = {}): WindowTab => ({ sid, tab: `conv-${sid}`, title: sid, kind: 'chat', busy: false, asking: false, dormant: false, ...over });

/** The deps AgentSurface builds for a caller in the parked window "Refactor": its panes and tabs only. */
function scoped(over: Partial<WindowVerbDeps> = {}): WindowVerbDeps {
  return {
    self: 'agent-3',
    window: 'Refactor',
    panes: [{ id: 'p3', tabs: ['agent-3', 'agent-4'], active: 'agent-3' }],
    activePaneId: 'p3',
    tabs: [tab('agent-3'), tab('agent-4')],
    openNew: vi.fn(async () => 'conv-new'),
    split: vi.fn(), join: vi.fn(), focus: vi.fn(),
    setMode: vi.fn(() => 'now' as const), setModel: vi.fn(() => true), setEffort: vi.fn(() => true),
    send: vi.fn(() => 'sent' as const), close: vi.fn(),
    ...over,
  };
}

describe('window verbs scoped to the caller\'s window', () => {
  it('state names the window and lists only its panes', () => {
    const s = windowState(scoped()) as { window: string; panes: Array<{ tabs: Array<{ tab: string; self?: true }> }> };
    expect(s.window).toBe('Refactor');
    expect(s.panes.flatMap((p) => p.tabs.map((t) => t.tab))).toEqual(['conv-agent-3', 'conv-agent-4']);
  });

  it("a tab of another window is not there to close, send to, split or focus", async () => {
    const deps = scoped();
    for (const verb of ['close', 'send', 'split', 'focus']) {
      const r = await runWindowVerb(deps, verb, { tab: 'conv-agent-1', text: 'hi', force: true });
      expect(r, verb).toEqual({ ok: false, error: expect.stringContaining('no tab "conv-agent-1" in this window') });
    }
    expect(deps.close).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('a split moves the caller\'s own tab in its own window', async () => {
    const deps = scoped();
    expect(await runWindowVerb(deps, 'split', { tab: 'conv-agent-4' })).toEqual({ ok: true, result: { tab: 'conv-agent-4', placed: 'new pane' } });
    expect(deps.split).toHaveBeenCalledWith('agent-4', 'p3');
  });

  it('new at the 40-tab ceiling says so, and nothing opens', async () => {
    const deps = scoped({ openNew: vi.fn(async () => '') });
    const r = await runWindowVerb(deps, 'new', { prompt: 'x' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('40 chats') });
  });

  it('AgentSurface builds the deps from the caller\'s window, and the Super Agent keeps the whole surface', () => {
    const at = SURFACE.indexOf('windowDepsRef.current = (self: string): WindowVerbDeps => {');
    expect(at).toBeGreaterThan(-1);
    const deps = SURFACE.slice(at, SURFACE.indexOf('// ── The Super Agent: who is who', at));
    expect(deps).toContain('const home = !isSuperCaller && selfKey ? parkedAll.get(selfKey) : undefined;');
    expect(deps).toContain('panes: parkedWin ? unparkPanes(parkedWin.panes, sessionList) : panes,');
    expect(deps).toContain('tabs: windowTabsFor(sessionList.filter(inScope)');
    // A parked caller's moves change its parked window; the shown window is never touched.
    expect(deps).toMatch(/split: \(sid, paneId\) => \{\s+if \(home\) setChatWindows\(\(prev\) => updateParked\(prev, home,/);
    expect(deps).toMatch(/join: \(sid, paneId\) => \{\s+if \(home\) setChatWindows\(\(prev\) => updateParked\(prev, home,/);
    expect(deps).toMatch(/if \(home && chatWindowsRef\.current\.activeId !== home\) \{\s+setChatWindows\(\(prev\) => updateParked\(prev, home, \(ps, ap\) => placeTab\(/);
    // Focus shows the tab, so its window comes forward first.
    expect(deps).toContain('focus: (sid, paneId) => { if (home) showWindow(home);');
  });
});
