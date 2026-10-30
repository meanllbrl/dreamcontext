/**
 * A notification, an app link, a notch row, a dock chip or History opens the chat window that
 * HOLDS the chat (task codex-tarzi-yeni-kabuk W3, D8); a past chat with no tab resumes into the
 * window on screen. Every one of those routes ends in `focusSession` / `resumePastSession`
 * (OPEN_SESSION → `resumePastSession`), so the reveal lives there, once.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { switchWindow, windowOfTab, type WindowsState } from '../../dashboard/src/components/sleepy/chatWindows.js';

const SURFACE = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'AgentSurface.tsx'), 'utf-8');
const body = (start: string, end: string) => {
  const a = SURFACE.indexOf(start);
  expect(a, start).toBeGreaterThan(-1);
  return SURFACE.slice(a, SURFACE.indexOf(end, a));
};

describe('opening a chat opens its window', () => {
  const state: WindowsState = {
    list: [
      { id: 'main', name: 'Chat', panes: [], activePaneId: '' },
      { id: 'w2', name: 'Two', panes: [{ id: 'p9', tabs: ['conv-9'], active: 'conv-9' }], activePaneId: 'p9' },
    ],
    activeId: 'main',
  };

  it('the window holding a conversation is found, and showing it brings the tab on screen', () => {
    expect(windowOfTab(state, 'conv-9')).toBe('w2');
    const sw = switchWindow(state, 'w2', { panes: [], activePaneId: '' }, [{ id: 'agent-9', claudeId: 'conv-9' }])!;
    expect(sw.panes[0].tabs).toEqual(['agent-9']);
  });

  it('focusSession reveals the holding window before it selects the tab', () => {
    const f = body('const focusSession = useCallback(', '}, [panes, focusTerm, revealTab]);');
    expect(f.indexOf('revealTab(sid)')).toBeGreaterThan(-1);
    expect(f.indexOf('revealTab(sid)')).toBeLessThan(f.indexOf('setPanes('));
  });

  it('a link to an open chat (OPEN_SESSION → resumePastSession) reveals its window; a new resume lands in the shown one', () => {
    const r = body('const resumePastSession = useCallback(', 'const adoptLiveChat');
    const existing = r.slice(r.indexOf('if (existing) {'));
    expect(existing.indexOf('revealTab(existing.id);')).toBeGreaterThan(-1);
    expect(existing.indexOf('revealTab(existing.id);')).toBeLessThan(existing.indexOf('resumeSession(existing.id)'));
    // The OPEN_SESSION handler (notifications, app links, notch rows) goes through it.
    const link = body('useInstanceEvent<OpenSessionDetail>(OPEN_SESSION_EVENT', 'Start the initializer chat');
    expect(link).toContain('resumePastSession(past)');
  });

  it('the drawer\'s window row shows THAT window', () => {
    const intent = body('runDrawerIntentRef.current = (intent) => {', "} else if (intent.kind === 'new-tab') {");
    expect(intent).toMatch(/intent\.kind === 'open-window'\) \{\s+if \(intent\.windowId\) showWindow\(intent\.windowId\);/);
  });
});
