import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { createWhiteboard, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import {
  DEFAULT_WIDGET_SIZES, REF_KINDS, WIDGET_KINDS, isAgentSlugShape, makeWidgetElement, widgetPayloadOf,
} from '../../src/lib/whiteboards/widgets.js';
import { isValidWidgetRef, validateWidgetPayload, WhiteboardValidationError } from '../../src/lib/whiteboards/validate.js';
import { boardAgents } from '../../src/lib/whiteboards/agents.js';
import { createAutomation, isSafeAutomationSlug } from '../../src/lib/automations/store.js';
import { AGENT_BOARD_ENV, AGENT_SCRATCH_ENV, AGENT_SELF_ENV, RESERVED_SLUGS } from '../../src/lib/automations/types.js';
import * as dash from '../../dashboard/src/lib/whiteboardWidgets.js';
import { REF_KINDS as DASH_REF_KINDS, isValidRefFor } from '../../dashboard/src/components/whiteboard/widgetModel.js';

/**
 * The `agent` widget kind (T5): the contract on both sides, the slug-shape mirror, `show --json
 * agents`, `add … agent --ref` refusing an unknown agent, and the CLI's second layer while a
 * board agent runs (`DREAMCONTEXT_AGENT_BOARD`): other boards and files outside the project are
 * refused.
 *
 * The CLI cases drive the REAL command tree in a scratch project the process chdirs into, with
 * HOME pointed at a scratch folder: nothing reaches the real brain or ~.
 */

const SLUG_CASES: string[] = [
  'growth-helper', 'a', 'a1', 'deep-researcher-2', 'cache', 'output', 'review', 'hitl', 'cache-2',
  '', '-lead', 'trail-', 'two--dashes', 'Upper', 'with space', 'a/b', '../x', 'ünlü', 'a_b', 'x'.repeat(200),
];

describe('agent widget contract', () => {
  it('is a ref kind on both sides, default size L', () => {
    expect(WIDGET_KINDS).toContain('agent');
    expect(REF_KINDS).toContain('agent');
    expect(DASH_REF_KINDS).toContain('agent');
    expect(DEFAULT_WIDGET_SIZES.agent).toBe('l');
    expect(dash.DEFAULT_WIDGET_SIZES.agent).toBe('l');
  });

  it('the slug-shape check equals isSafeAutomationSlug, on both sides', () => {
    // The mirror carries its own copy of the reserved list: pin it to the source.
    for (const reserved of RESERVED_SLUGS) expect(isAgentSlugShape(reserved), reserved).toBe(false);
    for (const c of SLUG_CASES) {
      expect(isAgentSlugShape(c), c).toBe(isSafeAutomationSlug(c));
      expect(dash.isAgentSlugShape(c), c).toBe(isSafeAutomationSlug(c));
      expect(isValidWidgetRef('agent', c), c).toBe(isSafeAutomationSlug(c));
      expect(isValidRefFor('agent', c), c).toBe(isSafeAutomationSlug(c));
    }
    expect(isAgentSlugShape(42)).toBe(false);
    expect(isAgentSlugShape('x'.repeat(201))).toBe(false);
  });

  it('a payload needs a valid agent slug as its ref', () => {
    expect(validateWidgetPayload({ v: 1, kind: 'agent', ref: 'growth-helper', size: 'l' })).toMatchObject({ kind: 'agent' });
    expect(() => validateWidgetPayload({ v: 1, kind: 'agent' })).toThrow(/needs a ref/);
    expect(() => validateWidgetPayload({ v: 1, kind: 'agent', ref: 'two--dashes' })).toThrow(WhiteboardValidationError);
    expect(() => validateWidgetPayload({ v: 1, kind: 'agent', ref: 'cache' })).toThrow(WhiteboardValidationError);
  });

  it('an element links to dreamcontext://agent/<slug> at the L preset', () => {
    const el = makeWidgetElement('agent', { ref: 'growth-helper' }, { x: 0, y: 0 }, 'a0');
    expect(el.link).toBe('dreamcontext://agent/growth-helper');
    expect([el.width, el.height]).toEqual([376, 376]);
    expect(widgetPayloadOf(el)).toEqual({ v: 1, kind: 'agent', ref: 'growth-helper', size: 'l' });
  });
});

// ── the CLI ───────────────────────────────────────────────────────────────────────────────────

let project: string;
let root: string;
let home: string;
let outside: string;
let cwd: string;
let board: string;
let other: string;

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

function liveCount(slug: string): number {
  return readWhiteboard(root, slug).board.elements.filter((e) => e.isDeleted !== true).length;
}

beforeEach(() => {
  cwd = process.cwd();
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-agent-cli-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-agent-home-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-agent-outside-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv(AGENT_BOARD_ENV, '');
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  board = createWhiteboard(root, 'Growth Board').slug;
  other = createWhiteboard(root, 'Other Board').slug;
  createAutomation(root, { slug: 'growth-helper', title: 'Growth helper', mode: 'call', whiteboard: board });
  createAutomation(root, { slug: 'digest', title: 'Digest', days: 'daily', at: '18:00' });
  writeFileSync(join(project, 'notes.md'), '# In the project\n');
  writeFileSync(join(outside, 'id_rsa'), 'SECRET KEY\n');
  process.chdir(project);
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  for (const dir of [project, home, outside]) rmSync(dir, { recursive: true, force: true });
});

describe('whiteboard add <board> agent', () => {
  it('adds a card for a known agent, at size L, linked by slug', async () => {
    const added = await json(['whiteboard', 'add', board, 'agent', '--ref', 'growth-helper']);
    expect(added.kind).toBe('agent');
    const el = readWhiteboard(root, board).board.elements.find((e) => e.id === added.id)!;
    expect(el.link).toBe('dreamcontext://agent/growth-helper');
    expect(widgetPayloadOf(el)).toMatchObject({ v: 1, kind: 'agent', ref: 'growth-helper', size: 'l' });
  });

  it('refuses an unknown agent, a bad slug and a missing --ref, writing nothing', async () => {
    for (const argv of [
      ['whiteboard', 'add', board, 'agent', '--ref', 'nobody'],
      ['whiteboard', 'add', board, 'agent', '--ref', 'Bad Slug'],
      ['whiteboard', 'add', board, 'agent'],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
    }
    expect((await run(['whiteboard', 'add', board, 'agent', '--ref', 'nobody'])).err).toMatch(/no agent 'nobody'/);
    expect(liveCount(board)).toBe(0);
  });
});

describe('whiteboard show --json agents', () => {
  it('lists every agent card with home, and a card whose agent is gone as missing', async () => {
    const home1 = await json(['whiteboard', 'add', board, 'agent', '--ref', 'growth-helper']);
    const attached = await json(['whiteboard', 'add', board, 'agent', '--ref', 'digest']);
    await json(['whiteboard', 'add', board, 'note', '--text', 'hello']);
    rmSync(join(root, 'automations', 'digest.md'));

    const shown = await json(['whiteboard', 'show', board]);
    expect(shown.agents).toEqual([
      { id: home1.id, slug: 'growth-helper', title: 'Growth helper', home: true, missing: false },
      { id: attached.id, slug: 'digest', title: 'digest', home: false, missing: true },
    ]);
    expect(boardAgents(root, board)).toEqual(shown.agents);

    // The same agent on another board is attached there, not home.
    await json(['whiteboard', 'add', other, 'agent', '--ref', 'growth-helper']);
    expect((await json(['whiteboard', 'show', other])).agents).toMatchObject([{ slug: 'growth-helper', home: false }]);
  });

  it('a board with no agent cards lists none; a missing board has none to route to', async () => {
    expect((await json(['whiteboard', 'show', other])).agents).toEqual([]);
    expect(boardAgents(root, 'no-such-board')).toEqual([]);
  });
});

describe('the second layer while a board agent runs (DREAMCONTEXT_AGENT_BOARD)', () => {
  beforeEach(() => { vi.stubEnv(AGENT_BOARD_ENV, board); });

  it('acts on its own board', async () => {
    const added = await json(['whiteboard', 'add', board, 'note', '--text', 'mine']);
    await json(['whiteboard', 'update', board, added.id, '--text', 'still mine']);
    await json(['whiteboard', 'add', board, 'wiki', '--title', 'Handbook']);
    expect(liveCount(board)).toBe(2);
    await json(['whiteboard', 'remove', board, added.id]);
    expect(liveCount(board)).toBe(1);
  });

  it('refuses every mutating verb on another board, and creating one', async () => {
    vi.stubEnv(AGENT_BOARD_ENV, '');
    const wiki = await json(['whiteboard', 'add', other, 'wiki', '--title', 'Theirs']);
    vi.stubEnv(AGENT_BOARD_ENV, board);
    const before = readWhiteboard(root, other).rev;
    const drawing = join(project, 'shape.json');
    writeFileSync(drawing, JSON.stringify({ type: 'excalidraw', elements: [] }));
    for (const argv of [
      ['whiteboard', 'add', other, 'note', '--text', 'not mine'],
      ['whiteboard', 'update', other, wiki.id, '--title', 'x'],
      ['whiteboard', 'remove', other, wiki.id],
      ['whiteboard', 'draw', other, '--file', drawing],
      ['whiteboard', 'nav', 'add', other, '--section', 'Intro'],
      ['whiteboard', 'nav', 'remove', other, '--section', 'Intro'],
      ['whiteboard', 'nav', 'move', other, '--section', 'Intro', '--to', '0'],
      ['whiteboard', 'create', 'Sneaky Board'],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err, argv.join(' ')).toMatch(/acts only on its own board/);
    }
    expect(readWhiteboard(root, other).rev).toBe(before);
    expect((await json(['whiteboard', 'list'])).map((b: { slug: string }) => b.slug).sort()).toEqual([board, other].sort());
  });

  it('reads any board', async () => {
    expect((await json(['whiteboard', 'show', other])).slug).toBe(other);
  });

  describe('--file comes only from the agent\'s scratch folder and output/<self>', () => {
    let scratch: string;
    let outputSelf: string;
    beforeEach(() => {
      // Deliberately NOT realpath'd (on macOS tmpdir is a /var -> /private/var symlink): the
      // check must compare real paths on both sides.
      scratch = mkdtempSync(join(tmpdir(), 'dc-board-'));
      outputSelf = join(root, 'automations', 'output', 'growth-helper');
      mkdirSync(outputSelf, { recursive: true });
      vi.stubEnv(AGENT_SCRATCH_ENV, scratch);
      vi.stubEnv(AGENT_SELF_ENV, 'growth-helper');
      writeFileSync(join(project, '.env'), 'API_KEY=SECRET\n');
      mkdirSync(join(project, '.claude'), { recursive: true });
      writeFileSync(join(project, '.claude', 'settings.local.json'), '{"SECRET":true}\n');
    });
    afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

    async function refused(file: string, why: RegExp): Promise<void> {
      const r = await run(['whiteboard', 'add', board, 'note', '--file', file]);
      expect(r.code, file).toBe(1);
      expect(r.err, file).toMatch(why);
      expect(r.err, file).toMatch(/scratch folder .* or _dream_context\/automations\/output\/growth-helper\//);
    }

    it('refuses project secrets, files elsewhere in the project, and anything outside it', async () => {
      await refused('.env', /outside the folders this agent may read from/);
      await refused(join(project, '.claude', 'settings.local.json'), /outside the folders/);
      await refused('notes.md', /outside the folders/);
      await refused(join(outside, 'id_rsa'), /outside the folders/);
      await refused(`../${outside.split('/').pop()}/id_rsa`, /outside the folders/);
      const r = await run(['whiteboard', 'update', board, 'any-id', '--file', '.env']);
      expect(r.err).toMatch(/outside the folders/);
      expect(liveCount(board)).toBe(0);
      expect(JSON.stringify(readWhiteboard(root, board).board.elements)).not.toContain('SECRET');
    });

    it('refuses a symlink, even one inside an allowed folder', async () => {
      symlinkSync(join(project, '.env'), join(scratch, 'innocent.md'));
      symlinkSync(join(outputSelf, 'x.md'), join(outputSelf, 'self-link.md'));
      writeFileSync(join(outputSelf, 'x.md'), 'fine\n');
      await refused(join(scratch, 'innocent.md'), /is a symlink/);
      await refused(join(outputSelf, 'self-link.md'), /is a symlink/);
      expect(liveCount(board)).toBe(0);
    });

    it('reads a file in the scratch folder and in output/<self>', async () => {
      writeFileSync(join(scratch, 'draft.md'), '# From scratch\n');
      writeFileSync(join(outputSelf, 'report.md'), '# From output\n');
      const a = await json(['whiteboard', 'add', board, 'note', '--file', join(scratch, 'draft.md')]);
      const b = await json(['whiteboard', 'add', board, 'note', '--file', join(outputSelf, 'report.md')]);
      const md = (id: string) => widgetPayloadOf(readWhiteboard(root, board).board.elements.find((e) => e.id === id)!)?.markdown;
      expect(md(a.id)).toBe('# From scratch\n');
      expect(md(b.id)).toBe('# From output\n');
    });

    it('with neither folder set, every --file is refused', async () => {
      vi.stubEnv(AGENT_SCRATCH_ENV, '');
      vi.stubEnv(AGENT_SELF_ENV, '');
      writeFileSync(join(scratch, 'draft.md'), 'x\n');
      const r = await run(['whiteboard', 'add', board, 'note', '--file', join(scratch, 'draft.md')]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/outside the folders/);
    });
  });

  it('with the variable unset, nothing is limited', async () => {
    vi.stubEnv(AGENT_BOARD_ENV, '');
    await json(['whiteboard', 'add', other, 'note', '--file', join(outside, 'id_rsa')]);
    expect(liveCount(other)).toBe(1);
  });
});
