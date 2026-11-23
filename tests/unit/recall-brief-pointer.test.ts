/**
 * A turn that only hands over a brief file ("Read and follow …/brief.md") recalls on the brief's
 * content (memory exam 23 Nov: 72 of 193 missed must files were such turns; the query was the
 * path's words). The read stays inside the vault: no symlink, no `..`, a bounded head.
 * Fixtures name a fictional project ("Orbit").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POINTED_BRIEF_MAX_BYTES, pointedBrief, recallTurn } from '../../src/lib/agents/team-roster.js';
import { readVaultHeadSafe } from '../../src/lib/vault-read.js';

const SERVER = 'If you start a dev server, pin its url (a `dream-view` pin) so the owner sees the site.';
const BRIEF = '# Orbit invoice export: dates in the customer\'s locale\n\n## Why (owner)\nThe PDF shows US dates to Turkish customers.\n';

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brief-ptr-'));
  root = join(dir, '_dream_context');
  mkdirSync(join(root, 'tmp', 'super-prompts', 'fatura-tarih'), { recursive: true });
  writeFileSync(join(root, 'tmp', 'super-prompts', 'fatura-tarih', 'brief.md'), BRIEF);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a turn that points at a brief recalls on the brief', () => {
  it('the relative form of a child first message', () => {
    const t = recallTurn(`${SERVER} Read and follow _dream_context/tmp/super-prompts/fatura-tarih/brief.md`, { root });
    expect(t?.about).toContain('Orbit invoice export');
    expect(t?.words).toBe('Read and follow');
    expect(t?.search.startsWith('Read and follow\n# Orbit invoice export')).toBe(true);
  });

  it('an absolute path into another checkout of the brain reads this vault\'s copy', () => {
    const t = recallTurn(`Brief'i oku ve uygula: /Users/someone/elsewhere/_dream_context/tmp/super-prompts/fatura-tarih/brief.md`, { root });
    expect(t?.about).toContain('US dates to Turkish customers');
  });

  it('without a root, or with a missing file, the turn is as before', () => {
    const msg = 'Read and follow _dream_context/tmp/super-prompts/fatura-tarih/brief.md';
    expect(recallTurn(msg)?.about).toBeNull();
    expect(recallTurn('Read and follow _dream_context/tmp/super-prompts/yok/brief.md', { root })?.about).toBeNull();
  });

  it('a turn that already points at something keeps that subject', () => {
    const t = recallTurn('[About agenda line note=n1 section=waiting]\nline: "Orbit launch checklist"\n\nread _dream_context/tmp/super-prompts/fatura-tarih/brief.md', { root });
    expect(t?.about).toBe('Orbit launch checklist');
  });

  it('an ordinary .md path is not a brief', () => {
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    writeFileSync(join(root, 'knowledge', 'notes.md'), 'Orbit notes');
    expect(pointedBrief('look at _dream_context/knowledge/notes.md', root)).toBeNull();
  });
});

describe('the brief read is safe', () => {
  it('refuses a symlinked brief and a path leaving the vault', () => {
    writeFileSync(join(dir, 'secret.md'), 'outside');
    mkdirSync(join(root, 'tmp', 'super-prompts', 'link'), { recursive: true });
    symlinkSync(join(dir, 'secret.md'), join(root, 'tmp', 'super-prompts', 'link', 'brief.md'));
    expect(pointedBrief('Read and follow _dream_context/tmp/super-prompts/link/brief.md', root)).toBeNull();
    expect(pointedBrief('Read and follow _dream_context/../secret-brief.md', root)).toBeNull();
    expect(pointedBrief('Read and follow ../secret-brief.md', root)).toBeNull();
  });

  it('refuses a symlinked folder on the way', () => {
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out', 'brief.md'), 'outside');
    symlinkSync(join(dir, 'out'), join(root, 'tmp', 'super-prompts', 'via'));
    expect(pointedBrief('Read and follow _dream_context/tmp/super-prompts/via/brief.md', root)).toBeNull();
  });

  it('reads at most the bounded head, never a split character', () => {
    const big = 'ş'.repeat(POINTED_BRIEF_MAX_BYTES);
    writeFileSync(join(root, 'tmp', 'super-prompts', 'fatura-tarih', 'brief.md'), big);
    const head = readVaultHeadSafe(root, 'tmp/super-prompts/fatura-tarih/brief.md', 7);
    expect(head).toBe('şşş');
    const b = pointedBrief('Read and follow _dream_context/tmp/super-prompts/fatura-tarih/brief.md', root);
    expect(Buffer.byteLength(b!.head)).toBeLessThanOrEqual(POINTED_BRIEF_MAX_BYTES);
  });
});
