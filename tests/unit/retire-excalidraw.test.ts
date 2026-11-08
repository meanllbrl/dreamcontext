import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pruneStaleFiles } from '../../src/cli/commands/update.js';
import { guardedFileSha, installDrawSkill, type GuardedInstallResult } from '../../src/lib/core-guarded-skill.js';
import { emptyManifest, recordFile, type Manifest } from '../../src/lib/manifest.js';
import { EXCALIDRAW_SHIPPED_SHAS } from '../../src/lib/retired-packs/excalidraw.js';
import { excalidrawKeptShas, excalidrawShimText, retireExcalidraw } from '../../src/lib/retired-packs.js';

/**
 * The excalidraw pack became the core `draw` skill (2026-11-08). Pinned: an old install keeps
 * every edited or foreign file and nothing is overwritten; the old script path keeps working for
 * `require()` and `node <path>`; one edited script leaves the whole `scripts/` alone; nothing is
 * retired unless draw is our current bytes in the same run; the stale prune can never delete an
 * excalidraw file on a path that did not retire; runs 2 and 3 change nothing.
 */

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

const ROOT = join(__dirname, '..', '..');
const DRAW = join(ROOT, 'skill-draw');
const SKILLS = '.claude/skills';
const OLD = `${SKILLS}/excalidraw`;

/**
 * The old pack as 0.41.x installed it, rebuilt from skill-draw: every file but the builder is the
 * same bytes; the builder differs only by its command block (now `main`). Each file is checked
 * against the retired pack's shipped table, so a drift fails here, never silently.
 */
const OLD_TAIL = `module.exports = { buildExcalidraw, lane, grid, thumbHeight, SPEC_TYPES, LAYOUT_TYPES };

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  let specPath = null, out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else specPath = args[i];
  }
  if (!specPath) { console.error('usage: node build_excalidraw.js <spec.json> [--out <path.excalidraw.md>]'); process.exit(1); }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (out) spec.out = out;
  const res = buildExcalidraw(spec);
  console.log(\`OK  \${res.outPath}\\n    elements=\${res.elements} images=\${res.images} texts=\${res.texts} overlaps=\${res.overlaps} buriedText=\${res.buriedText} longLines=\${res.longLines} wallOfText=\${res.wallOfText}\\n    vaultRoot=\${res.vaultRoot}\`);
}
`;
function oldBuilder(): string {
  const now = readFileSync(join(DRAW, 'scripts', 'build_excalidraw.js'), 'utf-8');
  const cut = now.indexOf('// ---------- CLI ----------');
  return (now.slice(0, cut) + OLD_TAIL).replace('(see ../references/format.md)', '(see ../reference/format.md)');
}

/** Write the old pack into `<proj>/.claude/skills/excalidraw/` and its manifest records. */
function plantOldPack(proj: string, m: Manifest | null, skillMd = '---\nname: excalidraw\n---\nmy own notes\n'): void {
  const dest = join(proj, OLD);
  mkdirSync(join(dest, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dest, 'reference'), { recursive: true });
  cpSync(join(DRAW, 'scripts', 'lib'), join(dest, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(dest, 'scripts', 'build_excalidraw.js'), oldBuilder());
  cpSync(join(DRAW, 'package.json'), join(dest, 'package.json'));
  cpSync(join(DRAW, 'examples'), join(dest, 'examples'), { recursive: true, filter: (s) => !s.endsWith('.excalidraw.md') });
  cpSync(join(DRAW, 'references', 'format.md'), join(dest, 'reference', 'format.md'));
  writeFileSync(join(dest, 'SKILL.md'), skillMd);
  // The user's own things in the folder (this brain has both).
  writeFileSync(join(dest, 'examples', 'mine.excalidraw.md'), 'my board\n');
  mkdirSync(join(dest, '.claude'), { recursive: true });
  writeFileSync(join(dest, '.claude', 'settings.local.json'), '{}\n');
  if (m) {
    for (const rel of listFiles(dest)) recordFile(m, `${OLD}/${rel}`, '0.41.0', 'pack-skill');
    m.packs.excalidraw = { version: '0.41.0' } as never;
  }
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...listFiles(join(dir, d.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const rel of listFiles(dir)) out[rel] = guardedFileSha(readFileSync(join(dir, rel)));
  return out;
}

/** One update run as `update` does it: draw install, then the retirement, then the stale prune (--yes, no TTY). */
async function updateRun(proj: string, old: Manifest, o: { packsOnly?: boolean; table?: Record<string, readonly string[]> } = {}): Promise<{ next: Manifest; notes: string[] }> {
  const next = emptyManifest();
  if (o.packsOnly) {
    for (const [p, e] of Object.entries(old.files)) if (e.kind === 'core') next.files[p] = e;
  }
  let draw: GuardedInstallResult | null = null;
  if (!o.packsOnly) {
    draw = installDrawSkill(DRAW, proj, SKILLS, old);
    for (const w of draw.written) recordFile(next, w.rel, '0.42.0', 'core', { baselineSha: w.baselineSha });
    for (const k of draw.kept) if (k.reason !== 'not-ours') recordFile(next, k.rel, '0.42.0', 'core', k.baselineSha ? { baselineSha: k.baselineSha } : undefined);
  }
  const r = retireExcalidraw(proj, SKILLS, draw, old, next, o.table ? { table: o.table } : {});
  const pruned = await pruneStaleFiles(proj, old, next, false, true);
  for (const p of pruned.keep) if (old.files[p] && !next.files[p]) next.files[p] = old.files[p];
  return { next, notes: r.notes };
}

describe('the rebuilt old pack is what 0.41 shipped', () => {
  it('every rebuilt file matches the retired table', () => {
    expect(EXCALIDRAW_SHIPPED_SHAS['scripts/build_excalidraw.js']).toContain(guardedFileSha(oldBuilder()));
    for (const f of readdirSync(join(DRAW, 'scripts', 'lib'))) {
      expect(EXCALIDRAW_SHIPPED_SHAS[`scripts/lib/${f}`] ?? [], f).toContain(guardedFileSha(readFileSync(join(DRAW, 'scripts', 'lib', f))));
    }
    expect(EXCALIDRAW_SHIPPED_SHAS['package.json']).toContain(guardedFileSha(readFileSync(join(DRAW, 'package.json'))));
    expect(EXCALIDRAW_SHIPPED_SHAS['reference/format.md']).toContain(guardedFileSha(readFileSync(join(DRAW, 'references', 'format.md'))));
    expect(EXCALIDRAW_SHIPPED_SHAS['examples/sample.png']).toContain(guardedFileSha(readFileSync(join(DRAW, 'examples', 'sample.png'))));
  });
});

describe('retireExcalidraw', () => {
  let proj: string;
  beforeEach(() => {
    proj = realpathSync(mkdtempSync(join(tmpdir(), 'dc-retire-excalidraw-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('retires: shipped files go, scripts forward, the edited SKILL.md and user files stay', async () => {
    const old = emptyManifest();
    plantOldPack(proj, old);
    const { next, notes } = await updateRun(proj, old);
    const dir = join(proj, OLD);
    expect(existsSync(join(dir, 'reference', 'format.md'))).toBe(false);
    expect(existsSync(join(dir, 'examples', 'sample.png'))).toBe(false);
    expect(existsSync(join(dir, 'examples', 'chart_board.js'))).toBe(false);
    expect(readFileSync(join(dir, 'examples', 'mine.excalidraw.md'), 'utf-8')).toBe('my board\n');
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(true);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(false);
    expect(readFileSync(join(dir, 'SKILL.md.pre-draw'), 'utf-8')).toContain('my own notes');
    expect(readFileSync(join(dir, 'scripts', 'build_excalidraw.js'), 'utf-8')).toBe(excalidrawShimText('scripts/build_excalidraw.js'));
    expect(readFileSync(join(dir, 'scripts', 'lib', 'style.js'), 'utf-8')).toBe(excalidrawShimText('scripts/lib/style.js'));
    expect(readFileSync(join(dir, 'package.json'))).toEqual(readFileSync(join(DRAW, 'package.json')));
    expect(existsSync(join(dir, 'scripts', 'lib', 'fractional-indexing.LICENSE'))).toBe(true);
    // Only the forwarding unit stays tracked, as core; nothing else of the old folder, no pack record.
    const tracked = Object.keys(next.files).filter((r) => r.startsWith(`${OLD}/`)).sort();
    expect(tracked.every((r) => /\/(scripts\/|package\.json)/.test(r))).toBe(true);
    expect(tracked).toContain(`${OLD}/scripts/build_excalidraw.js`);
    expect(next.files[`${OLD}/scripts/build_excalidraw.js`]?.kind).toBe('core');
    expect(next.packs.excalidraw).toBeUndefined();
    expect(notes.join('\n')).toContain('excalidraw is now `draw`');
    expect(notes.join('\n')).toContain('SKILL.md.pre-draw');
  });

  it('the old path still builds a board: node <old path> and require() from a "type":"module" project', async () => {
    const old = emptyManifest();
    plantOldPack(proj, old);
    await updateRun(proj, old);
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'p', type: 'module' }));
    const spec = join(proj, 'spec.json');
    writeFileSync(spec, JSON.stringify({ elements: [{ type: 'rectangle', x: 0, y: 0, width: 100, height: 60 }] }));
    const out = join(proj, 'boards', 'x.excalidraw.md');
    mkdirSync(join(proj, 'boards'));
    const r = spawnSync(process.execPath, [join(proj, OLD, 'scripts', 'build_excalidraw.js'), spec, '--out', out], { encoding: 'utf-8', cwd: proj });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(out, 'utf-8')).toContain('excalidraw-plugin');
    const req = createRequire(join(proj, 'pipeline.js'));
    const builder = req(join(proj, OLD, 'scripts', 'build_excalidraw.js')) as { buildExcalidraw: (s: unknown) => { elements: number } };
    const style = req(join(proj, OLD, 'scripts', 'lib', 'style.js')) as { card: unknown };
    expect(typeof builder.buildExcalidraw).toBe('function');
    expect(typeof style.card).toBe('function');
  });

  it('three runs: identical files and manifest after the first, no repeated note', async () => {
    const old = emptyManifest();
    plantOldPack(proj, old);
    const first = await updateRun(proj, old);
    const disk1 = snapshot(proj);
    const second = await updateRun(proj, structuredClone(first.next));
    const third = await updateRun(proj, structuredClone(second.next));
    expect(snapshot(proj)).toEqual(disk1);
    expect(second.next.files).toEqual(first.next.files);
    expect(third.next.files).toEqual(first.next.files);
    expect(second.notes).toEqual([]);
    expect(third.notes).toEqual([]);
  });

  it('with no manifest at all, the same decisions by content, and quiet afterwards', async () => {
    plantOldPack(proj, null);
    const first = await updateRun(proj, emptyManifest());
    expect(existsSync(join(proj, OLD, 'reference', 'format.md'))).toBe(false);
    expect(readFileSync(join(proj, OLD, 'scripts', 'lib', 'style.js'), 'utf-8')).toBe(excalidrawShimText('scripts/lib/style.js'));
    expect(existsSync(join(proj, OLD, 'SKILL.md.pre-draw'))).toBe(true);
    expect(first.notes.join('\n')).toContain('excalidraw is now `draw`');
    const again = await updateRun(proj, emptyManifest());
    expect(again.notes).toEqual([]);
  });

  it('one edited script leaves the whole scripts/ (and package.json) exactly as it was', async () => {
    const old = emptyManifest();
    plantOldPack(proj, old);
    writeFileSync(join(proj, OLD, 'scripts', 'lib', 'style.js'), '// my style\n');
    const before = snapshot(join(proj, OLD, 'scripts'));
    const pkg = readFileSync(join(proj, OLD, 'package.json'));
    const { next, notes } = await updateRun(proj, old);
    expect(snapshot(join(proj, OLD, 'scripts'))).toEqual(before);
    expect(readFileSync(join(proj, OLD, 'package.json'))).toEqual(pkg);
    expect(Object.keys(next.files).some((r) => r.startsWith(`${OLD}/scripts/`))).toBe(false);
    expect(notes.join('\n')).toContain('scripts/lib/style.js is edited');
  });

  it('a shipped SKILL.md goes; an existing .pre-draw is never overwritten (.pre-draw.2)', async () => {
    const shippedSkill = '---\nname: excalidraw\n---\nshipped\n';
    const table = { ...EXCALIDRAW_SHIPPED_SHAS, 'SKILL.md': [guardedFileSha(shippedSkill)] };
    const old = emptyManifest();
    plantOldPack(proj, old, shippedSkill);
    await updateRun(proj, old, { table });
    expect(existsSync(join(proj, OLD, 'SKILL.md'))).toBe(false);
    expect(existsSync(join(proj, OLD, 'SKILL.md.pre-draw'))).toBe(false);

    rmSync(join(proj, OLD), { recursive: true, force: true });
    const old2 = emptyManifest();
    plantOldPack(proj, old2, 'edited twice\n');
    writeFileSync(join(proj, OLD, 'SKILL.md.pre-draw'), 'the first kept copy\n');
    await updateRun(proj, old2);
    expect(readFileSync(join(proj, OLD, 'SKILL.md.pre-draw'), 'utf-8')).toBe('the first kept copy\n');
    expect(readFileSync(join(proj, OLD, 'SKILL.md.pre-draw.2'), 'utf-8')).toBe('edited twice\n');
  });

  it('a filesystem without hard links: SKILL.md stays and the note names the second skill', () => {
    const old = emptyManifest();
    plantOldPack(proj, old);
    const draw = installDrawSkill(DRAW, proj, SKILLS, null);
    const eperm = (): never => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    const r = retireExcalidraw(proj, SKILLS, draw, old, emptyManifest(), { link: eperm });
    expect(readFileSync(join(proj, OLD, 'SKILL.md'), 'utf-8')).toContain('my own notes');
    expect(r.notes.join('\n')).toContain('a second `excalidraw` skill stays');
  });

  it('a symlinked SKILL.md is left alone and named', () => {
    plantOldPack(proj, null);
    rmSync(join(proj, OLD, 'SKILL.md'));
    writeFileSync(join(proj, 'elsewhere.md'), 'x\n');
    symlinkSync(join(proj, 'elsewhere.md'), join(proj, OLD, 'SKILL.md'));
    const draw = installDrawSkill(DRAW, proj, SKILLS, null);
    const r = retireExcalidraw(proj, SKILLS, draw, emptyManifest(), emptyManifest());
    expect(readFileSync(join(proj, 'elsewhere.md'), 'utf-8')).toBe('x\n');
    expect(r.notes.join('\n')).toContain('SKILL.md is a symlink');
  });

  it('a file already at the staging name is never overwritten, and that script is kept', () => {
    plantOldPack(proj, null);
    const target = join(proj, OLD, 'scripts', 'lib', 'style.js');
    writeFileSync(`${target}.tmp-${process.pid}`, 'someone else\n');
    const draw = installDrawSkill(DRAW, proj, SKILLS, null);
    retireExcalidraw(proj, SKILLS, draw, emptyManifest(), emptyManifest());
    expect(readFileSync(`${target}.tmp-${process.pid}`, 'utf-8')).toBe('someone else\n');
    expect(readFileSync(target)).toEqual(readFileSync(join(DRAW, 'scripts', 'lib', 'style.js')));
  });

  it("a crashed run's staged forwarding file is cleaned on the next run", () => {
    plantOldPack(proj, null);
    const leftover = join(proj, OLD, 'scripts', 'lib', 'style.js.tmp-99999');
    writeFileSync(leftover, excalidrawShimText('scripts/lib/style.js'));
    const draw = installDrawSkill(DRAW, proj, SKILLS, null);
    retireExcalidraw(proj, SKILLS, draw, emptyManifest(), emptyManifest());
    expect(existsSync(leftover)).toBe(false);
    expect(readFileSync(join(proj, OLD, 'scripts', 'lib', 'style.js'), 'utf-8')).toBe(excalidrawShimText('scripts/lib/style.js'));
  });

  it('a script the user deleted is not brought back', () => {
    plantOldPack(proj, null);
    rmSync(join(proj, OLD, 'scripts', 'lib', 'wireframe.js'));
    const draw = installDrawSkill(DRAW, proj, SKILLS, null);
    retireExcalidraw(proj, SKILLS, draw, emptyManifest(), emptyManifest());
    expect(existsSync(join(proj, OLD, 'scripts', 'lib', 'wireframe.js'))).toBe(false);
  });

  it('every forwarding file and kept non-script is ours by hash', () => {
    const kept = excalidrawKeptShas();
    expect(kept['scripts/build_excalidraw.js']).toEqual([guardedFileSha(excalidrawShimText('scripts/build_excalidraw.js'))]);
    expect(kept['scripts/lib/fractional-indexing.LICENSE']).toEqual(EXCALIDRAW_SHIPPED_SHAS['scripts/lib/fractional-indexing.LICENSE']);
    expect(kept['package.json']).toEqual(EXCALIDRAW_SHIPPED_SHAS['package.json']);
    expect(kept['SKILL.md']).toBeUndefined();
  });

  it('a file vanishing mid-walk (a second pane) does not abort the run', () => {
    plantOldPack(proj, null);
    const draw = installDrawSkill(DRAW, proj, SKILLS, null);
    // A shipped file already gone (removed by a second pane) is skipped, never an abort.
    rmSync(join(proj, OLD, 'examples', 'sample.png'));
    expect(() => retireExcalidraw(proj, SKILLS, draw, emptyManifest(), emptyManifest())).not.toThrow();
  });
});

describe('stale-prune safety: a path that does not retire deletes nothing and keeps every record', () => {
  let proj: string;
  beforeEach(() => {
    proj = realpathSync(mkdtempSync(join(tmpdir(), 'dc-retire-excalidraw-safe-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function expectUntouched(run: (old: Manifest) => Promise<{ next: Manifest }>): Promise<void> {
    const old = emptyManifest();
    plantOldPack(proj, old);
    const tracked = Object.keys(old.files).filter((r) => r.startsWith(`${OLD}/`));
    const before = snapshot(join(proj, OLD));
    const { next } = await run(old);
    expect(snapshot(join(proj, OLD))).toEqual(before);
    for (const rel of tracked) expect(next.files[rel], rel).toBeDefined();
  }

  it('(a) update --packs-only --yes', async () => {
    await expectUntouched((old) => updateRun(proj, old, { packsOnly: true }));
  });

  it('(b) update --yes with draw/ symlinked', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dc-draw-out-'));
    try {
      mkdirSync(join(proj, SKILLS), { recursive: true });
      symlinkSync(outside, join(proj, SKILLS, 'draw'));
      await expectUntouched((old) => updateRun(proj, old));
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('(c) update --yes with an empty table', async () => {
    await expectUntouched((old) => updateRun(proj, old, { table: {} }));
  });

  it("(d) update --yes with a user's own draw/SKILL.md", async () => {
    mkdirSync(join(proj, SKILLS, 'draw'), { recursive: true });
    writeFileSync(join(proj, SKILLS, 'draw', 'SKILL.md'), '---\nname: draw\n---\nmine\n');
    await expectUntouched(async (old) => {
      old.files[`${SKILLS}/dreamcontext/SKILL.md`] = { version: '0.41.0', kind: 'core' };
      return updateRun(proj, old);
    });
    expect(readFileSync(join(proj, SKILLS, 'draw', 'SKILL.md'), 'utf-8')).toContain('mine');
  });

  it('a linked .claude/skills: nothing touched', async () => {
    const real = join(proj, 'real-skills');
    mkdirSync(join(proj, '.claude'), { recursive: true });
    mkdirSync(real);
    symlinkSync(real, join(proj, SKILLS));
    const old = emptyManifest();
    plantOldPack(proj, old);
    const before = snapshot(join(real, 'excalidraw'));
    const draw = installDrawSkill(DRAW, proj, SKILLS, old);
    const next = emptyManifest();
    const r = retireExcalidraw(proj, SKILLS, draw, old, next);
    expect(snapshot(join(real, 'excalidraw'))).toEqual(before);
    expect(Object.keys(next.files).filter((k) => k.startsWith(`${OLD}/`)).length).toBe(Object.keys(old.files).filter((k) => k.startsWith(`${OLD}/`)).length);
    expect(r.notes.join('\n')).toContain('symlink');
  });

  it('an edited-but-ours draw/SKILL.md (recorded baseline) still retires', async () => {
    const first = installDrawSkill(DRAW, proj, SKILLS, null);
    const recorded = emptyManifest();
    for (const w of first.written) recordFile(recorded, w.rel, '0.42.0', 'core', { baselineSha: w.baselineSha });
    writeFileSync(join(proj, SKILLS, 'draw', 'SKILL.md'), '---\nname: draw\n---\nmy tuned router\n');
    plantOldPack(proj, recorded);
    await updateRun(proj, recorded);
    expect(readFileSync(join(proj, OLD, 'scripts', 'lib', 'style.js'), 'utf-8')).toBe(excalidrawShimText('scripts/lib/style.js'));
  });

  it('linkSync is the real default (hard links are supported here)', () => {
    writeFileSync(join(proj, 'a'), 'a');
    linkSync(join(proj, 'a'), join(proj, 'b'));
    expect(readFileSync(join(proj, 'b'), 'utf-8')).toBe('a');
  });
});
