import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { readLedger } from '../../src/lib/migration-ledger.js';
import { connectionsPath, readConnections } from '../../src/lib/connections.js';
import { consumedDir, inboxDir } from '../../src/lib/federation-inbox.js';
import { readSetupConfig, writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.7.0',
  disableNativeMemory: true,
};

/**
 * The 0.8.0 migration runs on the `_dream_context` ROOT and resolves the project
 * config from `dirname(root)`. We build `<projectRoot>/_dream_context/state/` and
 * point migrations at the `_dream_context` dir.
 */
function makeProject(over: Partial<SetupConfig> = {}): { projectRoot: string; root: string } {
  const projectRoot = join(tmpdir(), `dc-mig080-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE, ...over });
  return { projectRoot, root };
}

/** Run only the 0.8.0 step (from just-below 0.8.0). */
function run080(root: string): ReturnType<typeof runMigrations> {
  return runMigrations(root, '0.7.2', '0.8.0');
}

describe('migration 0.8.0 — federation scaffolding (P3.9)', () => {
  let projectRoot: string;
  let root: string;

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('scaffolds .connections.json + .federation-inbox/ + consumed/ and sets shareable:false when absent', () => {
    ({ projectRoot, root } = makeProject()); // config WITHOUT shareable

    const result = run080(root);

    // .connections.json scaffolded as {version:1, connections:[]}.
    expect(existsSync(connectionsPath(root))).toBe(true);
    expect(readConnections(root)).toEqual({ version: 1, connections: [] });

    // Inbox tree scaffolded.
    expect(existsSync(inboxDir(root))).toBe(true);
    expect(existsSync(consumedDir(root))).toBe(true);

    // shareable defaulted to false (was absent).
    expect(readSetupConfig(projectRoot)?.shareable).toBe(false);

    // The migration applied with file writes (executor 'code').
    const fed = result.applied.find((e) => e.step === 'scaffold-federation');
    expect(fed).toBeTruthy();
    expect(fed?.executor).toBe('code');
  });

  it('is idempotent: a second run reports no changes', () => {
    ({ projectRoot, root } = makeProject());
    run080(root);

    // Re-run from a fresh ledger-aware runner: ledger already has the step → no-op.
    const second = run080(root);
    expect(second.applied).toHaveLength(0);

    // Even forcing a re-execution path (lower 'from') detects everything present.
    const forced = runMigrations(root, '0.0.0', '0.8.0');
    const fed = forced.applied.find((e) => e.step === 'scaffold-federation');
    if (fed) {
      // If the step re-ran (not ledger-gated for this range), it must be detected.
      expect(fed.executor).toBe('detected');
      expect(fed.filesTouched).toHaveLength(0);
    }
  });

  it('does NOT downgrade an explicit shareable:true', () => {
    ({ projectRoot, root } = makeProject({ shareable: true }));

    run080(root);

    expect(readSetupConfig(projectRoot)?.shareable).toBe(true);
  });

  it('records the migration in the ledger', () => {
    ({ projectRoot, root } = makeProject());

    run080(root);

    const ledger = readLedger(root);
    const entry = ledger.find((e) => e.version === '0.8.0' && e.step === 'scaffold-federation');
    expect(entry).toBeTruthy();
    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('summary');
  });

  it('leaves an existing .connections.json untouched', () => {
    ({ projectRoot, root } = makeProject());
    const existing = '{\n  "version": 1,\n  "connections": [\n    { "vault": "peer", "direction": "out", "topics": null, "last_synced_at": null, "status": "active" }\n  ]\n}\n';
    writeFileSync(connectionsPath(root), existing, 'utf-8');

    run080(root);

    // The hand-written file is preserved verbatim (only scaffolded if absent).
    expect(readFileSync(connectionsPath(root), 'utf-8')).toBe(existing);
    expect(readConnections(root).connections).toHaveLength(1);
  });
});
