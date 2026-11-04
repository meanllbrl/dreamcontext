/**
 * A retired skill pack leaves a project on `update` by content, never by absence: a file that is
 * exactly what we shipped goes; an edited one stays, untracked, and the user is told once. An
 * agent the pack used to install that still ships elsewhere is kept (refreshed when unedited),
 * so a project that only had `engineering` keeps its `reviewer`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneRetiredPacks, RETIRED_PACKS, type RetiredPack } from '../../src/lib/retired-packs.js';
import { emptyManifest, recordFile, type Manifest } from '../../src/lib/manifest.js';
import { agentBaselineSha } from '../../src/lib/sleep-specialist-frontmatter.js';

const PACKS_DIR = join(__dirname, '..', '..', 'skill-packs');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const SHIPPED = { 'SKILL.md': '# base v1\n', 'sub/ref.md': '# ref\n' };
const FAKE: RetiredPack = {
  name: 'oldpack',
  retired: '2026-11-04',
  replacedBy: 'its rules now live inside the agents',
  shipped: {
    'SKILL.md': [sha('# base v0\n'), sha(SHIPPED['SKILL.md'])],
    'sub/ref.md': [sha(SHIPPED['sub/ref.md'])],
  },
  keepAgents: ['reviewer'],
};

let root: string;
let oldM: Manifest;
let newM: Manifest;

function put(rel: string, content: string, track = true): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (track) recordFile(oldM, rel, '0.40.0', rel.includes('/agents/') ? 'pack-agent' : 'pack-skill');
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-retired-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  root = realpathSync(raw);
  oldM = emptyManifest();
  newM = emptyManifest();
  oldM.packs.oldpack = { version: '0.40.0' };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pruneRetiredPacks', () => {
  it('removes an unmodified copy (any shipped version), its folder, and every manifest trace', () => {
    put('.claude/skills/oldpack/SKILL.md', '# base v0\n');
    put('.claude/skills/oldpack/sub/ref.md', SHIPPED['sub/ref.md']);
    const r = pruneRetiredPacks(root, oldM, newM, PACKS_DIR, [FAKE]);
    expect(r.removed.sort()).toEqual(['.claude/skills/oldpack/SKILL.md', '.claude/skills/oldpack/sub/ref.md']);
    expect(r.kept).toEqual([]);
    expect(existsSync(join(root, '.claude/skills/oldpack'))).toBe(false);
    expect(Object.keys(oldM.files)).toEqual([]);
    expect(oldM.packs.oldpack).toBeUndefined();
    expect(r.notes).toEqual(['Removed the retired oldpack skill pack: its rules now live inside the agents.']);
  });

  it('keeps an edited file and an unknown one, untracks them, and says so only once', () => {
    put('.claude/skills/oldpack/SKILL.md', '# base v1\nmy own rule\n');
    put('.claude/skills/oldpack/sub/ref.md', SHIPPED['sub/ref.md']);
    put('.claude/skills/oldpack/mine.md', '# mine\n', false);
    const first = pruneRetiredPacks(root, oldM, newM, PACKS_DIR, [FAKE]);
    expect(first.removed).toEqual(['.claude/skills/oldpack/sub/ref.md']);
    expect(first.kept.sort()).toEqual(['.claude/skills/oldpack/SKILL.md', '.claude/skills/oldpack/mine.md']);
    expect(readFileSync(join(root, '.claude/skills/oldpack/SKILL.md'), 'utf-8')).toContain('my own rule');
    expect(Object.keys(oldM.files)).toEqual([]); // the generic prune can no longer offer it
    expect(first.notes.join('\n')).toMatch(/Kept 1 edited file\(s\) in \.claude\/skills\/oldpack\/: the oldpack pack is retired/);

    // The next update: nothing tracked any more, so no second note and nothing deleted.
    const second = pruneRetiredPacks(root, oldM, emptyManifest(), PACKS_DIR, [FAKE]);
    expect(second.removed).toEqual([]);
    expect(second.notes).toEqual([]);
    expect(existsSync(join(root, '.claude/skills/oldpack/SKILL.md'))).toBe(true);
  });

  it('never follows a symlinked pack folder', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'SKILL.md'), SHIPPED['SKILL.md']);
    mkdirSync(join(root, '.claude/skills'), { recursive: true });
    symlinkSync(elsewhere, join(root, '.claude/skills/oldpack'), 'dir');
    const r = pruneRetiredPacks(root, oldM, newM, PACKS_DIR, [FAKE]);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(elsewhere, 'SKILL.md'))).toBe(true);
    expect(r.notes.join('\n')).toMatch(/symlink/);
  });

  it('keeps and refreshes the reviewer when the retired pack was its only installer', () => {
    put('.claude/agents/reviewer.md', '---\nname: reviewer\n---\nold body\n');
    oldM.files['.claude/agents/reviewer.md'].baselineSha = agentBaselineSha('---\nname: reviewer\n---\nold body\n');
    pruneRetiredPacks(root, oldM, newM, PACKS_DIR, [FAKE]);
    const now = readFileSync(join(root, '.claude/agents/reviewer.md'), 'utf-8');
    expect(now).toBe(readFileSync(join(PACKS_DIR, 'agents', 'reviewer.md'), 'utf-8'));
    expect(newM.files['.claude/agents/reviewer.md']).toMatchObject({ kind: 'pack-agent', baselineSha: agentBaselineSha(now) });
  });

  it('leaves an edited reviewer as it is, still tracked', () => {
    put('.claude/agents/reviewer.md', '---\nname: reviewer\n---\nmy edits\n');
    oldM.files['.claude/agents/reviewer.md'].baselineSha = agentBaselineSha('---\nname: reviewer\n---\noriginal\n');
    pruneRetiredPacks(root, oldM, newM, PACKS_DIR, [FAKE]);
    expect(readFileSync(join(root, '.claude/agents/reviewer.md'), 'utf-8')).toContain('my edits');
    expect(newM.files['.claude/agents/reviewer.md']).toEqual(oldM.files['.claude/agents/reviewer.md']);
  });

  it('does not touch the reviewer another pack installed this run', () => {
    put('.claude/agents/reviewer.md', 'current\n');
    recordFile(newM, '.claude/agents/reviewer.md', '0.40.6', 'pack-agent', { baselineSha: 'x' });
    pruneRetiredPacks(root, oldM, newM, PACKS_DIR, [FAKE]);
    expect(readFileSync(join(root, '.claude/agents/reviewer.md'), 'utf-8')).toBe('current\n');
    expect(newM.files['.claude/agents/reviewer.md'].baselineSha).toBe('x');
  });

  it('is a no-op on a project that never had the pack', () => {
    delete oldM.packs.oldpack;
    const r = pruneRetiredPacks(root, oldM, newM, PACKS_DIR, [FAKE]);
    expect(r).toEqual({ removed: [], kept: [], notes: [] });
  });
});

describe('the engineering entry', () => {
  it('lists all 16 files the pack shipped, each with a sha256, and keeps the reviewer', () => {
    const eng = RETIRED_PACKS.find((p) => p.name === 'engineering');
    expect(eng).toBeDefined();
    expect(Object.keys(eng!.shipped)).toHaveLength(16);
    for (const hashes of Object.values(eng!.shipped)) for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(eng!.keepAgents).toEqual(['reviewer']);
    expect(existsSync(join(PACKS_DIR, 'agents', 'reviewer.md'))).toBe(true);
  });
});
