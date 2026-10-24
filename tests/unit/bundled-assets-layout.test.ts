/**
 * Regression for "the Windows app's bundled CLI deleted every core agent".
 *
 * The desktop app runs the CLI from `<resources>/dist/index.js`, so `findPackageDir('agents')`
 * looks in `<resources>/agents`. The app shipped `dist/` without it: the core-agent install
 * silently skipped, and `update` then read "in the old manifest, not in this install" as
 * "retired" and deleted all twelve project agents. Three guards, one per link of that chain.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

const mocks = vi.hoisted(() => ({ agentsMissing: false }));
vi.mock('../../src/lib/catalog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/catalog.js')>();
  return {
    ...real,
    findPackageDir: (subdir: string, base?: string) =>
      mocks.agentsMissing && subdir === 'agents' ? null : real.findPackageDir(subdir, base),
  };
});

import { findPackageDir } from '../../src/lib/catalog.js';
import { installCoreForPlatform } from '../../src/cli/commands/install-skill.js';
import { relPosix } from '../../src/lib/paths.js';
import { emptyManifest } from '../../src/lib/manifest.js';

const ROOT = join(__dirname, '..', '..');
const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-layout-'));
  scratch.push(d);
  return d;
}
afterEach(() => {
  mocks.agentsMissing = false;
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe('findPackageDir — an app resources layout', () => {
  it('finds <dist>/agents when the package root has no agents/ (tsup copies it there)', () => {
    const res = tmp();
    mkdirSync(join(res, 'dist', 'agents'), { recursive: true });
    expect(findPackageDir('agents', join(res, 'dist') + '/')).toBe(join(res, 'dist', 'agents'));
  });

  it('prefers the package-root copy over the one inside dist', () => {
    const res = tmp();
    mkdirSync(join(res, 'dist', 'agents'), { recursive: true });
    mkdirSync(join(res, 'agents'), { recursive: true });
    expect(findPackageDir('agents', join(res, 'dist') + '/')).toBe(join(res, 'agents'));
  });

  it('is null when neither exists', () => {
    const res = tmp();
    mkdirSync(join(res, 'dist'), { recursive: true });
    expect(findPackageDir('agents', join(res, 'dist') + '/')).toBeNull();
  });
});

describe('installCoreForPlatform — fails closed without agents/', () => {
  it('throws instead of installing nothing, so `update` never reaches the stale-file prune', async () => {
    mocks.agentsMissing = true;
    const project = tmp();
    await expect(installCoreForPlatform('claude', project, emptyManifest())).rejects.toThrow(/agents\/ not found/);
    expect(existsSync(join(project, '.claude', 'agents'))).toBe(false);
  });

  it('with agents/ present it records every core agent under a forward-slash .claude/ key', async () => {
    const project = tmp();
    const manifest = emptyManifest();
    await installCoreForPlatform('claude', project, manifest);
    const keys = Object.keys(manifest.files);
    expect(keys).toContain('.claude/agents/sleep-tasks.md');
    expect(keys).toContain('.claude/agents/dreamcontext-explore.md');
    // No key may be an absolute path or carry a backslash: such a key is outside the safe
    // prefixes, so uninstall and stale-file handling cannot see it.
    expect(keys.filter((k) => /^[A-Za-z]:|\\|^\//.test(k))).toEqual([]);
    expect(keys).toContain('.claude/skills/dreamcontext/SKILL.md');
  });
});

describe('relPosix — Windows path shapes', () => {
  it('turns a backslash join into the forward-slash key the manifest uses', () => {
    expect(relPosix('C:\\Users\\me\\proj', 'C:\\Users\\me\\proj\\.claude\\skills', win32)).toBe('.claude/skills');
  });

  it('works for a OneDrive-style root and a different drive-letter case', () => {
    expect(relPosix('C:\\Users\\me\\OneDrive\\Desktop\\croqi-claude', 'c:\\Users\\me\\OneDrive\\Desktop\\croqi-claude\\.claude\\skills', win32))
      .toBe('.claude/skills');
  });

  it('is unchanged for POSIX paths', () => {
    expect(relPosix('/a/b', '/a/b/.claude/skills')).toBe('.claude/skills');
  });
});

describe('the desktop app ships every directory the npm package does', () => {
  it('lists each directory in package.json `files` as a Tauri resource, mapped to the same name', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { files: string[] };
    const conf = JSON.parse(readFileSync(join(ROOT, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf-8')) as {
      bundle: { resources: Record<string, string> };
    };
    const dirs = pkg.files.filter((f) => existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isDirectory());
    expect(dirs).toContain('agents');
    for (const dir of dirs) {
      expect(conf.bundle.resources[`../../${dir}`], `resource for ${dir}`).toBe(dir);
    }
  });
});

