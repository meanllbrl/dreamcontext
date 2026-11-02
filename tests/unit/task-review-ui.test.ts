/**
 * Wave 1 lane G (plan r10 1c), the dashboard's pure half: the review rounds label owner
 * send-back, stuck and fail-at-cap; the job line says who it waits on (mockup r8-11); the board's
 * agent filter and counts find a reviewer; a Codex/Antigravity member is disabled in the menu
 * from a mirror of the envelope's task-step row (drift-pinned); the needs-approval badge only for
 * a member waiting on the approval card; every Wave 1 string exists in both languages.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentJob, AgentJobDelivery, StatusHistoryRow, Task } from '../../dashboard/src/hooks/useTasks';
import { toAssignAgentError } from '../../dashboard/src/hooks/useTasks';
import {
  jobWaitKey, jobWaitLine, reviewRounds, taskToolBlocked, TASK_STEP_TOOL_MODES, waitsOnApprovalCard,
} from '../../dashboard/src/lib/taskAgentJob';
import type { Translate } from '../../dashboard/src/lib/assignToAgent';
import { emptyFilters, filterTasks, taskAgentKeys, taskReviewer } from '../../dashboard/src/components/tasks/boardModel';
import { HEADLESS_ENVELOPES } from '../../src/lib/t3-bridge/headless-envelope';

const t: Translate = (k) => k;

function job(over: Partial<AgentJob> = {}): AgentJob {
  return {
    state: 'running', step: 'work', round: 0, cap: 5, reviewer: null, workspace: 'doc', repo: null,
    startAt: null, queuedAt: null, reviewPassed: false, claimedMachine: null, reason: null, ...over,
  };
}

function task(slug: string, over: Partial<Task> = {}): Task {
  return {
    slug, id: `task_${slug}`, name: slug, description: '', priority: 'medium', urgency: 'medium', status: 'todo',
    created_at: '2026-10-01', updated_at: '2026-10-01', tags: [], parent_task: null, related_feature: null, version: null,
    rice: null, why: '', user_stories: '', acceptance_criteria: '', constraints: '', technical_details: '', notes: '',
    changelog: '', sections: [], body: '', ...over,
  } as Task;
}

const delivery = (round: number): AgentJobDelivery => ({ round, at: `2026-10-1${round}T10:00:00Z`, by: 'rota', note: '', refs: [], branch: null, commits: [] });
const row = (by: string, reason: string, to = 'in_progress'): StatusHistoryRow => ({ date: '2026-10-12', to, by, reason });

describe('reviewRounds reads every way a round ends', () => {
  it('the reviewer\'s send-back carries who and the findings', () => {
    const rounds = reviewRounds(
      job({ state: 'running', step: 'review', round: 2, reviewer: 'gantt' }),
      [delivery(1), delivery(2)],
      [row('reviewer:gantt', 'Review round 1: sent back (Gantt): Gelir tablosunda KDV yok.')],
    );
    expect(rounds.map((r) => [r.round, r.result])).toEqual([[2, 'reviewing'], [1, 'sent-back']]);
    expect(rounds[1]).toMatchObject({ who: 'Gantt', findings: 'Gelir tablosunda KDV yok.' });
  });

  it('the owner\'s send-back is the owner\'s, never the reviewer\'s and never "waiting"', () => {
    const rounds = reviewRounds(job({ state: 'queued', step: 'rework', round: 1, reviewer: 'gantt' }), [delivery(1)], [
      row('owner', 'Review round 1: sent back by the owner.'),
      row('reviewer:gantt', 'Review round 1: passed (Gantt).', 'in_review'),
    ]);
    expect(rounds[0]).toMatchObject({ round: 1, result: 'owner-sent-back', who: null, findings: null });
  });

  it('a fail at the cap reads failed, with its findings', () => {
    const rounds = reviewRounds(job({ state: 'stuck', step: 'review', round: 5, reviewer: 'gantt' }), [delivery(5)], [
      row('reviewer:gantt', 'Review round 5: failed (Gantt): still no VAT', 'in_review'),
    ]);
    expect(rounds[0]).toMatchObject({ result: 'failed', findings: 'still no VAT' });
  });

  it('a stuck round reads stuck, from its line or from the job alone, never "reviewing"', () => {
    expect(reviewRounds(job({ state: 'stuck', step: 'review', round: 1, reviewer: 'gantt' }), [delivery(1)], [
      row('reviewer:gantt', 'Review round 1: stuck (Gantt): no usable verdict.', 'in_review'),
    ])[0]).toMatchObject({ result: 'stuck', findings: null });
    expect(reviewRounds(job({ state: 'stuck', step: 'review', round: 1, reviewer: 'gantt' }), [delivery(1)], [])[0].result).toBe('stuck');
  });

  it('a pass reads passed; an older plain "sent back." line still reads sent back', () => {
    const rounds = reviewRounds(job({ state: 'delivered', step: 'review', round: 2, reviewer: 'gantt', reviewPassed: true }), [delivery(1), delivery(2)], [
      row('reviewer:gantt', 'Review round 2: passed (Gantt).', 'in_review'),
      row('reviewer:gantt', 'Review round 1: sent back.'),
    ]);
    expect(rounds.map((r) => r.result)).toEqual(['passed', 'sent-back']);
  });

  it('someone else writing the reviewer\'s words never marks a round', () => {
    expect(reviewRounds(job({ round: 1 }), [delivery(1)], [row('agent:rota', 'Review round 1: failed (Gantt): x')])[0].result).toBe('owner');
  });
});

describe('the job line says who it waits on', () => {
  it('per state and step', () => {
    const cases: Array<[Partial<AgentJob>, string | null]> = [
      [{ state: 'running', step: 'review' }, 'reviewer'],
      [{ state: 'queued', step: 'review' }, 'reviewer'],
      [{ state: 'starting', step: 'review' }, 'reviewer'],
      [{ state: 'running', step: 'work' }, 'doer'],
      [{ state: 'queued', step: 'rework' }, 'doer'],
      [{ state: 'delivered', step: 'review', reviewPassed: true }, 'owner'],
      [{ state: 'delivered', step: 'work' }, 'owner'],
      [{ state: 'waiting_owner', step: 'plan' }, 'owner'],
      [{ state: 'stuck', step: 'review' }, 'stuck'],
      [{ state: 'blocked', step: 'work' }, 'stuck'],
      [{ state: 'stalled', step: 'work' }, 'stuck'],
      [{ state: 'scheduled', step: 'work' }, null],
      [{ state: null, step: null }, null],
    ];
    for (const [over, key] of cases) expect(jobWaitKey(job(over)), JSON.stringify(over)).toBe(key);
  });

  it('in words: the reviewer working says round N/cap and that nothing is needed from the owner', () => {
    // `t` answers every key with itself, so `tr` falls back to the English words.
    expect(jobWaitLine(job({ state: 'running', step: 'review', round: 2, cap: 5 }), t, 'Rota')).toEqual({
      key: 'reviewer', label: 'Reviewer at work', round: 'round 2/5', hint: 'nothing needed from you',
    });
    const turkish: Translate = (k) => ({
      'tasks.job.wait.reviewer': 'İnceleyici çalışıyor', 'tasks.job.wait.round': 'tur {round}/{cap}', 'tasks.job.wait.notYou': 'senden bir şey beklemiyor',
    } as Record<string, string>)[k] ?? k;
    expect(jobWaitLine(job({ state: 'running', step: 'review', round: 2, cap: 5 }), turkish, 'Rota')).toMatchObject({
      label: 'İnceleyici çalışıyor', round: 'tur 2/5', hint: 'senden bir şey beklemiyor',
    });
    // A rework waits for the next round.
    expect(jobWaitLine(job({ state: 'queued', step: 'rework', round: 1, cap: 5 }), t, 'Rota')).toMatchObject({ label: 'Rota is working', round: 'round 2/5' });
    expect(jobWaitLine(job({ state: 'delivered', step: 'review', round: 2, cap: 5, reviewPassed: true }), t, 'Rota')).toMatchObject({ label: 'Waiting for your approval', hint: '' });
    expect(jobWaitLine(job({ state: 'stuck', step: 'review', round: 5 }), t, 'Rota')).toMatchObject({ key: 'stuck', label: 'Stuck', hint: '' });
    expect(jobWaitLine(job({ state: 'running', step: 'work', round: 0 }), t, 'Rota')?.round).toBe('');
    expect(jobWaitLine(null, t, 'Rota')).toBeNull();
  });
});

describe('the board finds a task by its reviewer', () => {
  const tasks = [
    task('a', { agent: 'rota', agent_job: job({ reviewer: 'gantt' }) }),
    task('b', { agent: 'gantt', agent_job: job() }),
    task('c', { agent: 'rota', agent_job: job() }),
    task('d'),
  ];

  it('the filter matches the doer or the reviewer; excluding a reviewer drops its tasks', () => {
    const f = emptyFilters();
    expect(filterTasks(tasks, { ...f, agent: { inc: ['gantt'], exc: [] } }, '').map((x) => x.slug)).toEqual(['a', 'b']);
    expect(filterTasks(tasks, { ...f, agent: { inc: [], exc: ['gantt'] } }, '').map((x) => x.slug)).toEqual(['c', 'd']);
    expect(filterTasks(tasks, { ...f, agent: { inc: ['none'], exc: [] } }, '').map((x) => x.slug)).toEqual(['d']);
  });

  it('keys and the reviewer helper', () => {
    expect(taskAgentKeys(tasks[0])).toEqual(['rota', 'gantt']);
    expect(taskAgentKeys(tasks[3])).toEqual(['none']);
    expect(taskReviewer(tasks[0])).toBe('gantt');
    expect(taskReviewer(tasks[2])).toBeNull();
    // The counts the filter menu shows count the reviewer too.
    expect(tasks.filter((x) => taskAgentKeys(x).includes('gantt'))).toHaveLength(2);
  });
});

describe('a Codex/Antigravity member in the Give to agent menu', () => {
  it('the mirror equals the envelope\'s task-step row (drift test)', () => {
    expect(TASK_STEP_TOOL_MODES).toEqual({ codex: HEADLESS_ENVELOPES['task-step'].codex, antigravity: HEADLESS_ENVELOPES['task-step'].antigravity });
  });

  it('a member on a tool without a task-step mode is blocked; Claude members are not', () => {
    expect(taskToolBlocked({ tool: 'codex' })).toBe('codex');
    expect(taskToolBlocked({ tool: 'antigravity' })).toBe('antigravity');
    expect(taskToolBlocked({ tool: 'claude' })).toBeNull();
    expect(taskToolBlocked({})).toBeNull();
  });

  it('the server\'s tool_unsupported refusal is a typed refusal that keeps the server\'s reason', () => {
    const why = 'Coder runs on Codex and cannot take a task step: A task step pins a Claude session id before its first turn.';
    const err = toAssignAgentError({ message: why, code: 'tool_unsupported', status: 409 });
    expect(err.code).toBe('tool_unsupported');
    expect(err.message).toBe(why);
    expect(err.status).toBe(409);
  });

  it('the approval badge only for a member waiting on the card, never a teammate\'s or an approved one', () => {
    expect(waitsOnApprovalCard({ approvedToRun: false, approvalReason: 'manifest-changed' })).toBe(true);
    expect(waitsOnApprovalCard({ approvedToRun: false, approvalReason: 'never-approved' })).toBe(true);
    expect(waitsOnApprovalCard({ approvedToRun: true, approvalReason: null })).toBe(false);
    expect(waitsOnApprovalCard({ approvedToRun: false, approvalReason: null })).toBe(false);
    expect(waitsOnApprovalCard({ approvedToRun: false, approvalReason: 'not_owner', readOnly: true })).toBe(false);
  });
});

describe('Wave 1 strings, Turkish and English, same params', () => {
  const src = readFileSync(join(process.cwd(), 'dashboard/src/context/I18nContext.tsx'), 'utf-8');
  const pinned: Array<[string, string, string]> = [
    ['tasks.job.wait.reviewer', 'Reviewer at work', 'İnceleyici çalışıyor'],
    ['tasks.job.wait.notYou', 'nothing needed from you', 'senden bir şey beklemiyor'],
    ['tasks.job.wait.owner', 'Waiting for your approval', 'Senin onayında'],
    ['tasks.job.wait.stuck', 'Stuck', 'Takıldı'],
    ['tasks.job.wait.round', 'round {round}/{cap}', 'tur {round}/{cap}'],
    ['superStage.team.jobs', '{n} jobs', '{n} iş'],
    ['superStage.team.queued', 'queued', 'sırada'],
    ['superStage.team.previous', 'previous conversation', 'önceki konuşma'],
    ['agents.approval.widenConfirm', 'This change gives the member new authority: {fields}. Save = approve.', 'Bu değişiklik üyeye yeni yetki veriyor: {fields}. Kaydet = onay.'],
    ['agents.approval.synced', 'Change from the team: {fields}', 'Takımdan gelen değişiklik: {fields}'],
    ['agents.approval.waitsCard', 'Its approval card waits on the AI Team page.', 'Onay kartı AI Team sayfasında bekliyor.'],
    ['tasks.assignWaitsCard', '{name} waits for its approval card on the AI Team page. Open it there, then assign again.', '{name} AI Team sayfasındaki onay kartını bekliyor. Orada aç, sonra yeniden ata.'],
    ['tasks.assignToolRefused', '{name} cannot take a task: {reason}', '{name} görev alamaz: {reason}'],
  ];
  it.each(pinned)('%s', (key, en, tr) => {
    expect(src).toContain(`    '${key}': '${en}',`);
    expect(src).toContain(`  '${key}': '${tr}',`);
  });

  it('no em dash in any Wave 1 string', () => {
    const keys = ['tasks.job.wait.', 'tasks.reviewOwnerSentBack', 'tasks.reviewFailed', 'tasks.reviewStuck', 'tasks.assignToolUnsupported', 'tasks.assignWaitsApproval', 'tasks.assignSyncedBy', 'superStage.team.', 'agents.approval.widenConfirm', 'agents.approval.synced'];
    for (const line of src.split('\n').filter((l) => keys.some((k) => l.includes(`'${k}`)))) expect(line).not.toContain('—');
  });
});
