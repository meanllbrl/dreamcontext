/**
 * AI Team v2 C2, the task UI's decisions driven without React: the job's chip for every state,
 * the queue position the drawer names, the workspace guess, the local-time round trip of a start,
 * review rounds from deliveries and the status history, who moved a status, the board's agent
 * filter (and a view saved before it), the composer's lines for a scheduled or queued job and
 * its new refusals, and the notch's reading of task rows.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/context/VaultContext', () => ({ useApi: () => null }));

import type { AgentJob, AgentJobDelivery, StatusHistoryRow, Task } from '../../dashboard/src/hooks/useTasks';
import { AssignAgentError } from '../../dashboard/src/hooks/useTasks';
import {
  authorText, guessWorkspace, instantToLocalInput, jobChip, localInputToInstant, queuePosition, reviewRounds, shortWhen, stepAgent,
} from '../../dashboard/src/lib/taskAgentJob';
import { assignedMessage, refusalView, type Translate } from '../../dashboard/src/lib/assignToAgent';
import { emptyFilters, filterTasks, normConfig, taskAgentKey } from '../../dashboard/src/components/tasks/boardModel';
import { readInbox } from '../../dashboard/src/components/assistant/notchModel';

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

describe('jobChip: one chip per state, in words', () => {
  it('names every state, and the step decides between working, reviewing and sent back', () => {
    const now = new Date('2026-10-12T09:00:00');
    const cases: Array<[Partial<AgentJob>, string]> = [
      [{ state: 'scheduled', startAt: '2026-10-12T14:00:00' }, 'scheduled'],
      [{ state: 'queued' }, 'queued'],
      [{ state: 'queued', step: 'review', reviewer: 'critic' }, 'reviewing'],
      [{ state: 'queued', step: 'rework', round: 2 }, 'sent-back'],
      [{ state: 'starting' }, 'running'],
      [{ state: 'running', step: 'review', round: 1 }, 'reviewing'],
      [{ state: 'delivered' }, 'delivered'],
      [{ state: 'delivered', reviewPassed: true }, 'passed'],
      [{ state: 'waiting_owner' }, 'waiting'],
      [{ state: 'blocked' }, 'blocked'],
      [{ state: 'stopped' }, 'stopped'],
      [{ state: 'stalled' }, 'stalled'],
      [{ state: 'stuck', round: 5 }, 'stuck'],
    ];
    for (const [over, key] of cases) expect(jobChip(job(over), t, now)?.key, JSON.stringify(over)).toBe(key);
    expect(jobChip(job({ state: null }), t)).toBeNull();
    expect(jobChip(null, t)).toBeNull();
    expect(jobChip(job({ state: 'stuck', round: 5 }), t)?.tone).toBe('bad');
    expect(jobChip(job({ state: 'delivered', reviewPassed: true }), t)?.tone).toBe('good');
  });

  it('a scheduled start today reads as a time; another day carries its date', () => {
    const now = new Date('2026-10-12T09:00:00');
    expect(shortWhen('2026-10-12T14:05:00', now, 'en-GB')).toBe('14:05');
    expect(shortWhen('2026-10-14T14:05:00', now, 'en-GB')).toMatch(/14 Oct.*14:05/);
    expect(shortWhen('not a date', now)).toBe('');
  });
});

describe('queuePosition: the step agent\'s line, oldest first', () => {
  it('counts only queued tasks of the same step agent; a review step waits in the reviewer\'s line', () => {
    const a = task('a', { agent: 'scout', agent_job: job({ state: 'queued', queuedAt: '2026-10-12T09:02:00Z' }) });
    const b = task('b', { agent: 'scout', agent_job: job({ state: 'queued', queuedAt: '2026-10-12T09:01:00Z' }) });
    const c = task('c', { agent: 'scout', agent_job: job({ state: 'queued', step: 'review', reviewer: 'critic', queuedAt: '2026-10-12T09:00:00Z' }) });
    const d = task('d', { agent: 'scout', agent_job: job({ state: 'running' }) });
    const all = [a, b, c, d];
    expect(queuePosition(b, all)).toBe(1);
    expect(queuePosition(a, all)).toBe(2);
    expect(queuePosition(c, all)).toBe(1);
    expect(stepAgent(c)).toBe('critic');
    expect(queuePosition(d, all)).toBeNull();
  });
});

describe('the composer\'s guesses and the start\'s local time', () => {
  it('code only when a repo is here and the task names a code layer', () => {
    const repos = [{ name: 'app', gitRemoteUrl: 'x', present: true, path: '/x' }];
    expect(guessWorkspace({ tags: ['layer:frontend'] }, repos)).toBe('code');
    expect(guessWorkspace({ tags: ['topic:docs'] }, repos)).toBe('doc');
    expect(guessWorkspace({ tags: ['layer:backend'] }, [{ ...repos[0], present: false }])).toBe('doc');
    expect(guessWorkspace({ tags: ['kind:bug'] }, undefined)).toBe('doc');
  });

  it('a datetime-local value becomes an absolute instant and comes back the same', () => {
    const instant = localInputToInstant('2026-10-26T09:30');
    expect(instant).toMatch(/Z$/);
    expect(instantToLocalInput(instant)).toBe('2026-10-26T09:30');
    expect(localInputToInstant('26/10/2026 09:30')).toBeNull();
    expect(instantToLocalInput(null)).toBe('');
  });
});

describe('reviewRounds and the history\'s authors', () => {
  const deliveries: AgentJobDelivery[] = [
    { round: 1, at: '2026-10-11T10:00:00Z', by: 'scout', note: '', refs: [], branch: null, commits: [] },
    { round: 2, at: '2026-10-12T10:00:00Z', by: 'scout', note: '', refs: [], branch: null, commits: [] },
  ];
  const history: StatusHistoryRow[] = [
    { date: '2026-10-11', to: 'in_progress', by: 'reviewer:critic', reason: 'Review round 1: sent back.' },
    { date: '2026-10-11', to: 'in_review', by: 'agent:scout', reason: 'Delivered round 1.' },
  ];

  it('sent back from the reviewer\'s heading; the current round passed, in review, or the owner\'s', () => {
    expect(reviewRounds(job({ round: 2, reviewer: 'critic', reviewPassed: true }), deliveries, history).map((r) => [r.round, r.result]))
      .toEqual([[2, 'passed'], [1, 'sent-back']]);
    expect(reviewRounds(job({ round: 2, reviewer: 'critic', step: 'review' }), deliveries, history)[0].result).toBe('reviewing');
    expect(reviewRounds(job({ round: 2 }), deliveries, [])[0].result).toBe('owner');
    // An owner's or agent's heading never marks a round sent back.
    expect(reviewRounds(job({ round: 1 }), deliveries.slice(0, 1), [{ ...history[0], by: 'owner' }])[0].result).toBe('owner');
  });

  it('names who moved a status', () => {
    const nameOf = (s: string) => s.toUpperCase();
    expect(authorText('owner', t, nameOf)).toBe('you');
    expect(authorText('agent:scout', t, nameOf)).toBe('SCOUT');
    expect(authorText('reviewer:critic', t, nameOf)).toBe('CRITIC (reviewer)');
    expect(authorText('sleep', t, nameOf)).toBe('sleep');
    expect(authorText(null, t, nameOf)).toBe('');
  });
});

describe('the board\'s agent filter', () => {
  it('filters by agent and by "no agent"; a view saved before the field reads as any', () => {
    const tasks = [task('a', { agent: 'scout' }), task('b', { agent: 'critic' }), task('c')];
    const f = emptyFilters();
    expect(filterTasks(tasks, { ...f, agent: { inc: ['scout'], exc: [] } }, '').map((x) => x.slug)).toEqual(['a']);
    expect(filterTasks(tasks, { ...f, agent: { inc: ['none'], exc: [] } }, '').map((x) => x.slug)).toEqual(['c']);
    expect(filterTasks(tasks, { ...f, agent: { inc: [], exc: ['scout'] } }, '').map((x) => x.slug)).toEqual(['b', 'c']);
    expect(taskAgentKey(tasks[2])).toBe('none');
    const legacy = normConfig({ filters: { status: { inc: [], exc: [] } } });
    expect(legacy.filters.agent).toEqual({ inc: [], exc: [] });
    expect(filterTasks(tasks, legacy.filters, '').map((x) => x.slug)).toEqual(['a', 'b', 'c']);
  });
});

describe('the composer\'s lines', () => {
  it('a scheduled job names its time, a queued one says it waits', () => {
    expect(assignedMessage({ jobId: '', runId: '', statusMoved: false, state: 'scheduled' }, 'Scout', t, '14:00')).toBe('Scout starts on this task at 14:00.');
    expect(assignedMessage({ jobId: '', runId: '', statusMoved: false, state: 'queued' }, 'Scout', t)).toBe('Scout is busy. The task waits its turn.');
    expect(assignedMessage({ jobId: '', runId: '', statusMoved: true, state: 'starting' }, 'Scout', t)).toMatch(/In progress/);
  });

  it('every new refusal is a plain line', () => {
    for (const code of ['invalid_start', 'no_repo', 'unknown_reviewer', 'reviewer_is_agent', 'not_owner'] as const) {
      const v = refusalView(new AssignAgentError('x', code, 400), 'Scout', t);
      expect(v.kind, code).toBe('message');
      expect(v.kind === 'message' && v.text, code).not.toMatch(/tasks\.[a-z]|_/);
    }
  });
});

describe('the notch reads task rows', () => {
  it('keeps a well-formed task row and drops a junk one', () => {
    const inbox = readInbox({
      tasks: [
        { key: 'acme::r1', vault: 'acme', task: 'a-very-long-task-slug-'.repeat(6) + 'end', agent: 'scout', kind: 'task-review', title: 'Scout did it', detail: '', at: '2026-10-12T09:00:00Z' },
        { key: 'acme::r2', vault: 'acme', task: '../etc', kind: 'task-stuck', title: 'x' },
        { vault: 'acme', task: 'no-key' },
      ],
    });
    expect(inbox.tasks.map((r) => r.key)).toEqual(['acme::r1']);
    expect(inbox.tasks[0]).toMatchObject({ agent: 'scout', kind: 'task-review', title: 'Scout did it' });
  });
});
