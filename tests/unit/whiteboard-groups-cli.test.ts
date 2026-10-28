import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { createWhiteboard, listWhiteboards, setWhiteboardGroup } from '../../src/lib/whiteboards/store.js';
import { AGENT_BOARD_ENV } from '../../src/lib/automations/types.js';

/**
 * `dreamcontext whiteboard group list|set|clear|rename` and `create --group`, driven through the
 * real command tree in a scratch project, HOME pointed at a scratch folder.
 */
let project: string;
let root: string;
let home: string;
let cwd: string;

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

const groupOf = (slug: string) => listWhiteboards(root).find((b) => b.slug === slug)?.group;

beforeEach(() => {
  cwd = process.cwd();
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-groups-cli-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-groups-home-')));
  vi.stubEnv('HOME', home);
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  process.chdir(project);
});
afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('whiteboard group', () => {
  it('create --group, set, list --json and list print the group', async () => {
    expect((await run(['whiteboard', 'create', 'Revenue', '--group', 'Tilki metrics'])).code).toBe(0);
    const { slug } = createWhiteboard(root, 'CRM');
    expect((await run(['whiteboard', 'group', 'set', slug, 'tilki METRICS'])).code).toBe(0);
    expect(groupOf(slug)).toBe('Tilki metrics');
    const listed = JSON.parse((await run(['whiteboard', 'group', 'list', '--json'])).out);
    expect(listed).toEqual([{ name: 'Tilki metrics', boards: ['crm', 'revenue'] }]);
    createWhiteboard(root, 'Loose');
    const plain = await run(['whiteboard', 'list']);
    expect(plain.out).toMatch(/Tilki metrics:[\s\S]*Ungrouped:[\s\S]*Loose/);
    const json = JSON.parse((await run(['whiteboard', 'list', '--json'])).out);
    expect(json.find((b: { slug: string }) => b.slug === 'crm').group).toBe('Tilki metrics');
  });

  it('an invalid name exits 1 and changes nothing', async () => {
    const { slug } = createWhiteboard(root, 'X');
    const r = await run(['whiteboard', 'group', 'set', slug, 'a/b']);
    expect(r.code).toBe(1);
    expect(groupOf(slug)).toBeUndefined();
  });

  it('refuses a board the owner placed without --force', async () => {
    const { slug } = createWhiteboard(root, 'Owned');
    await setWhiteboardGroup(root, slug, 'Mine', { by: 'owner' });
    const r = await run(['whiteboard', 'group', 'clear', slug]);
    expect(r.code).toBe(1);
    expect(`${r.out}\n${r.err}`).toContain('--force');
    expect(groupOf(slug)).toBe('Mine');
    expect((await run(['whiteboard', 'group', 'clear', slug, '--force'])).code).toBe(0);
    expect(groupOf(slug)).toBeUndefined();
  });

  it('rename tilki → Tilki takes the new spelling', async () => {
    const a = createWhiteboard(root, 'a', '', { group: 'tilki', by: 'agent' }).slug;
    const b = createWhiteboard(root, 'b', '', { group: 'tilki', by: 'agent' }).slug;
    expect((await run(['whiteboard', 'group', 'rename', 'tilki', 'Tilki'])).code).toBe(0);
    expect([groupOf(a), groupOf(b)]).toEqual(['Tilki', 'Tilki']);
  });

  it('a board agent may regroup only its own board and may not rename a group', async () => {
    const own = createWhiteboard(root, 'Own').slug;
    const other = createWhiteboard(root, 'Other').slug;
    vi.stubEnv(AGENT_BOARD_ENV, own);
    expect((await run(['whiteboard', 'group', 'set', own, 'Mine'])).code).toBe(0);
    expect((await run(['whiteboard', 'group', 'set', other, 'Mine'])).code).toBe(1);
    expect((await run(['whiteboard', 'group', 'rename', 'Mine', 'Yours'])).code).toBe(1);
    expect(groupOf(own)).toBe('Mine');
    expect(groupOf(other)).toBeUndefined();
  });
});
