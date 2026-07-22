import { describe, it, expect } from 'vitest';
import { splitConflictMarkers } from '../../src/lib/task-backend/conflict-markers.js';

/**
 * B4 — the raw marker parser Task B needs because `readOursTheirsBase`
 * (git-sync/git.ts) reads git INDEX STAGES during an active merge; it cannot
 * parse literal `<<<<<<<` markers already baked into committed file bytes,
 * which is exactly the corrupt-map / dedup-heal scenario (#204).
 */
describe('splitConflictMarkers', () => {
  it('returns null when the text has no conflict markers', () => {
    expect(splitConflictMarkers('plain text\nno markers here\n')).toBeNull();
    expect(splitConflictMarkers('')).toBeNull();
  });

  it('splits a single two-way hunk (no diff3 base section)', () => {
    const text = [
      'line before',
      '<<<<<<< HEAD',
      'ours line',
      '=======',
      'theirs line',
      '>>>>>>> branch-b',
      'line after',
    ].join('\n');

    const result = splitConflictMarkers(text);
    expect(result).not.toBeNull();
    expect(result!.ours).toBe(['line before', 'ours line', 'line after'].join('\n'));
    expect(result!.theirs).toBe(['line before', 'theirs line', 'line after'].join('\n'));
  });

  it('discards the diff3 ||||||| base section (belongs to neither side)', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours line',
      '||||||| merged common ancestors',
      'base line — must not appear on either side',
      '=======',
      'theirs line',
      '>>>>>>> branch-b',
    ].join('\n');

    const result = splitConflictMarkers(text)!;
    expect(result.ours).toBe('ours line');
    expect(result.theirs).toBe('theirs line');
    expect(result.ours).not.toContain('base line');
    expect(result.theirs).not.toContain('base line');
  });

  it('handles multiple conflict hunks in one file', () => {
    const text = [
      'shared start',
      '<<<<<<< HEAD',
      'ours-1',
      '=======',
      'theirs-1',
      '>>>>>>> branch-b',
      'shared middle',
      '<<<<<<< HEAD',
      'ours-2',
      '=======',
      'theirs-2',
      '>>>>>>> branch-b',
      'shared end',
    ].join('\n');

    const result = splitConflictMarkers(text)!;
    expect(result.ours).toBe(['shared start', 'ours-1', 'shared middle', 'ours-2', 'shared end'].join('\n'));
    expect(result.theirs).toBe(['shared start', 'theirs-1', 'shared middle', 'theirs-2', 'shared end'].join('\n'));
  });

  it('tolerates arbitrary branch labels after the 7-char marker token', () => {
    const text = [
      '<<<<<<< some/weird label with spaces (2026-07-22)',
      'ours line',
      '||||||| some base label',
      'discarded',
      '=======',
      'theirs line',
      '>>>>>>> another/weird_label',
    ].join('\n');

    const result = splitConflictMarkers(text)!;
    expect(result.ours).toBe('ours line');
    expect(result.theirs).toBe('theirs line');
  });

  it('appends shared context outside any hunk to BOTH sides', () => {
    const text = ['context 1', 'context 2', '<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> b', 'context 3'].join('\n');
    const result = splitConflictMarkers(text)!;
    expect(result.ours).toBe(['context 1', 'context 2', 'x', 'context 3'].join('\n'));
    expect(result.theirs).toBe(['context 1', 'context 2', 'y', 'context 3'].join('\n'));
  });
});
