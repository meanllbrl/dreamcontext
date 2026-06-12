import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSnapshot } from '../../src/cli/commands/snapshot.js';

function makeProject(name: string): string {
  const root = join(
    tmpdir(),
    `dc-snap-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    '_dream_context',
  );
  mkdirSync(join(root, 'core'), { recursive: true });
  return root;
}

function writeSoul(contextRoot: string, body: string): void {
  writeFileSync(join(contextRoot, 'core', '0.soul.md'), body);
}

describe('snapshot --vault rootOverride (federation P1.4 / P1.6)', () => {
  let originalCwd: string;
  const roots: string[] = [];

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const r of roots) rmSync(join(r, '..'), { recursive: true, force: true });
    roots.length = 0;
  });

  it('rootOverride prints the PEER vault\'s snapshot content (P1.4)', () => {
    const peer = makeProject('peer');
    roots.push(peer);
    writeSoul(peer, 'PEER_SOUL_MARKER — distinctive peer identity text');

    const out = generateSnapshot(peer);
    expect(out).toContain('PEER_SOUL_MARKER');
  });

  it('no-arg path resolves the local cwd context root — output is identical to passing that root (regression P1.6)', () => {
    const local = makeProject('local');
    roots.push(local);
    writeSoul(local, 'LOCAL_SOUL_MARKER — this is the local project');

    // chdir into the project so resolveContextRoot() finds `local`.
    process.chdir(join(local, '..'));

    const noArg = generateSnapshot();
    const explicit = generateSnapshot(local);

    expect(noArg).toContain('LOCAL_SOUL_MARKER');
    // BYTE-IDENTICAL: the no-arg default resolution must equal the explicit root.
    expect(noArg).toBe(explicit);
  });

  it('rootOverride does not bleed peer content into the local no-arg snapshot', () => {
    const local = makeProject('local2');
    const peer = makeProject('peer2');
    roots.push(local, peer);
    writeSoul(local, 'LOCAL_ONLY_MARKER');
    writeSoul(peer, 'PEER_ONLY_MARKER');

    process.chdir(join(local, '..'));

    const noArg = generateSnapshot();
    expect(noArg).toContain('LOCAL_ONLY_MARKER');
    expect(noArg).not.toContain('PEER_ONLY_MARKER');
  });
});
