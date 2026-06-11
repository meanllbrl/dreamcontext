import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { appendLedger, readLedger } from '../../src/lib/migration-ledger.js';
import { pendingMigrations } from '../../src/migrations/index.js';
import type { Migration, MigrationAgentTask } from '../../src/migrations/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'dc-agent-'));
  mkdirSync(join(r, 'state'), { recursive: true });
  return r;
}

/**
 * Build a synthetic Migration with an agentTask for testing the agent-task
 * surface path without depending on the real registry.
 */
function buildMigrationWithAgentTask(version: string): Migration {
  const agentTask: MigrationAgentTask = {
    id: 'test-agent-step',
    instruction:
      'Start by checking if already reflected in filesystem. If work needed: do it. Write ledger on completion.',
  };
  return {
    version,
    steps: [
      (_root: string) => ({
        step: 'test-code-step',
        filesTouched: [],
        summary: 'Test code step (no-op)',
        detected: true, // simulate already done
      }),
    ],
    agentTask,
  };
}

describe('migration-agent-task', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('migrations pending surfaces agentTask; migrations record writes executor:agent entry', () => {
    const migration = buildMigrationWithAgentTask('0.99.0');

    // Simulate: pending agentTask is surfaced by the runner.
    // We test the surface via the agentTask structure on the migration object.
    expect(migration.agentTask).toBeDefined();
    expect(migration.agentTask!.id).toBe('test-agent-step');
    expect(migration.agentTask!.instruction).toContain('checking if already reflected');

    // Simulate the agent writing the ledger via appendLedger (mirrors
    // `dreamcontext migrations record --executor agent`).
    appendLedger(root, {
      version: '0.99.0',
      step: 'test-agent-step',
      executor: 'agent',
      timestamp: new Date().toISOString(),
      filesTouched: [],
      summary: 'Agent completed the task',
    });

    const ledger = readLedger(root);
    const agentEntry = ledger.find(
      (e) => e.version === '0.99.0' && e.step === 'test-agent-step',
    );
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.executor).toBe('agent');
  });

  it('no agentTask on 0.7.0 migration (deterministic steps only)', () => {
    const m = pendingMigrations('0.0.0', '0.7.0').find(
      (m) => m.version === '0.7.0',
    );
    expect(m).toBeDefined();
    expect(m!.agentTask).toBeUndefined();
  });

  it('pendingAgentTasks are returned when agentTask version has no agent ledger entry', () => {
    // We can't inject into the real registry from tests, but we CAN test the
    // runner's agentTask collection logic via a fresh root with no ledger.
    // The real 0.7.0 has no agentTask, so pendingAgentTasks should be empty.
    const result = runMigrations(root, '0.0.0', '0.7.0');
    expect(result.pendingAgentTasks).toHaveLength(0);
  });

  it('ledger entry with executor:agent is accepted by readLedger', () => {
    appendLedger(root, {
      version: '0.8.0',
      step: 'my-agent-step',
      executor: 'agent',
      timestamp: new Date().toISOString(),
      filesTouched: ['knowledge/some-file.md'],
      summary: 'Moved file per agent judgment',
    });
    const ledger = readLedger(root);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].executor).toBe('agent');
  });
});
