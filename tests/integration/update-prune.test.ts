import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const MANIFEST_REL = join('_dream_context', 'state', '.install-manifest.json');
const CUSTOM_AGENT_REL = join('.claude', 'agents', 'watchlist-monitor.md');

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-update-prune-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 30000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function scaffoldClaudeInstall(tmp: string): void {
  run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmp);
  run('install-skill --platforms claude', tmp);
}

describe('update prune — custom agent data-loss regression (integration)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('T10: no-manifest (bootstrap) path — custom agent survives update --yes', () => {
    scaffoldClaudeInstall(tmp);
    expect(existsSync(join(tmp, '.claude', 'agents'))).toBe(true);

    // User's own custom agent dreamcontext never installed.
    writeFileSync(join(tmp, CUSTOM_AGENT_REL), '# custom watchlist monitor\n', 'utf-8');

    // Delete the manifest to force the legacy bootstrap path on the next update.
    rmSync(join(tmp, MANIFEST_REL), { force: true });
    expect(existsSync(join(tmp, MANIFEST_REL))).toBe(false);

    const output = run('update --yes', tmp);

    // The custom file MUST survive (data-loss guard).
    expect(existsSync(join(tmp, CUSTOM_AGENT_REL))).toBe(true);
    // And it must NOT appear in the manifest as a tracked/owned file
    // (allowlist prevents bootstrap from adopting it at all).
    const manifest = JSON.parse(readFileSync(join(tmp, MANIFEST_REL), 'utf-8'));
    expect(manifest.files['.claude/agents/watchlist-monitor.md']).toBeUndefined();
    // Sanity: update actually ran.
    expect(output.toLowerCase()).not.toContain('no installed platforms');
  });

  it('T11: polluted-manifest path — custom agent survives and stays tracked across two updates', () => {
    scaffoldClaudeInstall(tmp);
    writeFileSync(join(tmp, CUSTOM_AGENT_REL), '# custom watchlist monitor\n', 'utf-8');

    // Simulate an already-polluted manifest: a prior shipped bootstrap adopted
    // the custom file as a pre-manifest (heuristic) entry.
    const manifestPath = join(tmp, MANIFEST_REL);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.files['.claude/agents/watchlist-monitor.md'] = { version: 'pre-manifest', kind: 'agent' };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    // First update: heuristic file must be flagged-not-removed.
    run('update --yes', tmp);
    expect(existsSync(join(tmp, CUSTOM_AGENT_REL))).toBe(true);
    const afterFirst = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(afterFirst.files['.claude/agents/watchlist-monitor.md']).toBeDefined();
    expect(afterFirst.files['.claude/agents/watchlist-monitor.md'].version).toBe('pre-manifest');

    // Second update: still survives + still tracked (re-persist is unconditional,
    // so the heuristic entry is never silently dropped).
    run('update --yes', tmp);
    expect(existsSync(join(tmp, CUSTOM_AGENT_REL))).toBe(true);
    const afterSecond = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(afterSecond.files['.claude/agents/watchlist-monitor.md']).toBeDefined();
  });
});
