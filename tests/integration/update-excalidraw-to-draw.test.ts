import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { oldBuilder } from '../helpers/old-excalidraw-pack.js';

/**
 * `dreamcontext update` and `install-skill` move a project off the old excalidraw pack through the
 * REAL built CLI, so the wiring is pinned, not just the function: draw is installed first, the
 * retirement runs with this run's draw result, and the stale prune (`--yes`, no TTY) never reaches
 * a file of the old folder. `--packs-only` retires nothing.
 */

const ROOT = join(__dirname, '..', '..');
const CLI = join(ROOT, 'dist', 'index.js');
const DRAW = join(ROOT, 'skill-draw');
const MANIFEST = '_dream_context/state/.install-manifest.json';
const OLD = '.claude/skills/excalidraw';

function run(args: string[], cwd: string, home: string): string {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd, encoding: 'utf-8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, DREAMCONTEXT_BRAIN_SYNC: '0' },
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function tmp(name: string): string {
  const raw = join(tmpdir(), `dc-upd-draw-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function files(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...files(join(dir, d.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** The old pack, rebuilt from skill-draw (see tests/unit/retire-excalidraw.test.ts). */
function plantOldPack(proj: string, o: { shippedBuilder?: boolean } = {}): void {
  const dest = join(proj, OLD);
  mkdirSync(join(dest, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dest, 'reference'), { recursive: true });
  cpSync(join(DRAW, 'scripts', 'lib'), join(dest, 'scripts', 'lib'), { recursive: true });
  const now = readFileSync(join(DRAW, 'scripts', 'build_excalidraw.js'), 'utf-8');
  // Default: a builder the old pack never shipped, so the scripts unit is left as it is.
  // shippedBuilder: the exact 0.41 builder, so every script is forwarded.
  writeFileSync(join(dest, 'scripts', 'build_excalidraw.js'), o.shippedBuilder ? oldBuilder() : `${now}\n// local tweak\n`);
  cpSync(join(DRAW, 'package.json'), join(dest, 'package.json'));
  cpSync(join(DRAW, 'references', 'format.md'), join(dest, 'reference', 'format.md'));
  writeFileSync(join(dest, 'SKILL.md'), '---\nname: excalidraw\n---\nmy own notes\n');
  mkdirSync(join(dest, 'examples'), { recursive: true });
  writeFileSync(join(dest, 'examples', 'mine.excalidraw.md'), 'my board\n');
  const manifest = JSON.parse(readFileSync(join(proj, MANIFEST), 'utf-8'));
  for (const rel of files(dest)) manifest.files[`${OLD}/${rel}`] = { version: '0.41.0', kind: 'pack-skill' };
  manifest.packs.excalidraw = { version: '0.41.0' };
  writeFileSync(join(proj, MANIFEST), JSON.stringify(manifest, null, 2));
}

describe.skipIf(!existsSync(CLI))('update moves the excalidraw pack to draw (integration)', () => {
  let proj: string;
  let home: string;
  beforeEach(() => {
    proj = tmp('proj');
    home = tmp('home');
    run(['init', '--yes', '--name', 'Test', '--description', 'd', '--stack', 'Node', '--priority', 'p'], proj, home);
    run(['install-skill', '--platforms', 'claude'], proj, home);
    plantOldPack(proj);
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('update --packs-only --yes retires nothing and deletes nothing', () => {
    const before = files(join(proj, OLD));
    run(['update', '--packs-only', '--yes'], proj, home);
    expect(files(join(proj, OLD))).toEqual(before);
    const m = JSON.parse(readFileSync(join(proj, MANIFEST), 'utf-8'));
    for (const rel of before) expect(m.files[`${OLD}/${rel}`], rel).toBeDefined();
  }, 120_000);

  it('update --yes installs draw, keeps every edited or foreign file, and is quiet the second time', () => {
    const first = run(['update', '--yes'], proj, home);
    expect(existsSync(join(proj, '.claude', 'skills', 'draw', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, '.claude', 'skills', 'draw', 'scripts', 'build_excalidraw.js'))).toBe(true);
    expect(readFileSync(join(proj, OLD, 'examples', 'mine.excalidraw.md'), 'utf-8')).toBe('my board\n');
    expect(readFileSync(join(proj, OLD, 'SKILL.md.pre-draw'), 'utf-8')).toContain('my own notes');
    expect(existsSync(join(proj, OLD, 'SKILL.md'))).toBe(false);
    expect(existsSync(join(proj, OLD, 'reference', 'format.md'))).toBe(false);
    // One edited script: the whole scripts unit stays exactly as it was.
    expect(readFileSync(join(proj, OLD, 'scripts', 'build_excalidraw.js'), 'utf-8')).toContain('// local tweak');
    expect(readFileSync(join(proj, OLD, 'scripts', 'lib', 'style.js'))).toEqual(readFileSync(join(DRAW, 'scripts', 'lib', 'style.js')));
    expect(first).toContain('excalidraw is now `draw`');
    const m = JSON.parse(readFileSync(join(proj, MANIFEST), 'utf-8'));
    expect(m.packs.excalidraw).toBeUndefined();
    const after1 = files(join(proj, OLD));
    const second = run(['update', '--yes'], proj, home);
    expect(second).not.toContain('excalidraw is now');
    expect(files(join(proj, OLD))).toEqual(after1);
  }, 180_000);

  it('shipped scripts: update --yes forwards them, the old path builds a board, and runs 2 and 3 change nothing', () => {
    rmSync(join(proj, OLD), { recursive: true, force: true });
    plantOldPack(proj, { shippedBuilder: true });
    run(['update', '--yes'], proj, home);
    const shim = readFileSync(join(proj, OLD, 'scripts', 'build_excalidraw.js'), 'utf-8');
    expect(shim).toContain("require('../../draw/scripts/build_excalidraw.js')");
    const spec = join(proj, 'spec.json');
    writeFileSync(spec, JSON.stringify({ elements: [{ type: 'rectangle', x: 0, y: 0, width: 80, height: 40 }] }));
    const built = spawnSync(process.execPath, [join(proj, OLD, 'scripts', 'build_excalidraw.js'), spec, '--out', join(proj, 'x.excalidraw.md')], { cwd: proj, encoding: 'utf-8' });
    expect(built.status, built.stderr).toBe(0);
    rmSync(spec);
    rmSync(join(proj, 'x.excalidraw.md'));
    const disk1 = files(join(proj, OLD)).map((f) => [f, readFileSync(join(proj, OLD, f), 'utf-8')]);
    const old1 = Object.entries(JSON.parse(readFileSync(join(proj, MANIFEST), 'utf-8')).files).filter(([k]) => k.startsWith(`${OLD}/`));
    for (let i = 0; i < 2; i++) {
      const out = run(['update', '--yes'], proj, home);
      expect(out).not.toContain('excalidraw is now');
      expect(files(join(proj, OLD)).map((f) => [f, readFileSync(join(proj, OLD, f), 'utf-8')])).toEqual(disk1);
      const m = JSON.parse(readFileSync(join(proj, MANIFEST), 'utf-8'));
      expect(Object.entries(m.files).filter(([k]) => k.startsWith(`${OLD}/`)).map(([k, v]) => [k, (v as { kind: string }).kind]))
        .toEqual(old1.map(([k, v]) => [k, (v as { kind: string }).kind]));
    }
  }, 240_000);

  it('update --core-only --yes retires too, drops the carried pack records, and is quiet on runs 2 and 3', () => {
    const first = run(['update', '--core-only', '--yes'], proj, home);
    expect(first).toContain('excalidraw is now `draw`');
    expect(readFileSync(join(proj, OLD, 'examples', 'mine.excalidraw.md'), 'utf-8')).toBe('my board\n');
    const m1 = JSON.parse(readFileSync(join(proj, MANIFEST), 'utf-8'));
    expect(m1.packs.excalidraw).toBeUndefined();
    expect(Object.keys(m1.files).filter((k) => k.startsWith(`${OLD}/`) && m1.files[k].kind === 'pack-skill')).toEqual([]);
    const disk1 = files(join(proj, OLD));
    for (let i = 0; i < 2; i++) {
      expect(run(['update', '--core-only', '--yes'], proj, home)).not.toContain('excalidraw is now');
      expect(files(join(proj, OLD))).toEqual(disk1);
    }
  }, 240_000);

  it('install-skill --packs excalidraw says packs are gone and draw is built in', () => {
    const out = run(['install-skill', '--packs', 'excalidraw'], proj, home);
    expect(out).toContain('Skill packs no longer exist');
    expect(out).toContain('draw');
    expect(out).not.toContain('not found');
  }, 60_000);

  it('a plain install-skill retires too, after draw is on disk', () => {
    const r = spawnSync(process.execPath, [CLI, 'install-skill', '--platforms', 'claude'], {
      cwd: proj, encoding: 'utf-8', timeout: 90_000, env: { ...process.env, HOME: home, USERPROFILE: home, DREAMCONTEXT_BRAIN_SYNC: '0' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(proj, '.claude', 'skills', 'draw', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, OLD, 'SKILL.md.pre-draw'))).toBe(true);
    expect(readFileSync(join(proj, OLD, 'examples', 'mine.excalidraw.md'), 'utf-8')).toBe('my board\n');
  }, 120_000);
});
