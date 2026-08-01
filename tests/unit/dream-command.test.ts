import { describe, it, expect } from 'vitest';
import {
  parseDreamActions, isDreamcontextCommand, describeDreamAction, dreamOutcome,
  splitShellSegments, tokenizeShell, domainNoun, cliEndpoint,
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

  it('domainNoun singularises without a table where the table is not needed', () => {
    expect(domainNoun('tasks')).toBe('Task');
    expect(domainNoun('connections')).toBe('Connection');
    expect(domainNoun('theses')).toBe('Thesis');
    expect(domainNoun('people')).toBe('Person');
    expect(domainNoun('tasks', true)).toBe('Tasks');
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
