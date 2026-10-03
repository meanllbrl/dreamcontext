import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { createWhiteboard, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import { widgetPayloadOf } from '../../src/lib/whiteboards/widgets.js';
import { parseWhiteboard, serializeWhiteboard } from '../../src/lib/whiteboards/format.js';

/**
 * `dreamcontext whiteboard add <slug> wiki`, `nav list|add|remove|move --card` and `show --json`
 * driven through the REAL
 * command tree, in a scratch project the process chdirs into, with HOME pointed at a scratch
 * folder (injectable-home isolation): nothing reaches the real brain or ~.
 */

let project: string;
let root: string;
let home: string;
let cwd: string;
let slug: string;

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  // eslint-disable-next-line no-control-regex
  const strip = (s: string[]) => s.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  return { code, out: strip(out), err: strip(err) };
}

async function json(argv: string[]): Promise<any> {
  const r = await run([...argv, '--json']);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out);
}

beforeEach(() => {
  cwd = process.cwd();
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-nav-cli-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-nav-home-')));
  vi.stubEnv('HOME', home);
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'knowledge', 'architecture'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'architecture', 'overview.md'), '---\nname: Overview\n---\n');
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'spec.pdf'), '%PDF');
  slug = createWhiteboard(root, 'Wiki Board').slug;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function cardOnDisk(id: string): unknown {
  const el = readWhiteboard(root, slug).board.elements.find((e) => e.id === id);
  return el ? widgetPayloadOf(el)?.sections : undefined;
}

describe('whiteboard add wiki', () => {
  it('adds an empty wiki card at size l; --title is required', async () => {
    const added = await json(['whiteboard', 'add', slug, 'wiki', '--title', 'Handbook']);
    expect(added.kind).toBe('wiki');
    const el = readWhiteboard(root, slug).board.elements.find((e) => e.id === added.id)!;
    expect(widgetPayloadOf(el)).toMatchObject({ v: 1, kind: 'wiki', title: 'Handbook', size: 'l', sections: [] });
    expect([el.width, el.height]).toEqual([376, 376]);
    const sized = await json(['whiteboard', 'add', slug, 'wiki', '--title', 'Small', '--size', 's']);
    expect(widgetPayloadOf(readWhiteboard(root, slug).board.elements.find((e) => e.id === sized.id)!)?.size).toBe('s');
    const bad = await run(['whiteboard', 'add', slug, 'wiki']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/wiki widget needs --title/);
  });
});

describe('whiteboard nav CLI on a wiki card', () => {
  it('with no wiki card, says how to add one', async () => {
    for (const argv of [
      ['whiteboard', 'nav', 'list', slug],
      ['whiteboard', 'nav', 'add', slug, '--section', 'S'],
    ]) {
      const r = await run(argv);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`has no wiki card. Add one: dreamcontext whiteboard add ${slug} wiki --title`);
    }
  });

  it('one card: --card may be left out; add, list, move, remove; show --json reports it', async () => {
    const { id } = await json(['whiteboard', 'add', slug, 'wiki', '--title', 'Handbook']);
    let r = await json(['whiteboard', 'nav', 'add', slug, '--section', 'Getting started']);
    expect(r.card.id).toBe(id);
    expect(r.card.sections).toHaveLength(1);
    const intro = r.card.sections[0].id as string;

    r = await json(['whiteboard', 'nav', 'add', slug, '--section', 'getting started', '--page', 'architecture/overview']);
    r = await json(['whiteboard', 'nav', 'add', slug, '--card', id, '--section', intro, '--page', 'docs/spec.pdf', '--label', 'Spec']);
    expect(r.card.sections[0].pages).toEqual([{ ref: 'architecture/overview' }, { ref: 'docs/spec.pdf', label: 'Spec' }]);

    // A page into a missing section creates it.
    r = await json(['whiteboard', 'nav', 'add', slug, '--section', 'Reference', '--page', 'docs/later.md']);
    expect(r.card.sections.map((s: { title: string }) => s.title)).toEqual(['Getting started', 'Reference']);

    r = await json(['whiteboard', 'nav', 'list', slug]);
    expect(r.card.sections[1].pages).toEqual([{ ref: 'docs/later.md' }]);

    r = await json(['whiteboard', 'nav', 'move', slug, '--section', intro, '--page', 'docs/spec.pdf', '--to', '0']);
    expect(r.card.sections[0].pages.map((p: { ref: string }) => p.ref)).toEqual(['docs/spec.pdf', 'architecture/overview']);
    r = await json(['whiteboard', 'nav', 'move', slug, '--section', 'Reference', '--to', '0']);
    expect(r.card.sections[0].title).toBe('Reference');
    r = await json(['whiteboard', 'nav', 'move', slug, '--section', intro, '--page', '#1', '--to', '0', '--to-section', 'Reference']);
    expect(r.card.sections[0].pages.map((p: { ref: string }) => p.ref)).toEqual(['architecture/overview', 'docs/later.md']);

    r = await json(['whiteboard', 'nav', 'remove', slug, '--section', 'Reference', '--page', 'docs/later.md']);
    expect(r.removed).toBe('docs/later.md');

    // Written into the card on disk, not the frontmatter.
    expect(cardOnDisk(id)).toEqual(r.card.sections);
    const file = readFileSync(join(root, 'whiteboards', slug, `${slug}.excalidraw.md`), 'utf-8');
    expect(file).not.toContain('dreamcontext-wiki');

    const show = await json(['whiteboard', 'show', slug]);
    expect(show.nav).toBeUndefined();
    expect(show.wikis).toEqual([{ id, title: 'Handbook', size: 'l', sections: r.card.sections }]);
    expect(show.wikis[0].sections[1].pages).toEqual([{ ref: 'docs/spec.pdf', label: 'Spec' }]);
    expect(show.elements.find((e: { id: string }) => e.id === id).sections).toEqual(r.card.sections);

    await json(['whiteboard', 'nav', 'remove', slug, '--section', 'Reference']);
    r = await json(['whiteboard', 'nav', 'remove', slug, '--section', intro]);
    expect(r.card.sections).toEqual([]);
  });

  it('several cards: --card is required, the error lists ids and titles, and each card keeps its own list', async () => {
    const a = (await json(['whiteboard', 'add', slug, 'wiki', '--title', 'Alpha'])).id as string;
    const b = (await json(['whiteboard', 'add', slug, 'wiki', '--title', 'Beta'])).id as string;
    const r = await run(['whiteboard', 'nav', 'add', slug, '--section', 'S']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('2 wiki cards; pick one with --card <id>');
    expect(r.err).toContain(`${a} "Alpha"`);
    expect(r.err).toContain(`${b} "Beta"`);

    await json(['whiteboard', 'nav', 'add', slug, '--card', a, '--section', 'A only', '--page', 'docs/spec.pdf']);
    await json(['whiteboard', 'nav', 'add', slug, '--card', b, '--section', 'B only']);
    expect(cardOnDisk(a)).toEqual([expect.objectContaining({ title: 'A only', pages: [{ ref: 'docs/spec.pdf' }] })]);
    expect(cardOnDisk(b)).toEqual([expect.objectContaining({ title: 'B only', pages: [] })]);

    const show = await json(['whiteboard', 'show', slug]);
    expect(show.wikis.map((w: { id: string; title: string }) => [w.id, w.title])).toEqual([[a, 'Alpha'], [b, 'Beta']]);

    const note = (await json(['whiteboard', 'add', slug, 'note', '--text', 'x'])).id as string;
    const notWiki = await run(['whiteboard', 'nav', 'list', slug, '--card', note]);
    expect(notWiki.code).toBe(1);
    expect(notWiki.err).toMatch(/is not a wiki card/);
    const missing = await run(['whiteboard', 'nav', 'list', slug, '--card', 'nope']);
    expect(missing.err).toMatch(/no wiki card 'nope'/);
  });

  it('a card whose file holds a section without pages (hand-edited, git sync) never crashes show / nav list / nav add', async () => {
    const { id } = await json(['whiteboard', 'add', slug, 'wiki', '--title', 'Hand edited']);
    const file = join(root, 'whiteboards', slug, `${slug}.excalidraw.md`);
    // Written past the validator, as a hand edit or a git-sync merge would land it.
    const board = parseWhiteboard(readFileSync(file, 'utf-8'));
    (board.elements.find((e) => e.id === id)!.customData!.dc as Record<string, unknown>).sections = [{ id: 'a', title: 'A' }];
    writeFileSync(file, serializeWhiteboard(board));
    expect(cardOnDisk(id)).toEqual([{ id: 'a', title: 'A' }]);

    const show = await json(['whiteboard', 'show', slug]);
    expect(show.wikis[0].sections).toEqual([{ id: 'a', title: 'A', pages: [] }]);
    expect((await run(['whiteboard', 'show', slug])).code).toBe(0);
    const list = await json(['whiteboard', 'nav', 'list', slug]);
    expect(list.card.sections).toEqual([{ id: 'a', title: 'A', pages: [] }]);
    expect((await run(['whiteboard', 'nav', 'list', slug])).code).toBe(0);

    const added = await json(['whiteboard', 'nav', 'add', slug, '--section', 'a', '--page', 'docs/spec.pdf']);
    expect(added.card.sections).toEqual([{ id: 'a', title: 'A', pages: [{ ref: 'docs/spec.pdf' }] }]);
    expect(cardOnDisk(id)).toEqual([{ id: 'a', title: 'A', pages: [{ ref: 'docs/spec.pdf' }] }]);
  });

  it('warns (never fails) on a page that does not exist yet', async () => {
    await json(['whiteboard', 'add', slug, 'wiki', '--title', 'W']);
    const r = await run(['whiteboard', 'nav', 'add', slug, '--section', 'S', '--page', 'docs/missing.html', '--json']);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/no page 'docs\/missing.html' exists yet/);
  });

  it('refuses traversal and absolute paths, and an unknown section on remove/move', async () => {
    const { id } = await json(['whiteboard', 'add', slug, 'wiki', '--title', 'W']);
    for (const page of ['../outside.md', '/etc/passwd.md', 'docs/a.exe']) {
      const r = await run(['whiteboard', 'nav', 'add', slug, '--section', 'S', '--page', page]);
      expect(r.code, page).toBe(1);
      expect(r.err).toMatch(/invalid page ref/);
    }
    expect((await run(['whiteboard', 'nav', 'remove', slug, '--section', 'nope'])).code).toBe(1);
    expect((await run(['whiteboard', 'nav', 'move', slug, '--section', 'nope', '--to', '0'])).code).toBe(1);
    expect((await run(['whiteboard', 'nav', 'move', slug, '--section', 'nope', '--to', 'x'])).code).toBe(1);
    expect(cardOnDisk(id)).toEqual([]);
  });

  it('show (text) prints each wiki card\'s list; add knowledge --ref accepts a project path', async () => {
    await json(['whiteboard', 'add', slug, 'wiki', '--title', 'Docs card']);
    await json(['whiteboard', 'nav', 'add', slug, '--section', 'Docs', '--page', 'docs/spec.pdf']);
    const shown = await run(['whiteboard', 'show', slug]);
    expect(shown.out).toContain('wiki card "Docs card"');
    expect(shown.out).toContain('docs/spec.pdf');

    const added = await json(['whiteboard', 'add', slug, 'knowledge', '--ref', 'docs/spec.pdf']);
    const show = await json(['whiteboard', 'show', slug]);
    expect(show.elements.find((e: { id: string }) => e.id === added.id).ref).toBe('docs/spec.pdf');
    const bad = await run(['whiteboard', 'add', slug, 'knowledge', '--ref', '../x.md']);
    expect(bad.code).toBe(1);
    const task = await run(['whiteboard', 'add', slug, 'task', '--ref', 'docs/spec.pdf']);
    expect(task.code).toBe(1);
  });
});
