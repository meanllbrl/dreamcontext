/**
 * A scratch vault for the plan-loop tests: a real `_dream_context/` with a local task backend
 * and a cancelled-kind status, plus helpers that drive the real `plan` verbs.
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import type { PlanDeps } from '../../src/cli/commands/plan.js';
import { planFilePath } from '../../src/lib/plan-store.js';

export interface PlanVault {
  root: string;
  project: string;
  deps: PlanDeps;
  backend: LocalTaskBackend;
  cleanup: () => void;
}

export function makePlanVault(): PlanVault {
  const raw = join(tmpdir(), `plan-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const project = realpathSync(raw);
  const root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'overrides'), { recursive: true });
  writeFileSync(join(root, 'overrides', 'task.md'), '---\nstatuses:\n  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }\n---\n', 'utf-8');
  const backend = new LocalTaskBackend(join(root, 'state'));
  let tick = Date.parse('2026-11-08T10:00:00Z');
  const deps: PlanDeps = { root, now: () => new Date((tick += 1000)), backend: () => backend };
  return { root, project, deps, backend, cleanup: () => rmSync(project, { recursive: true, force: true }) };
}

/** A task with the sections a Develop handoff reads, so only the plan gate can refuse it. */
export async function makeReadyTask(v: PlanVault, name: string): Promise<string> {
  const t = await v.backend.create({ name });
  await v.backend.insertSection(t.slug, 'Acceptance Criteria', '- [ ] it works\n- [ ] Validation method: unit tests', { position: 'bottom', replacePlaceholders: true });
  await v.backend.insertSection(t.slug, 'Technical Details', 'Edit src/lib/thing.ts', { position: 'bottom', replacePlaceholders: true });
  return t.slug;
}

/** Write plan.md for a round: sections the packet reads, plus the Changes lines asked for. */
export function writePlan(v: PlanVault, plan: string, round: number, changes: string[] = []): void {
  const text = [
    `# Plan ${plan} (r${round})`,
    '', '## Decisions', '- Budget 8 rounds.',
    '', '## Out of scope', '- Nothing else.',
    '', '## Environment', '- Base fixture.',
    '', '## Contracts', `- contract text r${round}`,
    '', '## Wave map', 'EXECUTION: lead', '- W1 src/lib/thing.ts',
    '', '## Build notes', '- none',
    '', '## Changes in this revision', ...(changes.length > 0 ? changes.map((c) => `- ${c}`) : [`- revision ${round}`]),
    '',
  ].join('\n');
  writeFileSync(planFilePath(v.root, plan), text, 'utf-8');
}

export interface ReviewFinding { id?: string; level?: 'Critical' | 'Major'; cls: string; kind?: string }

/** A review in the PLAN_REVIEW_RULES format. */
export function reviewText(findings: ReviewFinding[], closed: Array<[string, string]> = []): string {
  const lines = [findings.length > 0 ? 'NEEDS_WORK' : 'SOLID', ''];
  findings.forEach((f, i) => {
    lines.push(`${i + 1}. [${f.level ?? 'Major'}] id: ${f.id ?? 'new'} | class: ${f.cls} | kind: ${f.kind ?? 'contract'} | the invariant ${f.cls} holds everywhere`);
    lines.push('   Evidence: src/lib/thing.ts:1');
  });
  for (const [id, why] of closed) lines.push(`closed: ${id} | ${why}`);
  lines.push('', 'Build notes', '- none', '', 'Non-blocking', '- none');
  return lines.join('\n') + '\n';
}
