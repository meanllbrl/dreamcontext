/**
 * Unit tests for the folder-listing helpers behind the Chat file panel (issue #236).
 *
 * The panel used to model only the text/markdown answers of `GET /api/agent/file`, so a
 * FOLDER — which that route has always answered with a listing — reached the text renderer
 * with no `content` and threw mid-render, blanking the whole chat view. These are the pure
 * parts of the listing that replaced it: joining a child path (the agent writes folder paths
 * with and without a trailing slash), the size column, and the "not everything is here" note.
 */
import { describe, it, expect } from 'vitest';
import {
  joinChildPath, formatEntrySize, dirTruncationNote,
} from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

describe('joinChildPath', () => {
  it('joins with exactly one separator, trailing slash or not', () => {
    expect(joinChildPath('_dream_context/knowledge/legal', 'nda.md')).toBe('_dream_context/knowledge/legal/nda.md');
    expect(joinChildPath('_dream_context/knowledge/legal/', 'nda.md')).toBe('_dream_context/knowledge/legal/nda.md');
    expect(joinChildPath('_dream_context/knowledge/legal///', 'nda.md')).toBe('_dream_context/knowledge/legal/nda.md');
  });

  it('handles an absolute folder and a nested child name', () => {
    expect(joinChildPath('/Users/me/app/src/', 'lib')).toBe('/Users/me/app/src/lib');
    expect(joinChildPath('/', 'etc')).toBe('/etc');
  });
});

describe('formatEntrySize', () => {
  it('reads bytes below a kilobyte as bytes', () => {
    expect(formatEntrySize(0)).toBe('0 B');
    expect(formatEntrySize(310)).toBe('310 B');
    expect(formatEntrySize(1023)).toBe('1023 B');
  });

  it('steps up a unit at a time, one decimal only while it still reads', () => {
    expect(formatEntrySize(1024)).toBe('1.0 KB');
    expect(formatEntrySize(1434)).toBe('1.4 KB');
    expect(formatEntrySize(1024 * 20)).toBe('20 KB');
    expect(formatEntrySize(1024 * 1024 * 2.1)).toBe('2.1 MB');
    expect(formatEntrySize(1024 ** 3 * 3)).toBe('3.0 GB');
  });

  it('says nothing for a size the server did not report (a subfolder)', () => {
    expect(formatEntrySize(null)).toBe('');
    expect(formatEntrySize(undefined)).toBe('');
    expect(formatEntrySize(Number.NaN)).toBe('');
    expect(formatEntrySize(-1)).toBe('');
  });
});

describe('dirTruncationNote', () => {
  it('is silent when the whole folder is on screen', () => {
    expect(dirTruncationNote(12, 12, false)).toBeNull();
    expect(dirTruncationNote(12)).toBeNull();
  });

  it('names what was cut when the server capped the listing', () => {
    expect(dirTruncationNote(300, 812, true)).toBe('Showing 300 of 812 entries');
    expect(dirTruncationNote(300, undefined, true)).toBe('Showing the first 300 entries');
  });

  it('speaks up on a total larger than the rows, even without the flag', () => {
    expect(dirTruncationNote(300, 812)).toBe('Showing 300 of 812 entries');
  });
});
