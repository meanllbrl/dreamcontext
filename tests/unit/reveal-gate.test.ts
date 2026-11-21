/**
 * Tek-kenar C2 (task projeler-arasi-gezinme, AC4/AC5): prepare, then activate. A move to another
 * project B prepares it out of sight; the window shows it in ONE commit once B shows the target
 * with nothing loading or moving in the target's region for two frames, or at the bound (300 ms
 * warm, 1500 ms cold). Input in the project on screen, a newer move, a chat row, a link, closing
 * B or a move back to A end it. The region helpers are the probe's too (one definition).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRevealGate, isBareModifier, isMovePress, readinessRegion, regionSettled, targetShown,
  PREPARE_COLD_MS, PREPARE_WARM_MS, type Prepare, type PrepareReport,
} from '../../dashboard/src/lib/revealGate.js';
import { ceilingKeep, oldestEvictable } from '../../dashboard/src/components/layout/instanceCeiling.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function clock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { seq += 1; timers.set(seq, { at: t + ms, fn }); return seq; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      const until = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = until;
    },
  };
}

function make() {
  const c = clock();
  const activated: Prepare[] = [];
  const ended: { p: Prepare; why: string }[] = [];
  const gate = createRevealGate({
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    onActivate: (p) => activated.push(p),
    onEnd: (p, why) => ended.push({ p, why }),
  });
  return { c, gate, activated, ended };
}

const at = (page: string, extra: Partial<PrepareReport> = {}): PrepareReport =>
  ({ page: page as never, chatOpen: false, item: null, settled: true, ...extra });

describe('reveal gate: activation', () => {
  it('B shows the target and is settled for two frames: it activates once', () => {
    const { gate, activated } = make();
    gate.start('b', { kind: 'page', page: 'tasks' as never, id: null }, { cold: true, nonce: 7, moveId: 1 });
    gate.consumed('b', 7);
    gate.report('b', at('tasks'));
    expect(activated).toHaveLength(0);
    gate.report('b', at('tasks'));
    expect(activated.map((p) => p.vault)).toEqual(['b']);
    gate.report('b', at('tasks'));
    expect(activated).toHaveLength(1);
    expect(gate.current()).toBeNull();
  });

  it('nothing counts before its intent is taken; an unsettled frame starts the count again', () => {
    const { gate, activated } = make();
    gate.start('b', { kind: 'page', page: 'tasks' as never, id: null }, { cold: true, nonce: 3, moveId: null });
    gate.report('b', at('tasks'));
    gate.report('b', at('tasks'));
    expect(activated).toHaveLength(0);
    gate.consumed('b', 3);
    gate.report('b', at('tasks'));
    gate.report('b', at('tasks', { settled: false }));
    gate.report('b', at('tasks'));
    expect(activated).toHaveLength(0);
    gate.report('b', at('tasks'));
    expect(activated).toHaveLength(1);
  });

  it('the bound activates: 300 ms warm, 1500 ms cold, on the injected clock', () => {
    const warm = make();
    warm.gate.start('b', { kind: 'page', page: 'tasks' as never, id: null }, { cold: false, nonce: 1, moveId: null });
    warm.c.advance(PREPARE_WARM_MS - 1);
    expect(warm.activated).toHaveLength(0);
    warm.c.advance(1);
    expect(warm.activated).toHaveLength(1);
    const cold = make();
    cold.gate.start('b', { kind: 'chat' }, { cold: true, nonce: 1, moveId: null });
    cold.c.advance(PREPARE_WARM_MS);
    expect(cold.activated).toHaveLength(0);
    cold.c.advance(PREPARE_COLD_MS - PREPARE_WARM_MS);
    expect(cold.activated).toHaveLength(1);
  });

  it('B left on Chat with a page target waits for its chat to close; a Chat target waits for it to open', () => {
    expect(targetShown({ kind: 'page', page: 'tasks' as never, id: null }, at('tasks', { chatOpen: true }), true)).toBe(false);
    expect(targetShown({ kind: 'page', page: 'tasks' as never, id: null }, at('tasks'), true)).toBe(true);
    expect(targetShown({ kind: 'chat' }, at('tasks'), true)).toBe(false);
    expect(targetShown({ kind: 'chat' }, at('tasks', { chatOpen: true }), true)).toBe(true);
    // An item target needs that item; a null item target takes any.
    expect(targetShown({ kind: 'page', page: 'tasks' as never, id: 't1' }, at('tasks', { item: 't2' }), true)).toBe(false);
    expect(targetShown({ kind: 'page', page: 'tasks' as never, id: 't1' }, at('tasks', { item: 't1' }), true)).toBe(true);
  });
});

describe('reveal gate: cancel and replace', () => {
  it('cancel ends it; the bound that fires after a cancel does nothing', () => {
    const { c, gate, activated, ended } = make();
    gate.start('b', { kind: 'chat' }, { cold: true, nonce: 1, moveId: 4 });
    expect(gate.cancel()?.vault).toBe('b');
    expect(ended.map((e) => e.why)).toEqual(['cancel']);
    c.advance(PREPARE_COLD_MS * 2);
    expect(activated).toHaveLength(0);
    gate.report('b', at('tasks', { chatOpen: true }));
    expect(activated).toHaveLength(0);
  });

  it('a newer move to C replaces B (no activation of B, its end is "replaced")', () => {
    const { c, gate, activated, ended } = make();
    gate.start('b', { kind: 'chat' }, { cold: true, nonce: 1, moveId: 1 });
    gate.start('c', { kind: 'page', page: 'lab' as never, id: null }, { cold: false, nonce: 2, moveId: 2 });
    expect(ended).toEqual([expect.objectContaining({ why: 'replaced' })]);
    c.advance(PREPARE_WARM_MS);
    expect(activated.map((p) => p.vault)).toEqual(['c']);
  });

  it('a second move to the B already preparing keeps one prepare, its cold bound and its id', () => {
    const { c, gate, activated, ended } = make();
    const first = gate.start('b', { kind: 'page', page: 'tasks' as never, id: null }, { cold: true, nonce: 1, moveId: 1 });
    c.advance(1000);
    const again = gate.start('b', { kind: 'page', page: 'tasks' as never, id: null }, { cold: false, nonce: 2, moveId: 2 });
    expect(again.id).toBe(first.id);
    expect(again.cold).toBe(true);
    expect(ended).toHaveLength(0);
    c.advance(PREPARE_COLD_MS - 1000);
    expect(activated).toHaveLength(1);
  });

  it('a re-prepare of the same B inside its cancelled cold bound stays cold', () => {
    const { c, gate, activated } = make();
    gate.start('b', { kind: 'chat' }, { cold: true, nonce: 1, moveId: 1 });
    c.advance(200);
    gate.cancel();
    gate.start('b', { kind: 'chat' }, { cold: false, nonce: 2, moveId: 2 });
    expect(gate.current()?.cold).toBe(true);
    c.advance(PREPARE_WARM_MS);
    expect(activated).toHaveLength(0);
    c.advance(PREPARE_COLD_MS);
    expect(activated).toHaveLength(1);
  });

  it('a report from another project, or for an intent not this prepare\'s, does nothing', () => {
    const { gate, activated } = make();
    gate.start('b', { kind: 'page', page: 'tasks' as never, id: null }, { cold: true, nonce: 5, moveId: null });
    gate.consumed('b', 4);
    gate.report('b', at('tasks'));
    gate.report('b', at('tasks'));
    gate.report('c', at('tasks'));
    expect(activated).toHaveLength(0);
  });
});

describe('reveal gate: what counts as input', () => {
  const el = (sel: Record<string, boolean>) => ({
    closest: (q: string) => (sel[`closest:${q}`] ? {} : null),
    matches: (q: string) => !!sel[`matches:${q}`],
  });
  it('a bare modifier keydown is not input; a letter is', () => {
    for (const k of ['Meta', 'Alt', 'Shift', 'Control']) expect(isBareModifier(k)).toBe(true);
    expect(isBareModifier('k')).toBe(false);
    expect(isBareModifier('2')).toBe(false);
  });
  it('a primary press on a move control or the sidebar frame is a move; anything else in A is input', () => {
    expect(isMovePress(el({ 'closest:[data-move]': true }), 0)).toBe(true);
    // A right-click on a project row opens its menu: input.
    expect(isMovePress(el({ 'closest:[data-move]': true }), 2)).toBe(false);
    expect(isMovePress(el({ 'matches:[data-sidebar-frame], [data-scroll-frame]': true }), 0)).toBe(true);
    // A dialog opener in A's page, a key typed in A's explorer: input.
    expect(isMovePress(el({}), 0)).toBe(false);
    expect(isMovePress(null, 0)).toBe(false);
  });
});

describe('reveal gate: the region', () => {
  type Anim = { playState: string; effect: { getComputedTiming: () => { iterations: number } } };
  const anim = (running: boolean, iterations = 1): Anim => ({ playState: running ? 'running' : 'finished', effect: { getComputedTiming: () => ({ iterations }) } });
  function node(opts: { loading?: boolean; anims?: Anim[]; classes?: string[] } = {}) {
    return {
      matches: (q: string) => q === '[data-loading]' && !!opts.loading,
      querySelector: (_q: string) => null,
      getAnimations: () => opts.anims ?? [],
      classList: { contains: (c: string) => (opts.classes ?? []).includes(c) },
    };
  }
  function root(page: ReturnType<typeof node> | null, surface: ReturnType<typeof node> | null) {
    return {
      querySelector: (q: string) => (q === '[data-region="page"]' ? page : q === '.agent-surface' ? surface : null),
    } as unknown as ParentNode;
  }
  const pageT = { kind: 'page' as const, page: 'tasks' as never, id: null };

  it('the page target reads the page frame; the Chat target reads the agent surface', () => {
    const page = node();
    const surface = node({ classes: ['expanded'] });
    expect(readinessRegion(root(page, surface), pageT)).toBe(page);
    expect(readinessRegion(root(page, surface), { kind: 'chat' })).toBe(surface);
  });

  it('a marker in the target region holds it; a marker outside it does not', () => {
    // Page target: a loading collapsed surface is outside the page frame.
    expect(regionSettled(root(node(), node({ loading: true })), pageT)).toBe(true);
    expect(regionSettled(root(node({ loading: true }), node()), pageT)).toBe(false);
    // Chat target: a loading page behind the expanded chat does not hold it.
    expect(regionSettled(root(node({ loading: true }), node({ classes: ['expanded'] })), { kind: 'chat' })).toBe(true);
    expect(regionSettled(root(node(), node({ loading: true, classes: ['expanded'] })), { kind: 'chat' })).toBe(false);
  });

  it('a running animation on the surface holds it; an endless one does not', () => {
    expect(regionSettled(root(node(), node({ anims: [anim(true)] })), pageT)).toBe(false);
    expect(regionSettled(root(node(), node({ anims: [anim(true, Infinity)] })), pageT)).toBe(true);
    expect(regionSettled(root(node(), node({ anims: [anim(false)] })), pageT)).toBe(true);
  });

  it('the surface at the target state: expanded for Chat, collapsed and not closing for a page', () => {
    expect(regionSettled(root(node(), node({ classes: ['closing'] })), pageT)).toBe(false);
    expect(regionSettled(root(node(), node({ classes: ['expanded'] })), pageT)).toBe(false);
    expect(regionSettled(root(node(), node()), { kind: 'chat' })).toBe(false);
  });
});

describe('reveal gate: the window wires it', () => {
  const chrome = read('dashboard/src/components/layout/WindowChrome.tsx');
  it('every activation but the gate\'s own commit cancels a pending prepare first', () => {
    expect(chrome).toMatch(/const setActive = useCallback\(\(vault: string\) => \{\s*gate\.cancel\(\);/);
    expect(chrome).toMatch(/onActivate: \(p\) => \{[\s\S]{0,200}setActiveState\(p\.vault\)/);
  });
  it('a move back to A, closing B and committing an Option-Tab pick back to A cancel it', () => {
    expect(chrome).toMatch(/if \(vault === activeRef\.current\) \{ gate\.cancel\(\); return; \}/);
    expect(chrome).toMatch(/if \(gate\.current\(\)\?\.vault === vault\) gate\.cancel\(\);/);
    expect(chrome).toMatch(/if \(target === activeRef\.current\) \{ gate\.cancel\(\); return; \}/);
  });
  it('input while preparing is decided after dispatch, a move in the same event stamps it', () => {
    expect(chrome).toMatch(/window\.addEventListener\('pointerdown', onInput, true\)/);
    expect(chrome).toMatch(/window\.addEventListener\('keydown', onInput, true\)/);
    expect(chrome).toMatch(/if \(!rec\.stamped && gate\.current\(\)\?\.id === preparingId\) gate\.cancel\(\);/);
  });
  it('the ceiling never evicts the project being prepared', () => {
    const roll = { worst: 'ended', live: 0, alive: 0, waiting: 0, asking: 0, working: 0, idle: 0, flagged: 0 } as never;
    const open = [{ vault: 'a', instanceId: 'a', cold: false, rollup: roll }, { vault: 'b', instanceId: 'b', cold: false, rollup: roll }, { vault: 'c', instanceId: 'c', cold: false, rollup: roll }];
    expect(oldestEvictable(open, ceilingKeep('a', 'b'))?.vault).toBe('c');
    expect(oldestEvictable(open, ceilingKeep('a', null))?.vault).toBe('b');
  });
});
