/**
 * `show` says what changed since this session last looked, and not what this session did
 * itself (seen.ts). The note is machine-local, under `whiteboards/.locks/`, and keyed by
 * CLAUDE_CODE_SESSION_ID.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWhiteboard, mutateWhiteboard, nextIndices, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import { foldOwnWrite, noteShow } from '../../src/lib/whiteboards/seen.js';
import { makeWidgetElement } from '../../src/lib/whiteboards/widgets.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

let root: string;
const prevSession = process.env.CLAUDE_CODE_SESSION_ID;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'dc-wb-seen-')), '_dream_context');
  createWhiteboard(root, 'Board');
});
afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
  if (prevSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = prevSession;
});

async function addNote(tag: string): Promise<{ id: string; res: Awaited<ReturnType<typeof mutateWhiteboard>> }> {
  let id = '';
  const res = await mutateWhiteboard(root, 'board', (b) => {
    const el = makeWidgetElement('note', { markdown: 'x', tag }, { x: b.elements.length * 400, y: 0 }, nextIndices(b.elements, 1)[0]) as WhiteboardElement;
    id = el.id;
    b.elements.push(el);
  });
  return { id, res };
}

function show() {
  const { board, rev } = readWhiteboard(root, 'board');
  return noteShow(root, 'board', rev, board.elements);
}

describe('show: changed since your last show', () => {
  it('first look, then unchanged, then another session\'s adds by tag', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'agent-a';
    expect(show()).toEqual({ since: null, first: true });
    expect(existsSync(join(root, 'whiteboards', '.locks', 'seen', 'board', 'agent-a.json'))).toBe(true);
    expect(show()).toEqual({ since: null, first: false });

    process.env.CLAUDE_CODE_SESSION_ID = 'agent-b';
    const { id } = await addNote('exp-4092');

    process.env.CLAUDE_CODE_SESSION_ID = 'agent-a';
    const { since } = show();
    expect(since?.added).toEqual([{ id, tag: 'exp-4092' }]);
    expect(since?.changed).toEqual([]);
    expect(since?.removed).toEqual([]);
    expect(show().since).toBeNull();
  });

  it('this session\'s own writes are folded in; someone else\'s in between still shows', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'agent-a';
    show();
    const mine = await addNote('mine');
    foldOwnWrite(root, 'board', { before: mine.res.before, rev: mine.res.rev, elements: mine.res.board.elements }, [mine.id]);
    expect(show().since).toBeNull();

    process.env.CLAUDE_CODE_SESSION_ID = 'agent-b';
    const theirs = await addNote('theirs');
    process.env.CLAUDE_CODE_SESSION_ID = 'agent-a';
    const mine2 = await addNote('mine');
    foldOwnWrite(root, 'board', { before: mine2.res.before, rev: mine2.res.rev, elements: mine2.res.board.elements }, [mine2.id]);
    const { since } = show();
    expect(since?.added).toEqual([{ id: theirs.id, tag: 'theirs' }]);
  });
});
