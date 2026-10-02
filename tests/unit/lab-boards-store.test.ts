import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsight } from '../../src/lib/lab/store.js';
import {
  BoardStoreError,
  boardsLockPath,
  createBoard,
  dedupeSlugs,
  deleteBoard,
  deriveBoardsFromLegacy,
  editBoard,
  getBoard,
  isMaterialized,
  listBoards,
  parseBoardText,
  putBoard,
  readBoardFile,
  serializeBoardSpec,
  slugifyTitle,
  sweepBoardStaging,
  unplacedInsights,
  validateBoardSpec,
  type Board,
} from '../../src/lib/lab/boards.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-lab-boards-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const boardsDir = () => join(root, 'lab', 'boards');
const labEntries = () => readdirSync(join(root, 'lab')).sort();

function seedLegacy(): void {
  createInsight(root, { slug: 'signups', title: 'Signups', category: 'Growth' });
  createInsight(root, { slug: 'activation', title: 'Activation', category: 'Growth', group: 'Funnel' });
  createInsight(root, { slug: 'revenue', title: 'Revenue', category: 'Finance' });
}

/** Retitle the first card: a minimal real edit. */
const nudge = (current: Board | null) => ({
  ...current!,
  cards: current!.cards.map((c, i) => (i === 0 ? { ...c, title: 'Edited' } : c)),
});

describe('slugs', () => {
  it('transliterates Turkish and strips diacritics', () => {
    expect(slugifyTitle('Ürün Büyümesi')).toBe('urun-buyumesi');
    expect(slugifyTitle('İŞ GELİŞTİRME ağı')).toBe('is-gelistirme-agi');
    expect(slugifyTitle('Çağrı Merkezi & Destek')).toBe('cagri-merkezi-destek');
    expect(slugifyTitle('Café déjà vu')).toBe('cafe-deja-vu');
    expect(slugifyTitle('📈 🚀')).toBe('');
  });

  it('dedupes colliding titles with -2, -3 and gives empty titles board-N, in the given order', () => {
    expect(dedupeSlugs(['Growth', 'growth!', 'GROWTH', '🚀', 'Growth 2'], 'board'))
      .toEqual(['growth', 'growth-2', 'growth-3', 'board-4', 'growth-2-2']);
  });

  it('derived board slugs are distinct and ordered by the sorted category key, not by prefs', () => {
    const list = ['Büyüme', 'Buyume', '🚀', '!!!'].map((category, i) => ({
      slug: `i${i}`, title: `I${i}`, category, group: null, render: 'number' as const, size: null, width: null, height: null,
    }));
    const a = deriveBoardsFromLegacy(list);
    const b = deriveBoardsFromLegacy(list, { catOrder: ['🚀', '!!!', 'Büyüme', 'Buyume'] });
    const bySlug = (bs: typeof a) => Object.fromEntries(bs.map((x) => [x.spec.title, x.slug]));
    expect(bySlug(a)).toEqual(bySlug(b));
    expect(new Set(a.map((x) => x.slug)).size).toBe(4);
    // Sorted keys: '!!!' < 'Buyume' < 'Büyüme' < '🚀'
    expect(bySlug(a)).toEqual({ '!!!': 'board-1', Buyume: 'buyume', 'Büyüme': 'buyume-2', '🚀': 'board-4' });
  });
});

describe('materialize-all', () => {
  it('the first edit writes EVERY board in one step and applies the edit', async () => {
    seedLegacy();
    const derived = listBoards(root);
    expect(derived.derived).toBe(true);
    const growth = derived.boards.find((b) => b.slug === 'growth')!;

    const saved = await editBoard(root, 'growth', nudge, { expectedRev: growth.rev });
    expect(saved!.cards[0].title).toBe('Edited');
    expect(isMaterialized(root)).toBe(true);
    expect(readdirSync(boardsDir()).sort()).toEqual(['finance.md', 'growth.md']);
    expect(labEntries().some((e) => e.startsWith('.boards-staging-'))).toBe(false);
    // The untouched board is byte-identical to its derivation (same rev).
    const finance = derived.boards.find((b) => b.slug === 'finance')!;
    expect(readBoardFile(root, 'finance')!.rev).toBe(finance.rev);
    expect(listBoards(root).derived).toBe(false);
    expect(existsSync(boardsLockPath(root))).toBe(false); // released
  });

  it('an EMPTY lab/boards/ counts as absent (derivation, then materialize replaces it)', async () => {
    seedLegacy();
    mkdirSync(boardsDir(), { recursive: true });
    expect(isMaterialized(root)).toBe(false);
    expect(listBoards(root).derived).toBe(true);
    await editBoard(root, 'finance', nudge);
    expect(readdirSync(boardsDir()).sort()).toEqual(['finance.md', 'growth.md']);
  });

  describe('a lab/boards/ holding only stray (non-board) entries', () => {
    const seedStrays = () => {
      mkdirSync(join(boardsDir(), 'notes'), { recursive: true });
      writeFileSync(join(boardsDir(), '.gitkeep'), '');
      writeFileSync(join(boardsDir(), '.DS_Store'), 'x');
      writeFileSync(join(boardsDir(), 'Draft_Board.md'), 'mine');
      writeFileSync(join(boardsDir(), 'notes', 'a.txt'), 'nested');
    };
    const strayState = () => ({
      entries: readdirSync(boardsDir()).sort(),
      draft: readFileSync(join(boardsDir(), 'Draft_Board.md'), 'utf-8'),
      nested: readFileSync(join(boardsDir(), 'notes', 'a.txt'), 'utf-8'),
    });

    it('still counts as absent, and materializes in ONE rename keeping the strays', async () => {
      seedLegacy();
      seedStrays();
      expect(isMaterialized(root)).toBe(false);
      await editBoard(root, 'growth', nudge);
      expect(readdirSync(boardsDir()).sort()).toEqual(['.DS_Store', '.gitkeep', 'Draft_Board.md', 'finance.md', 'growth.md', 'notes']);
      expect(readFileSync(join(boardsDir(), 'notes', 'a.txt'), 'utf-8')).toBe('nested');
      expect(labEntries().some((e) => e.startsWith('.boards-staging-'))).toBe(false);
    });

    it('a forced failure at any step leaves no board live, derivation intact and every stray in place', async () => {
      seedLegacy();
      seedStrays();
      const before = JSON.stringify(listBoards(root));
      const strays = strayState();
      const faults: Array<[string, NonNullable<Parameters<typeof editBoard>[3]>['hooks']]> = [
        ['staging write', { afterStagingFile: () => { throw new Error('fault'); } }],
        ['after first stray moved', { afterStrayMove: () => { throw new Error('fault'); } }],
        ['after every stray moved', { beforeRename: () => { throw new Error('fault'); } }],
      ];
      for (const [label, hooks] of faults) {
        await expect(editBoard(root, 'growth', nudge, { hooks }), label).rejects.toThrow('fault');
        expect(isMaterialized(root), label).toBe(false);
        expect(readdirSync(boardsDir()).filter((f) => f.endsWith('.md') && f !== 'Draft_Board.md'), label).toEqual([]);
        expect(strayState(), label).toEqual(strays);
        expect(JSON.stringify(listBoards(root)), label).toBe(before);
        expect(labEntries().some((e) => e.startsWith('.boards-staging-')), label).toBe(false);
      }
    });
  });

  it('a forced failure mid-materialize leaves no lab/boards/, no staging dir, and derivation intact', async () => {
    seedLegacy();
    const before = JSON.stringify(listBoards(root));
    let calls = 0;
    await expect(editBoard(root, 'growth', nudge, {
      hooks: { afterStagingFile: () => { if (++calls === 1) throw new Error('disk full'); } },
    })).rejects.toThrow('disk full');
    await expect(editBoard(root, 'growth', nudge, {
      hooks: { beforeRename: () => { throw new Error('power cut'); } },
    })).rejects.toThrow('power cut');
    expect(existsSync(boardsDir())).toBe(false);
    expect(labEntries().some((e) => e.startsWith('.boards-staging-'))).toBe(false);
    expect(JSON.stringify(listBoards(root))).toBe(before);
    expect(existsSync(boardsLockPath(root))).toBe(false);
  });

  it('a lost materialize race discards staging, re-reads and re-applies the edit', async () => {
    seedLegacy();
    const derived = listBoards(root).boards;
    const growth = derived.find((b) => b.slug === 'growth')!;
    const winner = derived.find((b) => b.slug === 'finance')!;
    const saved = await editBoard(root, 'growth', nudge, {
      expectedRev: growth.rev,
      hooks: {
        beforeRename: () => {
          // Another writer materializes first (same derivation for growth, plus its own board).
          if (existsSync(boardsDir())) return;
          mkdirSync(boardsDir());
          const src = (b: Board) => validateBoardSpec(b, b.slug).spec;
          writeFileSync(join(boardsDir(), 'growth.md'), serializeBoardSpec(src(growth)));
          writeFileSync(join(boardsDir(), 'finance.md'), serializeBoardSpec(src(winner)));
          writeFileSync(join(boardsDir(), 'theirs.md'), serializeBoardSpec({ title: 'Theirs', order: 9, cards: [], body: '' }));
        },
      },
    });
    expect(saved!.cards[0].title).toBe('Edited');
    expect(readdirSync(boardsDir()).sort()).toEqual(['finance.md', 'growth.md', 'theirs.md']);
    expect(labEntries().some((e) => e.startsWith('.boards-staging-'))).toBe(false);
  });

  it('a lost race where the target board moved is a 409, not a silent overwrite', async () => {
    seedLegacy();
    const growth = listBoards(root).boards.find((b) => b.slug === 'growth')!;
    const err = await editBoard(root, 'growth', nudge, {
      expectedRev: growth.rev,
      hooks: {
        beforeRename: () => {
          if (existsSync(boardsDir())) return;
          mkdirSync(boardsDir());
          writeFileSync(join(boardsDir(), 'growth.md'), serializeBoardSpec({ title: 'Growth (theirs)', order: 1, cards: [], body: '' }));
        },
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardStoreError);
    expect((err as BoardStoreError).status).toBe(409);
    expect(readBoardFile(root, 'growth')!.title).toBe('Growth (theirs)');
  });
});

describe('writes after materialize', () => {
  it('rev-checks: a stale rev is 409 and leaves the file alone', async () => {
    seedLegacy();
    const first = await editBoard(root, 'growth', nudge);
    await putBoard(root, 'growth', { ...first!, title: 'Growth v2' }, { expectedRev: first!.rev });
    const err = await putBoard(root, 'growth', { ...first!, title: 'Stale' }, { expectedRev: first!.rev }).catch((e) => e);
    expect(err).toBeInstanceOf(BoardStoreError);
    expect(err.code).toBe('rev-conflict');
    expect(getBoard(root, 'growth')!.title).toBe('Growth v2');
  });

  it('strict validation rejects overlaps, dup ids and unsafe slugs with card id + block path + fix', async () => {
    seedLegacy();
    await createBoard(root, 'lab-x', 'Lab X');
    const err = await putBoard(root, 'lab-x', {
      title: 'Lab X',
      cards: [
        { id: 'c-a', at: { x: 0, y: 0, w: 6, h: 3 }, insight: 'signups' },
        { id: 'c-a', at: { x: 6, y: 0, w: 6, h: 3 }, insight: 'signups' },
        { id: 'c-b', at: { x: 2, y: 1, w: 4, h: 3 }, blocks: [{ line: { data: '../etc/passwd', color: 9 } }] },
      ],
    }).catch((e) => e) as BoardStoreError;
    expect(err.code).toBe('invalid');
    expect(err.status).toBe(400);
    const paths = err.diagnostics.map((d) => `${d.cardId}@${d.path}`);
    expect(paths).toContain('c-a@cards[1].id');
    expect(paths).toContain('c-b@cards[2].blocks[0].line.data');
    expect(paths).toContain('c-b@cards[2].blocks[0].line.color');
    expect(paths.some((p) => p.startsWith('c-b@cards[2].at'))).toBe(true);
    expect(err.diagnostics.every((d) => d.fix.length > 0)).toBe(true);
    expect(err.message).toContain('Fix:');
  });

  it('a missing insight is a warning, not an error', () => {
    seedLegacy();
    const v = validateBoardSpec({ title: 'T', cards: [{ id: 'c-x', at: { x: 0, y: 0, w: 4, h: 3 }, insight: 'nope' }] }, 't', { contextRoot: root });
    expect(v.ok).toBe(true);
    expect(v.warnings[0]).toMatchObject({ cardId: 'c-x', path: 'cards[0].insight' });
  });

  it('create, delete, unplaced', async () => {
    seedLegacy();
    await createBoard(root, 'empty', 'Empty');
    expect(isMaterialized(root)).toBe(true);
    expect(getBoard(root, 'empty')!.order).toBe(3);
    await expect(createBoard(root, 'empty', 'Again')).rejects.toMatchObject({ code: 'exists' });
    await deleteBoard(root, 'finance');
    expect(getBoard(root, 'finance')).toBeNull();
    expect(unplacedInsights(root, listBoards(root).boards)).toEqual(['revenue']);
    await expect(deleteBoard(root, 'finance')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a board slug that is not kebab-case before touching disk', async () => {
    await expect(editBoard(root, '../x', () => ({ title: 'x', cards: [] }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(editBoard(root, 'a%2Fb', () => ({ title: 'x', cards: [] }))).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(join(root, 'lab'))).toBe(false);
  });

  it('a held lock (live pid) makes the write busy (503) after the wait', async () => {
    mkdirSync(join(root, 'state', '.locks'), { recursive: true });
    writeFileSync(boardsLockPath(root), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(createBoard(root, 'x', 'X', { waitMs: 60 })).rejects.toMatchObject({ code: 'busy', status: 503 });
  });

  it('a stale lock from a dead pid is reclaimed', async () => {
    mkdirSync(join(root, 'state', '.locks'), { recursive: true });
    writeFileSync(boardsLockPath(root), JSON.stringify({ pid: 999999, at: Date.now() - 60_000 }));
    await createBoard(root, 'x', 'X', { waitMs: 60 });
    expect(getBoard(root, 'x')!.title).toBe('X');
  });
});

describe('error boards', () => {
  it('conflict markers and unparseable YAML read as error boards; edits are refused with 423', async () => {
    mkdirSync(boardsDir(), { recursive: true });
    writeFileSync(join(boardsDir(), 'ok.md'), '---\ntitle: OK\ncards: []\n---\n');
    writeFileSync(join(boardsDir(), 'merged.md'), '---\ntitle: X\n<<<<<<< ours\ncards: []\n=======\ncards: [1]\n>>>>>>> theirs\n---\n');
    writeFileSync(join(boardsDir(), 'broken.md'), '---\ntitle: [unclosed\n---\n');
    const { boards } = listBoards(root);
    const bySlug = Object.fromEntries(boards.map((b) => [b.slug, b]));
    expect(bySlug.merged.error).toMatchObject({ kind: 'conflict' });
    expect(bySlug.broken.error).toMatchObject({ kind: 'parse' });
    expect(bySlug.ok.error).toBeNull();
    expect(boards[boards.length - 1].error).not.toBeNull(); // error boards sort last
    const err = await putBoard(root, 'merged', { title: 'X', cards: [] }).catch((e) => e);
    expect(err).toMatchObject({ code: 'error-board', status: 423 });
    expect(readFileSync(join(boardsDir(), 'merged.md'), 'utf-8')).toContain('<<<<<<<');
  });

  it('a ---js fence is an error board and never evaluated', () => {
    (globalThis as Record<string, unknown>).__boardPwned = 0;
    const b = parseBoardText('evil', '---js\n{title: (globalThis.__boardPwned = 1, "x")}\n---\n');
    expect(b.error).toMatchObject({ kind: 'parse' });
    expect((globalThis as Record<string, unknown>).__boardPwned).toBe(0);
  });
});

describe('lenient read', () => {
  it('clamps geometry, resolves overlaps and duplicate ids in memory, and never writes back', () => {
    mkdirSync(boardsDir(), { recursive: true });
    const text = [
      '---',
      'title: Messy',
      'cards:',
      '  - {id: c-a, at: {x: 20, y: -3, w: 30, h: 99}, insight: a}',
      '  - {id: c-a, at: {x: 0, y: 0, w: 4, h: 3}, insight: b}',
      '  - {id: c-c, at: {x: 1.4, y: "2", w: 0, h: 0}, insight: c}',
      '  - {id: c-d, insight: d, blocks: [{nope: {}}, {line: {data: d, bogus: 1}}]}',
      '---',
      '',
    ].join('\n');
    writeFileSync(join(boardsDir(), 'messy.md'), text);
    const b = readBoardFile(root, 'messy')!;
    expect(b.error).toBeNull();
    expect(b.cards.map((c) => c.id)).toEqual(['c-a', 'c-a-2', 'c-c', 'c-d']);
    expect(b.cards[0].at).toMatchObject({ x: 0, w: 12, h: 24 });
    for (let i = 0; i < b.cards.length; i++) {
      for (let j = i + 1; j < b.cards.length; j++) {
        const [p, q] = [b.cards[i].at, b.cards[j].at];
        expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h).toBe(false);
      }
    }
    expect(b.cards[3].blocks!.map((x) => x.type)).toEqual(['line']);
    expect(b.cards[3].blocks![0].options).toEqual({});
    expect(b.warnings.length).toBeGreaterThan(0);
    expect(readFileSync(join(boardsDir(), 'messy.md'), 'utf-8')).toBe(text);
  });
});

describe('staging sweep', () => {
  it('removes staging dirs of dead pids only', () => {
    mkdirSync(join(root, 'lab', '.boards-staging-999999-abc'), { recursive: true });
    mkdirSync(join(root, 'lab', `.boards-staging-${process.ppid}-def`), { recursive: true });
    expect(sweepBoardStaging(root)).toBe(1);
    expect(labEntries()).toEqual([`.boards-staging-${process.ppid}-def`]);
  });
});
