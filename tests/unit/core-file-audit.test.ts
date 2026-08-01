import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  auditCoreFileSizes,
  CORE_FILE_CHAR_CEILING,
  CORE_FILE_LINE_CEILING,
} from '../../src/lib/core-index.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-cfaudit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A short, compliant core file: under both ceilings on either axis. */
const COMPLIANT = '---\nname: x\ntype: soul\n---\n\nShort and useful.\n';

/**
 * Mirrors this repo's real `core/0.soul.md` at the moment the char ceiling was
 * introduced: exactly 13,573 chars across exactly 69 newline-separated segments.
 * 67 lines of 200 chars (199 + '\n') + one line of 173 (172 + '\n') = 13,573,
 * with 68 newlines ⇒ 69 segments. This is THE case a line-only ceiling misses.
 */
const WIDE_SOUL =
  `${'x'.repeat(199)}\n`.repeat(67) + `${'x'.repeat(172)}\n`;

describe('auditCoreFileSizes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, 'core'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes the two ceilings, char-based and line-based', () => {
    expect(CORE_FILE_LINE_CEILING).toBe(150);
    expect(CORE_FILE_CHAR_CEILING).toBe(4_000);
  });

  it('returns [] when neither audited directory exists', () => {
    const other = makeTmpDir();
    expect(auditCoreFileSizes(other)).toEqual([]);
    rmSync(other, { recursive: true, force: true });
  });

  it('returns [] when the core directory is empty', () => {
    expect(auditCoreFileSizes(tmpDir)).toEqual([]);
  });

  it('computes chars and lines for a compliant file and flags neither ceiling', () => {
    writeFileSync(join(tmpDir, 'core', '0.soul.md'), COMPLIANT);

    const audits = auditCoreFileSizes(tmpDir);
    expect(audits).toEqual([
      {
        relPath: '_dream_context/core/0.soul.md',
        chars: COMPLIANT.length,
        lines: COMPLIANT.split('\n').length,
        overChars: false,
        overLines: false,
        // Soul renders verbatim in the snapshot, so its chars ARE a per-session
        // bill — unlike the extended files (3+), which are one index line.
        alwaysLoaded: true,
      },
    ]);
  });

  // The reason CORE_FILE_CHAR_CEILING exists at all: the real 0.soul.md is only
  // 69 lines but 13,573 chars, so a line-only check calls it healthy while the
  // snapshot pays 13.5KB for it every single session.
  it('flags a 69-line / 13,573-char file on chars but NOT on lines', () => {
    // Guard the fixture itself — a construction slip here would silently weaken
    // the one assertion this whole ceiling was introduced for.
    expect(WIDE_SOUL.length).toBe(13_573);
    expect(WIDE_SOUL.split('\n').length).toBe(69);

    writeFileSync(join(tmpDir, 'core', '0.soul.md'), WIDE_SOUL);

    const [audit] = auditCoreFileSizes(tmpDir);
    expect(audit.chars).toBe(13_573);
    expect(audit.lines).toBe(69);
    expect(audit.overChars).toBe(true);
    expect(audit.overLines).toBe(false);
  });

  it('flags the inverse case — many short lines trip lines but not chars', () => {
    const tall = 'a\n'.repeat(200); // 400 chars, 201 segments
    writeFileSync(join(tmpDir, 'core', '2.memory.md'), tall);

    const [audit] = auditCoreFileSizes(tmpDir);
    expect(audit.chars).toBe(400);
    expect(audit.lines).toBe(201);
    expect(audit.overChars).toBe(false);
    expect(audit.overLines).toBe(true);
  });

  it('counts newline-separated segments, so a trailing newline adds one', () => {
    writeFileSync(join(tmpDir, 'core', '0.soul.md'), 'a\nb\n');
    writeFileSync(join(tmpDir, 'core', '1.user.md'), 'a\nb');

    const audits = auditCoreFileSizes(tmpDir);
    expect(audits.map((a) => a.lines)).toEqual([3, 2]);
  });

  it('covers soul, user, memory and the extended files, sorted numerically', () => {
    for (const name of ['0.soul.md', '1.user.md', '2.memory.md', '3.style.md', '10.architecture.md']) {
      writeFileSync(join(tmpDir, 'core', name), COMPLIANT);
    }

    const audits = auditCoreFileSizes(tmpDir);
    expect(audits.map((a) => a.relPath)).toEqual([
      '_dream_context/core/0.soul.md',
      '_dream_context/core/1.user.md',
      '_dream_context/core/2.memory.md',
      '_dream_context/core/3.style.md',
      '_dream_context/core/10.architecture.md',
    ]);
  });

  it('skips .json payloads even when they are enormous', () => {
    writeFileSync(join(tmpDir, 'core', '9.custom_data.json'), `[${'"x",'.repeat(5_000)}"x"]`);
    writeFileSync(join(tmpDir, 'core', 'CHANGELOG.json'), '[]');
    writeFileSync(join(tmpDir, 'core', '3.style.md'), COMPLIANT);

    const audits = auditCoreFileSizes(tmpDir);
    expect(audits.map((a) => a.relPath)).toEqual(['_dream_context/core/3.style.md']);
  });

  it('skips non-markdown siblings and unnumbered files', () => {
    writeFileSync(join(tmpDir, 'core', '5.data_structures.sql'), 'CREATE TABLE t();\n');
    writeFileSync(join(tmpDir, 'core', 'notes.md'), COMPLIANT);
    writeFileSync(join(tmpDir, 'core', '4.tech_stack.md'), COMPLIANT);

    const audits = auditCoreFileSizes(tmpDir);
    expect(audits.map((a) => a.relPath)).toEqual(['_dream_context/core/4.tech_stack.md']);
  });

  it('skips an unreadable file instead of throwing, and still reports its siblings', (ctx) => {
    const blocked = join(tmpDir, 'core', '3.blocked.md');
    writeFileSync(blocked, COMPLIANT);
    writeFileSync(join(tmpDir, 'core', '4.readable.md'), COMPLIANT);
    chmodSync(blocked, 0o000);

    // Root ignores the mode bits, so there is nothing to exercise there. Probe
    // rather than assume, so this either tests the branch or says why it didn't.
    let stillReadable = false;
    try {
      readFileSync(blocked, 'utf-8');
      stillReadable = true;
    } catch { /* expected: the mode bits hold */ }
    if (stillReadable) ctx.skip();

    let audits: ReturnType<typeof auditCoreFileSizes> = [];
    expect(() => { audits = auditCoreFileSizes(tmpDir); }).not.toThrow();
    expect(audits.map((a) => a.relPath)).toEqual(['_dream_context/core/4.readable.md']);
  });

  it('does not throw when a numbered path is a directory rather than a file', () => {
    mkdirSync(join(tmpDir, 'core', '6.notes.md'), { recursive: true });
    writeFileSync(join(tmpDir, 'core', '0.soul.md'), COMPLIANT);

    let audits: ReturnType<typeof auditCoreFileSizes> = [];
    expect(() => { audits = auditCoreFileSizes(tmpDir); }).not.toThrow();
    expect(audits.map((a) => a.relPath)).toEqual(['_dream_context/core/0.soul.md']);
  });

  // ─── people/ ──────────────────────────────────────────────────────────────
  // Person constitutions earn the same ceiling on the same grounds: the ACTIVE
  // one is never-evict and renders verbatim on every session, so an oversized
  // constitution is a content problem the demotion ladder cannot absorb. This is
  // also what lets the snapshot's over-budget banner NAME the file — the audited
  // path set is the banner's only source of names.

  it('audits people/*.md at the same ceiling, after the core files', () => {
    mkdirSync(join(tmpDir, 'people'), { recursive: true });
    writeFileSync(join(tmpDir, 'core', '0.soul.md'), COMPLIANT);
    writeFileSync(join(tmpDir, 'people', 'ada.md'), COMPLIANT);
    writeFileSync(join(tmpDir, 'people', 'bob.md'), WIDE_SOUL);

    const audits = auditCoreFileSizes(tmpDir);
    expect(audits.map((a) => a.relPath)).toEqual([
      '_dream_context/core/0.soul.md',
      '_dream_context/people/ada.md',
      '_dream_context/people/bob.md',
    ]);
    expect(audits[1].overChars).toBe(false);
    expect(audits[2].chars).toBe(13_573);
    expect(audits[2].overChars).toBe(true);
    expect(audits[2].overLines).toBe(false);
  });

  it('skips people/people.json — a roster is data, not prose under a ceiling', () => {
    mkdirSync(join(tmpDir, 'people'), { recursive: true });
    writeFileSync(join(tmpDir, 'people', 'people.json'), `{"version":1,"people":{${'"x":1,'.repeat(2_000)}"y":2}}`);
    writeFileSync(join(tmpDir, 'people', 'ada.md'), COMPLIANT);

    expect(auditCoreFileSizes(tmpDir).map((a) => a.relPath)).toEqual(['_dream_context/people/ada.md']);
  });

  it('audits people/ even when core/ is absent, and vice versa', () => {
    rmSync(join(tmpDir, 'core'), { recursive: true, force: true });
    mkdirSync(join(tmpDir, 'people'), { recursive: true });
    writeFileSync(join(tmpDir, 'people', 'ada.md'), COMPLIANT);

    expect(auditCoreFileSizes(tmpDir).map((a) => a.relPath)).toEqual(['_dream_context/people/ada.md']);
  });

  it('returns [] when neither directory exists', () => {
    rmSync(join(tmpDir, 'core'), { recursive: true, force: true });
    expect(auditCoreFileSizes(tmpDir)).toEqual([]);
  });
});
