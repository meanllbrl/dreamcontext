/**
 * Unit tests for `parseChatActions` — the split between what an assistant answer wants the
 * Chat view to READ, to CLICK, and to DRAW.
 *
 * Two things carry real risk here and are pinned hardest:
 *   • the STREAMING path — this runs on every token, and a fence that hasn't closed yet must
 *     be hidden, not shown as raw JSON to the user mid-write;
 *   • the VALIDATION path — a button with no target behind it is a dead end the user still
 *     clicks, so a malformed entry must be dropped rather than rendered inert.
 */
import { describe, it, expect } from 'vitest';
import {
  parseChatActions, parseActionBlock,
} from '../../dashboard/src/components/sleepy/chat/chatActions.js';

const fence = (json: string) => '```dream-actions\n' + json + '\n```';

describe('parseChatActions — actions', () => {
  it('lifts a closed fence out of the prose entirely', () => {
    const text = `Done.\n\n${fence('[{"label":"Open the board","action":"board","path":"a/b.excalidraw.md"}]')}\n\nAnything else?`;
    const r = parseChatActions(text);
    expect(r.actions).toEqual([{ label: 'Open the board', action: 'board', path: 'a/b.excalidraw.md' }]);
    expect(r.body).toBe('Done.\n\nAnything else?');
    expect(r.body).not.toContain('dream-actions');
    expect(r.body).not.toContain('{');
  });

  it('accepts every kind with its own payload field', () => {
    // Split across two parses because the row is capped at 6 (see the cap test below) and
    // there are 7 kinds — the point here is that each kind is honoured, not the cap.
    const entities = parseChatActions(fence(JSON.stringify([
      { label: 'T', action: 'task', id: 'my-task' },
      { label: 'K', action: 'knowledge', id: 'recall-engine-v2' },
      { label: 'C', action: 'core', id: '1.soul.md' },
    ])));
    expect(entities.actions.map((a) => a.action)).toEqual(['task', 'knowledge', 'core']);
    expect(entities.actions[0]).toEqual({ label: 'T', action: 'task', id: 'my-task' });

    const paths = parseChatActions(fence(JSON.stringify([
      { label: 'F', action: 'file', path: 'src/a.ts' },
      { label: 'B', action: 'board', path: 'x.excalidraw.md' },
      { label: 'R', action: 'reveal', path: '/tmp/x.mp4' },
      { label: 'A', action: 'ask', text: 'run npm test' },
    ])));
    expect(paths.actions.map((a) => a.action)).toEqual(['file', 'board', 'reveal', 'ask']);
    expect(paths.actions[3]).toEqual({ label: 'A', action: 'ask', text: 'run npm test' });
  });

  it('drops an entry whose payload is missing — a button with nothing behind it', () => {
    const r = parseChatActions(fence(JSON.stringify([
      { label: 'no id', action: 'task' },
      { label: 'no path', action: 'board' },
      { label: 'blank ask', action: 'ask', text: '   ' },
      { label: 'wrong field', action: 'task', path: 'src/a.ts' },
      { label: 'good', action: 'task', id: 'ok' },
    ])));
    expect(r.actions).toEqual([{ label: 'good', action: 'task', id: 'ok' }]);
  });

  it('drops an unknown action, an empty label, and an over-long label', () => {
    const r = parseChatActions(fence(JSON.stringify([
      { label: 'rm', action: 'exec', path: '/bin/sh' },
      { label: '', action: 'task', id: 'x' },
      { label: 'x'.repeat(81), action: 'task', id: 'x' },
    ])));
    expect(r.actions).toEqual([]);
  });

  it('caps the row so an answer cannot turn into a menu', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, action: 'task', id: `t${i}` }));
    expect(parseChatActions(fence(JSON.stringify(many))).actions).toHaveLength(6);
  });

  it('survives malformed JSON without eating the answer', () => {
    const r = parseChatActions(`Here.\n\n${fence('[{"label": broken')}\n\nTail.`);
    expect(r.actions).toEqual([]);
    // The fence is still removed — half-written JSON is never prose.
    expect(r.body).toBe('Here.\n\nTail.');
  });

  it('accepts a single object as well as an array', () => {
    expect(parseActionBlock('{"label":"T","action":"task","id":"x"}')).toHaveLength(1);
  });

  it('leaves an ordinary code fence completely alone', () => {
    const text = 'Run this:\n\n```bash\nnpm test\n```\n';
    const r = parseChatActions(text);
    expect(r.actions).toEqual([]);
    expect(r.body).toContain('```bash');
    expect(r.body).toContain('npm test');
  });
});

describe('parseChatActions — streaming', () => {
  it('hides a fence that is still being written', () => {
    const partial = 'Done.\n\n```dream-actions\n[{"label":"Open the bo';
    const r = parseChatActions(partial);
    expect(r.body).toBe('Done.');
    expect(r.body).not.toContain('label');
    expect(r.actions).toEqual([]);
  });

  it('hides the fence marker the instant it opens, before any JSON exists', () => {
    expect(parseChatActions('Done.\n\n```dream-actions').body).toBe('Done.');
  });

  it('renders the buttons as soon as the fence closes', () => {
    const done = 'Done.\n\n' + fence('[{"label":"Go","action":"task","id":"t"}]');
    expect(parseChatActions(done).actions).toHaveLength(1);
  });
});

describe('parseChatActions — boards', () => {
  it('extracts an image-syntax board reference and removes it from the prose', () => {
    const r = parseChatActions('Here it is:\n\n![board](docs/launch.excalidraw.md)\n\nDone.');
    expect(r.boards).toEqual(['docs/launch.excalidraw.md']);
    expect(r.body).toBe('Here it is:\n\nDone.');
  });

  it('extracts a link-syntax board reference and a bare .excalidraw file', () => {
    const r = parseChatActions('[the board](a/b.excalidraw) and ![x](c/d.excalidraw.md)');
    expect(r.boards).toEqual(['a/b.excalidraw', 'c/d.excalidraw.md']);
  });

  it('de-duplicates a board named twice', () => {
    const r = parseChatActions('![a](x.excalidraw.md)\n\n![again](x.excalidraw.md)');
    expect(r.boards).toEqual(['x.excalidraw.md']);
  });

  it('leaves an ordinary image alone — that path already renders inline', () => {
    const r = parseChatActions('![shot](docs/shot.png)');
    expect(r.boards).toEqual([]);
    expect(r.body).toContain('docs/shot.png');
  });

  it('handles an answer that is ONLY a board reference', () => {
    const r = parseChatActions('![board](x.excalidraw.md)');
    expect(r.body).toBe('');
    expect(r.boards).toEqual(['x.excalidraw.md']);
  });
});

describe('parseChatActions — empty input', () => {
  it('returns empties for an empty message rather than throwing', () => {
    expect(parseChatActions('')).toEqual({ body: '', actions: [], boards: [] });
  });
});
