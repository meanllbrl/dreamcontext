/**
 * `.html`/`.htm` is its own kind (`html`), not a `doc`: the shared reader renders it in the
 * chat's strict sandbox instead of showing its markup as text.
 */
import { describe, it, expect } from 'vitest';
import { agentFileKind } from '../../dashboard/src/lib/agentFileKind.js';

describe('agentFileKind', () => {
  it('returns html for .html and .htm, any case', () => {
    expect(agentFileKind('reports/weekly.html')).toBe('html');
    expect(agentFileKind('reports/WEEKLY.HTM')).toBe('html');
  });
  it('keeps every other kind where it was', () => {
    expect(agentFileKind('boards/x.excalidraw.md')).toBe('board');
    expect(agentFileKind('a.png')).toBe('image');
    expect(agentFileKind('a.mp4')).toBe('video');
    expect(agentFileKind('a.mp3')).toBe('audio');
    expect(agentFileKind('a.pdf')).toBe('pdf');
    expect(agentFileKind('a.md')).toBe('doc');
    expect(agentFileKind('a.svg')).toBe('doc');
    expect(agentFileKind('page.html.md')).toBe('doc');
    expect(agentFileKind('no-extension')).toBe('doc');
  });
});
