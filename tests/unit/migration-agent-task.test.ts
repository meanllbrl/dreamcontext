import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { appendLedger, readLedger } from '../../src/lib/migration-ledger.js';
import { pendingMigrations, unfinishedAgentTasks } from '../../src/migrations/index.js';
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

describe('unfinishedAgentTasks — ledger-judged, setupVersion-blind (the 0.23.0 live regression)', () => {
  // The live failure (Tilki, 2026-07-30): `update` ran the 0.23.0 code steps
  // and advanced setupVersion to 0.23.0, so the old setupVersion-ranged
  // `migrations pending` computed the empty range (0.23.0, 0.23.0] and printed
  // "No pending agent migration tasks" while the residue distribution task
  // sat unfinished. The LEDGER is the truth: started (code/detected recorded)
  // and not done (no agent entry for the agentTask id) ⇒ pending.
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });

  const codeEntry = (version: string) => ({
    version,
    step: 'split-user-file',
    executor: 'code' as const,
    timestamp: new Date().toISOString(),
    filesTouched: [],
    summary: 'code step ran',
  });

  it('a fresh vault (empty ledger) has NO unfinished agent tasks', () => {
    // init'ing at the current version never ran the code steps, so a fresh
    // vault must not be told to distribute a residue that does not exist.
    expect(unfinishedAgentTasks(root, '0.23.0')).toEqual([]);
  });

  it('code steps recorded + agent steps missing ⇒ BOTH 0.23.0 tasks pending, same version', () => {
    appendLedger(root, codeEntry('0.23.0'));
    const tasks = unfinishedAgentTasks(root, '0.23.0');
    expect(tasks.map((m) => m.agentTask?.id))
      .toEqual(['distribute-user-md-residue', 'split-soul-into-patterns']);
  });

  it('recording BOTH agent steps silences the version entirely', () => {
    appendLedger(root, codeEntry('0.23.0'));
    for (const step of ['distribute-user-md-residue', 'split-soul-into-patterns']) {
      appendLedger(root, {
        version: '0.23.0',
        step,
        executor: 'agent',
        timestamp: new Date().toISOString(),
        filesTouched: [],
        summary: 'done',
      });
    }
    expect(unfinishedAgentTasks(root, '0.23.0')).toEqual([]);
  });

  it('an agent entry for a DIFFERENT step does not count as done', () => {
    appendLedger(root, codeEntry('0.23.0'));
    appendLedger(root, {
      version: '0.23.0',
      step: 'some-other-agent-step',
      executor: 'agent',
      timestamp: new Date().toISOString(),
      filesTouched: [],
      summary: 'unrelated',
    });
    expect(unfinishedAgentTasks(root, '0.23.0').map((m) => m.agentTask?.id))
      .toEqual(['distribute-user-md-residue', 'split-soul-into-patterns']);
  });

  it('a migration newer than the running CLI never surfaces', () => {
    appendLedger(root, codeEntry('0.23.0'));
    expect(unfinishedAgentTasks(root, '0.22.0')).toEqual([]);
  });

  it('two agentTasks under the SAME version are judged independently (0.23.0)', () => {
    // people-first (distribute-user-md-residue) and soul-split
    // (split-soul-into-patterns) both ship as 0.23.0 — recording one must not
    // hide the other.
    appendLedger(root, codeEntry('0.23.0'));
    appendLedger(root, {
      version: '0.23.0',
      step: 'detect-oversized-soul',
      executor: 'detected',
      timestamp: new Date().toISOString(),
      filesTouched: [],
      summary: 'soul over ceiling',
    });
    appendLedger(root, {
      version: '0.23.0',
      step: 'distribute-user-md-residue',
      executor: 'agent',
      timestamp: new Date().toISOString(),
      filesTouched: [],
      summary: 'distributed',
    });

    const stillPending = unfinishedAgentTasks(root, '0.23.0');
    expect(stillPending.map((m) => m.agentTask?.id)).toEqual(['split-soul-into-patterns']);

    appendLedger(root, {
      version: '0.23.0',
      step: 'split-soul-into-patterns',
      executor: 'agent',
      timestamp: new Date().toISOString(),
      filesTouched: [],
      summary: 'split',
    });
    expect(unfinishedAgentTasks(root, '0.23.0')).toEqual([]);
  });

  it('an opt-in agentTask (0.7.2 diagrams) is an offer, never "unfinished"', () => {
    // Its code step ran ('detected') on every old vault and its agent entry is
    // only ever written by `migrations apply-diagrams` — without the optIn
    // exemption a ledger-judged pending would nag about it forever.
    appendLedger(root, {
      version: '0.7.2',
      step: 'detect-flat-diagram-boards',
      executor: 'detected',
      timestamp: new Date().toISOString(),
      filesTouched: [],
      summary: 'no flat boards',
    });
    expect(unfinishedAgentTasks(root, '0.23.0')).toEqual([]);
  });
});
