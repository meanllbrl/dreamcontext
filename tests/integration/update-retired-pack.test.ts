import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * `dreamcontext update` retires the `engineering` pack through the REAL built CLI, so the
 * wiring is pinned, not just the function: the retired-pack step runs BEFORE the generic
 * stale prune. Were it moved after, `update --yes` would delete a user's edited pack file
 * (the generic prune has no content check) and the unit tests would stay green.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const PACKAGE_REVIEWER = join(__dirname, '..', '..', 'skill-packs', 'agents', 'reviewer.md');
const MANIFEST = '_dream_context/state/.install-manifest.json';

function run(args: string[], cwd: string, home: string): string {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function makeTmpDir(name: string): string {
  const raw = join(tmpdir(), `dc-update-retired-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

describe('update retires the engineering pack (integration)', () => {
  let proj: string;
  let home: string;
  const edited = '.claude/skills/engineering/backend-principles.md';

  beforeEach(() => {
    proj = makeTmpDir('proj');
    home = makeTmpDir('home');
    run(['init', '--yes', '--name', 'Test', '--description', 'd', '--stack', 'Node', '--priority', 'p'], proj, home);
    run(['install-skill', '--platforms', 'claude'], proj, home);
    mkdirSync(join(proj, '.claude/skills/engineering'), { recursive: true });
    writeFileSync(join(proj, edited), '# backend principles\n\n## Our own rule\nAlways use our logger.\n');
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps a tracked, edited pack file under --yes and says so once', () => {
    const manifest = JSON.parse(readFileSync(join(proj, MANIFEST), 'utf-8'));
    manifest.files[edited] = { version: '0.40.5', kind: 'pack-skill' };
    manifest.packs.engineering = { version: '0.40.5' };
    writeFileSync(join(proj, MANIFEST), JSON.stringify(manifest, null, 2));

    const first = run(['update', '--yes'], proj, home);
    expect(existsSync(join(proj, edited))).toBe(true);
    expect(first).toMatch(/Kept 1 file\(s\) in \.claude\/skills\/engineering\/ that differ from what dreamcontext shipped/);
    const after = JSON.parse(readFileSync(join(proj, MANIFEST), 'utf-8'));
    expect(after.files[edited]).toBeUndefined();
    expect(after.packs.engineering).toBeUndefined();

    const second = run(['update', '--yes'], proj, home);
    expect(second).not.toMatch(/engineering/);
    expect(existsSync(join(proj, edited))).toBe(true);
  });

  it('with no manifest (a fresh clone), refreshes a shipped reviewer instead of leaving it stale', () => {
    // A shipped reviewer, as a pre-manifest project would hold it (effort differs: it is
    // outside the canonical form, so the content still proves the file is ours).
    const shipped = readFileSync(PACKAGE_REVIEWER, 'utf-8');
    writeFileSync(join(proj, '.claude/agents/reviewer.md'), shipped.replace(/^effort: high$/m, 'effort: low'));
    rmSync(join(proj, MANIFEST));

    const out = run(['update', '--yes'], proj, home);
    expect(readFileSync(join(proj, '.claude/agents/reviewer.md'), 'utf-8')).toBe(shipped);
    const after = JSON.parse(readFileSync(join(proj, MANIFEST), 'utf-8'));
    expect(after.files['.claude/agents/reviewer.md']).toMatchObject({ kind: 'pack-agent' });
    expect(out).not.toMatch(/legacy file\(s\) detected[\s\S]*reviewer\.md/);
  });
});
