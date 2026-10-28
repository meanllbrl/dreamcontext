/**
 * The Super Agent's tiles (owner decisions 2026-10-20: small 1:1 "Cam HUD" tiles, groups as one
 * tile, and "kart küçük olsa bile kartlar gösterilmeli"):
 *
 *  - a task tile says how far the task is from its own acceptance criteria (done / total) and
 *    the next open one, as plain text;
 *  - the status ring says a state twice (its colour AND its mark), never spins;
 *  - a group tile carries its name, its count and its first cards, and glows as its loudest card;
 *  - side by side, presented or as a sheet, a task or a note shows its page body (criteria,
 *    to-dos, text), not a title over an empty card; a floating web tile never holds a frame;
 *  - the surface groups on a drop onto a tile, through the same patch the server applies.
 *
 * Tiles are rendered to static markup with the dashboard's own React, inside its I18n provider
 * (English).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { criteriaProgress, insightTile, plainCriterion } from '../../dashboard/src/components/sleepy/super/tileModel.js';
import { fileURLToPath } from 'node:url';

const { StatusRing, ChatTile } = await import('../../dashboard/src/components/sleepy/super/AgentCard.js');
const { GroupTile, groupStatus } = await import('../../dashboard/src/components/sleepy/super/SuperTiles.js');
const { panelRect } = await import('../../dashboard/src/components/sleepy/super/GroupPanel.js');
const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
const { QueryClient, QueryClientProvider } = await import('../../dashboard/node_modules/@tanstack/react-query/build/modern/index.js');
// A chat tile's rate-limit ring reads the usage query, so it renders under a QueryClient as in the app.
const inI18n = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(
  createElement(QueryClientProvider, { client: new QueryClient() }, createElement(I18nProvider, null, el)));

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SUPER = 'dashboard/src/components/sleepy/super';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('a task tile reads its own criteria', () => {
  it('counts done and total, and names the first open one as plain text', () => {
    const md = [
      '- [x] AC1 **Mockup first**: approved',
      '- [ ] AC2 Small `1:1` tiles, see [[stage-v2|the stage]]',
      '  - [ ] a nested step counts too',
      '* [X] AC3 done with a capital X',
      'Some prose that is not a criterion: - [ ] inline',
      '- [ ] AC4 [the link](https://example.com) reads as its text',
    ].join('\n');
    expect(criteriaProgress(md)).toEqual({ done: 2, total: 5, next: 'AC2 Small 1:1 tiles, see the stage', upcoming: ['AC2 Small 1:1 tiles, see the stage', 'a nested step counts too'] });
    expect(plainCriterion('[the link](https://example.com) and _soft_ *words*')).toBe('the link and soft words');
  });

  it('no criteria, or every one ticked, says so', () => {
    expect(criteriaProgress('')).toEqual({ done: 0, total: 0, next: null, upcoming: [] });
    expect(criteriaProgress(undefined)).toEqual({ done: 0, total: 0, next: null, upcoming: [] });
    expect(criteriaProgress('- [x] a\n- [x] b')).toEqual({ done: 2, total: 2, next: null, upcoming: [] });
  });
});

describe('an insight tile reads its cached detail (owner 2026-10-21)', () => {
  const detail = (over: Record<string, unknown> = {}, render = 'number') => ({
    insight: { render, unit: 'users' },
    cache: { fetchedAt: '2026-10-21T11:30:00Z', series: [] as { points: { t: string; v: number }[] }[], ...over },
  });
  const days = (...vs: number[]) => vs.map((v, i) => ({ t: `2026-10-${10 + i}`, v }));

  it('a series is its latest figure, the change from the point before and a trend', () => {
    const v = insightTile(detail({ latest: 9660, series: [{ points: days(9400, 9690, 9660) }] }))!;
    expect(v).toMatchObject({ shape: 'trend', value: 9660, delta: -30, unit: 'users', fresh: 'fresh' });
    expect(v.points.map((p) => p.v)).toEqual([9400, 9690, 9660]);
  });

  it('a funnel is the share of the top that reaches its last step, never "the last step and a drop"', () => {
    const steps = [4120, 3811, 1280, 38];
    const legacy = insightTile(detail({ series: [{ points: days(...steps) }] }, 'funnel'))!;
    expect(legacy).toMatchObject({ shape: 'funnel', top: 4120, last: 38, delta: null });
    expect(legacy.value).toBeCloseTo((38 / 4120) * 100, 5);
    expect(legacy.lane[0]).toBe(1);
    expect(legacy.lane).toHaveLength(4);
    // A funnel SET reads its first funnel (`set.primary` names a metric, not a funnel); the series is not looked at.
    const set = insightTile(detail({ series: [{ points: days(1, 2) }], funnel: { set: { primary: 'users', funnels: [{ id: 'a', steps: [{ users: 200 }, { users: 50 }] }, { id: 'users', steps: [{ users: 10 }] }] } } }, 'funnel'))!;
    expect(set).toMatchObject({ shape: 'funnel', top: 200, last: 50, value: 25 });
  });

  it('an unmeasured step is not a zero, and a funnel never turns into a trend', () => {
    const set = (steps: { users: number; measured?: boolean }[]) => insightTile(detail({ series: [{ points: days(1280, 38) }], latest: 7, funnel: { set: { funnels: [{ id: 'a', steps }] } } }, 'funnel'))!;
    // The last step is not measured: the reach is of the last MEASURED one.
    expect(set([{ users: 4000 }, { users: 1000 }, { users: 0, measured: false }])).toMatchObject({ shape: 'funnel', top: 4000, last: 1000, value: 25 });
    // The top is not measured: the first measured step is the top (as the Lab card reads it).
    expect(set([{ users: 0, measured: false }, { users: 800 }, { users: 200 }])).toMatchObject({ shape: 'funnel', top: 800, last: 200, value: 25 });
    // Nothing measured, or no traffic at all: empty, never the series read as a trend with a "drop".
    expect(set([{ users: 0, measured: false }])).toMatchObject({ shape: 'empty', value: null, delta: null });
    expect(set([{ users: 0 }, { users: 0 }])).toMatchObject({ shape: 'empty', value: null, delta: null });
  });

  it('a long funnel keeps at most 24 bars and each one is its run\'s lowest, so a drop does not vanish', () => {
    const users = Array.from({ length: 60 }, (_, i) => (i === 31 ? 5 : 1000 - i));
    const v = insightTile(detail({ series: [{ points: days(...users) }] }, 'funnel'))!;
    expect(v.lane).toHaveLength(24);
    expect(Math.min(...v.lane)).toBeCloseTo(5 / 1000, 5);
  });

  it('freshness is one word: failed, never synced, stale (the server\'s verdict), or up to date', () => {
    expect(insightTile(detail({ error: 'HTTP 500' }))!.fresh).toBe('failed');
    expect(insightTile(detail({ fetchedAt: null }))!.fresh).toBe('never');
    expect(insightTile(detail(), true)!.fresh).toBe('stale');
    expect(insightTile(detail(), false)!.fresh).toBe('fresh');
    // Stale is never re-derived from the fetch time: an old fetch the server calls fresh stays fresh.
    expect(insightTile(detail({ fetchedAt: '2020-01-01T00:00:00Z' }))!.fresh).toBe('fresh');
  });

  it('one figure and no series is the figure; nothing at all is empty; no detail yet is null', () => {
    expect(insightTile(detail({ latest: 3 }))).toMatchObject({ shape: 'figure', value: 3 });
    expect(insightTile(detail())).toMatchObject({ shape: 'empty', value: null });
    expect(insightTile(undefined)).toBeNull();
  });
});

describe('the status ring and the tiles', () => {
  const ring = (kind: string) => renderToStaticMarkup(createElement(StatusRing, { kind: kind as never }));

  it('the ring\'s mark repeats its colour: a dot working, "?" asking, a check done; a bare track saved', () => {
    expect(ring('working')).toMatch(/data-kind="working"/);
    expect(ring('working')).toMatch(/class="super-ring-mark"/);
    expect(ring('asking')).toMatch(/>\?<\/text>/);
    expect(ring('ready')).toMatch(/class="super-ring-check"/);
    expect(ring('saved')).not.toMatch(/super-ring-arc/);
    for (const k of ['working', 'asking', 'ready', 'saved', 'starting', 'ended']) expect(ring(k)).not.toMatch(/animate|<animate/);
  });

  it('a chat tile with no live session still reads: title, the state as its line, test ids kept', () => {
    const html = inI18n(createElement(ChatTile, {
      session: undefined, child: undefined, title: 'Ödeme sayfası: yükleme durumları', asksOwner: true,
      status: { kind: 'asking', label: 'needs you', mood: 'asking' },
    }));
    expect(html).toContain('Ödeme sayfası: yükleme durumları');
    expect(html).toContain('data-testid="super-card-doing"');
    expect(html).toContain('super-tile-asks');
    expect(html).toContain('data-kind="asking"');
    // No live session: the account is not known, so the ring says unknown and the state moved to the foot's dot.
    expect(html).toContain('data-testid="chat-limit-ring" data-known="false"');
    expect(html).toMatch(/data-testid="super-tile-status"/);
  });

  it('a group tile: its name, its count, its first cards, and the state of its loudest one', () => {
    const members = [
      { id: 'a', kind: 'chat' as const, title: 'Ödev Ver formu', status: 'working' as const },
      { id: 'b', kind: 'chat' as const, title: 'Rutin formu', status: 'ready' as const },
      { id: 'c', kind: 'task' as const, title: 'Giriş formu' },
      { id: 'd', kind: 'chat' as const, title: 'Ödeme', status: 'asking' as const },
    ];
    expect(groupStatus(members)).toBe('asking');
    expect(groupStatus(members.slice(0, 3))).toBe('working');
    expect(groupStatus([members[2]])).toBe('saved');
    const html = inI18n(createElement(GroupTile, { group: { name: 'Formlar' }, members }));
    expect(html).toContain('Formlar');
    expect(html).toContain('>4<');
    expect(html).toContain('Ödev Ver formu');
    expect(html).toContain('+2 more');
    expect(html).toContain('data-kind="asking"');
  });

  it('a panel opens over its group\'s tile (Others: above its stack), inside the stage, four tiles a row', () => {
    const stage = { width: 1544, height: 914 };
    const tile = { x: 260, y: 300, width: 160, height: 160 };
    const r = panelRect(tile, 3, stage, false);
    expect(r.x).toBe(260);
    expect(r.width).toBe(3 * 160 + 2 * 16 + 32);
    expect(r.y + r.height / 2).toBeCloseTo(380, 6);
    const others = panelRect({ x: 1372, y: 862, width: 148, height: 40 }, 6, stage, true);
    expect(others.x + others.width).toBeCloseTo(1520, 6);
    expect(others.y + others.height).toBeLessThanOrEqual(862);
    expect(others.width).toBe(4 * 160 + 3 * 16 + 32);
    // 30 cards in Others: the panel is capped to the room above its stack and never reaches it.
    const many = panelRect({ x: 1372, y: 862, width: 148, height: 40 }, 30, stage, true);
    expect(many.y).toBeGreaterThanOrEqual(24);
    expect(many.y + many.height).toBeLessThanOrEqual(862 - 12);
    expect(many.height).toBeLessThan(48 + 8 * 160 + 7 * 16 + 16);
    for (const p of [r, others]) {
      expect(p.x).toBeGreaterThanOrEqual(24);
      expect(p.y).toBeGreaterThanOrEqual(24);
      expect(p.x + p.width).toBeLessThanOrEqual(stage.width - 24);
    }
  });
});

describe('the surface wiring (source rules)', () => {
  const surface = ['SuperSurface.tsx', 'useStageDrag.ts'].map((f) => read(`${SUPER}/${f}`)).join('\n');
  const frame = read(`${SUPER}/SuperContainer.tsx`);

  it('side by side, a task or a note shows its page body, read like a whiteboard\'s page popup', () => {
    expect(frame).toMatch(/case 'task':\n\s*case 'knowledge': \{/);
    expect(frame).toMatch(/const path = targetPath\(\{ kind: c\.kind, ref: c\.ref \}\);/);
    expect(frame).toMatch(/<DocumentReader key=\{path\} path=\{path\} .* embedded vaultReads variant="page" \/>/);
  });

  // Card sizes (owner 2026-10-22): a small or medium floating card is a tile; a large or wide one
  // draws its view, and a web page there holds a frame only within the two-frame budget.
  it('a small or medium floating card is a tile; only a large or wide floating web card holds a frame', () => {
    expect(frame).toMatch(/: <ChatTile session=\{p\.session\}/);
    expect(frame).toMatch(/: <KindTile container=\{c\} title=\{p\.title\} viewReady=\{p\.viewReady\} wide=\{size === 'medium'\} \/>/);
    expect(frame).toMatch(/if \(SIZE_UNITS\[size\]\.h > 1 && c\.kind !== 'chat'\)/);
    expect(surface).toMatch(/return cp\.where !== 'float' \|\| cp\.size === 'large' \|\| cp\.size === 'wide';/);
    expect(surface).toMatch(/const liveWeb = keptWebIds\(lru, webOnScreen, /);
  });

  it('a card released on a tile groups: on a card a new group where it stood, on a group into it', () => {
    // Only in the float view: beside a page a tile is a live job's rail tile (super-canli-kart-sahnede).
    expect(surface).toMatch(/const tg = drop && !h && floatView \? dropTargetAt\(p, x - origin\.left, y - origin\.top, id\) : null;/);
    expect(surface).toMatch(/else if \(drop && tg\) groupOnto\(id, tg\);/);
    expect(surface).toMatch(/if \(isGroupId\(onto\)\) onLayout\(\{ \.\.\.out, group: \{ id: onto, cards: \[held\] \} \}\);/);
    expect(surface).toMatch(/onLayout\(\{ \.\.\.out, group: \{ id: newGroupId\(\), cards: \[onto, held\], name: nextGroupName\(/);
    // A card brought out of Others onto a tile is no longer put aside.
    expect(surface).toMatch(/byId\.get\(held\)\?\.place === 'others' \? \{ cards: \[\{ id: held, place: 'float' as const \}\] \} : \{\}/);
    // Dragged out of a group, a card leaves it wherever it lands.
    expect(surface).toMatch(/const leave = from !== 'others' \? \{ leave: \[id\] \} : \{\};/);
  });

  it('a stage that leaves the screen closes its panel, so a hidden panel never keeps Escape (end review)', () => {
    expect(surface).toMatch(/useEffect\(\(\) => \{ if \(!props\.visible\) setOpenGroup\(null\); \}, \[props\.visible\]\);/);
  });

  it('a card dragged out of a panel keeps the panel mounted until the release (its item holds the pointer)', () => {
    expect(surface).toMatch(/onBegin: \(\) => \{\n\s*origin = root\.getBoundingClientRect\(\);\n\s*setPanelDrag\(true\);/);
    expect(surface).toMatch(/setPanelDrag\(false\);\n\s*setOpenGroup\(null\);/);
    expect(read(`${SUPER}/AgentSurface.tsx`.replace('/super/AgentSurface', '/AgentSurface'))).toMatch(/if \(document\.querySelector\('\.super-group-panel'\)\) return;/);
  });
});
