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
import { criteriaProgress, plainCriterion } from '../../dashboard/src/components/sleepy/super/tileModel.js';

const { StatusRing, ChatTile } = await import('../../dashboard/src/components/sleepy/super/AgentCard.js');
const { GroupTile, groupStatus } = await import('../../dashboard/src/components/sleepy/super/SuperTiles.js');
const { panelRect } = await import('../../dashboard/src/components/sleepy/super/GroupPanel.js');
const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
const inI18n = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, null, el));

const ROOT = new URL('../../', import.meta.url).pathname;
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
    expect(criteriaProgress(md)).toEqual({ done: 2, total: 5, next: 'AC2 Small 1:1 tiles, see the stage' });
    expect(plainCriterion('[the link](https://example.com) and _soft_ *words*')).toBe('the link and soft words');
  });

  it('no criteria, or every one ticked, says so', () => {
    expect(criteriaProgress('')).toEqual({ done: 0, total: 0, next: null });
    expect(criteriaProgress(undefined)).toEqual({ done: 0, total: 0, next: null });
    expect(criteriaProgress('- [x] a\n- [x] b')).toEqual({ done: 2, total: 2, next: null });
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

  it('a floating card is a tile; a floating web tile never holds a frame', () => {
    expect(frame).toMatch(/\? <ChatTile session=\{p\.session\}/);
    expect(frame).toMatch(/: <KindTile container=\{c\} title=\{p\.title\} viewReady=\{p\.viewReady\} \/>/);
    expect(surface).toMatch(/plan\.cards\[c\.id\]\.where !== 'others' && plan\.cards\[c\.id\]\.where !== 'float'/);
  });

  it('a card released on a tile groups: on a card a new group where it stood, on a group into it', () => {
    expect(surface).toMatch(/const tg = drop && !h \? dropTargetAt\(p, x - origin\.left, y - origin\.top, id\) : null;/);
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
