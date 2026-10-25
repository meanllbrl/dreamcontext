/**
 * The agenda as a stage CARD and a NOTEPAD (owner 2026-10-22, 18:56 "a card, not a column";
 * 19:15 "like a person's sticky notepad; the agent writes what it does and what it expects from
 * me"):
 *  - the hand-over opens one `agenda` card (large, first in the record, so it lands left); a
 *    missing one comes back with the next hand-over, and so does one in Others (owner 23:44: the
 *    agenda is always on the stage; super-agenda-always.test.ts);
 *  - the owner's layout `{agenda: 'open'}` makes it again, or brings it back from Others; it is
 *    the only card his layout may create;
 *  - `super open agenda` (no ref) opens it large; any other ref is refused;
 *  - the store keeps one agenda card with its one ref, and a sane pad (`n<k>` ids, known
 *    sections, a one-line text, a finite time);
 *  - `super note add|done|drop|clear`: a line per call, the same line twice is one note, done
 *    moves it to the end of Done, ids are never reused, a full pad gives up its oldest Done line
 *    first and otherwise refuses, clear empties one section or all;
 *  - the window's patch reads the same (`applyLayoutPatch`, `patchEchoed`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox, containerIdFor, ensureAgendaCard, writeSuper } from '../../src/lib/super/inbox.js';
import { enableSuper } from '../../src/lib/super/handover.js';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { MAX_FLOAT, MAX_PAD, emptySuperState, nextPadId, type SuperState } from '../../src/lib/super/types.js';
import { SUPER_OWNER_HANDLERS, SUPER_VERB_HANDLERS, refForState, type SuperCaller } from '../../src/server/routes/super.js';
import { applyLayoutPatch, patchEchoed } from '../../dashboard/src/components/sleepy/super/superLayout.js';

let dir: string;
let root: string;
const SESSION = 'sess-pad';
const AGENDA_ID = containerIdFor('agenda', 'agenda');
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

function makeVault(extra: Partial<SuperState> = {}): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SESSION, enabled: true, ...extra }));
}

async function verb(name: keyof typeof SUPER_VERB_HANDLERS, body: Record<string, unknown>) {
  const r = res();
  const caller = { token: 't', who: { contextRoot: root }, state: await readSuperState(root) } as unknown as SuperCaller;
  await SUPER_VERB_HANDLERS[name](caller, body, r);
  return r;
}

async function layout(body: Record<string, unknown>) {
  const r = res();
  await SUPER_OWNER_HANDLERS.layout({} as never, r, root, body);
  return r;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-agenda-'));
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

describe('the agenda card', () => {
  it('opens with the hand-over: one large card, first in the record; missing or in Others, it comes back', async () => {
    registerChat({ sessionId: 'mine', conversationId: null, vault: 'acme', mode: 'basic' });
    const { state } = await enableSuper(root, { adopt: ['mine'], titles: {} });
    const agenda = state.containers.filter((c) => c.kind === 'agenda');
    expect(agenda).toEqual([expect.objectContaining({ id: AGENDA_ID, ref: 'agenda', size: 'large', place: 'float' })]);
    expect(state.containers[0].id).toBe(AGENDA_ID);
    await writeSuper(root, (s) => { s.containers = s.containers.filter((c) => c.kind !== 'agenda'); });
    expect((await enableSuper(root, { adopt: [], titles: {} })).state.containers.some((c) => c.id === AGENDA_ID)).toBe(true);
    await writeSuper(root, (s) => { s.containers.find((c) => c.id === AGENDA_ID)!.place = 'others'; });
    expect((await enableSuper(root, { adopt: [], titles: {} })).state.containers.find((c) => c.id === AGENDA_ID)?.place).toBe('float');
  });

  it('a full stage puts a new agenda in Others; a full record adds none', () => {
    const s = emptySuperState();
    for (let i = 0; i < MAX_FLOAT; i++) s.containers.push({ id: `task-${i}`, kind: 'task', ref: `t-${i}`, shape: 'square', place: 'float' });
    expect(ensureAgendaCard(s)).toBe(AGENDA_ID);
    expect(s.containers.find((c) => c.id === AGENDA_ID)?.place).toBe('others');
    const full = emptySuperState();
    for (let i = 0; i < 48; i++) full.containers.push({ id: `task-${i}`, kind: 'task', ref: `t-${i}`, shape: 'square', place: 'others' });
    expect(ensureAgendaCard(full)).toBeNull();
  });

  it('the owner\'s reopen takes it out of its group and floats it even on a full stage (end review r1); the hand-over never does', () => {
    const s = emptySuperState();
    for (let i = 0; i < MAX_FLOAT; i++) s.containers.push({ id: `task-${i}`, kind: 'task', ref: `t-${i}`, shape: 'square', place: 'float' });
    s.containers.push({ id: AGENDA_ID, kind: 'agenda', ref: 'agenda', shape: 'square', size: 'large', place: 'others' });
    s.groups = [{ id: 'grp-a', name: 'Group 1', cards: [AGENDA_ID, 'task-0', 'task-1'], place: 'others' }];
    ensureAgendaCard(s, { first: true });
    expect(s.containers.find((c) => c.id === AGENDA_ID)?.place).toBe('others');
    expect(s.groups[0].cards).toContain(AGENDA_ID);
    ensureAgendaCard(s, { bring: true, owner: true });
    expect(s.containers.find((c) => c.id === AGENDA_ID)?.place).toBe('float');
    expect(s.groups.some((g) => g.cards.includes(AGENDA_ID))).toBe(false);
    // A new one for the owner floats too, whatever the stage holds.
    const t = emptySuperState();
    for (let i = 0; i < MAX_FLOAT; i++) t.containers.push({ id: `task-${i}`, kind: 'task', ref: `t-${i}`, shape: 'square', place: 'float' });
    ensureAgendaCard(t, { bring: true, owner: true });
    expect(t.containers.find((c) => c.id === AGENDA_ID)?.place).toBe('float');
  });

  it('the owner\'s layout {agenda: "open"} makes it again or brings it back from Others; nothing else is created', async () => {
    makeVault();
    expect((await layout({ agenda: 'open' })).status).toBe(200);
    let s = await readSuperState(root);
    expect(s.containers.filter((c) => c.kind === 'agenda')).toEqual([expect.objectContaining({ id: AGENDA_ID, place: 'float', size: 'large' })]);
    expect((await layout({ cards: [{ id: AGENDA_ID, place: 'others' }] })).status).toBe(200);
    expect((await layout({ agenda: 'open' })).status).toBe(200);
    s = await readSuperState(root);
    expect(s.containers.find((c) => c.id === AGENDA_ID)?.place).toBe('float');
    expect((await layout({ agenda: 'yes', cards: [{ id: 'web-nope', place: 'float' }] })).status).toBe(200);
    expect((await readSuperState(root)).containers).toHaveLength(1);
  });

  it('`super open agenda` takes no ref (or "agenda") and opens it large; another ref is refused', async () => {
    const st = emptySuperState();
    expect(refForState(st, 'agenda', undefined)).toEqual({ ref: 'agenda' });
    expect(refForState(st, 'agenda', 'agenda')).toEqual({ ref: 'agenda' });
    expect(refForState(st, 'agenda', 'other')).toHaveProperty('error');
    makeVault();
    const r = await verb('open', { kind: 'agenda', ref: '' });
    expect(r.status).toBe(200);
    expect((await readSuperState(root)).containers).toEqual([expect.objectContaining({ id: AGENDA_ID, kind: 'agenda', size: 'large' })]);
    expect((await verb('open', { kind: 'agenda', ref: 'x' })).status).toBe(400);
  });

  it('the store keeps one agenda card with its one ref', async () => {
    makeVault({ containers: [
      { id: AGENDA_ID, kind: 'agenda', ref: 'agenda', shape: 'square', size: 'large', place: 'float' },
      { id: 'agenda-bad', kind: 'agenda', ref: 'elsewhere', shape: 'square', place: 'float' },
    ] });
    expect((await readSuperState(root)).containers.map((c) => c.id)).toEqual([AGENDA_ID]);
  });

  it('the window applies and echoes the reopen the same way', () => {
    const base = { containers: [{ id: AGENDA_ID, kind: 'agenda' as const, ref: 'agenda', shape: 'square' as const, place: 'others' as const }], groups: [], view: { mode: 'half' as const, card: 'x' } };
    const next = applyLayoutPatch(base, { agenda: 'open', view: { mode: 'float' } });
    expect(next.containers[0].place).toBe('float');
    // Grouped, it comes out of its group, as the server does.
    const grouped = {
      containers: [
        { id: AGENDA_ID, kind: 'agenda' as const, ref: 'agenda', shape: 'square' as const, place: 'float' as const },
        { id: 'task-a', kind: 'task' as const, ref: 'a', shape: 'square' as const, place: 'float' as const },
        { id: 'task-b', kind: 'task' as const, ref: 'b', shape: 'square' as const, place: 'float' as const },
      ],
      groups: [{ id: 'grp-a', name: 'Group 1', cards: [AGENDA_ID, 'task-a', 'task-b'], place: 'float' as const }],
      view: { mode: 'float' as const },
    };
    expect(applyLayoutPatch(grouped, { agenda: 'open' }).groups?.[0].cards).toEqual(['task-a', 'task-b']);
    expect(next.view).toEqual({ mode: 'float' });
    expect(patchEchoed({ containers: [], groups: [], view: { mode: 'float' } }, { agenda: 'open' })).toBe(false);
    expect(patchEchoed(next, { agenda: 'open' })).toBe(true);
  });
});

describe('the notepad: `super note`', () => {
  it('adds a line per call (the same line twice is one note), moves one to Done, drops one, ids never reused', async () => {
    makeVault();
    const a = await verb('note-add', { section: 'now', text: '  Fixing how pictures\ngroup on the stage ' });
    expect(a.status).toBe(200);
    expect((a.json.result as { note: unknown }).note).toMatchObject({ id: 'n1', section: 'now', text: 'Fixing how pictures group on the stage' });
    expect(((await verb('note-add', { section: 'now', text: 'Fixing how pictures group on the stage' })).json.result as { note: { id: string } }).note.id).toBe('n1');
    expect(((await verb('note-add', { section: 'waiting', text: 'Your pick between the two paywalls' })).json.result as { note: { id: string } }).note.id).toBe('n2');
    expect((await verb('note-done', { id: 'n1' })).status).toBe(200);
    let s = await readSuperState(root);
    expect(s.pad?.map((p) => [p.id, p.section])).toEqual([['n2', 'waiting'], ['n1', 'done']]);
    expect((await verb('note-drop', { id: 'n2' })).status).toBe(200);
    expect(((await verb('note-add', { section: 'now', text: 'Something new' })).json.result as { note: { id: string } }).note.id).toBe('n3');
    s = await readSuperState(root);
    expect(s.pad?.map((p) => p.id)).toEqual(['n1', 'n3']);
    expect(s.padSeq).toBe(3);
    expect((await verb('note-done', { id: 'n9' })).status).toBe(404);
    expect((await verb('note-drop', { id: 'n2' })).status).toBe(404);
  });

  it('refuses a bad section or an empty line', async () => {
    makeVault();
    for (const body of [{ section: 'later', text: 'x' }, { section: 'now', text: '   ' }, { text: 'x' }, { section: 'now' }]) {
      expect((await verb('note-add', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await verb('note-clear', { section: 'later' })).status).toBe(400);
  });

  it('clear empties one section or all of it', async () => {
    makeVault({ pad: [
      { id: 'n1', section: 'now', text: 'a', at: 1 }, { id: 'n2', section: 'done', text: 'b', at: 2 }, { id: 'n3', section: 'done', text: 'c', at: 3 },
    ], padSeq: 3 });
    expect(((await verb('note-clear', { section: 'done' })).json.result as { cleared: number }).cleared).toBe(2);
    expect((await readSuperState(root)).pad?.map((p) => p.id)).toEqual(['n1']);
    expect(((await verb('note-clear', {})).json.result as { cleared: number }).cleared).toBe(1);
    expect((await readSuperState(root)).pad).toBeUndefined();
  });

  it('a full pad gives up its oldest Done line first, and refuses when it holds none', async () => {
    const lines = (section: 'now' | 'done') => Array.from({ length: MAX_PAD }, (_, i) => ({ id: `n${i + 1}`, section, text: `line ${i}`, at: i }));
    makeVault({ pad: lines('done'), padSeq: MAX_PAD });
    expect((await verb('note-add', { section: 'now', text: 'one more' })).status).toBe(200);
    let s = await readSuperState(root);
    expect(s.pad).toHaveLength(MAX_PAD);
    expect(s.pad?.some((p) => p.id === 'n1')).toBe(false);
    makeVault({ pad: lines('now'), padSeq: MAX_PAD });
    resetSuperIndex();
    expect((await verb('note-add', { section: 'now', text: 'one more' })).status).toBe(409);
    s = await readSuperState(root);
    expect(s.pad).toHaveLength(MAX_PAD);
  });

  it('the store keeps only sane lines; the next id passes every one it holds', async () => {
    makeVault({ pad: [
      { id: 'n1', section: 'now', text: 'ok', at: 1 },
      { id: 'n1', section: 'now', text: 'duplicate id', at: 2 },
      { id: 'x2', section: 'now', text: 'bad id', at: 2 },
      { id: 'n3', section: 'later', text: 'bad section', at: 3 },
      { id: 'n4', section: 'done', text: '   ', at: 4 },
      { id: 'n5', section: 'done', text: 'no time', at: Number.NaN },
      { id: 'n6', section: 'waiting', text: `a\u0007${'z'.repeat(300)}`, at: 6 },
    ] as never, padSeq: -4 as never });
    const s = await readSuperState(root);
    expect(s.pad?.map((p) => p.id)).toEqual(['n1', 'n6']);
    expect(s.pad?.[1].text.length).toBeLessThanOrEqual(160);
    expect(s.padSeq).toBeUndefined();
    expect(nextPadId(s.pad ?? [], 0)).toEqual({ id: 'n7', seq: 7 });
    expect(nextPadId([], 12)).toEqual({ id: 'n13', seq: 13 });
  });
});

/**
 * "Write about this" on every agenda line (owner 2026-10-23, pick A: at the row's right edge,
 * always there and faint). Rendered for real (static markup), plus the one wiring a static
 * render cannot press: the icon calls onWriteAbout(row), the row keeps its own press.
 */
describe('the agenda row\'s Write about this icon', () => {
  const ROOT_URL = new URL('../../', import.meta.url);
  async function render(variant: 'tile' | 'full', onWriteAbout?: (r: unknown) => void): Promise<string> {
    const { createElement } = await import('../../dashboard/node_modules/react/index.js');
    const { renderToStaticMarkup } = await import('../../dashboard/node_modules/react-dom/server.node.js');
    const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
    const { SuperAgenda } = await import('../../dashboard/src/components/sleepy/super/SuperAgenda.js');
    const state = {
      ...emptySuperState(), session: SESSION, enabled: true, vault: 'acme',
      queue: [
        { id: 'q-ask-1', sessionId: SESSION, kind: 'ask', state: 'escalated', ownerText: 'Ship it?', createdAt: 1 },
        { id: 'q-c1', sessionId: 'c1', kind: 'question', state: 'escalated', ownerText: 'Postgres or sqlite?', createdAt: 2 },
      ],
      pad: [
        { id: 'n1', section: 'waiting', text: 'Your pick between the two paywalls', at: 1 },
        { id: 'n2', section: 'now', text: 'Fixing how pictures group', at: 2 },
        { id: 'n3', section: 'done', text: 'Released the login fix', at: 3 },
      ],
    };
    const look = { live: () => null, titleFor: (s: string) => `Job ${s}`, superTitle: 'Super Agent' };
    return renderToStaticMarkup(createElement(I18nProvider, null, createElement(SuperAgenda as never, {
      state, look, variant, canShowChild: () => true, onShowChild: () => {}, onShowQuestion: () => {}, onWriteAbout,
    })));
  }

  it('one faint button on every full row (notes and questions, every section), none on the tile or without a handler', async () => {
    const html = await render('full', () => {});
    const rows = html.match(/data-testid="super-agenda-row"/g) ?? [];
    const icons = html.match(/data-testid="super-agenda-about"/g) ?? [];
    expect(rows).toHaveLength(5);
    expect(icons).toHaveLength(5);
    expect(html).toContain('aria-label="Write about this"');
    expect(await render('tile', () => {})).not.toContain('super-agenda-about');
    expect(await render('full')).not.toContain('super-agenda-about');
  });

  it('no button inside a button: the icon is the row control\'s sibling', async () => {
    const html = await render('full', () => {});
    let depth = 0;
    for (const m of html.matchAll(/<(\/?)button\b/g)) {
      depth += m[1] ? -1 : 1;
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
  });

  it('the icon calls onWriteAbout(row); the row\'s own press is unchanged', () => {
    const src = readFileSync(new URL('dashboard/src/components/sleepy/super/SuperAgenda.tsx', ROOT_URL), 'utf-8');
    expect(src).toMatch(/className="super-agenda-row-btn" onClick=\{\(\) => press\(r\)\}/);
    expect(src).toMatch(/className="super-agenda-about"[\s\S]{0,300}onClick=\{\(\) => onWriteAbout\(r\)\}/);
    const css = readFileSync(new URL('dashboard/src/components/sleepy/super/SuperAgenda.css', ROOT_URL), 'utf-8');
    expect(css).toMatch(/\.super-agenda-about \{[^}]*width: 28px;[^}]*height: 28px;[^}]*opacity: 0\.45;/);
    expect(css).toMatch(/\.super-agenda-row:hover \.super-agenda-about \{ opacity: 1; \}/);
    expect(css).toMatch(/\.super-agenda-about:focus-visible \{ opacity: 1;/);
  });

  it('the stage passes it only while the super chat is there; a narrow stage floats first; the surface stages one chip and focuses', () => {
    const surface = readFileSync(new URL('dashboard/src/components/sleepy/super/SuperSurface.tsx', ROOT_URL), 'utf-8');
    expect(surface).toMatch(/const writeAbout = onWriteAbout && superSession && superSession\.status !== 'closed'/);
    expect(surface).toMatch(/if \(plan\.narrow && viewMode !== 'float'\) onLayout\(\{ view: \{ mode: 'float' \} \}\);/);
    const agent = readFileSync(new URL('dashboard/src/components/sleepy/AgentSurface.tsx', ROOT_URL), 'utf-8');
    // One writer for both surfaces (writeAboutInto); the stage's writes into its Super chat.
    const body = agent.slice(agent.indexOf('const writeAboutInto'), agent.indexOf('const writeAboutInto') + 900);
    expect(agent).toMatch(/const writeAboutRow = useCallback\(\(row: AgendaRow\) => writeAboutInto\(superChatRef\.current, row\)/);
    expect(body).toMatch(/const convId = cs\.scratchId \|\| cs\.claudeId;/);
    // Owner 2026-10-24: a ↩ ADDS a chip at the caret (several references in one message).
    expect(body).toMatch(/insertRef\(convId, \{ id: nextAttachmentId\(\), kind: 'about', name: agendaRefName\(row, words\), text \}\);/);
    expect(body).toMatch(/requestAnimationFrame\(\(\) => cs\.focus\(\)\)/);
    expect(agent).toMatch(/onWriteAbout=\{writeAboutRow\}/);
  });
});
