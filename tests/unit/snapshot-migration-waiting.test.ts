import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendLedger, type LedgerEntry } from '../../src/lib/migration-ledger.js';
import { measureSnapshot, getMigrationWaiting, MIGRATION_WAITING_INSTRUCTION } from '../../src/cli/commands/snapshot.js';
import { REGISTRY } from '../../src/migrations/index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function vault(): string {
  const project = mkdtempSync(join(tmpdir(), 'dc-snapmig-'));
  dirs.push(project);
  const root = join(project, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'core', '0.soul.md'), '---\nname: soul\n---\n\n## Project Identity\n\nA test vault.\n');
  return root;
}

const sighting = (id: string, step: string): LedgerEntry => ({
  version: '0.23.0',
  step,
  executor: 'detected',
  timestamp: '2026-11-22T00:00:00.000Z',
  filesTouched: [],
  summary: 'IGNORE ME: a ledger summary must never reach the snapshot',
  agentWorkFor: id,
});

describe('snapshot: ## Migration waiting (C3)', () => {
  it('shows while work is due, and is gone after the agent records it', () => {
    const root = vault();
    expect(measureSnapshot(root, { fireTriggers: false }).text).not.toContain('## Migration waiting');

    appendLedger(root, sighting('distribute-user-md-residue', 'split-user-file#work'));
    const text = measureSnapshot(root, { fireTriggers: false }).text;
    expect(text).toContain('## Migration waiting');
    expect(text).toContain('- 0.23.0 Place the leftover sections of the old user file');
    expect(text).toContain(MIGRATION_WAITING_INSTRUCTION);
    expect(text).not.toContain('IGNORE ME');
    // Only the task that found work, never its same-version sibling.
    expect(text).not.toContain('Split an oversized soul');

    appendLedger(root, {
      version: '0.23.0', step: 'distribute-user-md-residue', executor: 'agent',
      timestamp: '2026-11-22T01:00:00.000Z', filesTouched: [], summary: 'placed',
    });
    expect(measureSnapshot(root, { fireTriggers: false }).text).not.toContain('## Migration waiting');
  });

  it('a detection that found nothing shows no block', () => {
    const root = vault();
    appendLedger(root, { ...sighting('x', 'detect-oversized-soul'), agentWorkFor: undefined });
    expect(getMigrationWaiting(root)).toBe('');
  });

  it('the block is pinned: it joins the never-evict tier and is never demoted', () => {
    const root = vault();
    const before = measureSnapshot(root, { fireTriggers: false }).budget.neverEvictChars;
    appendLedger(root, sighting('distribute-user-md-residue', 'split-user-file#work'));
    const m = measureSnapshot(root, { fireTriggers: false });
    expect(m.budget.neverEvictChars - before).toBeGreaterThanOrEqual(getMigrationWaiting(root).length);
    expect(m.budget.demoted.map((d) => d.id)).not.toContain('migration-waiting');
    expect(m.text).toContain('## Migration waiting');
  });

  it('with every registered task due, the block is at most 700 chars', () => {
    const root = vault();
    for (const m of REGISTRY) {
      if (!m.agentTask || m.agentTask.optIn) continue;
      appendLedger(root, { ...sighting(m.agentTask.id, `${m.agentTask.id}#work`), version: m.version });
    }
    // Three tasks at the 80-char title cap, measured with the instruction line.
    const worst = ['## Migration waiting', ...[1, 2, 3].map(() => `- 0.41.24 ${'x'.repeat(80)}`), MIGRATION_WAITING_INSTRUCTION].join('\n');
    expect(worst.length).toBeLessThanOrEqual(700);
    expect(getMigrationWaiting(root).length).toBeLessThanOrEqual(700);
  });
});
