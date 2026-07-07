import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bootstrapManifestFromScan,
  type KnownArtifacts,
} from '../../src/lib/manifest.js';
import { knownArtifactNames } from '../../src/lib/catalog.js';

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function touch(path: string, content = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

describe('bootstrapManifestFromScan — allowlist', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('T1: adopts only known claude agents, never custom ones', () => {
    touch(join(tmp, '.claude', 'agents', 'watchlist-monitor.md')); // custom
    touch(join(tmp, '.claude', 'agents', 'reviewer.md')); // known

    const known: KnownArtifacts = {
      agentNames: new Set(['reviewer']),
      skillDirs: new Set(['dreamcontext']),
    };
    const m = bootstrapManifestFromScan(tmp, known);

    expect(m.files['.claude/agents/reviewer.md']).toBeDefined();
    expect(m.files['.claude/agents/reviewer.md'].kind).toBe('agent');
    expect(m.files['.claude/agents/watchlist-monitor.md']).toBeUndefined();
  });

  it('T2: adopts only known claude skill dirs, never custom ones', () => {
    touch(join(tmp, '.claude', 'skills', 'dreamcontext', 'SKILL.md'));
    touch(join(tmp, '.claude', 'skills', 'engineering', 'SKILL.md'));
    touch(join(tmp, '.claude', 'skills', 'my-custom-thing', 'SKILL.md'));

    const known: KnownArtifacts = {
      agentNames: new Set<string>(),
      skillDirs: new Set(['dreamcontext', 'engineering']),
    };
    const m = bootstrapManifestFromScan(tmp, known);

    expect(m.files['.claude/skills/dreamcontext/SKILL.md']).toBeDefined();
    expect(m.files['.claude/skills/dreamcontext/SKILL.md'].kind).toBe('core');
    expect(m.files['.claude/skills/engineering/SKILL.md']).toBeDefined();
    expect(m.files['.claude/skills/engineering/SKILL.md'].kind).toBe('pack-skill');
    expect(m.files['.claude/skills/my-custom-thing/SKILL.md']).toBeUndefined();
  });

  it('T4: knownArtifactNames() includes shipped artifacts, excludes custom/removed', () => {
    const known = knownArtifactNames();

    // Pack agents (catalog.agents)
    expect(known.agentNames.has('reviewer')).toBe(true);
    expect(known.agentNames.has('goal-planner')).toBe(true);
    // Core agents (repo-root agents/)
    expect(known.agentNames.has('sleep-state')).toBe(true);
    expect(known.agentNames.has('dreamcontext-explore')).toBe(true);
    // Skills: core + pack
    expect(known.skillDirs.has('dreamcontext')).toBe(true);
    expect(known.skillDirs.has('engineering')).toBe(true);

    // Custom + genuinely-removed are NOT in the allowlist
    expect(known.agentNames.has('watchlist-monitor')).toBe(false);
    expect(known.agentNames.has('review-coordinator')).toBe(false);
  });
});
