import { describe, it, expect } from 'vitest';
import {
  toolAction, actionText, isQuestOnlyCommand, thinkingLabel, workBeatHeadline, stepStretches,
  type StretchProbe, type ToolAction,
} from '../../dashboard/src/components/sleepy/chat/toolAction';
import { JARGON_RE } from '../../dashboard/src/lib/quest';

/**
 * The team log's action lines: a step's TENSE is its status. Every case is a call the agent
 * really makes, read the way the transcript now prints it.
 */

type Status = 'running' | 'done' | 'error';
const line = (name: string, input: unknown, status: Status) => actionText(toolAction(name, input, status));
const all = (name: string, input: unknown) => ({
  done: line(name, input, 'done'), running: line(name, input, 'running'), error: line(name, input, 'error'),
});

describe('toolAction: every tool in all three tenses', () => {
  const file = { file_path: '/Users/demo/app/src/ChatPane.tsx' };
  const cases: [string, unknown, { done: string; running: string; error: string }][] = [
    ['Read', file, { done: 'Read ChatPane.tsx', running: 'Reading ChatPane.tsx…', error: "Couldn't read ChatPane.tsx" }],
    ['Grep', { pattern: 'useQuest' }, { done: 'Searched for useQuest', running: 'Searching for useQuest…', error: "Couldn't search for useQuest" }],
    ['Glob', { pattern: '**/*.css' }, { done: 'Looked for files matching **/*.css', running: 'Looking for files matching **/*.css…', error: "Couldn't look for files matching **/*.css" }],
    ['LS', { path: '/Users/demo/app/src' }, { done: 'Listed src', running: 'Listing src…', error: "Couldn't list src" }],
    ['Edit', file, { done: 'Edited ChatPane.tsx', running: 'Editing ChatPane.tsx…', error: "Couldn't edit ChatPane.tsx" }],
    ['MultiEdit', file, { done: 'Edited ChatPane.tsx', running: 'Editing ChatPane.tsx…', error: "Couldn't edit ChatPane.tsx" }],
    ['NotebookEdit', { notebook_path: '/a/b/n.ipynb' }, { done: 'Edited n.ipynb', running: 'Editing n.ipynb…', error: "Couldn't edit n.ipynb" }],
    ['Write', file, { done: 'Wrote ChatPane.tsx', running: 'Writing ChatPane.tsx…', error: "Couldn't write ChatPane.tsx" }],
    ['WebFetch', { url: 'https://docs.example.com/guide' }, { done: 'Read docs.example.com on the web', running: 'Reading docs.example.com on the web…', error: "Couldn't read docs.example.com on the web" }],
    ['WebSearch', { query: 'container queries' }, { done: 'Searched the web for container queries', running: 'Searching the web for container queries…', error: "Couldn't search the web for container queries" }],
    ['Skill', { skill: 'design' }, { done: 'Used design', running: 'Using design…', error: "Couldn't use design" }],
    ['AskUserQuestion', { questions: [{}, {}] }, { done: 'Asked you 2 questions', running: 'Asking you 2 questions…', error: "Couldn't ask you 2 questions" }],
    ['Agent', { subagent_type: 'Explore', description: 'Map old notes' }, { done: 'Sent the scout: Map old notes', running: 'Sending the scout: Map old notes…', error: "Couldn't send the scout: Map old notes" }],
    ['Task', { subagent_type: 'goal-validator', description: 'Final checks' }, { done: 'Sent the validator: Final checks', running: 'Sending the validator: Final checks…', error: "Couldn't send the validator: Final checks" }],
    ['TodoWrite', { todos: [] }, { done: 'Updated the to-do list', running: 'Updating the to-do list…', error: "Couldn't update the to-do list" }],
    ['ExitPlanMode', { plan: 'x' }, { done: 'Proposed a plan', running: 'Proposing a plan…', error: "Couldn't propose a plan" }],
    ['BashOutput', { bash_id: 'b1' }, { done: 'Checked on a background job', running: 'Checking on a background job…', error: "Couldn't check on a background job" }],
    ['TaskOutput', {}, { done: 'Checked on a background job', running: 'Checking on a background job…', error: "Couldn't check on a background job" }],
    ['KillShell', { shell_id: 's1' }, { done: 'Stopped a background job', running: 'Stopping a background job…', error: "Couldn't stop a background job" }],
    ['TaskStop', {}, { done: 'Stopped a background job', running: 'Stopping a background job…', error: "Couldn't stop a background job" }],
    ['mcp__claude_ai_Claude_Docs__batch', {}, { done: 'Used Claude Docs: batch', running: 'Using Claude Docs: batch…', error: "Couldn't use Claude Docs: batch" }],
    ['FrobnicateThing', {}, { done: 'Used FrobnicateThing', running: 'Using FrobnicateThing…', error: "Couldn't use FrobnicateThing" }],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(all(name, input)).toEqual(expected));
  }

  it('a single question reads as one', () => {
    expect(line('AskUserQuestion', { questions: [{}] }, 'done')).toBe('Asked you a question');
  });

  it('keeps the raw tool name for the details, and only a running step has an ellipsis', () => {
    const a = toolAction('Read', { file_path: '/a/b.ts' }, 'running');
    expect(a.raw).toBe('Read');
    expect(a.ellipsis).toBe(true);
    expect(toolAction('Read', { file_path: '/a/b.ts' }, 'done').ellipsis).toBe(false);
  });
});

describe('toolAction: Bash', () => {
  it('conjugates a known leading verb', () => {
    const input = { command: 'cat snapshot.md', description: 'Read the full project snapshot' };
    expect(all('Bash', input)).toEqual({
      done: 'Read the full project snapshot',
      running: 'Reading the full project snapshot…',
      error: 'Tried to read the full project snapshot',
    });
    expect(line('Bash', { command: 'ls', description: 'List the chat components' }, 'done')).toBe('Listed the chat components');
    expect(line('Bash', { command: 'npm run build', description: 'Build the dashboard' }, 'running')).toBe('Building the dashboard…');
    expect(line('Bash', { command: 'npx tsc', description: 'Type-check the dashboard' }, 'done')).toBe('Type-checked the dashboard');
  });

  it('keeps an unknown verb verbatim, still ends a running line in one ellipsis, and fails in words', () => {
    const input = { command: './deploy.sh', description: 'Deploy the preview build' };
    expect(all('Bash', input)).toEqual({
      done: 'Deploy the preview build',
      running: 'Deploy the preview build…',
      error: 'Tried to deploy the preview build',
    });
  });

  it('never doubles an ellipsis the agent already wrote', () => {
    expect(line('Bash', { command: 'x', description: 'Warm the cache…' }, 'running')).toBe('Warm the cache…');
    expect(line('Bash', { command: 'x', description: 'Warm the cache...' }, 'running')).toBe('Warm the cache…');
    expect(line('Bash', { command: 'x', description: 'Warm the cache...' }, 'done')).toBe('Warm the cache');
  });

  it('keeps a name in capitals when a failure lowercases the sentence', () => {
    expect(line('Bash', { command: 'x', description: 'CI checks for the branch' }, 'error')).toBe('Tried to CI checks for the branch');
  });

  it('with no description it ran a command, and the command is the subtitle', () => {
    const a = toolAction('Bash', { command: 'git status' }, 'done');
    expect(a.verb).toBe('Ran a command');
    expect(a.subject).toEqual({ kind: 'prose', text: 'git status' });
    expect(line('Bash', { command: 'git status' }, 'running')).toBe('Running a command git status…');
  });

  it('a quest-only command is quiet bookkeeping in all three tenses', () => {
    const input = { command: 'dreamcontext goal-live phase review && dreamcontext goal-live actor critic,pragmatist --kind fresh --round 1' };
    const done = toolAction('Bash', input, 'done');
    expect(done).toMatchObject({ verb: 'Updated the quest map', kind: 'quest', quiet: true, subject: null });
    expect(line('Bash', input, 'running')).toBe('Updating the quest map…');
    expect(line('Bash', input, 'error')).toBe("Couldn't update the quest map");
  });

  it('a goal-live call chained onto real work is not quest-only, and drops out of the subtitle', () => {
    const command = 'dreamcontext goal-live state critic=NEEDS_WORK && dreamcontext tasks log quest-demo "round 1 sent back"';
    expect(isQuestOnlyCommand(command)).toBe(false);
    const a = toolAction('Bash', { command }, 'done');
    expect(a.quiet).toBe(false);
    expect(a.subject).toEqual({ kind: 'prose', text: 'dreamcontext tasks log quest-demo "round 1 sent back"' });
  });

  it('isQuestOnlyCommand', () => {
    expect(isQuestOnlyCommand('dreamcontext goal-live phase plan')).toBe(true);
    expect(isQuestOnlyCommand('npx dreamcontext goal-live clear')).toBe(true);
    expect(isQuestOnlyCommand('echo goal-live')).toBe(false);
    expect(isQuestOnlyCommand('dreamcontext tasks list')).toBe(false);
    expect(isQuestOnlyCommand(undefined)).toBe(false);
    expect(isQuestOnlyCommand('')).toBe(false);
  });

  it('reads the three headless teammate forms, and the parallel subshell form', () => {
    const fork = 'claude -p --resume planner-x --fork-session "T3 verify lane"';
    const resume = "claude -p --resume planner-x 'Revise the plan'";
    const brief = 'claude -p "Draft the plan" --output-format json';
    const subshell = 'dreamcontext goal-live actor "T1=Role registry,T2=Tokens" --role implementer --kind fork --from planner && (claude -p --resume planner-x --fork-session "T1" & claude -p --resume planner-x --fork-session "T2" & wait)';
    expect(all('Bash', { command: fork })).toEqual({
      done: "Started a builder with the Planner's memory",
      running: "Starting a builder with the Planner's memory…",
      error: "Couldn't start a builder with the Planner's memory",
    });
    expect(all('Bash', { command: resume })).toEqual({
      done: 'Brought a teammate back where it left off',
      running: 'Bringing a teammate back where it left off…',
      error: "Couldn't bring a teammate back where it left off",
    });
    expect(all('Bash', { command: brief })).toEqual({
      done: 'Briefed a new teammate',
      running: 'Briefing a new teammate…',
      error: "Couldn't brief a new teammate",
    });
    expect(line('Bash', { command: subshell }, 'done')).toBe("Started a builder with the Planner's memory");
    expect(line('Bash', { command: '"claude" -p --fork-session "x"' }, 'done')).toBe("Started a builder with the Planner's memory");
    expect(toolAction('Bash', { command: fork }, 'done').kind).toBe('delegate');
  });

  it('a flag named inside a prompt is not a flag', () => {
    expect(line('Bash', { command: 'claude -p "never pass --fork-session here"' }, 'done')).toBe('Briefed a new teammate');
  });

  it('no headless line says how it is wired', () => {
    for (const command of ['claude -p --resume a --fork-session x', 'claude -p --resume a x', 'claude -p x']) {
      for (const status of ['running', 'done', 'error'] as const) {
        expect(toolAction('Bash', { command }, status).verb).not.toMatch(JARGON_RE);
      }
    }
  });
});

describe('actionText', () => {
  const base: ToolAction = { verb: '', subject: null, kind: 'other', quiet: false, ellipsis: false, raw: 'Bash' };

  it('joins verb and tail with single spaces', () => {
    expect(actionText({ ...base, verb: 'Thesis promote', tail: 'failed' })).toBe('Thesis promote failed');
  });

  it('joins verb, subject and tail, reading a path by its filename', () => {
    const a: ToolAction = { ...base, verb: 'Reading', subject: { kind: 'path', path: '/a/b/ChatPane.tsx' }, tail: 'again', ellipsis: true };
    expect(actionText(a)).toBe('Reading ChatPane.tsx again…');
    expect(actionText({ ...a, subject: { kind: 'path', path: '/a/b/x.md', label: 'Fix the parser' }, tail: undefined, ellipsis: false }))
      .toBe('Reading Fix the parser');
    expect(actionText({ ...base, verb: 'Searched for', subject: { kind: 'text', text: 'useQuest' } })).toBe('Searched for useQuest');
  });

  it('strips an existing trailing ellipsis before adding its own', () => {
    expect(actionText({ ...base, verb: 'Deploying…', ellipsis: true })).toBe('Deploying…');
    expect(actionText({ ...base, verb: 'Deploying...', ellipsis: false })).toBe('Deploying');
  });
});

describe('thinkingLabel', () => {
  it('reads in the same tense grammar as a step', () => {
    expect(thinkingLabel(true)).toBe('Thinking it through…');
    expect(thinkingLabel(false)).toBe('Thought it through');
  });
});

describe('workBeatHeadline', () => {
  const item = (name: string, input: unknown = {}, startedAt = 0, endedAt = 1000) =>
    ({ name, input, status: 'done' as const, startedAt, endedAt });
  const goalLive = item('Bash', { command: 'dreamcontext goal-live phase review' });

  it('a stretch of looking reads "Looked around", and bookkeeping is not a step', () => {
    const items = [
      item('Read', { file_path: '/a' }), item('Read', { file_path: '/b' }), item('Grep', { pattern: 'x' }),
      item('Bash', { command: 'ls', description: 'List the chat components' }), goalLive,
    ];
    expect(workBeatHeadline(items)).toBe('Looked around: 4 steps · 2 files read · 1 command');
  });

  it('any change makes it "Made changes", keeping the counts', () => {
    const items = [
      item('Read'), item('Read'), item('Read'), item('Edit'),
      item('Bash', { command: 'npm test', description: 'Run the tests' }),
      item('Bash', { command: 'npx tsc' }), item('Grep'), goalLive,
    ];
    const headline = workBeatHeadline(items);
    expect(headline.startsWith('Made changes: ')).toBe(true);
    expect(headline).toContain('7 steps · 3 files read · 2 commands');
  });

  it('mostly running reads "Ran checks", otherwise "Worked through it"', () => {
    expect(workBeatHeadline([
      item('Bash', { command: 'npm test', description: 'Run the tests' }),
      item('Bash', { command: 'npx tsc', description: 'Type-check the dashboard' }),
      item('Read'),
    ])).toBe('Ran checks: 3 steps · 1 file read · 2 commands');
    expect(workBeatHeadline([item('Read'), item('TodoWrite'), item('Skill', { skill: 'design' }), item('FrobnicateThing')]))
      .toBe('Worked through it: 4 steps · 1 file read');
  });
});

describe('stepStretches', () => {
  const p = (key: string, over: Partial<StretchProbe> = {}): StretchProbe =>
    ({ key, step: true, invisible: false, actor: 'lead', running: false, ...over });

  it('the first step leads, the rest follow', () => {
    const m = stepStretches([p('a'), p('b'), p('c')]);
    expect([...m.entries()]).toEqual([
      ['a', { stretch: 'lead', running: false }],
      ['b', { stretch: 'follow', running: false }],
      ['c', { stretch: 'follow', running: false }],
    ]);
  });

  it('an invisible item neither joins nor breaks a stretch', () => {
    const m = stepStretches([p('a'), p('ghost', { invisible: true, step: false }), p('b')]);
    expect(m.has('ghost')).toBe(false);
    expect(m.get('b')).toEqual({ stretch: 'follow', running: false });
  });

  it('a non-step breaks it', () => {
    const m = stepStretches([p('a'), p('msg', { step: false }), p('b')]);
    expect(m.has('msg')).toBe(false);
    expect(m.get('b')?.stretch).toBe('lead');
  });

  it('an actor change starts a new stretch', () => {
    const m = stepStretches([p('a'), p('b', { actor: 'planner' }), p('c', { actor: 'planner' })]);
    expect(m.get('b')?.stretch).toBe('lead');
    expect(m.get('c')?.stretch).toBe('follow');
  });

  it('only the lead runs, and it runs while any step in its stretch does', () => {
    const m = stepStretches([p('a'), p('b'), p('c', { running: true }), p('msg', { step: false }), p('d')]);
    expect(m.get('a')).toEqual({ stretch: 'lead', running: true });
    expect(m.get('c')).toEqual({ stretch: 'follow', running: false });
    expect(m.get('d')).toEqual({ stretch: 'lead', running: false });
  });

  it('a run segment that leads is running when a later step runs', () => {
    const m = stepStretches([p('run-1'), p('dream', { running: true })]);
    expect(m.get('run-1')?.running).toBe(true);
  });
});
