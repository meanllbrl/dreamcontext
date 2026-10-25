/**
 * The Super dock (owner 2026-10-25): with Super Agent mode on, every screen but the Chat screen
 * holds ONE pill bottom-right in place of the session stack, and it opens THE Super chat as a
 * right-hand column. Pinned here: the one gate (and that nothing in the dock path writes the
 * view), where the Super chat is homed, the pill's model, the pill as the stage's own Others pill,
 * the question band as a row, a question's card found inside the Super chat wherever it is homed,
 * and the wiring in AgentSurface. Fictional names throughout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { superDockOn, superDockPill, superSlotFor } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { showQuestionCard } from '../../dashboard/src/components/sleepy/super/JobBar.js';
import type { SuperQueueItem, SuperStateView } from '../../dashboard/src/lib/superTypes.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

const child = (startedAt: number, ended = false) => ({ sessionId: 'x', brief: 'Fix the login form', adopted: true, startedAt, ...(ended ? { endedAt: 9 } : {}) });
const ask: SuperQueueItem = { id: 'q-ask-1', sessionId: 'sup', kind: 'ask', state: 'escalated', createdAt: 1, ownerText: 'Merge now?' };

describe('the gate and the slot', () => {
  it('is on only handed over, with the record on, in the desktop app, with Agents on', () => {
    const on = { handedOver: true, enabled: true, desktop: true, agentsEnabled: true };
    expect(superDockOn(on)).toBe(true);
    for (const k of ['handedOver', 'enabled', 'desktop', 'agentsEnabled'] as const) expect(superDockOn({ ...on, [k]: false })).toBe(false);
    // T4: the view still 'super' (handedOver) but the record pushed enabled:false: off.
    expect(superDockOn({ ...on, enabled: undefined })).toBe(false);
  });

  it('homes the Super chat in the dock only while the window is open and the overlay folded', () => {
    expect(superSlotFor({ dockOpen: true, expanded: false })).toBe('dock');
    expect(superSlotFor({ dockOpen: false, expanded: false })).toBe('centre');
    expect(superSlotFor({ dockOpen: true, expanded: true })).toBe('centre');
  });

  it('nothing in the dock path writes the view (T1: take-back and its reversal stay as they are)', () => {
    const src = read('dashboard/src/components/sleepy/AgentSurface.tsx');
    const from = src.indexOf('// ── The Super dock (owner 2026-10-25)');
    const dockBits = [
      src.slice(src.indexOf('const dockOn = superDockOn('), src.indexOf('}, [dockOpen, superConvId, pageKey, locale]);')),
      src.slice(src.indexOf('// ── The Super dock\'s pill, rows and gestures'), src.indexOf('// Rows for the corner dock that floats over the EXPANDED overlay')),
    ];
    expect(from).toBeGreaterThan(0);
    for (const b of dockBits) {
      expect(b.length).toBeGreaterThan(100);
      expect(b).not.toMatch(/setSuperView\(/);
    }
    // One gate, used by the render and the homing; the window forced closed when off or expanded.
    expect(src).toMatch(/const dockOpen = dockOn && superDockOpen && !expanded;/);
    expect(src).toMatch(/if \(superDockOpen && \(!dockOn \|\| expanded\)\) setSuperDockOpen\(false\);/);
    expect(src).toMatch(/const foreground = new Set\(expanded \? homed : dockOpen && superSid \? \[superSid\] : \[\]\);/);
    expect(src).toMatch(/if \(superSlotFor\(\{ dockOpen, expanded \}\) === 'dock'\) \{/);
    expect(src).toMatch(/\}, \[panes, expanded, handedOver, superSid, superShownSid, superSlotEpoch, dockOpen, dockSlotEpoch\]\);/);
    // homedSessions is unchanged (the dock never changes what is homed, only where).
    expect(read('dashboard/src/components/sleepy/super/superHandover.ts')).toMatch(/if \(!opts\.handedOver\) return new Set\(opts\.paneActives\.filter\(Boolean\)\);\n  return new Set\(\[opts\.superSid, opts\.shownSid\]/);
    // The page chip is ONE effect, cleared by its own cleanup.
    expect(src.match(/setPageContext\(/g)?.length).toBe(2);
    expect(src).toMatch(/setPageContext\(superConvId, \{ id: nextAttachmentId\(\), kind: 'page', name, text \}\);\s*return \(\) => setPageContext\(superConvId, null\);\s*\}, \[dockOpen, superConvId, pageKey, locale\]\);/);
    // `t` is never a dependency there: a new `t` per provider render brought a ✕'d chip back.
    expect(src).toMatch(/tRef\.current\(PAGE_LABEL_KEY\[p as Page\]\)/);
    // Nothing until the record is known; the old stack only when the dock is off.
    expect(src).toMatch(/\{caps\?\.desktop && agentSettings\.enabled && !expanded && superKnown && \(/);
    expect(src).toMatch(/\) : dockOn \? null :/);
  });
});

describe('the pill', () => {
  const state = (over: Partial<Pick<SuperStateView, 'queue' | 'children'>> = {}) => ({ queue: [], children: {}, ...over });
  const base = { on: true, known: true, liveStatus: () => 'working', otherAsking: false, superAttention: false };

  it('draws nothing with Super off, the record unknown or absent', () => {
    expect(superDockPill({ ...base, on: false, state: state() })).toBeNull();
    expect(superDockPill({ ...base, known: false, state: state() })).toBeNull();
    expect(superDockPill({ ...base, state: null })).toBeNull();
  });

  it('counts the live jobs (a live session, not ended), dots for the first four', () => {
    const children = { a: child(1), b: child(2), c: child(3, true), d: child(4), e: child(5), f: child(6), g: child(7) };
    const live: Record<string, string | null> = { a: 'working', b: 'asking', c: 'working', d: null, e: 'ended', f: 'idle', g: 'starting' };
    const pill = superDockPill({ ...base, state: state({ children }), liveStatus: (sid) => live[sid] ?? null })!;
    expect(pill.count).toBe(4);
    expect(pill.dots).toEqual([{ id: 'a', status: 'working' }, { id: 'b', status: 'asking' }, { id: 'f', status: 'idle' }, { id: 'g', status: 'idle' }]);
    expect(superDockPill({ ...base, state: state() })).toEqual({ count: 0, dots: [], asking: false, news: false });
  });

  it('asks when the Super queue waits on the owner, or a session that is not its child asks', () => {
    expect(superDockPill({ ...base, state: state({ queue: [ask] }) })!.asking).toBe(true);
    expect(superDockPill({ ...base, state: state({ queue: [{ ...ask, state: 'done' }] }) })!.asking).toBe(false);
    expect(superDockPill({ ...base, state: state(), otherAsking: true })!.asking).toBe(true);
  });

  it('has news only when nothing is asked', () => {
    expect(superDockPill({ ...base, state: state(), superAttention: true })!.news).toBe(true);
    expect(superDockPill({ ...base, state: state({ queue: [ask] }), superAttention: true })!.news).toBe(false);
  });

  it('is the stage\'s Others pill (StagePill): same classes, no count chip and no dots at zero', async () => {
    const { createElement } = await import('../../dashboard/node_modules/react/index.js');
    const { renderToStaticMarkup } = await import('../../dashboard/node_modules/react-dom/server.node.js');
    const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
    const { StagePill, OthersStack } = await import('../../dashboard/src/components/sleepy/super/OthersStack.js');
    const pill = (count: number, dots: { id: string; status?: 'working' }[]) => renderToStaticMarkup(createElement(StagePill as never, {
      testId: 'super-dock-pill', lead: createElement('span', { className: 'lead' }), name: 'Claude', dots, count, asking: true, news: false,
      expanded: false, label: 'Claude: 2 jobs', onClick: () => {}, badge: createElement('span', { className: 'agent-dock-chip-q' }, '?'),
    }));
    const two = pill(2, [{ id: 'a', status: 'working' }, { id: 'b' }]);
    expect(two).toMatch(/^<button type="button" class="super-others-stack" data-testid="super-dock-pill" data-asking="true"/);
    expect(two).toContain('<span class="super-others-name">Claude</span>');
    expect(two).toContain('<span class="super-others-count">2</span>');
    expect(two.match(/super-others-dot"/g)).toHaveLength(2);
    expect(two).toContain('agent-dock-chip-q');
    const zero = pill(0, []);
    expect(zero).not.toContain('super-others-count');
    expect(zero).not.toContain('super-others-dots');
    // The stage's Others is drawn exactly as before.
    const others = renderToStaticMarkup(createElement(I18nProvider, null, createElement(OthersStack as never, {
      items: [{ id: 'c1', title: 'Login fix', kind: 'chat', status: 'asking' }], rect: { x: 1, y: 2, width: 3, height: 4 }, open: false, onToggle: () => {}, stackRef: { current: null },
    })));
    expect(others).toBe('<div class="super-others" data-testid="super-others" style="left:1px;top:2px;width:3px;height:4px">'
      + '<button type="button" class="super-others-stack" data-testid="super-others-stack" data-asking="true" aria-haspopup="dialog" aria-expanded="false" aria-label="1 cards in Others">'
      + '<span class="super-others-sheets" aria-hidden="true"><span></span><span></span><span></span></span><span class="super-others-name">Others</span>'
      + '<span class="super-others-dots" aria-hidden="true"><span class="super-others-dot" data-status="asking" data-super-tone="asking"></span></span><span class="super-others-count">1</span></button></div>');
  });

  it('re-bounces while asking, at rest in its first 0.6 s, never with reduced motion', () => {
    const css = read('dashboard/src/components/sleepy/super/SuperDock.css');
    expect(css).toMatch(/\.super-dock \.super-others-stack\[data-asking\] \{[^}]*animation: var\(--dc-motion-status-name, super-dock-bounce\) 4s var\(--ease-out\) infinite;\s*animation-play-state: var\(--dc-motion-play, running\);/);
    expect(css).toMatch(/15% \{ transform: translateY\(0\); \}\s*100% \{ transform: translateY\(0\); \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.super-dock \.super-others-stack\[data-asking\] \{ animation: none; \}/);
  });
});

describe('the question band in the dock', () => {
  it('is a row in normal flow without a rect, the stage\'s overlay with one', async () => {
    const { createElement } = await import('../../dashboard/node_modules/react/index.js');
    const { renderToStaticMarkup } = await import('../../dashboard/node_modules/react-dom/server.node.js');
    const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
    const { JobBar } = await import('../../dashboard/src/components/sleepy/super/JobBar.js');
    const st = { queue: [ask], session: 'sup' } as unknown as SuperStateView;
    const look = { live: () => null, titleFor: () => '', superTitle: 'Claude' } as never;
    const draw = (rect?: { x: number; y: number; width: number; height: number }) => renderToStaticMarkup(createElement(I18nProvider, null, createElement(JobBar as never, {
      state: st, head: ask, waiting: 1, vault: 'acme', rect, look, superSession: undefined, sessionFor: () => undefined, titleFor: () => 'Login fix', onReplyToSuper: () => {}, onShowChild: () => {},
    })));
    const stage = draw({ x: 10, y: 0, width: 400, height: 40 });
    expect(stage).toContain('style="left:10px;top:0;width:400px;min-height:40px"');
    expect(stage).not.toContain('data-flow');
    const row = draw();
    expect(row).toContain('data-flow="row"');
    expect(row).not.toContain('style=');
    expect(row).toContain('data-testid="super-queue-head"');
    // A child's item in the dock: its name opens the stage (7c); the stage's band is unchanged.
    const perm = { ...ask, id: 'q-p', kind: 'permission', sessionId: 'kid', requestId: 'r1' } as SuperQueueItem;
    const permRow = renderToStaticMarkup(createElement(I18nProvider, null, createElement(JobBar as never, {
      state: { queue: [perm], session: 'sup' }, head: perm, waiting: 1, vault: 'acme', look, superSession: undefined, sessionFor: () => undefined, titleFor: () => 'Login fix', onReplyToSuper: () => {}, onShowChild: () => {},
    })));
    expect(permRow).toContain('data-testid="super-queue-open-child"');
    expect(read('dashboard/src/components/sleepy/super/SuperSurface.css')).toMatch(/\.super-dock \.super-queue-strip \{ position: static; pointer-events: auto;/);
    expect(read('dashboard/src/components/sleepy/super/SuperSurface.css')).toMatch(/\.super-surface,\n\.super-dock \{\n  --sz-under: 1;/);
  });

  it('finds a question\'s card inside the Super chat\'s own container, wherever it is homed', () => {
    const calls: string[] = [];
    const card = (item: string, connected = true) => ({
      dataset: { item }, isConnected: connected,
      scrollIntoView: () => calls.push(`scroll:${item}`),
      querySelector: () => ({ focus: () => calls.push(`focus:${item}`) }),
    });
    const root = { querySelectorAll: (sel: string) => { calls.push(sel); return [card('q-1'), card('q-2')]; } };
    (globalThis as { window?: unknown }).window = {};
    expect(showQuestionCard('q-2', root as never)).toBe(true);
    expect(calls).toEqual(['[data-testid="super-question-card"]', 'scroll:q-2', 'focus:q-2']);
    expect(showQuestionCard('q-9', root as never)).toBe(false);
    const gone = { querySelectorAll: () => [card('q-1', false)] };
    expect(showQuestionCard('q-1', gone as never)).toBe(false);
    // The stage's agenda passes the same root.
    expect(read('dashboard/src/components/sleepy/super/SuperSurface.tsx')).toMatch(/if \(showQuestionCard\(item, superSession\?\.container\)\) return;/);
    expect(read('dashboard/src/components/sleepy/super/JobBar.tsx')).toMatch(/if \(!showQuestionCard\(item\.id, root\)\) onReplyToSuper\(\);/);
  });
});

describe('the wiring', () => {
  const src = read('dashboard/src/components/sleepy/AgentSurface.tsx');
  it('the stage draws no band while the dock has it, and lends the dock its showChild', () => {
    expect(src).toMatch(/queueElsewhere=\{dockOpen\}\s*stageShowChild=\{stageShowChild\}/);
    const surface = read('dashboard/src/components/sleepy/super/SuperSurface.tsx');
    expect(surface).toMatch(/\{!props\.queueElsewhere && <JobBar/);
    expect(surface).toMatch(/if \(props\.stageShowChild\) props\.stageShowChild\.current = \{ show: showChild, ready: plan\.width > 0 && props\.visible \};/);
  });

  it('Büyüt opens the Chat screen in one click; the band\'s child waits for the stage (1.5 s, the newest click wins)', () => {
    expect(src).toMatch(/const expandSuperDock = \(\) => \{ setSuperDockOpen\(false\); setExpanded\(true\); \};/);
    expect(src).toMatch(/if \(seq !== showChildSeq\.current\) return;/);
    expect(src).toMatch(/if \(stage\?\.ready && st\?\.containers\.some\(\(c\) => c\.kind === 'chat' && c\.ref === sid\)\) \{ stage\.show\(sid\); return; \}/);
    expect(src).toMatch(/if \(Date\.now\(\) - started < 1500\) window\.setTimeout\(tick, 50\);/);
  });

  it('a row of the window runs today\'s dock-tile handler', () => {
    expect(src).toMatch(/const openDockRow = \(id: string\) => \{ setExpanded\(true\); if \(minimizedIds\.includes\(id\)\) restoreMinimized\(id\); else focusSession\(id\); \};/);
    expect(src).toMatch(/const dockAskingRows = dockOn \? dockRows\.filter\(\(r\) => !r\.superChild && r\.info\.kind === 'asking'\) : \[\];/);
  });

  it('every new word exists in EN and TR', () => {
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    const tr = i18n.indexOf('const TR_PARTIAL');
    for (const k of ['super.dock.expand', 'super.dock.minimize', 'super.dock.label', 'super.dock.connecting', 'super.page.label']) {
      expect(i18n.slice(0, tr)).toContain(`'${k}':`);
      expect(i18n.slice(tr)).toContain(`'${k}':`);
    }
  });
});
