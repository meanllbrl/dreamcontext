import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installCoreForPlatform,
  pruneRetiredCoreAgents,
  RETIRED_CORE_AGENTS,
} from '../../src/cli/commands/install-skill.js';
import { emptyManifest, readManifest, recordFile, writeManifest } from '../../src/lib/manifest.js';
import { agentBaselineSha } from '../../src/lib/sleep-specialist-frontmatter.js';
import { guardedFileSha } from '../../src/lib/core-guarded-skill.js';

/** A stand-in for the review-coordinator bytes we shipped (the real ones live only in old git history). */
const COORD_REL = '.claude/agents/review-coordinator.md';
const COORD_SHIPPED = '---\nname: review-coordinator\ndescription: retired\n---\n\n# Coordinator as shipped\n';

vi.mock('../../src/lib/retired-packs/stopped.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/retired-packs/stopped.js')>();
  const { createHash } = await import('node:crypto');
  const fake = createHash('sha256').update('---\nname: review-coordinator\ndescription: retired\n---\n\n# Coordinator as shipped\n', 'utf-8').digest('hex');
  return {
    ...real,
    REAL_RETIRED_CORE_AGENT_SHAS: real.RETIRED_CORE_AGENT_SHAS,
    RETIRED_CORE_AGENT_SHAS: { 'review-coordinator.md': [...real.RETIRED_CORE_AGENT_SHAS['review-coordinator.md'], fake] },
  };
});

/**
 * Retiring a shipped core agent (sleep-federation, 2026-09-30).
 *
 * The package stops carrying the file, but installers never prune, so without an
 * explicit step every upgraded project keeps the retired agent forever. The
 * prune must remove exactly what dreamcontext wrote and nothing else: never a
 * customized copy, never through a symlink, never a same-named file that is not
 * ours.
 */

const REL = '.claude/agents/sleep-federation.md';
const SHIPPED = '---\nname: sleep-federation\ndescription: retired\n---\n\n# Body as shipped\n';

let projectRoot: string;

function install(content: string, withBaseline: boolean): void {
  mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(projectRoot, REL), content);
  if (withBaseline) {
    const m = emptyManifest();
    recordFile(m, REL, '0.28.0', 'agent', { baselineSha: agentBaselineSha(SHIPPED) });
    writeManifest(projectRoot, m);
  }
}

beforeEach(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-retired-agent-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('pruneRetiredCoreAgents', () => {
  it('retires sleep-federation', () => {
    expect([...RETIRED_CORE_AGENTS]).toContain('sleep-federation');
  });

  it('removes an uncustomized copy and drops its entry from the manifest being built', () => {
    install(SHIPPED, true);
    const next = emptyManifest();
    recordFile(next, REL, '0.28.0', 'agent');
    const notes = pruneRetiredCoreAgents(projectRoot, next);
    expect(existsSync(join(projectRoot, REL))).toBe(false);
    expect(next.files[REL]).toBeUndefined();
    expect(notes.join('\n')).toContain('Removed the retired sleep-federation agent');
  });

  it('removes a legacy copy with no recorded baseline (nothing says a human changed it)', () => {
    install(SHIPPED, false);
    pruneRetiredCoreAgents(projectRoot);
    expect(existsSync(join(projectRoot, REL))).toBe(false);
  });

  it('keeps a customized copy and says so', () => {
    install(SHIPPED.replace('Body as shipped', 'MY OWN notes'), true);
    const notes = pruneRetiredCoreAgents(projectRoot);
    expect(readFileSync(join(projectRoot, REL), 'utf-8')).toContain('MY OWN notes');
    expect(notes.join('\n')).toContain('because it was edited');
  });

  it('never follows a symlink: the link and its target both survive', () => {
    const outside = join(projectRoot, 'outside.md');
    writeFileSync(outside, SHIPPED);
    mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
    symlinkSync(outside, join(projectRoot, REL));
    const notes = pruneRetiredCoreAgents(projectRoot);
    expect(lstatSync(join(projectRoot, REL)).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf-8')).toBe(SHIPPED);
    expect(notes.join('\n')).toContain('symlink');
  });

  it('leaves a same-named file that declares a different agent', () => {
    install('---\nname: my-own-federation-helper\n---\n\n# Mine\n', false);
    pruneRetiredCoreAgents(projectRoot);
    expect(existsSync(join(projectRoot, REL))).toBe(true);
  });

  it('is a no-op when nothing is installed', () => {
    expect(pruneRetiredCoreAgents(projectRoot)).toEqual([]);
  });
});

describe('review-coordinator (retired 2026-05-26, pruned since 2026-11-12)', () => {
  function put(content: string): void {
    mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(projectRoot, COORD_REL), content);
  }

  it('is retired, and the table holds the one version the multi-review pack shipped', async () => {
    expect([...RETIRED_CORE_AGENTS]).toContain('review-coordinator');
    const mod = await import('../../src/lib/retired-packs/stopped.js') as unknown as { REAL_RETIRED_CORE_AGENT_SHAS: Record<string, readonly string[]> };
    expect(mod.REAL_RETIRED_CORE_AGENT_SHAS['review-coordinator.md']).toEqual(['1da49fe302c8dad1946e432466b38755b7e619c49a29a549a16620c6899b999e']);
    expect(guardedFileSha(Buffer.from(COORD_SHIPPED))).toHaveLength(64);
  });

  it('removes an unrecorded copy whose bytes are a version we shipped', () => {
    put(COORD_SHIPPED);
    const notes = pruneRetiredCoreAgents(projectRoot);
    expect(existsSync(join(projectRoot, COORD_REL))).toBe(false);
    expect(notes.join('\n')).toContain('Removed the retired review-coordinator agent');
  });

  it('removes a shipped copy with CRLF line endings (a Windows checkout)', () => {
    put(COORD_SHIPPED.split('\n').join('\r\n'));
    pruneRetiredCoreAgents(projectRoot);
    expect(existsSync(join(projectRoot, COORD_REL))).toBe(false);
  });

  it('keeps an unrecorded copy someone edited, and says so', () => {
    put(COORD_SHIPPED.replace('as shipped', 'with my own steps'));
    const notes = pruneRetiredCoreAgents(projectRoot);
    expect(readFileSync(join(projectRoot, COORD_REL), 'utf-8')).toContain('with my own steps');
    expect(notes.join('\n')).toContain('because it was edited');
  });
});

describe('the package and the install path', () => {
  it('no longer ships agents/sleep-federation.md', () => {
    expect(existsSync(join(__dirname, '..', '..', 'agents', 'sleep-federation.md'))).toBe(false);
  });

  it('installCoreForPlatform removes the retired agent and does not reinstall it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    install(SHIPPED, true);
    const manifest = emptyManifest();
    const result = await installCoreForPlatform('claude', projectRoot, manifest);
    expect(existsSync(join(projectRoot, REL))).toBe(false);
    expect(manifest.files[REL]).toBeUndefined();
    expect(result.notes.join('\n')).toContain('Removed the retired sleep-federation agent');
    // The on-disk manifest is the previous install's record; the prune reads it but never rewrites it.
    expect(readManifest(projectRoot)?.files[REL]).toBeDefined();
  });
});
