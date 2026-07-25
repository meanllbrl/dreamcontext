/**
 * Unit tests for `looksLikePath` — the gate that decides whether a backticked span in an
 * answer becomes a clickable chip.
 *
 * The asymmetry matters: a missed path costs a click the user makes by hand, but a FALSE
 * positive is a button that opens nothing (a shell fragment, a branch name), which is worse.
 * So most of these pin what must NOT become clickable.
 */
import { describe, it, expect } from 'vitest';
import { looksLikePath } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

describe('looksLikePath — the way an answer actually names files', () => {
  it('accepts a project-relative source path', () => {
    expect(looksLikePath('src/server/routes/agent-chat.ts')).toBe(true);
    expect(looksLikePath('dashboard/src/components/sleepy/ChatPane.tsx')).toBe(true);
    expect(looksLikePath('_dream_context/state/my-task.md')).toBe(true);
  });

  it('accepts a `./`-prefixed path and a folder (which the file endpoint lists)', () => {
    expect(looksLikePath('./scripts/build.js')).toBe(true);
    expect(looksLikePath('src/server/routes/')).toBe(true);
  });

  it('tolerates surrounding whitespace from the DOM text node', () => {
    expect(looksLikePath('  src/a.ts  ')).toBe(true);
  });
});

describe('looksLikePath — what must stay inert', () => {
  it('rejects a bare filename with no directory', () => {
    expect(looksLikePath('package.json')).toBe(false);
  });

  it('rejects a command, which is what most backticks in an answer hold', () => {
    expect(looksLikePath('npm run build')).toBe(false);
    expect(looksLikePath('git push --force')).toBe(false);
  });

  it('rejects a URL — that is a link, not a file to preview', () => {
    expect(looksLikePath('https://example.com/a/b.ts')).toBe(false);
    expect(looksLikePath('file:///etc/passwd')).toBe(false);
  });

  it('rejects prose and identifiers that merely contain a slash', () => {
    expect(looksLikePath('and/or')).toBe(false);       // no extension, no trailing slash
    expect(looksLikePath('feat/inline-boards')).toBe(false);
    expect(looksLikePath('')).toBe(false);
  });

  it('rejects an over-long span rather than making a wall of text clickable', () => {
    expect(looksLikePath(`${'a/'.repeat(120)}b.ts`)).toBe(false);
  });

  it('rejects an extension too long to be one', () => {
    expect(looksLikePath('a/b.thisisnotanextension')).toBe(false);
  });
});
