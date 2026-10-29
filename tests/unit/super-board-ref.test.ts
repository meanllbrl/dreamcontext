import { describe, it, expect } from 'vitest';
import { whiteboardSlugOfBoardRef, boardRerouteNote } from '../../src/lib/super/board-ref.js';
import { createProgram } from '../../src/cli/index.js';

// 2026-10-29: `super open board <whiteboard slug>` drew a dead card; the whiteboard's path was refused.
describe('whiteboardSlugOfBoardRef', () => {
  it('reads a slug, a folder or the whiteboard file as the whiteboard', () => {
    expect(whiteboardSlugOfBoardRef('ana-sayfa-tasarimlari')).toBe('ana-sayfa-tasarimlari');
    expect(whiteboardSlugOfBoardRef('_dream_context/whiteboards/ana-sayfa/ana-sayfa.excalidraw.md')).toBe('ana-sayfa');
    expect(whiteboardSlugOfBoardRef('./_dream_context/whiteboards/ana-sayfa/')).toBe('ana-sayfa');
    expect(whiteboardSlugOfBoardRef('whiteboards/ana-sayfa/ana-sayfa.excalidraw.md')).toBe('ana-sayfa');
    expect(whiteboardSlugOfBoardRef('ctx/whiteboards/a/a.excalidraw.md', 'ctx')).toBe('a');
  });

  it('leaves a plain project board file alone', () => {
    expect(whiteboardSlugOfBoardRef('docs/flow.excalidraw.md')).toBeNull();
    expect(whiteboardSlugOfBoardRef('flow.excalidraw.md')).toBeNull();
    expect(whiteboardSlugOfBoardRef('_dream_context/whiteboards/a/other.excalidraw.md')).toBeNull();
    expect(whiteboardSlugOfBoardRef('Docs')).toBeNull();
  });

  it('the note names the right verb', () => {
    expect(boardRerouteNote(['a'])).toContain('super open whiteboard a');
  });
});

describe('super open --help', () => {
  it('says per kind what the ref is: whiteboard a slug, board a file outside whiteboards', () => {
    const open = createProgram().commands.find((c) => c.name() === 'super')!.commands.find((c) => c.name() === 'open')!;
    const help = open.helpInformation();
    expect(help).toMatch(/whiteboard\s+a slug from `dreamcontext whiteboard list`/);
    expect(help).toContain('never board');
    expect(help).toMatch(/board\s+a project \.excalidraw\.md file OUTSIDE _dream_context\/whiteboards\//);
  });
});
