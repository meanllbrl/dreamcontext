import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWhiteboard, listWhiteboards, renameWhiteboardGroup, whiteboardsDir } from '../../src/lib/whiteboards/store.js';
import {
  GROUP_ORDER_FILE, mergeGroupOrderJson, parseGroupOrder, readGroupOrder, renameInGroupOrder, serializeGroupOrder, writeGroupOrder,
} from '../../src/lib/whiteboards/group-order.js';
import { WhiteboardValidationError } from '../../src/lib/whiteboards/errors.js';
import { classifyPath } from '../../src/lib/git-sync/semantic-merge.js';
import { handleWhiteboardGroupOrderGet, handleWhiteboardGroupOrderPut } from '../../src/server/routes/whiteboards.js';

/** The explorer's group order (`whiteboards/.groups.json`), against a scratch context root. */
let root: string;

beforeEach(() => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-order-')));
  root = join(project, '_dream_context');
  mkdirSync(root);
});
afterEach(() => { rmSync(join(root, '..'), { recursive: true, force: true }); });

const file = () => join(whiteboardsDir(root), GROUP_ORDER_FILE);

describe('group order file', () => {
  it('no file reads as no order; a write lands beside the boards and never shows as a board', async () => {
    expect(readGroupOrder(root)).toEqual([]);
    createWhiteboard(root, 'Board');
    expect(await writeGroupOrder(root, ['Ops', 'Tilki'])).toEqual(['Ops', 'Tilki']);
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toEqual({ order: ['Ops', 'Tilki'] });
    expect(readGroupOrder(root)).toEqual(['Ops', 'Tilki']);
    expect(listWhiteboards(root).map((b) => b.slug)).toEqual(['board']);
  });

  it('a write refuses a bad name instead of dropping it, and keeps one spelling per fold', async () => {
    await expect(writeGroupOrder(root, ['ok', 'a/b'])).rejects.toBeInstanceOf(WhiteboardValidationError);
    await expect(writeGroupOrder(root, ['ok', 3])).rejects.toBeInstanceOf(WhiteboardValidationError);
    await expect(writeGroupOrder(root, 'ok')).rejects.toBeInstanceOf(WhiteboardValidationError);
    expect(await writeGroupOrder(root, ['Satış', 'SATIS', ' Ops '])).toEqual(['Satış', 'Ops']);
  });

  it('a broken or hand-mangled file reads as what is valid in it, never throws', () => {
    expect(parseGroupOrder('not json')).toEqual([]);
    expect(parseGroupOrder('[1,2]')).toEqual([]);
    expect(parseGroupOrder('{"order":["A",4,"a/b","a","B"]}')).toEqual(['A', 'B']);
  });

  it('a symlinked order file is never read nor written through', async () => {
    mkdirSync(whiteboardsDir(root), { recursive: true });
    const outside = join(root, '..', 'outside.json');
    writeFileSync(outside, serializeGroupOrder(['Secret']));
    symlinkSync(outside, file());
    expect(readGroupOrder(root)).toEqual([]);
    await expect(writeGroupOrder(root, ['A'])).rejects.toBeInstanceOf(WhiteboardValidationError);
    expect(readFileSync(outside, 'utf-8')).toBe(serializeGroupOrder(['Secret']));
  });

  it('a renamed group keeps its place; ungroup-all and a merge into a listed group drop the old entry', async () => {
    await writeGroupOrder(root, ['A', 'B', 'C']);
    await renameInGroupOrder(root, 'b', 'Bee');
    expect(readGroupOrder(root)).toEqual(['A', 'Bee', 'C']);
    await renameInGroupOrder(root, 'Bee', 'c');
    expect(readGroupOrder(root)).toEqual(['A', 'C']);
    await renameInGroupOrder(root, 'A', null);
    expect(readGroupOrder(root)).toEqual(['C']);
  });

  it('renameWhiteboardGroup (dashboard and CLI) carries the place over', async () => {
    createWhiteboard(root, 'One', '', { group: 'Alpha', by: 'owner' });
    createWhiteboard(root, 'Two', '', { group: 'Beta', by: 'owner' });
    await writeGroupOrder(root, ['Beta', 'Alpha']);
    await renameWhiteboardGroup(root, 'Beta', 'Gamma', { by: 'owner' });
    expect(readGroupOrder(root)).toEqual(['Gamma', 'Alpha']);
  });
});

describe('two machines reorder at once (brain sync)', () => {
  it('the file has its own merge class', () => {
    expect(classifyPath('whiteboards/.groups.json')).toBe('whiteboard-group-order');
    expect(classifyPath('_dream_context/whiteboards/.groups.json')).toBe('whiteboard-group-order');
  });

  it('ours wins on shared groups; theirs-only additions land after their neighbour; drops stay dropped', () => {
    const base = serializeGroupOrder(['A', 'B', 'C']);
    const ours = serializeGroupOrder(['C', 'A', 'B']);
    const theirs = serializeGroupOrder(['A', 'N', 'C']); // dropped B, added N after A
    expect(parseGroupOrder(mergeGroupOrderJson(base, ours, theirs))).toEqual(['C', 'A', 'N']);
    // From nothing: both sides made the file.
    expect(parseGroupOrder(mergeGroupOrderJson('', serializeGroupOrder(['X']), serializeGroupOrder(['Y', 'X'])))).toEqual(['Y', 'X']);
  });
});

async function call(
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>,
  opts: { method?: string; body?: unknown } = {},
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
    method: opts.method ?? 'GET', url: '/', headers: { host: 'localhost:4000' },
  }) as unknown as IncomingMessage;
  return handler(req, res, {}, root).then(() => ({ status, body }));
}

describe('group order routes', () => {
  it('GET reads, PUT replaces, a bad body is a 400', async () => {
    expect(await call(handleWhiteboardGroupOrderGet)).toEqual({ status: 200, body: { order: [] } });
    expect(await call(handleWhiteboardGroupOrderPut, { method: 'PUT', body: { order: ['B', 'A'] } })).toEqual({ status: 200, body: { order: ['B', 'A'] } });
    expect((await call(handleWhiteboardGroupOrderGet)).body).toEqual({ order: ['B', 'A'] });
    expect((await call(handleWhiteboardGroupOrderPut, { method: 'PUT', body: {} })).status).toBe(400);
    expect((await call(handleWhiteboardGroupOrderPut, { method: 'PUT', body: { order: ['x/y'] } })).status).toBe(400);
    expect((await call(handleWhiteboardGroupOrderGet)).body).toEqual({ order: ['B', 'A'] });
  });
});
