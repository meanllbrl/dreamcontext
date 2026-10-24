/**
 * The agenda is ALWAYS on the Super stage (owner 2026-10-22 23:44: "Bu agenda otomatik olarak
 * açık olsun, bu şekilde gözüksün. Kapandığı kısımda Others kısmına gidebilir ya da sol alt
 * köşeye kapanır."):
 *  - a stage load (GET state) of a handed-over vault with no agenda makes it at its default place
 *    (first, large, floating); the app's start (startSuperInbox) and a new super session (the
 *    hand-over) show it again from its pill or from Others, keeping the owner's drop and size;
 *  - its close never removes it: the owner's layout `{agenda:'min'}`, a `closed` naming it, and
 *    the agent's `super close` collapse it to the bottom-left pill (min), out of the view and any
 *    group, never noted as dismissed; the owner's `{agenda:'open'}` restores it where it stood;
 *  - Others still works (`place: 'others'`), and a minimised agenda takes no floating slot;
 *  - the stage tidy never moves it (floating, untouched for hours, in a group, minimised);
 *  - the window applies and echoes the same (`applyLayoutPatch`, `patchEchoed`), leaves a
 *    minimised agenda out of the stage items, and plans its pill bottom-left with the dock after it;
 *  - the agent's `open`, `float` and `stack` and a grouping take it out of its pill (end review r1);
 *  - ONE stacking order (owner 2026-10-23: the agenda covered an opened group): every stage layer
 *    in SuperSurface.css names a `--sz-*` step, the card band ends under them all, the agenda takes
 *    the band's top slot and no card's z (owner-placed, moved last) climbs out of the band;
 *  - every agenda line is read whole (owner 2026-10-23): no clamp, no ellipsis.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox, agendaMissing, containerIdFor, minimiseAgendaCard, showAgendaCard, startSuperInbox } from '../../src/lib/super/inbox.js';
import { enableSuper } from '../../src/lib/super/handover.js';
import { planTidy } from '../../src/lib/super/tidy.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { MAX_FLOAT, emptySuperState, floatCount, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { SUPER_OWNER_HANDLERS, SUPER_VERB_HANDLERS, handleSuperStateGet, type SuperCaller } from '../../src/server/routes/super.js';
import { CARD_Z_BASE, CARD_Z_SPAN, STAGE, applyLayoutPatch, cardZIndex, patchEchoed, planStage, stageItems } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { applyGroupOp } from '../../src/lib/super/types.js';
import { MAX_CONTAINERS as WINDOW_MAX } from '../../dashboard/src/lib/superTypes.js';
import { planLayoutMotion } from '../../dashboard/src/components/sleepy/super/handoverMotion.js';

let dir: string;
let root: string;
const SESSION = 'sess-always';
const AGENDA_ID = containerIdFor('agenda', 'agenda');
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

const agenda = (extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: AGENDA_ID, kind: 'agenda', ref: 'agenda', shape: 'square', size: 'large', place: 'float', ...extra });
const task = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'task', ref: id, shape: 'square', place: 'float', ...extra });

function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

function makeVault(extra: Partial<SuperState> = {}): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SESSION, enabled: true, ...extra }));
}

async function layout(body: Record<string, unknown>) {
  const r = res();
  await SUPER_OWNER_HANDLERS.layout({} as never, r, root, body);
  return r;
}

async function verb(name: keyof typeof SUPER_VERB_HANDLERS, body: Record<string, unknown>) {
  const r = res();
  const caller = { token: 't', who: { contextRoot: root }, state: await readSuperState(root) } as unknown as SuperCaller;
  await SUPER_VERB_HANDLERS[name](caller, body, r);
  return r;
}

async function stageLoad() {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' }, socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url: '/' });
  setImmediate(() => (req as unknown as PassThrough).end(''));
  const r = res();
  await handleSuperStateGet(req, r, {}, root);
  return r;
}

const agendaOf = async () => (await readSuperState(root)).containers.find((c) => c.kind === 'agenda');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-agenda-always-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  _resetSuperInbox();
  resetSuperIndex();
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

describe('the agenda is always on the stage', () => {
  it('a stage load of a handed-over record with no agenda makes it first, large and floating; an off stage gets none', async () => {
    makeVault({ containers: [task('task-a'), task('task-b')] });
    const r = await stageLoad();
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.containers[0]).toEqual(expect.objectContaining({ id: AGENDA_ID, size: 'large', place: 'float' }));
    expect((r.json.containers as SuperContainer[]).some((c) => c.id === AGENDA_ID)).toBe(true);
    // A minimised one stays minimised on a reload: the stage load only makes a missing one.
    await layout({ agenda: 'min' });
    await stageLoad();
    expect((await agendaOf())?.min).toBe(true);
    // Not handed over: the stage is not shown, nothing is written.
    makeVault({ enabled: false, containers: [] });
    await stageLoad();
    expect((await readSuperState(root)).containers).toEqual([]);
    expect(agendaMissing({ enabled: false, containers: [] })).toBe(false);
  });

  it('the app\'s start shows it again: from its pill and from Others, keeping the owner\'s drop and size', async () => {
    makeVault({ containers: [task('task-a'), agenda({ min: true, pos: { x: 0.1, y: 0.2 }, size: 'wide', sizeBy: 'owner' })] });
    await startSuperInbox([root]);
    expect(await agendaOf()).toEqual(agenda({ pos: { x: 0.1, y: 0.2 }, size: 'wide', sizeBy: 'owner' }));
    makeVault({ containers: [agenda({ place: 'others' })] });
    _resetSuperInbox(); resetSuperIndex();
    await startSuperInbox([root]);
    expect((await agendaOf())?.place).toBe('float');
    // A record that never had one gets it at the start too.
    makeVault({ containers: [task('task-a')] });
    _resetSuperInbox(); resetSuperIndex();
    await startSuperInbox([root]);
    expect((await readSuperState(root)).containers[0].id).toBe(AGENDA_ID);
  });

  it('a new super session (the hand-over) shows it from its pill, keeping the owner\'s place and group', async () => {
    makeVault({
      containers: [task('task-a'), task('task-b'), agenda({ min: true, pos: { x: 0.3, y: 0.4 } })],
    });
    const { state } = await enableSuper(root, { adopt: [], titles: {} });
    expect(state.containers.find((c) => c.id === AGENDA_ID)).toEqual(agenda({ pos: { x: 0.3, y: 0.4 } }));
    const s = emptySuperState();
    s.containers = [agenda({ place: 'others' }), task('task-a'), task('task-b')];
    s.groups = [{ id: 'grp-a', name: 'Group 1', cards: [AGENDA_ID, 'task-a'], place: 'float' }];
    showAgendaCard(s);
    expect(s.containers[0].place).toBe('float');
    expect(s.groups[0].cards).toContain(AGENDA_ID);
    // Floats on a full stage too: the agenda is not one of the cards an agent opens.
    const full = emptySuperState();
    for (let i = 0; i < MAX_FLOAT; i++) full.containers.push(task(`task-${i}`));
    showAgendaCard(full);
    expect(full.containers[0]).toEqual(expect.objectContaining({ id: AGENDA_ID, place: 'float' }));
  });
});

describe('its close minimises it to the bottom-left pill', () => {
  it('the owner\'s {agenda:"min"} and a `closed` naming it minimise it (out of the view, never dismissed); {agenda:"open"} restores it where it stood', async () => {
    makeVault({ containers: [agenda({ pos: { x: 0.2, y: 0.3 }, size: 'wide', sizeBy: 'owner' }), task('task-a')], view: { mode: 'present', cards: [AGENDA_ID, 'task-a'] } });
    expect((await layout({ agenda: 'min' })).status).toBe(200);
    let s = await readSuperState(root);
    expect(s.containers.find((c) => c.id === AGENDA_ID)).toEqual(agenda({ pos: { x: 0.2, y: 0.3 }, size: 'wide', sizeBy: 'owner', min: true }));
    expect(s.view).toEqual({ mode: 'present', cards: ['task-a'], layout: 'spotlight' });
    expect(s.dismissed).toEqual([]);
    expect((await layout({ agenda: 'open' })).status).toBe(200);
    expect(await agendaOf()).toEqual(agenda({ pos: { x: 0.2, y: 0.3 }, size: 'wide', sizeBy: 'owner' }));
    // A `closed` naming it (an older window, a hand-made patch) minimises it; the other card closes.
    expect((await layout({ closed: [AGENDA_ID, 'task-a'] })).status).toBe(200);
    s = await readSuperState(root);
    expect(s.containers.map((c) => [c.id, c.min ?? false])).toEqual([[AGENDA_ID, true]]);
    expect(s.dismissed).toEqual([]);
  });

  it('the agent\'s `super close` of the agenda minimises it too', async () => {
    makeVault({ containers: [agenda(), task('task-a')], view: { mode: 'half', card: AGENDA_ID } });
    const r = await verb('close', { container: AGENDA_ID });
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.containers.find((c) => c.id === AGENDA_ID)?.min).toBe(true);
    expect(s.view).toEqual({ mode: 'float' });
  });

  it('a minimised agenda leaves its group and takes no floating slot; Others still works and restores clear min', () => {
    const s = emptySuperState();
    s.containers = [agenda(), task('task-a'), task('task-b')];
    s.groups = [{ id: 'grp-a', name: 'Group 1', cards: [AGENDA_ID, 'task-a', 'task-b'], place: 'float' }];
    expect(minimiseAgendaCard(s)).toBe(AGENDA_ID);
    expect(s.groups[0].cards).toEqual(['task-a', 'task-b']);
    expect(floatCount(s)).toBe(1);
    s.containers[0].place = 'others';
    expect(floatCount(s)).toBe(1);
  });

  it('the store keeps `min` on the agenda only', async () => {
    makeVault({ containers: [agenda({ min: true }), task('task-a', { min: true } as Partial<SuperContainer>)] });
    const s = await readSuperState(root);
    expect(s.containers.find((c) => c.id === AGENDA_ID)?.min).toBe(true);
    expect(s.containers.find((c) => c.id === 'task-a')).not.toHaveProperty('min');
  });
});

describe('the stage tidy never moves the agenda', () => {
  const HOURS = 6 * 3600_000;
  it('floating and untouched for hours, minimised, or in a group with idle cards: it stays', () => {
    const s = emptySuperState();
    s.enabled = true;
    s.containers = [agenda(), task('task-a')];
    expect(planTidy(s, () => 0, HOURS)).toEqual(['task-a']);
    s.containers = [agenda({ min: true }), task('task-a')];
    expect(planTidy(s, () => 0, HOURS)).toEqual(['task-a']);
    s.containers = [agenda(), task('task-a'), task('task-b')];
    s.groups = [{ id: 'grp-a', name: 'Group 1', cards: [AGENDA_ID, 'task-a'], place: 'float' }];
    expect(planTidy(s, () => 0, HOURS)).toEqual(['task-b']);
  });
});

describe('the window: patch, echo, stage items and the pill', () => {
  const base = () => ({
    containers: [agenda({ size: 'large' }), task('task-a')],
    groups: [],
    view: { mode: 'half' as const, card: AGENDA_ID },
  });

  it('applies {agenda:"min"} and a `closed` naming it as the server does, and echoes only the minimised record', () => {
    const next = applyLayoutPatch(base(), { agenda: 'min' });
    expect(next.containers.find((c) => c.id === AGENDA_ID)).toEqual(agenda({ min: true }));
    expect(next.view).toEqual({ mode: 'float' });
    expect(applyLayoutPatch(base(), { closed: [AGENDA_ID] }).containers.find((c) => c.id === AGENDA_ID)?.min).toBe(true);
    expect(patchEchoed(base(), { agenda: 'min' })).toBe(false);
    expect(patchEchoed(next, { agenda: 'min' })).toBe(true);
    expect(patchEchoed(next, { closed: [AGENDA_ID] })).toBe(true);
    // Restored: floating, not minimised; a pushed minimised record does not echo the open.
    const open = applyLayoutPatch(next, { agenda: 'open' });
    expect(open.containers[0]).toEqual(agenda());
    expect(patchEchoed(next, { agenda: 'open' })).toBe(false);
    expect(patchEchoed(open, { agenda: 'open' })).toBe(true);
  });

  it('leaves a minimised agenda out of the stage (unless the view shows it) and plans its pill bottom-left, the dock after it', () => {
    const containers = [agenda({ min: true }), task('task-a')];
    expect(stageItems(containers, [], { mode: 'float' }).map((i) => i.id)).toEqual(['task-a']);
    expect(stageItems(containers, [], { mode: 'half', card: AGENDA_ID }).map((i) => i.id)).toEqual([AGENDA_ID, 'task-a']);
    const stage = { width: 1440, height: 820 };
    const plan = planStage(stageItems(containers, [], { mode: 'float' }), { mode: 'float' }, stage, { agendaPill: AGENDA_ID });
    expect(plan.cards[AGENDA_ID]).toBeUndefined();
    expect(plan.agendaPill).toEqual({ x: STAGE.MARGIN, y: stage.height - STAGE.MARGIN / 2 - STAGE.BAND, width: STAGE.AGENDA_PILL_W, height: STAGE.BAND });
    // Mirrors Others: the same band, opposite corners.
    expect(plan.agendaPill.y).toBe(plan.othersRect.y);
    expect(plan.agendaPill.x).toBe(stage.width - plan.othersRect.x - plan.othersRect.width);
    expect(plan.dock.x).toBe(plan.agendaPill.x + plan.agendaPill.width + STAGE.GAP);
    expect(plan.dock.x + plan.dock.width).toBe(plan.othersRect.x - STAGE.GAP);
    expect(plan.pill).toBe(AGENDA_ID);
    // It flies into its pill (not Others) and back out of it, like a card to and from Others.
    const card = { x: 80, y: 250, width: 344, height: 344 };
    const opts = { reduced: false, light: false, othersRect: plan.othersRect };
    const into = planLayoutMotion(new Map([[AGENDA_ID, { rect: card, where: 'float' as const }]]), new Map([[AGENDA_ID, { rect: plan.agendaPill, where: 'others' as const }]]), opts);
    expect(into.kind === 'spring' && into.steps[0]).toMatchObject({ kind: 'toOthers', to: plan.agendaPill });
    const back = planLayoutMotion(new Map([[AGENDA_ID, { rect: plan.agendaPill, where: 'others' as const }]]), new Map([[AGENDA_ID, { rect: card, where: 'float' as const }]]), opts);
    expect(back.kind === 'spring' && back.steps[0]).toMatchObject({ kind: 'fromOthers', from: plan.agendaPill });
    // The band is reserved: no card reaches into it.
    for (const c of Object.values(plan.cards)) if (c.where === 'float') expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(plan.agendaPill.y);
  });
});

describe('the agent and grouping take it out of its pill', () => {
  it('`super open agenda`, `super float` show it; `super stack` puts it in Others, not both', async () => {
    makeVault({ containers: [agenda({ min: true })] });
    expect((await verb('open', { kind: 'agenda', ref: '' })).status).toBe(200);
    expect(await agendaOf()).not.toHaveProperty('min');
    await layout({ agenda: 'min' });
    expect((await verb('float', { container: AGENDA_ID })).status).toBe(200);
    expect(await agendaOf()).not.toHaveProperty('min');
    await layout({ agenda: 'min' });
    expect((await verb('stack', { container: AGENDA_ID })).status).toBe(200);
    expect(await agendaOf()).toEqual(expect.not.objectContaining({ min: true }));
    expect((await agendaOf())?.place).toBe('others');
  });

  it('a grouping takes it out of its pill (one tile, never also the pill)', () => {
    const s = { containers: [agenda({ min: true }), task('task-a')], groups: [] as SuperState['groups'] };
    applyGroupOp(s, { id: 'grp-a', cards: [AGENDA_ID, 'task-a'] });
    expect(s.containers[0]).not.toHaveProperty('min');
  });
});

describe('one stacking order on the stage', () => {
  const css = readFileSync(new URL('../../dashboard/src/components/sleepy/super/SuperSurface.css', import.meta.url), 'utf-8');
  const scale = Object.fromEntries([...css.matchAll(/--sz-([a-z-]+):\s*(\d+);/g)].map((m) => [m[1], Number(m[2])]));
  const ORDER = ['under', 'orbit', 'centre', 'cards', 'dock-zone', 'dock', 'card-open', 'handover', 'queue', 'flight', 'sheet', 'scrim', 'panel', 'panel-stack', 'lifted', 'lifted-label'];

  it('the scale is declared once, strictly rising, and the window\'s card band matches it', () => {
    expect(Object.keys(scale).sort()).toEqual([...ORDER].sort());
    for (let i = 1; i < ORDER.length; i++) expect(scale[ORDER[i]], ORDER[i]).toBeGreaterThan(scale[ORDER[i - 1]]);
    expect(scale.cards).toBe(CARD_Z_BASE);
    expect(scale.dock).toBe(CARD_Z_BASE + CARD_Z_SPAN);
  });

  it('every stage-level layer names a step: no bare z-index at or above the card band', () => {
    const bare = [...css.matchAll(/z-index:\s*(-?\d+)/g)].map((m) => Number(m[1])).filter((n) => n >= CARD_Z_BASE);
    expect(bare).toEqual([]);
    for (const m of css.matchAll(/z-index:\s*var\(--sz-([a-z-]+)\)/g)) expect(scale, m[1]).toHaveProperty(m[1]);
    // The whole stage is one stacking context, under the app's own full-screen viewers.
    expect(css).toMatch(/\.super-surface \{[^}]*isolation: isolate;/);
  });

  it('no card leaves the band; the agenda is over every card, under every layer opened over the stage', () => {
    // The highest z the window gives: an owner-placed card moved last (+2 x MAX and its turn).
    const highest = cardZIndex(2 * WINDOW_MAX - 1 + 2 * WINDOW_MAX + WINDOW_MAX);
    expect(highest).toBeLessThan(cardZIndex(0, true));
    expect(cardZIndex(1e6)).toBeLessThan(cardZIndex(0, true));
    expect(cardZIndex(-5)).toBe(CARD_Z_BASE);
    expect(cardZIndex(0, true)).toBe(scale['dock-zone'] - 1);
    // A card with its menu open lifts over the agenda; it stays under what opens over the stage.
    expect(css).toMatch(/:has\(\.super-size-menu, \.super-close-choice\) \{ z-index: var\(--sz-card-open\) !important; \}/);
    for (const layer of ['dock-zone', 'card-open', 'dock', 'queue', 'flight', 'sheet', 'scrim', 'panel', 'panel-stack', 'lifted']) expect(cardZIndex(0, true), layer).toBeLessThan(scale[layer]);
    const src = (f: string) => readFileSync(new URL(`../../dashboard/src/components/sleepy/super/${f}`, import.meta.url), 'utf-8');
    expect(src('SuperContainer.tsx')).toMatch(/zIndex: cardZIndex\(plan\.z, c\.kind === 'agenda'\)/);
    expect(src('SuperGroupCard.tsx')).toMatch(/zIndex: cardZIndex\(plan\.z\)/);
  });
});

describe('every agenda line is read whole', () => {
  it('no line clamp, no ellipsis, no nowrap on its lines', () => {
    const css = readFileSync(new URL('../../dashboard/src/components/sleepy/super/SuperAgenda.css', import.meta.url), 'utf-8');
    const rules = [...css.matchAll(/([^{}]*\.super-agenda-(?:name|line)[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const [, sel, body] of rules) {
      expect(body, sel).not.toMatch(/line-clamp|text-overflow:\s*ellipsis|white-space:\s*nowrap/);
    }
  });
});
