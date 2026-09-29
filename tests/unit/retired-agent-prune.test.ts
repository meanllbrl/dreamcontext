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
