import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWhiteboard, listWhiteboards, mutateWhiteboard, patchWhiteboardMeta, readWhiteboard, renameWhiteboardGroup,
  resolveWhiteboardPath, setWhiteboardGroup, whiteboardsDir,
} from '../../src/lib/whiteboards/store.js';
import { foldGroup, GROUP_MAX, groupLength, parseGroupInput, readGroup } from '../../src/lib/whiteboards/validate.js';
import { WhiteboardConflictError, WhiteboardValidationError } from '../../src/lib/whiteboards/errors.js';
import { parseWhiteboard } from '../../src/lib/whiteboards/format.js';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleWhiteboardGroupRename, handleWhiteboardRename, handleWhiteboardsCreate } from '../../src/server/routes/whiteboards.js';

/**
 * The board explorer's groups (frontmatter `group` + `group-by`), against a scratch context root:
 * nothing here reaches the real brain.
 */
let root: string;

beforeEach(() => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-groups-')));
  root = join(project, '_dream_context');
  mkdirSync(root);
});
afterEach(() => { rmSync(join(root, '..'), { recursive: true, force: true }); });

const fm = (slug: string) => readWhiteboard(root, slug).board.frontmatter;
const groupOf = (slug: string) => listWhiteboards(root).find((b) => b.slug === slug)?.group;
const fileOf = (slug: string) => resolveWhiteboardPath(root, slug).file;

/** Write a raw frontmatter value the way a hand edit or Obsidian would. */
function handWrite(slug: string, line: string): void {
  const file = fileOf(slug);
  const raw = readFileSync(file, 'utf-8');
  writeFileSync(file, raw.replace('excalidraw-plugin: parsed\n', `excalidraw-plugin: parsed\n${line}\n`));
}

describe('readGroup / parseGroupInput', () => {
  it('reads only valid names; anything else is no group', () => {
    expect(readGroup('  Tilki metrics ')).toBe('Tilki metrics');
    expect(readGroup(undefined)).toBeNull();
    expect(readGroup(2026)).toBeNull();
    expect(readGroup(['Tilki', 'CRM'])).toBeNull();
    expect(readGroup('a/b')).toBeNull();
    expect(readGroup('x'.repeat(GROUP_MAX + 1))).toBeNull();
    expect(readGroup('Sati̇s')).toBe('Sati̇s'.normalize('NFC'));
  });

  it('a write refuses a bad name instead of ungrouping; only null ungroups', () => {
    expect(parseGroupInput(null)).toBeNull();
    for (const bad of ['', '   ', 'a/b', 'line\nbreak', 5, ['x'], undefined, 'x'.repeat(GROUP_MAX + 1)]) {
      expect(() => parseGroupInput(bad)).toThrow(WhiteboardValidationError);
    }
  });

  it('counts code points and folds case, accents and ı', () => {
    expect(groupLength('ğğ😀')).toBe(3);
    expect(parseGroupInput('😀'.repeat(GROUP_MAX))).toBe('😀'.repeat(GROUP_MAX));
    expect(foldGroup('Satış')).toBe(foldGroup('SATIS'));
    expect(foldGroup('Tilki')).toBe(foldGroup('tilki'));
  });
});

describe('a board in a group', () => {
  it('existing boards are ungrouped and nothing on disk moves', () => {
    const { slug } = createWhiteboard(root, 'Plain');
    expect(groupOf(slug)).toBeUndefined();
    expect(readdirSync(whiteboardsDir(root)).filter((n) => !n.startsWith('.'))).toEqual([slug]);
  });

  it('create --group stores group + group-by, and validates before making the folder', () => {
    const { slug } = createWhiteboard(root, 'Revenue', '', { group: 'Tilki metrics', by: 'owner' });
    expect(fm(slug)).toMatchObject({ group: 'Tilki metrics', 'group-by': 'owner' });
    expect(() => createWhiteboard(root, 'Broken', '', { group: 'a/b' })).toThrow(WhiteboardValidationError);
    expect(listWhiteboards(root).map((b) => b.slug)).toEqual([slug]);
    expect(readdirSync(whiteboardsDir(root))).not.toContain('broken');
  });

  it('the group survives an elements write (the editor save) and round-trips through the file', async () => {
    const { slug } = createWhiteboard(root, 'Board');
    await setWhiteboardGroup(root, slug, 'Product', { by: 'owner' });
    await mutateWhiteboard(root, slug, (b) => { b.frontmatter = { ...b.frontmatter }; });
    expect(parseWhiteboard(readFileSync(fileOf(slug), 'utf-8')).frontmatter.group).toBe('Product');
    expect(groupOf(slug)).toBe('Product');
  });

  it('a board whose disk value is invalid reads ungrouped and is moved with expect: null', async () => {
    for (const [i, line] of ['group: 2026', 'group: [Tilki, CRM]', 'group: "a/b"'].entries()) {
      const { slug } = createWhiteboard(root, `Odd ${i}`);
      handWrite(slug, line);
      const before = readFileSync(fileOf(slug), 'utf-8');
      expect(groupOf(slug)).toBeUndefined();
      expect(readFileSync(fileOf(slug), 'utf-8')).toBe(before); // a read never rewrites
      await setWhiteboardGroup(root, slug, 'Fixed', { by: 'owner', expect: null });
      expect(groupOf(slug)).toBe('Fixed');
    }
  });

  it('a hand-written date reads as its ISO string', () => {
    const { slug } = createWhiteboard(root, 'Dated');
    handWrite(slug, 'group: 2026-10-28');
    expect(groupOf(slug)).toBe('2026-10-28T00:00:00.000Z');
  });

  it('an invalid write is a 400 and the file is byte-identical', async () => {
    const { slug } = createWhiteboard(root, 'Keep', '', { group: 'Keep me' });
    const before = readFileSync(fileOf(slug), 'utf-8');
    await expect(setWhiteboardGroup(root, slug, 'a/b', { by: 'owner' })).rejects.toThrow(WhiteboardValidationError);
    await expect(patchWhiteboardMeta(root, slug, { group: 7, by: 'owner' })).rejects.toThrow(WhiteboardValidationError);
    expect(readFileSync(fileOf(slug), 'utf-8')).toBe(before);
  });

  it('a stale expect is a 409 stale_group', async () => {
    const { slug } = createWhiteboard(root, 'Moved', '', { group: 'A' });
    await expect(setWhiteboardGroup(root, slug, 'B', { by: 'owner', expect: null }))
      .rejects.toMatchObject({ code: 'stale_group', status: 409 });
    expect(groupOf(slug)).toBe('A');
  });

  it('an agent cannot move what the owner placed, even after he took it out of a group, unless forced', async () => {
    const { slug } = createWhiteboard(root, 'Owned');
    await setWhiteboardGroup(root, slug, 'Mine', { by: 'owner' });
    await expect(setWhiteboardGroup(root, slug, 'Theirs', { by: 'agent' })).rejects.toMatchObject({ code: 'owner_grouped' });
    await setWhiteboardGroup(root, slug, null, { by: 'owner' });
    expect(fm(slug)).toMatchObject({ 'group-by': 'owner' });
    expect(fm(slug).group).toBeUndefined();
    await expect(setWhiteboardGroup(root, slug, 'Theirs', { by: 'agent' })).rejects.toBeInstanceOf(WhiteboardConflictError);
    await setWhiteboardGroup(root, slug, 'Theirs', { by: 'agent', force: true });
    expect(fm(slug)).toMatchObject({ group: 'Theirs', 'group-by': 'agent' });
    // An agent's own placement it may change freely.
    await setWhiteboardGroup(root, slug, 'Again', { by: 'agent' });
    expect(groupOf(slug)).toBe('Again');
  });

  it('a new name adopts an existing group\'s spelling, ignoring the board being written', async () => {
    createWhiteboard(root, 'One', '', { group: 'Tilki metrics' });
    const { slug } = createWhiteboard(root, 'Two', '', { group: 'tilki METRICS' });
    expect(groupOf(slug)).toBe('Tilki metrics');
    // A lone board re-spelling its own group is not outvoted by itself.
    const solo = createWhiteboard(root, 'Solo', '', { group: 'satis' }).slug;
    await setWhiteboardGroup(root, solo, 'Satış', { by: 'owner' });
    expect(groupOf(solo)).toBe('Satış');
  });

  it('name + group in one PATCH land in one write', async () => {
    const { slug } = createWhiteboard(root, 'Old');
    const out = await patchWhiteboardMeta(root, slug, { name: 'New', group: 'G', expectGroup: null, by: 'owner' });
    expect(out).toMatchObject({ name: 'New', group: 'G' });
    await expect(patchWhiteboardMeta(root, slug, { name: 'Newer', group: 'H', expectGroup: 'X', by: 'owner' }))
      .rejects.toMatchObject({ code: 'stale_group' });
    expect(fm(slug)).toMatchObject({ name: 'New', group: 'G' }); // neither half landed
  });
});

describe('renameWhiteboardGroup', () => {
  it('Satis → Satış on three boards and on one: the new spelling is taken as typed', async () => {
    const many = ['a', 'b', 'c'].map((n) => createWhiteboard(root, n, '', { group: 'Satis' }).slug);
    const r = await renameWhiteboardGroup(root, 'Satis', 'Satış', { by: 'owner' });
    expect(r.moved.sort()).toEqual(many.sort());
    for (const s of many) expect(groupOf(s)).toBe('Satış');
    const one = createWhiteboard(root, 'one', '', { group: 'tilki' }).slug;
    await renameWhiteboardGroup(root, 'tilki', 'Tilki', { by: 'owner' });
    expect(groupOf(one)).toBe('Tilki');
  });

  it('moves every spelling of the group (Tilki + tilki → CRM), and adopts a different existing group', async () => {
    const a = createWhiteboard(root, 'a', '', { group: 'Tilki' }).slug;
    const b = createWhiteboard(root, 'b').slug;
    handWrite(b, 'group: tilki');
    createWhiteboard(root, 'c', '', { group: 'CRM' });
    const r = await renameWhiteboardGroup(root, 'Tilki', 'crm', { by: 'owner' });
    expect(r.to).toBe('CRM');
    expect(groupOf(a)).toBe('CRM');
    expect(groupOf(b)).toBe('CRM');
  });

  it('to: null ungroups all; from: null is refused; a bad to touches nothing', async () => {
    const a = createWhiteboard(root, 'a', '', { group: 'G' }).slug;
    await expect(renameWhiteboardGroup(root, null, 'X', { by: 'owner' })).rejects.toThrow(WhiteboardValidationError);
    const before = readFileSync(fileOf(a), 'utf-8');
    await expect(renameWhiteboardGroup(root, 'G', 'a/b', { by: 'owner' })).rejects.toThrow(WhiteboardValidationError);
    expect(readFileSync(fileOf(a), 'utf-8')).toBe(before);
    await renameWhiteboardGroup(root, 'G', null, { by: 'owner' });
    expect(groupOf(a)).toBeUndefined();
  });

  it('an agent rename skips owner-placed boards and reports them; a retry is idempotent', async () => {
    const owned = createWhiteboard(root, 'owned', '', { group: 'G', by: 'owner' }).slug;
    const agents = createWhiteboard(root, 'agents', '', { group: 'G', by: 'agent' }).slug;
    const r = await renameWhiteboardGroup(root, 'G', 'H', { by: 'agent' });
    expect(r.moved).toEqual([agents]);
    expect(r.failed).toEqual([{ slug: owned, reason: 'owner_grouped' }]);
    const again = await renameWhiteboardGroup(root, 'G', 'H', { by: 'owner' });
    expect(again.moved).toEqual([owned]);
    expect(groupOf(owned)).toBe('H');
  });
});

// ─── routes ─────────────────────────────────────────────────────────────────

function call(
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>,
  opts: { method?: string; params?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  let status = 0;
  let body: unknown = null;
  const res = {
    headersSent: false,
    writeHead(s: number) { status = s; this.headersSent = true; },
    setHeader() {},
    end(data?: string) { body = data ? JSON.parse(data) : null; },
  } as unknown as ServerResponse;
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const req = Object.assign(Readable.from(chunks), {
    method: opts.method ?? 'POST', url: '/', headers: { host: 'localhost:4000' },
  }) as unknown as IncomingMessage;
  return handler(req, res, opts.params ?? {}, root).then(() => ({ status, body }));
}

describe('whiteboard group routes', () => {
  it('PATCH reads keys by presence: {group} alone is a 200, {} a 400, name still renames alone', async () => {
    const { slug } = createWhiteboard(root, 'Board');
    let r = await call(handleWhiteboardRename, { method: 'PATCH', params: { slug }, body: { group: 'G', expectGroup: null } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ slug, group: 'G', name: 'Board' });
    expect(fm(slug)['group-by']).toBe('owner');
    r = await call(handleWhiteboardRename, { method: 'PATCH', params: { slug }, body: {} });
    expect(r.status).toBe(400);
    r = await call(handleWhiteboardRename, { method: 'PATCH', params: { slug }, body: { name: 'Renamed' } });
    expect(r.status).toBe(200);
    expect(groupOf(slug)).toBe('G');
    r = await call(handleWhiteboardRename, { method: 'PATCH', params: { slug }, body: { group: 'H', expectGroup: null } });
    expect(r).toMatchObject({ status: 409, body: { error: 'stale_group' } });
    r = await call(handleWhiteboardRename, { method: 'PATCH', params: { slug }, body: { group: null, expectGroup: 'G' } });
    expect(r.status).toBe(200);
    expect(groupOf(slug)).toBeUndefined();
    r = await call(handleWhiteboardRename, { method: 'PATCH', params: { slug }, body: { group: 'a/b' } });
    expect(r.status).toBe(400);
  });

  it('POST create takes a group; groups/rename answers moved/failed', async () => {
    let r = await call(handleWhiteboardsCreate, { body: { name: 'New', group: 'Tilki' } });
    expect(r).toMatchObject({ status: 201, body: { group: 'Tilki' } });
    r = await call(handleWhiteboardsCreate, { body: { name: 'Bad', group: 5 } });
    expect(r.status).toBe(400);
    r = await call(handleWhiteboardGroupRename, { body: { from: 'Tilki', to: 'Tilki ops' } });
    expect(r).toMatchObject({ status: 200, body: { moved: ['new'], failed: [] } });
    r = await call(handleWhiteboardGroupRename, { body: { from: null, to: 'X' } });
    expect(r.status).toBe(400);
  });
});
