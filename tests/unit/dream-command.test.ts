import { describe, it, expect } from 'vitest';
import {
  parseDreamActions, isDreamcontextCommand, describeDreamAction, dreamOutcome,
  splitShellSegments, tokenizeShell, domainNoun, cliEndpoint,
  VERBS, DREAM_VERB_FORMS, dreamActionPhrase, isQuietDreamSegment,
} from '../../dashboard/src/components/sleepy/chat/dreamCommand';

/**
 * The transcript's recognition of dreamcontext's own CLI. Every case here is a command shape
 * the agent actually writes in this repo — the point of the feature is that the row says what
 * the call DID, so a parse that is subtly wrong is worse than no parse at all.
 */

describe('splitShellSegments', () => {
  it('splits on shell separators', () => {
    expect(splitShellSegments('a && b || c ; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops a heredoc body — text written to a file is not work performed', () => {
    const command = [
      "cat <<'EOF' > notes.md",
      'dreamcontext tasks create "Never actually ran"',
      'EOF',
      'dreamcontext tasks list',
    ].join('\n');
    expect(splitShellSegments(command)).toEqual(["cat <<'EOF' > notes.md", 'dreamcontext tasks list']);
    expect(parseDreamActions(command).map((a) => a.path)).toEqual(['tasks list']);
  });

  it('keeps the line that OPENED the heredoc — it can be a real invocation', () => {
    const command = ['dreamcontext tasks insert t notes "$(cat)" <<EOF', 'body text', 'EOF'].join('\n');
    expect(parseDreamActions(command).map((a) => a.path)).toEqual(['tasks insert']);
  });

  it('does not split inside quotes', () => {
    // The reason this exists: an inserted acceptance criterion routinely contains `;` or `&&`.
    expect(splitShellSegments('dreamcontext tasks insert t Notes "a; b && c"'))
      .toEqual(['dreamcontext tasks insert t Notes "a; b && c"']);
  });
});

describe('tokenizeShell', () => {
  it('keeps a quoted phrase as one token', () => {
    expect(tokenizeShell('dreamcontext tasks create "Fix the parser"'))
      .toEqual(['dreamcontext', 'tasks', 'create', 'Fix the parser']);
  });

  it('keeps an empty quoted string as a token', () => {
    expect(tokenizeShell('x --why ""')).toEqual(['x', '--why', '']);
  });

  it('unescapes inside double quotes and honours single quotes literally', () => {
    expect(tokenizeShell('x "a \\"b\\" c" \'d e\'')).toEqual(['x', 'a "b" c', 'd e']);
  });
});

describe('parseDreamActions', () => {
  it('reads domain, action, and the subject argument', () => {
    const [a] = parseDreamActions('dreamcontext tasks create "Fix the parser"');
    expect(a.path).toBe('tasks create');
    expect(a.domain).toBe('tasks');
    expect(a.action).toBe('create');
    expect(a.args).toEqual(['Fix the parser']);
    expect(a.known).toBe(true);
    expect(a.desc).toBe('Create a new task');
  });

  it('does not mistake a flag VALUE for the subject', () => {
    // The manifest's `valueFlags` is what makes this work — without it the row would be
    // titled "high", which is exactly the class of quiet wrongness this feature must not add.
    const [a] = parseDreamActions('dreamcontext tasks create -p high --why "it breaks" "Fix the parser"');
    expect(a.args).toEqual(['Fix the parser']);
    expect(a.flags['-p']).toBe('high');
    expect(a.flags['--why']).toBe('it breaks');
  });

  it('handles --flag=value', () => {
    const [a] = parseDreamActions('dreamcontext memory recall "context root" --types=task');
    expect(a.args).toEqual(['context root']);
    expect(a.flags['--types']).toBe('task');
  });

  it('keeps every action in a chained command, in order', () => {
    const actions = parseDreamActions(
      'dreamcontext tasks create "A" && dreamcontext tasks insert a Notes "x" && dreamcontext tasks insert a Notes "y"',
    );
    expect(actions.map((a) => a.path)).toEqual(['tasks create', 'tasks insert', 'tasks insert']);
    expect(actions[2].args).toEqual(['a', 'Notes', 'y']);
  });

  it('finds dreamcontext behind a wrapper, a path, or an env assignment', () => {
    expect(parseDreamActions('npx dreamcontext snapshot')[0]?.path).toBe('snapshot');
    expect(parseDreamActions('/usr/local/bin/dreamcontext doctor')[0]?.path).toBe('doctor');
    expect(parseDreamActions('DEBUG=1 dreamcontext sleep status')[0]?.path).toBe('sleep status');
  });

  it('stops descending at a leaf, so an argument is never read as a subcommand', () => {
    // `tasks status <name> <new-status>` — `create` here is a task NAME, not `tasks create`.
    const [a] = parseDreamActions('dreamcontext tasks status create in_progress');
    expect(a.path).toBe('tasks status');
    expect(a.args).toEqual(['create', 'in_progress']);
  });

  it('ignores a command that only MENTIONS dreamcontext', () => {
    expect(parseDreamActions('grep -rn dreamcontext src/')).toEqual([]);
    expect(parseDreamActions('echo "run dreamcontext tasks create"')).toEqual([]);
    expect(parseDreamActions('git commit -m "use dreamcontext tasks"')).toEqual([]);
  });

  it('still names a command this build has never heard of', () => {
    const [a] = parseDreamActions('dreamcontext frobnicate widgets --deep');
    expect(a.known).toBe(false);
    expect(a.domain).toBe('frobnicate');
    expect(a.action).toBe('widgets');
  });

  it('isDreamcontextCommand mirrors the parse', () => {
    expect(isDreamcontextCommand('dreamcontext tasks list')).toBe(true);
    expect(isDreamcontextCommand('npm test')).toBe(false);
    expect(isDreamcontextCommand(undefined)).toBe(false);
  });

  it('yields no action for quest-map bookkeeping, and keeps the work it is chained onto', () => {
    // `goal-live` is the quest map drawing itself; a row for it would report bookkeeping as work.
    expect(parseDreamActions('dreamcontext goal-live phase review')).toEqual([]);
    expect(parseDreamActions('npx dreamcontext goal-live actor critic,pragmatist --kind fresh --round 2')).toEqual([]);
    expect(isDreamcontextCommand('dreamcontext goal-live state critic=SOLID')).toBe(false);
    const chained = parseDreamActions('dreamcontext goal-live state critic=NEEDS_WORK && dreamcontext tasks log quest-demo "sent back"');
    expect(chained.map((a) => a.path)).toEqual(['tasks log']);
  });

  it('isQuietDreamSegment names one goal-live segment and nothing else', () => {
    expect(isQuietDreamSegment('dreamcontext goal-live clear')).toBe(true);
    expect(isQuietDreamSegment('DEBUG=1 npx dreamcontext goal-live phase done')).toBe(true);
    expect(isQuietDreamSegment('dreamcontext tasks list')).toBe(false);
    expect(isQuietDreamSegment('echo dreamcontext goal-live')).toBe(false);
  });
});

describe('describeDreamAction', () => {
  const view = (command: string) => describeDreamAction(parseDreamActions(command)[0]);

  it('names the object and the action, not the tool', () => {
    expect(view('dreamcontext tasks create "Fix the parser"')).toMatchObject({
      label: 'Task created', tone: 'write', subject: 'Fix the parser',
    });
  });

  it('carries the trailing positionals as the detail', () => {
    expect(view('dreamcontext tasks status my-task in_progress')).toMatchObject({
      label: 'Task status', subject: 'my-task', detail: 'in_progress',
    });
  });

  it('reads a lookup as a read and a change as a write', () => {
    expect(view('dreamcontext memory recall "context root"').tone).toBe('read');
    expect(view('dreamcontext tasks list').tone).toBe('read');
    expect(view('dreamcontext knowledge create "Recall engine"').tone).toBe('write');
    expect(view('dreamcontext tasks delete my-task').tone).toBe('destructive');
  });

  it('resolves an arity-sensitive verb by its arguments', () => {
    // `status` ASKS with no argument and ORDERS with one — same word, opposite consequence.
    expect(view('dreamcontext sleep status').tone).toBe('read');
    expect(view('dreamcontext tasks status my-task completed').tone).toBe('write');
  });

  it('renders a command with no subcommand as its own noun', () => {
    expect(view('dreamcontext snapshot')).toMatchObject({ label: 'Snapshot', tone: 'read' });
  });

  it('describes an endpoint the lexicon has never seen', () => {
    // The generic path — nothing in this file mentions `theses`' verbs. If this ever needs a
    // lexicon entry to pass, the auto-detection promise has been broken.
    const [action] = parseDreamActions('dreamcontext theses list');
    expect(describeDreamAction(action).label).toBe('Theses list');
  });

  it('carries the verb key and the noun the label used, on every view', () => {
    for (const command of [
      'dreamcontext tasks create "A"', 'dreamcontext tasks list', 'dreamcontext snapshot',
      'dreamcontext sleep status', 'dreamcontext theses promote x', 'dreamcontext frobnicate widgets',
    ]) {
      const v = view(command);
      expect(typeof v.verbKey).toBe('string');
      expect(typeof v.noun).toBe('string');
      expect(v.label.startsWith(v.noun)).toBe(true);
    }
    expect(view('dreamcontext tasks list')).toMatchObject({ verbKey: 'list', noun: 'Tasks' });
    expect(view('dreamcontext snapshot')).toMatchObject({ verbKey: '', noun: 'Snapshot' });
  });

  it('a verb token that names a prototype property is just an unknown verb', () => {
    const v = view('dreamcontext frobnicate constructor');
    expect(v).toMatchObject({ label: 'Frobnicate constructor', tone: 'write', verbKey: 'constructor' });
    // Read off the prototype, `constructor` would be a function with no `failed` form to call.
    expect(dreamActionPhrase(v, 'error')).toEqual({ verb: 'Frobnicate constructor', tail: 'failed' });
  });

  it('domainNoun singularises without a table where the table is not needed', () => {
    expect(domainNoun('tasks')).toBe('Task');
    expect(domainNoun('connections')).toBe('Connection');
    expect(domainNoun('theses')).toBe('Thesis');
    expect(domainNoun('people')).toBe('Person');
    expect(domainNoun('tasks', true)).toBe('Tasks');
  });
});

describe('dreamActionPhrase', () => {
  const view = (command: string) => describeDreamAction(parseDreamActions(command)[0]);
  const phrase = (command: string, status: 'running' | 'done' | 'error') => dreamActionPhrase(view(command), status);

  // Irregular past forms a VERBS label can take without ending in "ed".
  const IRREGULAR_PAST = new Set(['set', 'done', 'made', 'built', 'sent', 'run', 'ran', 'got', 'kept', 'left', 'lost', 'put', 'read', 'shut', 'split', 'taken', 'wrote', 'written']);

  it('names a running and a failed form for every past-tense verb (read off VERBS, not copied)', () => {
    const pastTense = Object.entries(VERBS)
      .filter(([key, v]) => key !== 'set' && (/ed$/.test(v.text) || IRREGULAR_PAST.has(v.text)))
      .map(([key]) => key);
    expect(pastTense.length).toBeGreaterThanOrEqual(21);
    for (const key of pastTense) expect(Object.prototype.hasOwnProperty.call(DREAM_VERB_FORMS, key), key).toBe(true);
  });

  it('covers every VERBS key, so the fallback applies only to verbs nobody named', () => {
    for (const key of Object.keys(VERBS)) expect(Object.prototype.hasOwnProperty.call(DREAM_VERB_FORMS, key), key).toBe(true);
  });

  it('reads tasks create in all three tenses', () => {
    expect(phrase('dreamcontext tasks create "Quest demo"', 'running')).toEqual({ verb: 'Creating task' });
    expect(phrase('dreamcontext tasks create "Quest demo"', 'error')).toEqual({ verb: "Couldn't create task" });
    expect(phrase('dreamcontext tasks create "Quest demo"', 'done')).toEqual({ verb: 'Task created' });
  });

  it('reads the other verbs by their own words', () => {
    expect(phrase('dreamcontext tasks complete x', 'running')).toEqual({ verb: 'Completing task' });
    expect(phrase('dreamcontext tasks delete x', 'error')).toEqual({ verb: "Couldn't delete task" });
    expect(phrase('dreamcontext tasks insert x notes "y"', 'running')).toEqual({ verb: 'Adding to task' });
    expect(phrase('dreamcontext tasks list', 'running')).toEqual({ verb: 'Listing tasks' });
    expect(phrase('dreamcontext memory recall "context root"', 'error')).toEqual({ verb: "Couldn't recall memory" });
  });

  it('reads an arity-sensitive verb by what the call did', () => {
    expect(phrase('dreamcontext sleep status', 'running')).toEqual({ verb: 'Checking sleep status' });
    expect(phrase('dreamcontext sleep status', 'error')).toEqual({ verb: "Couldn't check sleep status" });
    expect(phrase('dreamcontext tasks status x in_progress', 'running')).toEqual({ verb: 'Setting task status' });
    expect(phrase('dreamcontext tasks status x in_progress', 'error')).toEqual({ verb: "Couldn't set task status" });
    expect(phrase('dreamcontext tasks due x 2026-10-01', 'error')).toEqual({ verb: "Couldn't set task due date" });
    expect(phrase('dreamcontext tasks status x in_progress', 'done')).toEqual({ verb: 'Task status' });
  });

  it('keeps the label for a verb nobody named, and says it failed', () => {
    expect(phrase('dreamcontext theses promote x', 'error')).toEqual({ verb: 'Thesis promote', tail: 'failed' });
    expect(phrase('dreamcontext theses promote x', 'running')).toEqual({ verb: 'Thesis promote' });
  });
});

describe('dreamOutcome', () => {
  it('reads the CLI’s own success line', () => {
    expect(dreamOutcome('some noise\n✓ Task created: fix-the-parser.md\n', 'tasks')).toEqual({
      tone: 'ok',
      text: 'Task created: fix-the-parser.md',
      path: '_dream_context/state/fix-the-parser.md',
    });
  });

  it('reports a failure the CLI printed even when nothing threw', () => {
    expect(dreamOutcome('✗ Task already exists: foo.md', 'tasks')).toMatchObject({ tone: 'error' });
  });

  it('takes the LAST outcome line — a warning followed by a success ended in success', () => {
    expect(dreamOutcome('⚠ no version set\n✓ Task created: a.md', 'tasks')?.tone).toBe('ok');
  });

  it('prefers a path the output actually printed', () => {
    expect(dreamOutcome('✓ Moved _dream_context/knowledge/a.md → _dream_context/knowledge/b/a.md', 'knowledge')?.path)
      .toBe('_dream_context/knowledge/a.md');
  });

  it('invents no path for a domain whose files are not flat', () => {
    // Knowledge nests in subfolders, so `<slug>.md` does not locate the file — and a chip that
    // opens nothing is worse than a chip that only names.
    expect(dreamOutcome('✓ Knowledge file created: recall-engine.md', 'knowledge')?.path).toBeUndefined();
  });

  it('is null when the command reported nothing', () => {
    expect(dreamOutcome('a\nb\nc', 'memory')).toBeNull();
    expect(dreamOutcome(undefined, 'tasks')).toBeNull();
  });
});

describe('manifest lookup', () => {
  it('exposes the real endpoint, so a row can explain itself from the CLI’s own words', () => {
    expect(cliEndpoint('tasks create')?.desc).toBe('Create a new task');
    expect(cliEndpoint('tasks')?.group).toBe(true);
  });
});
