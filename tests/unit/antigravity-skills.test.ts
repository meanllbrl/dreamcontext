/**
 * Our skills in an Antigravity profile: fake HOME only. The folder T3 links to the real
 * `~/.gemini` is replaced by a real one, and nothing is ever written through that link.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityProfileDir } from '../../src/lib/antigravity-accounts.js';
import { syncAntigravitySkills } from '../../src/lib/antigravity-skills.js';
import { TOOL_SKILL_SOURCES } from '../../src/lib/tool-skills.js';

const ROOT = resolve(import.meta.dirname, '../..');
const repo = (sub: string): string | null => join(ROOT, sub);

describe('syncAntigravitySkills', () => {
  let home: string;
  let skills: (id?: string) => string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-agy-skills-'));
    skills = (id = 'primary') => join(antigravityProfileDir(id, home), 'config', 'skills');
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('puts every core skill where the agent reads it, per account, and touches no project', () => {
    const project = join(home, 'project');
    mkdirSync(project);
    const r = syncAntigravitySkills('primary', { home, packageDir: repo });
    expect(r).toMatchObject({ ok: true });
    for (const name of ['dreamcontext', 'curator', 'patterns', 'design', 'draw']) expect(existsSync(join(skills(), name, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skills(), 'dreamcontext', 'references'))).toBe(true);
    // draw carries its builder and its binary example as they ship.
    expect(readFileSync(join(skills(), 'draw', 'scripts', 'lib', 'style.js'))).toEqual(readFileSync(join(ROOT, 'skill-draw', 'scripts', 'lib', 'style.js')));
    expect(readFileSync(join(skills(), 'draw', 'examples', 'sample.png'))).toEqual(readFileSync(join(ROOT, 'skill-draw', 'examples', 'sample.png')));
    expect(readdirSync(project)).toEqual([]);
    expect(existsSync(skills('acct-two'))).toBe(false);
    syncAntigravitySkills('acct-two', { home, packageDir: repo });
    expect(existsSync(join(skills('acct-two'), 'dreamcontext', 'SKILL.md'))).toBe(true);
  });

  it("replaces T3's link with a real folder and writes nothing through it", () => {
    const own = join(home, '.gemini', 'config', 'skills');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'keep.txt'), 'the owner');
    mkdirSync(join(own, 'my-skill'));
    writeFileSync(join(own, 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n');
    mkdirSync(join(skills(), '..'), { recursive: true });
    symlinkSync(own, skills(), 'dir');
    expect(syncAntigravitySkills('primary', { home, packageDir: repo })).toMatchObject({ ok: true });
    expect(lstatSync(skills()).isDirectory()).toBe(true);
    expect(lstatSync(skills()).isSymbolicLink()).toBe(false);
    expect(readdirSync(own).sort()).toEqual(['keep.txt', 'my-skill']);
    // The owner's own skill stays readable, by a link of its own.
    expect(lstatSync(join(skills(), 'my-skill')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(skills(), 'my-skill', 'SKILL.md'))).toBe(true);
  });

  it('a link whose target went is taken away; the owner’s folder is never written', () => {
    const own = join(home, '.gemini', 'config', 'skills');
    mkdirSync(join(own, 'gone'), { recursive: true });
    syncAntigravitySkills('primary', { home, packageDir: repo });
    expect(lstatSync(join(skills(), 'gone')).isSymbolicLink()).toBe(true);
    rmSync(join(own, 'gone'), { recursive: true });
    syncAntigravitySkills('primary', { home, packageDir: repo });
    expect(() => lstatSync(join(skills(), 'gone'))).toThrow();
  });

  it('refreshes after an update, repairs a missing skill, and drops only what it wrote', () => {
    const pkg = join(home, 'pkg');
    const make = (sub: string, body: string): void => {
      mkdirSync(join(pkg, sub), { recursive: true });
      writeFileSync(join(pkg, sub, 'SKILL.md'), `---\nname: ${sub === 'skill' ? 'dreamcontext' : sub.replace('skill-', '')}\n---\n${body}`);
    };
    for (const s of TOOL_SKILL_SOURCES) make(s, 'v1');
    const packageDir = (sub: string): string => join(pkg, sub);
    syncAntigravitySkills('primary', { home, packageDir });
    mkdirSync(join(skills(), 'agent-made'));
    const before = readFileSync(join(skills(), '.dreamcontext-skills.json'), 'utf-8');
    syncAntigravitySkills('primary', { home, packageDir });
    expect(readFileSync(join(skills(), '.dreamcontext-skills.json'), 'utf-8')).toBe(before);
    make('skill', 'v2');
    syncAntigravitySkills('primary', { home, packageDir });
    expect(readFileSync(join(skills(), 'dreamcontext', 'SKILL.md'), 'utf-8')).toContain('v2');
    rmSync(join(skills(), 'curator'), { recursive: true });
    syncAntigravitySkills('primary', { home, packageDir });
    expect(existsSync(join(skills(), 'curator', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skills(), 'agent-made'))).toBe(true);
  });

  it('never follows a symlink out of the package, and reports instead of throwing', () => {
    const pkg = join(home, 'pkg');
    for (const s of TOOL_SKILL_SOURCES) {
      mkdirSync(join(pkg, s), { recursive: true });
      writeFileSync(join(pkg, s, 'SKILL.md'), `---\nname: ${s.replace('skill-', 'x-')}\n---\n`);
    }
    writeFileSync(join(home, 'secret'), 'token');
    symlinkSync(join(home, 'secret'), join(pkg, 'skill-sync', 'leak'));
    expect(syncAntigravitySkills('primary', { home, packageDir: (s) => join(pkg, s) })).toMatchObject({ ok: true });
    expect(existsSync(join(skills(), 'x-sync', 'leak'))).toBe(false);
    expect(syncAntigravitySkills('primary', { home, packageDir: () => null })).toMatchObject({ ok: false });
  });

  it('never writes through a link planted as its record, and replaces the link', () => {
    syncAntigravitySkills('primary', { home, packageDir: repo });
    const victim = join(home, 'victim.txt');
    writeFileSync(victim, 'precious');
    rmSync(join(skills(), '.dreamcontext-skills.json'));
    symlinkSync(victim, join(skills(), '.dreamcontext-skills.json'));
    expect(syncAntigravitySkills('primary', { home, packageDir: repo })).toMatchObject({ ok: true });
    expect(readFileSync(victim, 'utf-8')).toBe('precious');
    expect(lstatSync(join(skills(), '.dreamcontext-skills.json')).isSymbolicLink()).toBe(false);
  });

  it.each(['null', '{"digest":"x","names":"abc"}', '{"digest":"x","names":[1]}', 'not json'])('a damaged record (%s) heals and never throws', (body) => {
    syncAntigravitySkills('primary', { home, packageDir: repo });
    writeFileSync(join(skills(), '.dreamcontext-skills.json'), body);
    expect(syncAntigravitySkills('primary', { home, packageDir: repo })).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(skills(), '.dreamcontext-skills.json'), 'utf-8')).names).toContain('dreamcontext');
  });

  it("one broken entry in the owner's folder hides none of the others", () => {
    const own = join(home, '.gemini', 'config', 'skills');
    mkdirSync(join(own, 'a-skill'), { recursive: true });
    mkdirSync(join(own, 'z-skill'));
    symlinkSync(join(home, 'nowhere'), join(own, 'm-broken'));
    expect(syncAntigravitySkills('primary', { home, packageDir: repo })).toMatchObject({ ok: true });
    expect(lstatSync(join(skills(), 'a-skill')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(skills(), 'z-skill')).isSymbolicLink()).toBe(true);
  });

  it('a skill it wrote that left the list is removed; a name it never wrote is not', () => {
    syncAntigravitySkills('primary', { home, packageDir: repo });
    mkdirSync(join(skills(), 'retired'));
    mkdirSync(join(skills(), 'not-ours'));
    const m = JSON.parse(readFileSync(join(skills(), '.dreamcontext-skills.json'), 'utf-8'));
    writeFileSync(join(skills(), '.dreamcontext-skills.json'), JSON.stringify({ digest: 'old', names: [...m.names, 'retired'] }));
    syncAntigravitySkills('primary', { home, packageDir: repo });
    expect(existsSync(join(skills(), 'retired'))).toBe(false);
    expect(existsSync(join(skills(), 'not-ours'))).toBe(true);
  });

  it('refuses a profile whose config folder is a link', () => {
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(antigravityProfileDir('primary', home), { recursive: true });
    symlinkSync(elsewhere, join(antigravityProfileDir('primary', home), 'config'), 'dir');
    expect(syncAntigravitySkills('primary', { home, packageDir: repo })).toMatchObject({ ok: false });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('takes the second folder off the real .gemini too, keeping what is there in reach', () => {
    const profile = antigravityProfileDir('primary', home);
    const real = join(home, '.gemini', 'antigravity-cli', 'skills');
    mkdirSync(join(real, 'owners-skill'), { recursive: true });
    mkdirSync(join(profile, 'antigravity-cli'), { recursive: true });
    symlinkSync(real, join(profile, 'antigravity-cli', 'skills'));
    expect(syncAntigravitySkills('primary', { home, packageDir: repo }).ok).toBe(true);
    const second = join(profile, 'antigravity-cli', 'skills');
    expect(lstatSync(second).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(second, 'owners-skill')).isSymbolicLink()).toBe(true);
  });
});
