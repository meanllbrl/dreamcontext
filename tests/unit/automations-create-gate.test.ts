/**
 * Setting up a routine from a conversation (AI Team, A6). Inside a run, `automations create`
 * needs `--answer` naming this agent's routine proposal that the owner answered with its FIRST
 * choice, once. And the brief that teaches it names only flags the real CLI parses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Command } from 'commander';
import { createAgent } from '../../src/lib/agents/store.js';
import { createAutomation, getAutomation, writeRunSidecar } from '../../src/lib/automations/store.js';
import { createQuestion, listQuestions, writeQuestion } from '../../src/lib/automations/hitl.js';
import { appendThreadEntry, readThread } from '../../src/lib/automations/threads.js';
import { checkRoutineCreate, ownerInTurn, recordRoutineCreated } from '../../src/lib/automations/routine-gate.js';
import { proposeFromRun, buildThreadMessagePreamble } from '../../src/lib/automations/verdict.js';
import { buildAskBlock, buildPreamble, routineClause } from '../../src/lib/automations/runner.js';
import { createProgram } from '../../src/cli/program.js';
import type { AutomationQuestion } from '../../src/lib/automations/types.js';

const NOW = new Date('2026-10-20T09:00:00.000Z');
const RUN = NOW.toISOString();
let projectRoot: string;
let contextRoot: string;

/** The env of a run of `slug`, the way the runner sets it. */
const runEnv = (slug = 'scout'): NodeJS.ProcessEnv => ({ DREAMCONTEXT_AUTOMATION_SLUG: slug, DREAMCONTEXT_AUTOMATION_RUN: RUN });

function routineQuestion(slug: string, patch: Partial<AutomationQuestion> = {}): AutomationQuestion {
  const q = createQuestion(contextRoot, {
    slug, runFiredAt: RUN, kind: 'flow-hitl', channel: 'chat', sessionId: null,
    question: 'Every weekday 09:00: scan the rivals\' pricing pages.',
    choices: ['Set it up', 'Change it'], proposes: 'routine',
  });
  const next = { ...q, ...patch };
  writeQuestion(contextRoot, next);
  return next;
}

const answered = (answer: string): Partial<AutomationQuestion> =>
  ({ state: 'answered', answer, answeredAt: RUN, answeredVia: 'dashboard' });

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-create-gate-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' });
  createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('checkRoutineCreate', () => {
  it('a person at a terminal needs no answer', () => {
    expect(checkRoutineCreate(contextRoot, { agent: 'scout' }, {})).toMatchObject({ ok: true, question: null });
  });

  it('a run with no --answer is refused, and told how to ask', () => {
    const g = checkRoutineCreate(contextRoot, { agent: 'scout' }, runEnv());
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('propose scout --routine');
  });

  it('an unanswered proposal is refused', () => {
    const q = routineQuestion('scout');
    const g = checkRoutineCreate(contextRoot, { agent: 'scout', answer: q.id }, runEnv());
    expect(g).toMatchObject({ ok: false, reason: expect.stringContaining('not answered') });
  });

  it('a rejected proposal (another choice, or free text) is refused', () => {
    const second = routineQuestion('scout', answered('Change it'));
    expect(checkRoutineCreate(contextRoot, { agent: 'scout', answer: second.id }, runEnv()))
      .toMatchObject({ ok: false, reason: expect.stringContaining('not "Set it up"') });
    const prose = routineQuestion('scout', answered('evet ama 10:00 olsun'));
    expect(checkRoutineCreate(contextRoot, { agent: 'scout', answer: prose.id }, runEnv()).ok).toBe(false);
  });

  it('another agent\'s question, or creating for another agent, is refused', () => {
    const theirs = routineQuestion('writer', answered('Set it up'));
    expect(checkRoutineCreate(contextRoot, { agent: 'scout', answer: theirs.id }, runEnv()))
      .toMatchObject({ ok: false, reason: expect.stringContaining('no question') });
    const mine = routineQuestion('scout', answered('Set it up'));
    expect(checkRoutineCreate(contextRoot, { agent: 'writer', answer: mine.id }, runEnv()))
      .toMatchObject({ ok: false, reason: expect.stringContaining('--agent scout') });
    expect(checkRoutineCreate(contextRoot, { agent: 'scout', answer: mine.id }, { ...runEnv(), DREAMCONTEXT_AGENT_SELF: 'writer' }).ok)
      .toBe(false);
  });

  it('a question that is not a routine proposal is refused', () => {
    const q = routineQuestion('scout', { ...answered('Set it up'), proposes: undefined });
    delete (q as Partial<AutomationQuestion>).proposes;
    writeQuestion(contextRoot, q);
    expect(checkRoutineCreate(contextRoot, { agent: 'scout', answer: q.id }, runEnv()))
      .toMatchObject({ ok: false, reason: expect.stringContaining('not a routine proposal') });
  });

  it('the first choice passes once; the stamp and the conversation line follow, and a replay is refused', () => {
    const q = routineQuestion('scout', answered('Set it up'));
    const g = checkRoutineCreate(contextRoot, { agent: 'scout', answer: q.id }, runEnv());
    expect(g).toMatchObject({ ok: true, runSlug: 'scout' });
    if (!g.ok) return;
    const created = createAutomation(contextRoot, {
      slug: 'rival-pricing', title: 'Rival pricing', agent: 'scout', slots: undefined, days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '09:00',
    });
    recordRoutineCreated(contextRoot, g, created, runEnv());
    expect(listQuestions(contextRoot, 'scout').find((x) => x.id === q.id)?.routine).toBe('rival-pricing');
    const line = readThread(contextRoot, 'scout').find((e) => e.event === 'routine');
    expect(line).toMatchObject({ runId: RUN, kind: 'system', via: 'cli' });
    expect(line?.text).toMatch(/^Routine created · Rival pricing · /);
    expect(checkRoutineCreate(contextRoot, { agent: 'scout', answer: q.id }, runEnv()))
      .toMatchObject({ ok: false, reason: expect.stringContaining('already set up') });
  });

  it('an automation run holds its agent: a job of scout creates for scout', () => {
    createAutomation(contextRoot, { slug: 'morning', title: 'Morning', agent: 'scout', days: 'daily', at: '08:00' });
    expect(getAutomation(contextRoot, 'morning')?.agent).toBe('scout');
    const q = routineQuestion('morning', answered('Set it up'));
    expect(checkRoutineCreate(contextRoot, { agent: 'scout', answer: q.id }, runEnv('morning'))).toMatchObject({ ok: true });
    expect(checkRoutineCreate(contextRoot, { agent: 'morning', answer: q.id }, runEnv('morning')).ok).toBe(false);
  });
});

describe('propose --routine', () => {
  it('ownerInTurn: only a turn the owner started by typing', () => {
    expect(ownerInTurn(contextRoot, 'scout', RUN)).toBe(false);
    appendThreadEntry(contextRoot, 'scout', { runId: RUN, kind: 'user', text: 'Her sabah bak.', via: 'dashboard', now: NOW });
    expect(ownerInTurn(contextRoot, 'scout', RUN)).toBe(true);
    expect(ownerInTurn(contextRoot, 'scout', undefined)).toBe(false);
    expect(ownerInTurn(contextRoot, 'scout', '2026-10-19T09:00:00.000Z')).toBe(false);
  });

  it('marks the question as a routine proposal, and only then', () => {
    writeRunSidecar(contextRoot, 'scout', {
      slug: 'scout', runnerPid: 1000, childPid: 4242, childPgid: 4242, fireAt: RUN, startedAt: RUN,
      timeoutAt: new Date(NOW.getTime() + 900_000).toISOString(),
    });
    const r = proposeFromRun(contextRoot, 'scout', { title: 'Rival pricing', body: 'Weekdays 09:00.', choices: ['Set it up', 'Change it'], routine: true }, { ancestryProbe: () => [4242] });
    expect(r.ok ? r.card.proposes : r.reason).toBe('routine');
    expect(listQuestions(contextRoot, 'scout')[0].proposes).toBe('routine');
  });
});

describe('the brief teaches only what the CLI parses', () => {
  /** `a "b c" d` → ['a', 'b c', 'd']; `<placeholder>` becomes a plain word. */
  function tokens(line: string): string[] {
    const out: string[] = [];
    for (const m of line.replace(/<[^>]+>/g, 'x').matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
    return out;
  }
  function sub(program: Command, name: string): Command {
    const automations = program.commands.find((c) => c.name() === 'automations') as Command;
    return automations.commands.find((c) => c.name() === name) as Command;
  }

  it('both example commands parse with no unknown option', () => {
    const program = createProgram();
    const lines = routineClause({ slug: 'scout', agent: 'scout' }).split('\n').filter((l) => l.trim().startsWith('dreamcontext automations'));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const [, , verb, ...rest] = tokens(line.trim());
      const parsed = sub(program, verb).parseOptions(rest);
      expect(parsed.unknown, line).toEqual([]);
      expect(parsed.operands, line).toHaveLength(1);
    }
    expect(lines[1]).toContain('--answer');
    expect(lines[1]).toContain('--agent scout');
  });

  it('the ask and the thread-reply briefs carry it, whatever review says; a scheduled brief does not', () => {
    for (const review of ['off', 'agent'] as const) {
      const m = { slug: 'scout', agent: 'scout', review };
      expect(buildAskBlock('Her sabah rakiplere bak.', m)).toContain(routineClause(m));
      expect(buildThreadMessagePreamble('Her sabah bak.', m)).toContain(routineClause(m));
    }
    const scheduled = { slug: 'scout', agent: 'scout', title: 'Scout', mode: 'sched', schedule: null, review: 'agent' };
    expect(buildPreamble(scheduled as never, '/tmp/p', NOW, '/tmp/o.md')).not.toContain('ROUTINES:');
  });

  it('a job of an agent creates as the agent, not as the job', () => {
    expect(routineClause({ slug: 'morning', agent: 'scout' })).toContain('--agent scout');
    expect(routineClause({ slug: 'morning', agent: 'scout' })).toContain('propose morning --routine');
  });
});
