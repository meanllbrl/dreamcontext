/**
 * Tests for computeUsedAssetsChanged (src/cli/commands/asset-drift.ts) against a
 * real temp project + the repo's real core skills. Verifies the content
 * check that scopes the SessionStart drift nag:
 *   - disk matches what the CLI would install  → false (no nag-worthy change)
 *   - an installed asset was modified on disk   → true
 *   - an installed asset is missing on disk      → true
 * Hooks (settings.json) and `_dream_context/` machine-state are excluded.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, appendFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeUsedAssetsChanged } from '../../src/cli/commands/asset-drift.js';
import { installCoreForPlatform } from '../../src/cli/commands/install-skill.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-asset-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

// computeUsedAssetsChanged only reads platforms.
const CONFIG = { platforms: ['claude'] } as unknown as SetupConfig;

let projectRoot: string;

beforeEach(async () => {
  // Installer chatter would otherwise flood test output.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  projectRoot = makeTmpDir();
  // Install exactly the canonical asset set this project "uses".
  await installCoreForPlatform('claude', projectRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('computeUsedAssetsChanged', () => {
  it('is false when on-disk assets match what the current CLI would install', async () => {
    await expect(computeUsedAssetsChanged(projectRoot, CONFIG)).resolves.toBe(false);
  });

  it('is true when an installed asset was modified on disk', async () => {
    const skill = join(projectRoot, '.claude', 'skills', 'council', 'SKILL.md');
    expect(existsSync(skill)).toBe(true);
    appendFileSync(skill, '\n<!-- local drift -->\n', 'utf-8');
    await expect(computeUsedAssetsChanged(projectRoot, CONFIG)).resolves.toBe(true);
  });

  it('is true when an installed asset is missing on disk', async () => {
    const skill = join(projectRoot, '.claude', 'skills', 'council', 'SKILL.md');
    rmSync(skill, { force: true });
    await expect(computeUsedAssetsChanged(projectRoot, CONFIG)).resolves.toBe(true);
  });

  it('ignores an unused/extra skill the project has but does not install', async () => {
    // An extra skill on disk that dreamcontext does not ship must not flip the verdict:
    // that is the whole point, unused additional skills never trigger the nag.
    mkdirSync(join(projectRoot, '.claude', 'skills', 'growth'), { recursive: true });
    appendFileSync(join(projectRoot, '.claude', 'skills', 'growth', 'SKILL.md'), '# growth\n', 'utf-8');
    await expect(computeUsedAssetsChanged(projectRoot, CONFIG)).resolves.toBe(false);
  });
});
