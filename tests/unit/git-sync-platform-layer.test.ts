import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PLATFORM_GITIGNORE_ENTRIES,
  healPlatformLinks,
  healPlatformLinksBestEffort,
  platformLayerStatus,
  setupPlatformLayer,
} from '../../src/lib/git-sync/platform-layer.js';
import { buildBrainGitignore, ensureLocalOnlyArtifacts } from '../../src/lib/git-sync/brain-repo.js';

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-platform-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function stateOf(items: { item: string; state: string }[], item: string): string | undefined {
  return items.find((i) => i.item === item)?.state;
}

describe('git-sync/platform-layer — setupPlatformLayer', () => {
  it('moves CLAUDE.md + .claude into platform/ and symlinks them back', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# rules\n');
    mkdirSync(join(projectRoot, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{}\n');

    const result = setupPlatformLayer(projectRoot, contextRoot);

    expect(result.moved.sort()).toEqual(['.claude', 'CLAUDE.md']);
    expect(result.linked.sort()).toEqual(['.claude', 'CLAUDE.md']);
    // real content lives in the brain
    expect(readFileSync(join(contextRoot, 'platform', 'CLAUDE.md'), 'utf-8')).toBe('# rules\n');
    expect(existsSync(join(contextRoot, 'platform', '.claude', 'settings.json'))).toBe(true);
    // project root holds symlinks resolving into the brain
    expect(lstatSync(join(projectRoot, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(projectRoot, '.claude'))).toBe(realpathSync(join(contextRoot, 'platform', '.claude')));
    // relative target — the tree stays relocatable
    expect(readlinkSync(join(projectRoot, 'CLAUDE.md'))).toBe(join('_dream_context', 'platform', 'CLAUDE.md'));
  });

  it('writes the machine-local gitignore excludes BEFORE moving anything', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# rules\n');
    setupPlatformLayer(projectRoot, contextRoot);
    const gi = readFileSync(join(contextRoot, '.gitignore'), 'utf-8');
    for (const entry of PLATFORM_GITIGNORE_ENTRIES) expect(gi).toContain(entry);
  });

  it('is idempotent — a second run changes nothing', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# rules\n');
    setupPlatformLayer(projectRoot, contextRoot);
    const second = setupPlatformLayer(projectRoot, contextRoot);
    expect(second.moved).toEqual([]);
    expect(second.linked).toEqual([]);
    expect(stateOf(second.items, 'CLAUDE.md')).toBe('linked');
    expect(readFileSync(join(contextRoot, 'platform', 'CLAUDE.md'), 'utf-8')).toBe('# rules\n');
  });

  it('never clobbers a conflict (real root copy AND platform copy)', () => {
    mkdirSync(join(contextRoot, 'platform'), { recursive: true });
    writeFileSync(join(contextRoot, 'platform', 'CLAUDE.md'), '# from team\n');
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# local\n');

    const result = setupPlatformLayer(projectRoot, contextRoot);

    expect(stateOf(result.items, 'CLAUDE.md')).toBe('conflict');
    expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8')).toBe('# local\n');
    expect(readFileSync(join(contextRoot, 'platform', 'CLAUDE.md'), 'utf-8')).toBe('# from team\n');
  });

  it('leaves a foreign symlink (e.g. CLAUDE.md → AGENTS.md) untouched', () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# agents\n');
    symlinkSync('AGENTS.md', join(projectRoot, 'CLAUDE.md'));

    const result = setupPlatformLayer(projectRoot, contextRoot);

    expect(stateOf(result.items, 'CLAUDE.md')).toBe('foreign-link');
    expect(readlinkSync(join(projectRoot, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(existsSync(join(contextRoot, 'platform', 'CLAUDE.md'))).toBe(false);
  });
});

describe('git-sync/platform-layer — healPlatformLinks', () => {
  it('re-creates missing root links after a fresh clone (platform/ exists, no links)', () => {
    mkdirSync(join(contextRoot, 'platform', '.claude'), { recursive: true });
    writeFileSync(join(contextRoot, 'platform', 'CLAUDE.md'), '# team rules\n');
    writeFileSync(join(contextRoot, 'platform', '.claude', 'settings.json'), '{}\n');

    const result = healPlatformLinks(projectRoot, contextRoot);

    expect(result.linked.sort()).toEqual(['.claude', 'CLAUDE.md']);
    expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8')).toBe('# team rules\n');
    expect(realpathSync(join(projectRoot, '.claude'))).toBe(realpathSync(join(contextRoot, 'platform', '.claude')));
  });

  it('also links extra items that live in platform/ beyond the canonical set', () => {
    mkdirSync(join(contextRoot, 'platform'), { recursive: true });
    writeFileSync(join(contextRoot, 'platform', 'AGENTS.md'), '# agents\n');

    const result = healPlatformLinks(projectRoot, contextRoot);

    expect(result.linked).toContain('AGENTS.md');
    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf-8')).toBe('# agents\n');
  });

  it('never moves and never overwrites a real root file', () => {
    mkdirSync(join(contextRoot, 'platform'), { recursive: true });
    writeFileSync(join(contextRoot, 'platform', 'CLAUDE.md'), '# from team\n');
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# local\n');

    const result = healPlatformLinks(projectRoot, contextRoot);

    expect(result.linked).toEqual([]);
    expect(stateOf(result.items, 'CLAUDE.md')).toBe('conflict');
    expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf-8')).toBe('# local\n');
  });

  it('is a no-op without a platform layer', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# local\n');
    const result = healPlatformLinks(projectRoot, contextRoot);
    expect(result.active).toBe(false);
    expect(result.linked).toEqual([]);
    expect(lstatSync(join(projectRoot, 'CLAUDE.md')).isSymbolicLink()).toBe(false);
  });

  it('best-effort variant never throws', () => {
    expect(() => healPlatformLinksBestEffort(join(projectRoot, 'nope'), join(projectRoot, 'nope2'))).not.toThrow();
  });
});

describe('git-sync/platform-layer — status', () => {
  it('reports not-migrated / linked / missing-link / absent accurately', () => {
    // not yet set up
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# rules\n');
    let status = platformLayerStatus(projectRoot, contextRoot);
    expect(status.active).toBe(false);
    expect(stateOf(status.items, 'CLAUDE.md')).toBe('not-migrated');
    expect(stateOf(status.items, '.claude')).toBe('absent');

    setupPlatformLayer(projectRoot, contextRoot);
    status = platformLayerStatus(projectRoot, contextRoot);
    expect(status.active).toBe(true);
    expect(stateOf(status.items, 'CLAUDE.md')).toBe('linked');

    rmSync(join(projectRoot, 'CLAUDE.md'));
    status = platformLayerStatus(projectRoot, contextRoot);
    expect(stateOf(status.items, 'CLAUDE.md')).toBe('missing-link');
  });
});

describe('git-sync/platform-layer — gitignore integration', () => {
  it('buildBrainGitignore carries the platform excludes and the DS_Store ignore', () => {
    const gi = buildBrainGitignore();
    for (const entry of PLATFORM_GITIGNORE_ENTRIES) expect(gi).toContain(entry);
    expect(gi).toContain('**/.DS_Store');
    expect(gi).toContain('!lab/credentials.example.json');
  });

  it('ensureLocalOnlyArtifacts self-heals a pre-platform gitignore when platform/ exists', () => {
    // simulate an older bootstrapped brain whose gitignore predates the platform layer
    writeFileSync(join(contextRoot, '.gitignore'), 'state/.secrets.json\n');
    mkdirSync(join(contextRoot, 'platform'), { recursive: true });

    ensureLocalOnlyArtifacts(contextRoot);

    const gi = readFileSync(join(contextRoot, '.gitignore'), 'utf-8');
    for (const entry of PLATFORM_GITIGNORE_ENTRIES) expect(gi).toContain(entry);
  });

  it('ensureLocalOnlyArtifacts leaves a platform-less existing gitignore untouched', () => {
    writeFileSync(join(contextRoot, '.gitignore'), 'state/.secrets.json\n');
    ensureLocalOnlyArtifacts(contextRoot);
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).toBe('state/.secrets.json\n');
  });
});
