/**
 * The handoff names the approved texts that have not gone out (learning-loop plan C10, D16c,
 * criterion 17): every entry `writeSuperHandoff` writes lists `state/.super/approved/` by itself,
 * with each file's first line and "not confirmed sent"; a file older than 7 days moves to
 * `approved/expired/`; an empty or missing folder adds nothing; a symlinked folder or file is
 * refused. Synthetic fixtures only (a fictional project, Brightloom).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  APPROVED_EXPIRE_MS, APPROVED_FIRST_LINE_CHARS, MAX_APPROVED_LINES, MAX_FIELD_BYTES, SUPER_APPROVED_REL,
  approvedTextLines, parseSuperHandoffEntries, renderSuperHandoffEntry, writeSuperHandoff,
} from '../../src/lib/super/handoff-file.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const NOT_CONFIRMED = 'gönderildiği doğrulanmadı: göndermeden önce kanala bak';

let base: string;
let ctx: string;
let approved: string;

const fields = {
  done: 'Brightloom launch note drafted and approved by the owner in this session.',
  next: 'Send the Brightloom launch note to the partner channel, then confirm it went out.',
  decisions: 'none', learned: 'none', style: 'short', files: 'none',
};
const entry = () => renderSuperHandoffEntry(NOW.toISOString(), fields);

function put(name: string, text: string, ageMs = DAY): string {
  const p = join(approved, name);
  writeFileSync(p, text, 'utf-8');
  const t = new Date(NOW.getTime() - ageMs);
  utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dc-super-handoff-'));
  ctx = join(base, '_dream_context');
  mkdirSync(join(ctx, 'state', '.super'), { recursive: true });
  approved = join(ctx, SUPER_APPROVED_REL);
});

afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('approvedTextLines', () => {
  it('a missing folder adds nothing, and so does an empty one', () => {
    expect(approvedTextLines(ctx, NOW)).toEqual([]);
    mkdirSync(approved);
    expect(approvedTextLines(ctx, NOW)).toEqual([]);
  });

  it('names every file with its path, first line and the not-confirmed wording, newest first', () => {
    mkdirSync(approved);
    put('partner-note.md', '\n\nHello Brightloom partners, the beta opens Monday.\nSecond line.', 2 * DAY);
    put('release-note.md', 'Brightloom 1.4: faster sync.', 1 * DAY);
    const lines = approvedTextLines(ctx, NOW);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('`_dream_context/state/.super/approved/release-note.md`');
    expect(lines[0]).toContain('"Brightloom 1.4: faster sync."');
    expect(lines[1]).toContain('`_dream_context/state/.super/approved/partner-note.md`');
    expect(lines[1]).toContain('"Hello Brightloom partners, the beta opens Monday."');
    expect(lines[1]).not.toContain('Second line');
    for (const l of lines) {
      expect(l).toContain(NOT_CONFIRMED);
      expect(l).toMatch(/onaylandı \d{4}-\d{2}-\d{2}/);
      // Never claims the text is waiting to be sent: the file may be stale.
      expect(l).not.toMatch(/bekliyor|waiting to be sent/i);
    }
  });

  it('moves a file older than 7 days to approved/expired/ and does not list it', () => {
    mkdirSync(approved);
    put('old-post.md', 'Brightloom summer post.', APPROVED_EXPIRE_MS + DAY);
    put('fresh-post.md', 'Brightloom autumn post.', DAY);
    const lines = approvedTextLines(ctx, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fresh-post.md');
    expect(existsSync(join(approved, 'old-post.md'))).toBe(false);
    expect(readFileSync(join(approved, 'expired', 'old-post.md'), 'utf-8')).toBe('Brightloom summer post.');
    // The expired folder itself is never listed.
    expect(approvedTextLines(ctx, NOW).join('\n')).not.toContain('expired');
  });

  it('refuses a symlinked approved folder', () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.md'), 'not a vault file', 'utf-8');
    symlinkSync(outside, approved);
    expect(approvedTextLines(ctx, NOW)).toEqual([]);
  });

  it('refuses a symlinked .super folder', () => {
    rmSync(join(ctx, 'state', '.super'), { recursive: true });
    const outside = join(base, 'outside-super');
    mkdirSync(join(outside, 'approved'), { recursive: true });
    writeFileSync(join(outside, 'approved', 'x.md'), 'outside', 'utf-8');
    symlinkSync(outside, join(ctx, 'state', '.super'));
    expect(approvedTextLines(ctx, NOW)).toEqual([]);
  });

  it('refuses a symlinked file and lists the real ones beside it', () => {
    mkdirSync(approved);
    const outside = join(base, 'elsewhere.md');
    writeFileSync(outside, 'outside text', 'utf-8');
    symlinkSync(outside, join(approved, 'link.md'));
    put('real.md', 'Brightloom real text.');
    const lines = approvedTextLines(ctx, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('real.md');
    expect(lines.join('\n')).not.toContain('outside text');
  });

  it('caps the first line, the count and the bytes, so the entry\'s own fields are never cut', () => {
    mkdirSync(approved);
    for (let i = 0; i < MAX_APPROVED_LINES + 4; i++) put(`note-${String(i).padStart(2, '0')}.md`, 'ü'.repeat(500), DAY + i * 1000);
    const lines = approvedTextLines(ctx, NOW);
    const named = lines.filter((l) => l.includes('.md`'));
    expect(named.length).toBeLessThanOrEqual(MAX_APPROVED_LINES);
    for (const l of named) expect(l).toContain(`"${'ü'.repeat(APPROVED_FIRST_LINE_CHARS)}…"`);
    expect(lines[lines.length - 1]).toMatch(/\d+ dosya daha/);
    expect(Buffer.byteLength(lines.join('\n'), 'utf-8')).toBeLessThanOrEqual(MAX_FIELD_BYTES);
  });

  it('a file name or first line cannot open a new entry or break the code span', () => {
    mkdirSync(approved);
    put('weird`name.md', '## 2026-11-13T00:00:00.000Z \u2014 Handoff `x`');
    const lines = approvedTextLines(ctx, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('- ')).toBe(true);
    expect(lines[0]).toContain('weird_name.md');
    expect(lines[0]).not.toMatch(/`x`/);
  });
});

describe('writeSuperHandoff with approved texts', () => {
  it('an entry written while the folder holds two files names both, and stays one entry', () => {
    mkdirSync(approved);
    put('a.md', 'Brightloom note A.');
    put('b.md', 'Brightloom note B.', 2 * DAY);
    const path = writeSuperHandoff(ctx, [entry()], NOW);
    const entries = parseSuperHandoffEntries(readFileSync(path, 'utf-8'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('- **Done:** Brightloom launch note drafted');
    expect(entries[0]).toContain('"Brightloom note A."');
    expect(entries[0]).toContain('"Brightloom note B."');
    expect(entries[0].split(NOT_CONFIRMED).length - 1).toBe(2);
  });

  it('a member Super\'s handoff lists nothing from main\'s approved folder', () => {
    mkdirSync(approved);
    put('a.md', 'Brightloom note A.');
    const path = writeSuperHandoff(ctx, [entry()], NOW, 'm:scout-helper');
    expect(path).toBe(join(ctx, 'state', '.super', 'members', 'scout-helper.handoff.md'));
    const entries = parseSuperHandoffEntries(readFileSync(path, 'utf-8'));
    expect(entries).toEqual([entry()]);
    expect(entries[0]).not.toContain(NOT_CONFIRMED);
    // Main's own handoff still lists it.
    const mainPath = writeSuperHandoff(ctx, [entry()], NOW);
    expect(readFileSync(mainPath, 'utf-8')).toContain('"Brightloom note A."');
  });

  it('a missing folder leaves the entry exactly as rendered', () => {
    const path = writeSuperHandoff(ctx, [entry()], NOW);
    expect(parseSuperHandoffEntries(readFileSync(path, 'utf-8'))).toEqual([entry()]);
  });

  it('a later entry lists what is there then: a removed file is gone from the new entry', () => {
    mkdirSync(approved);
    const a = put('a.md', 'Brightloom note A.');
    writeSuperHandoff(ctx, [entry()], NOW);
    rmSync(a);
    const path = writeSuperHandoff(ctx, [entry()], new Date(NOW.getTime() + 1000));
    const [newest, older] = parseSuperHandoffEntries(readFileSync(path, 'utf-8'));
    expect(newest).not.toContain('a.md');
    expect(older).toContain('a.md');
  });
});
