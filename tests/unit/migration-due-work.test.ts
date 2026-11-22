import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendLedger, readLedger, type LedgerEntry } from '../../src/lib/migration-ledger.js';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { REGISTRY, dueAgentTasks, agentTaskById } from '../../src/migrations/index.js';
import { settleAgentWork, LEGACY_SETTLED_TASKS, SETTLE_VERSION } from '../../src/migrations/0.41.24.js';
import { migration0230SoulSplit } from '../../src/migrations/0.23.0-soul-split.js';
import { CORE_FILE_CHAR_CEILING } from '../../src/lib/core-index.js';

const dirs: string[] = [];
function makeRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'dc-due-'));
  mkdirSync(join(r, 'state'), { recursive: true });
  dirs.push(r);
  return r;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, 'core'), 0o755); } catch { /* absent */ }
    rmSync(d, { recursive: true, force: true });
  }
});

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  version: '0.23.0',
  step: 'x',
  executor: 'detected',
  timestamp: '2026-11-22T00:00:00.000Z',
  filesTouched: [],
  summary: 's',
  ...over,
});

const ids = (root: string, v = '9.9.9') => dueAgentTasks(root, v).map((d) => d.id);

describe('dueAgentTasks: due work is named by the task, never by the version (C1)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot(); });

  it('a fresh vault (empty ledger) has no due work', () => {
    expect(dueAgentTasks(root, '9.9.9')).toEqual([]);
  });

  it('a detection that found nothing makes nothing due (the old rule nagged here)', () => {
    appendLedger(root, entry({ step: 'detect-oversized-soul', summary: 'within the ceiling' }));
    appendLedger(root, entry({ step: 'split-user-file', executor: 'code' }));
    expect(ids(root)).toEqual([]);
  });

  it('a sighting makes ITS task due, with version and title, and never the sibling on the same version', () => {
    appendLedger(root, entry({ step: 'detect-oversized-soul#work', agentWorkFor: 'split-soul-into-patterns' }));
    const due = dueAgentTasks(root, '9.9.9');
    expect(due).toEqual([{ version: '0.23.0', id: 'split-soul-into-patterns', title: agentTaskById('split-soul-into-patterns')!.task.title }]);
  });

  it("the agent's record (done or declined) silences the task", () => {
    appendLedger(root, entry({ step: 'split-user-file#work', agentWorkFor: 'distribute-user-md-residue' }));
    expect(ids(root)).toEqual(['distribute-user-md-residue']);
    appendLedger(root, entry({ step: 'distribute-user-md-residue', executor: 'agent', summary: 'owner declined: not now' }));
    expect(ids(root)).toEqual([]);
  });

  it('a task newer than the running CLI never surfaces; an opt-in task never does', () => {
    appendLedger(root, entry({ step: 'split-user-file#work', agentWorkFor: 'distribute-user-md-residue' }));
    appendLedger(root, entry({ version: '0.7.2', step: 'detect-flat-diagram-boards#work', agentWorkFor: 'diagrams-folder-convention' }));
    expect(ids(root, '0.22.0')).toEqual([]);
    expect(ids(root, '0.23.0')).toEqual(['distribute-user-md-residue']);
  });

  it('a malformed ledger reads as no due work and never throws', () => {
    writeFileSync(join(root, 'state', '.migrations.json'), '{ torn');
    expect(dueAgentTasks(root, '9.9.9')).toEqual([]);
    writeFileSync(join(root, 'state', '.migrations.json'), '[null, 3, "x"]');
    expect(dueAgentTasks(root, '9.9.9')).toEqual([]);
  });
});

describe('registry: titles and agentWorkFor references (C1)', () => {
  it('agentTask ids are unique and every task has a one-line title of at most 80 chars', () => {
    const tasks = REGISTRY.flatMap((m) => (m.agentTask ? [m.agentTask] : []));
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    for (const t of tasks) {
      expect(t.title.length, t.id).toBeGreaterThan(0);
      expect(t.title.length, t.id).toBeLessThanOrEqual(80);
      expect(t.title, t.id).not.toMatch(/[\r\n]/);
    }
  });

  it('every non-optIn task is settled by 0.41.24 or reported by its own steps; 0.7.2 opt-in is excluded on purpose', () => {
    // A step reports agentWorkFor = <its own migration's task id> (asserted on
    // the real steps below for 0.23.0). The settle step covers exactly the two
    // tasks whose ledgers predate the sighting.
    const nonOptIn = REGISTRY.filter((m) => m.agentTask && !m.agentTask.optIn).map((m) => m.agentTask!.id);
    for (const id of nonOptIn) expect(LEGACY_SETTLED_TASKS as readonly string[]).toContain(id);
    expect(REGISTRY.find((m) => m.version === '0.7.2')?.agentTask?.optIn).toBe(true);
  });
});

describe('runner: a sighting is its own ledger entry (C1)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot(); });

  it('an oversized soul writes detect-oversized-soul#work with agentWorkFor; a small one writes none', () => {
    mkdirSync(join(root, 'core'), { recursive: true });
    writeFileSync(join(root, 'core', '0.soul.md'), 'x'.repeat(100));
    runMigrations(root, '0.22.0', '0.23.0');
    expect(readLedger(root).some((e) => e.agentWorkFor)).toBe(false);
    expect(ids(root, '0.23.0')).toEqual([]);

    const big = makeRoot();
    mkdirSync(join(big, 'core'), { recursive: true });
    writeFileSync(join(big, 'core', '0.soul.md'), 'x'.repeat(CORE_FILE_CHAR_CEILING + 1));
    const res = runMigrations(big, '0.22.0', '0.23.0');
    const work = readLedger(big).filter((e) => e.step === 'detect-oversized-soul#work');
    expect(work).toHaveLength(1);
    expect(work[0].agentWorkFor).toBe('split-soul-into-patterns');
    expect(res.pendingAgentTasks.map((p) => p.agentTask.id)).toEqual(['split-soul-into-patterns']);
    // Written once: a second pass adds no second sighting.
    runMigrations(big, '0.22.0', '0.23.0');
    expect(readLedger(big).filter((e) => e.step === 'detect-oversized-soul#work')).toHaveLength(1);
  });

  it("an earlier 'found nothing' entry of the step never swallows a later sighting", () => {
    mkdirSync(join(root, 'core'), { recursive: true });
    appendLedger(root, entry({ step: 'detect-oversized-soul', summary: 'within the ceiling' }));
    writeFileSync(join(root, 'core', '0.soul.md'), 'x'.repeat(CORE_FILE_CHAR_CEILING + 1));
    runMigrations(root, '0.22.0', '0.23.0');
    expect(ids(root, '0.23.0')).toEqual(['split-soul-into-patterns']);
  });

  it('the soul step reports agentWorkFor only when over the ceiling', () => {
    mkdirSync(join(root, 'core'), { recursive: true });
    writeFileSync(join(root, 'core', '0.soul.md'), 'x'.repeat(10));
    expect(migration0230SoulSplit.steps[0](root).agentWorkFor).toBeUndefined();
  });
});

describe('0.41.24 settle-agent-work: legacy ledgers decided once from the filesystem (C2)', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
    mkdirSync(join(root, 'core'), { recursive: true });
    mkdirSync(join(root, 'inbox'), { recursive: true });
  });
  const legacy = () => {
    appendLedger(root, entry({ step: 'split-user-file', executor: 'code' }));
    appendLedger(root, entry({ step: 'detect-oversized-soul' }));
  };
  const vaultFiles = () => ['core/0.soul.md', 'inbox/1.user-residue.md'].map((f) => {
    try { return readFileSync(join(root, f), 'utf-8'); } catch { return null; }
  });

  it('residue present: the residue task is due; small soul: the soul task is ticked', () => {
    legacy();
    writeFileSync(join(root, 'inbox', '1.user-residue.md'), '## Left over\n');
    writeFileSync(join(root, 'core', '0.soul.md'), 'small');
    const before = vaultFiles();
    settleAgentWork(root);
    expect(ids(root, SETTLE_VERSION)).toEqual(['distribute-user-md-residue']);
    const tick = readLedger(root).find((e) => e.step === 'split-soul-into-patterns' && e.executor === 'agent');
    expect(tick?.version).toBe('0.23.0');
    expect(tick?.summary).toBe(`nothing left to do (checked by ${SETTLE_VERSION})`);
    expect(vaultFiles()).toEqual(before);
  });

  it('soul over the ceiling: due; neither: both ticked and nothing waits', () => {
    legacy();
    writeFileSync(join(root, 'core', '0.soul.md'), 'x'.repeat(CORE_FILE_CHAR_CEILING + 1));
    settleAgentWork(root);
    expect(ids(root, SETTLE_VERSION)).toEqual(['split-soul-into-patterns']);
    expect(readLedger(root).find((e) => e.step === 'split-soul-into-patterns-recheck#work')?.version).toBe(SETTLE_VERSION);

    const clear = makeRoot();
    appendLedger(clear, entry({ step: 'split-user-file', executor: 'code' }));
    settleAgentWork(clear);
    expect(ids(clear, SETTLE_VERSION)).toEqual([]);
    expect(readLedger(clear).filter((e) => e.executor === 'agent').map((e) => e.step).sort())
      .toEqual(['distribute-user-md-residue', 'split-soul-into-patterns']);
  });

  it('a vault that never ran 0.23.0 is skipped (no ledger write)', () => {
    writeFileSync(join(root, 'inbox', '1.user-residue.md'), '## x\n');
    settleAgentWork(root);
    expect(readLedger(root)).toEqual([]);
  });

  it('a pre-0.23.0 vault running 0.23.0 and 0.41.24 in one pass gets no wrong tick', () => {
    writeFileSync(join(root, 'core', '0.soul.md'), 'x'.repeat(CORE_FILE_CHAR_CEILING + 1));
    runMigrations(root, '0.22.0', SETTLE_VERSION);
    expect(ids(root, SETTLE_VERSION)).toEqual(['split-soul-into-patterns']);
    expect(readLedger(root).some((e) => e.executor === 'agent' && e.step === 'split-soul-into-patterns')).toBe(false);
    // The settle saw the fresh sighting and left the task alone.
    expect(readLedger(root).some((e) => e.step === 'split-soul-into-patterns-recheck#work')).toBe(false);
  });

  it('an already recorded task is left alone', () => {
    legacy();
    appendLedger(root, entry({ step: 'distribute-user-md-residue', executor: 'agent', summary: 'done by hand' }));
    writeFileSync(join(root, 'inbox', '1.user-residue.md'), '## x\n');
    settleAgentWork(root);
    expect(ids(root, SETTLE_VERSION)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable soul is never "nothing to do": that task is left untouched', () => {
    legacy();
    writeFileSync(join(root, 'core', '0.soul.md'), 'x'.repeat(10));
    chmodSync(join(root, 'core', '0.soul.md'), 0o000);
    try {
      settleAgentWork(root);
    } finally {
      chmodSync(join(root, 'core', '0.soul.md'), 0o644);
    }
    const ledger = readLedger(root);
    expect(ledger.some((e) => e.step === 'split-soul-into-patterns')).toBe(false);
    expect(ledger.some((e) => e.agentWorkFor === 'split-soul-into-patterns')).toBe(false);
    // The residue task (readable: absent) is still decided.
    expect(ledger.some((e) => e.step === 'distribute-user-md-residue' && e.executor === 'agent')).toBe(true);
  });
});

describe('migrations pending: --json for the server, the declined line for the agent (C1)', () => {
  async function runPending(project: string, args: string[]): Promise<string> {
    const { Command } = await import('commander');
    const { registerMigrationsCommand } = await import('../../src/cli/commands/migrations.js');
    const program = new Command();
    program.exitOverride();
    registerMigrationsCommand(program);
    const out: string[] = [];
    const log = console.log;
    const cwd = process.cwd();
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    process.chdir(project);
    try {
      await program.parseAsync(['node', 'dc', 'migrations', 'pending', ...args]);
    } finally {
      console.log = log;
      process.chdir(cwd);
    }
    return out.join('\n');
  }

  it('--json prints DueTask[] only (no instruction text); text mode prints the record and declined lines', async () => {
    const project = mkdtempSync(join(tmpdir(), 'dc-pend-'));
    dirs.push(project);
    const ctx = join(project, '_dream_context');
    mkdirSync(join(ctx, 'state'), { recursive: true });
    expect(JSON.parse(await runPending(project, ['--json']))).toEqual([]);

    appendLedger(ctx, entry({ step: 'split-user-file#work', agentWorkFor: 'distribute-user-md-residue' }));
    const json = JSON.parse(await runPending(project, ['--json']));
    expect(json).toEqual([{ version: '0.23.0', id: 'distribute-user-md-residue', title: agentTaskById('distribute-user-md-residue')!.task.title }]);

    const text = await runPending(project, []);
    expect(text).toContain('--step distribute-user-md-residue --executor agent --summary "<what you did>"');
    expect(text).toContain('If the owner says no, record it:');
    expect(text).toContain('--summary "owner declined: <his words>"');
    expect(text).not.toContain('split-soul-into-patterns');
  });
});
