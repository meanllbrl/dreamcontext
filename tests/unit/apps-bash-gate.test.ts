import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { LISTED_VERBS, REFUSED_FLAGS, classifyBash, gateHookOutput, parseCommand, parseGateContext, type BashGateContext } from '../../src/lib/apps/bash-gate.js';
import { createProgram } from '../../src/cli/program.js';

/** The Bash gate's table (plan r9, D6): every row of the task's criterion, in its own words. */

let root: string;
let ctx: BashGateContext;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-gate-')));
  mkdirSync(join(root, 'app', 'public'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  ctx = { slug: 'yuk', appRoot: join(root, 'app'), dataDir: join(root, 'data'), actions: ['snapshot'] };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const verdict = (c: string) => classifyBash(c, ctx).decision;

describe('runs with no card', () => {
  it.each([
    'dreamcontext memory recall "R&D"',
    'dreamcontext memory recall q --top 3 --types knowledge',
    'dreamcontext memory recall q -t 3 --json',
    'dreamcontext lab show weekly-active --json',
    'dreamcontext knowledge index --plain',
    'dreamcontext tasks list -s todo --json',
    'dreamcontext apps actions yuk',
    'dreamcontext apps status yuk',
    'dreamcontext apps logs yuk -n 20',
    `dreamcontext apps do yuk snapshot --input '{"q":"a;b"}'`,
  ])('%s', (c) => expect(verdict(c)).toBe('pass'));
  it('`ls` of the app root and the data dir', () => {
    expect(verdict(`ls ${ctx.appRoot}`)).toBe('pass');
    expect(verdict(`ls -la ${ctx.dataDir}`)).toBe('pass');
    expect(verdict(`ls ${join(ctx.appRoot, 'public')}`)).toBe('pass');
  });
});

describe('raises one card', () => {
  const q = "'";
  it.each([
    ['grep -r', 'grep -r TOKEN .'],
    ['git grep', 'git grep TOKEN'],
    ['git show', 'git show HEAD:.env'],
    ['find', 'find . -name .env'],
    ['a redirect', 'echo hi > x'],
    ['--vault <path>', 'dreamcontext memory recall q --vault /x'],
    ['--vault=<path>', 'dreamcontext memory recall q --vault=/x'],
    ['"--vault" <path>', 'dreamcontext memory recall q "--vault" /x'],
    ["'--vault' <path>", "dreamcontext memory recall q '--vault' /x"],
    ['\\--vault <path>', 'dreamcontext memory recall q \\--vault /x'],
    ['--va""ult <path>', 'dreamcontext memory recall q --va""ult /x'],
    ['--all-vaults', 'dreamcontext memory recall q --all-vaults'],
    ['--connected', 'dreamcontext memory recall q --connected'],
    ['a sibling app', 'dreamcontext apps logs other'],
    ['a danger action', 'dreamcontext apps do yuk wipe'],
    ['apps call', 'dreamcontext apps call yuk GET /x'],
    ['ls ~', 'ls ~'],
    ['ls /etc', 'ls /etc'],
    ['a newline form', 'dreamcontext memory recall q\ngrep -r X .'],
    ['a line continuation', 'dreamcontext memory recall q \\\n--vault /x'],
    ['a # that hides a newline in single quotes', `dreamcontext memory recall q # ${q}\ngrep -r X . #${q}`],
    ['a # that hides a newline in double quotes', 'dreamcontext memory recall q # "\ngrep -r X . #"'],
    ['$HOME in double quotes', 'dreamcontext memory recall "$HOME"'],
    ['a backtick in double quotes', 'dreamcontext memory recall "`id`"'],
    ['an unbalanced quote', 'dreamcontext memory recall "q'],
    ['an unquoted #', 'dreamcontext memory recall q # x'],
    ['a glob', 'ls *'],
  ])('%s', (_n, c) => expect(verdict(c)).toBe('ask'));
  it('the newline forms after `ls <app root>` too', () => {
    expect(verdict(`ls ${ctx.appRoot} # ${q}\ngrep -r X . #${q}`)).toBe('ask');
    expect(verdict(`ls ${ctx.appRoot} # "\ngrep -r X . #"`)).toBe('ask');
  });
});

describe('denied with the bare form, no card', () => {
  it.each([
    'cd x && dreamcontext memory recall q | head',
    'ls x 2>/dev/null',
    'cd x && ls',
    'sed -n 1,80p x',
    'cat x | head',
    'cd x && cat y',
    'cat ~/x',
    'wc -l src/*.ts',
    'cat x\ny',
    'ls',
    'ls public',
    'dreamcontext apps status yuk | head',
  ])('%s', (c) => expect(verdict(c)).toBe('deny'));
  it('names both absolute paths for a bare ls, and Read for a file', () => {
    const d = classifyBash('ls', ctx);
    expect('reason' in d && d.reason).toContain(ctx.appRoot);
    expect('reason' in d && d.reason).toContain(ctx.dataDir);
    const r = classifyBash('head -5 x', ctx);
    expect('reason' in r && r.reason).toContain('Read');
  });
});

describe('the parser', () => {
  it('takes quotes off and keeps a quoted splitter in its token', () => {
    expect(parseCommand(`a "b;c" d'e'f`)).toEqual({ parts: [['a', 'b;c', 'def']] });
    expect(parseCommand('a && b')).toEqual({ parts: [['a'], ['b']] });
  });
  it('accepts Turkish letters as plain text', () => {
    expect(verdict('dreamcontext memory recall yük')).toBe('pass');
  });
});

describe('the hook output', () => {
  it('prints an empty object, or one decision; never allow', () => {
    expect(gateHookOutput({ decision: 'pass' })).toEqual({});
    expect(JSON.stringify(gateHookOutput({ decision: 'ask', reason: 'x' }))).toContain('"permissionDecision":"ask"');
    expect(JSON.stringify(gateHookOutput({ decision: 'deny', reason: 'x' }))).toContain('"permissionDecision":"deny"');
  });
  it('refuses a malformed gate file', () => {
    expect(parseGateContext('{')).toBeNull();
    expect(parseGateContext('{"slug":"a"}')).toBeNull();
    expect(parseGateContext(JSON.stringify(ctx))).toEqual(ctx);
  });
});

describe('drift: every option of a listed verb is decided', () => {
  const find = (program: Command, words: readonly string[]): Command => {
    let at = program;
    for (const w of words) {
      const next = at.commands.find((c) => c.name() === w);
      if (!next) throw new Error(`no command ${words.join(' ')}`);
      at = next;
    }
    return at;
  };
  it.each(LISTED_VERBS.map((v) => [v.words.join(' '), v] as const))('%s', (name, verb) => {
    const options = find(createProgram(), verb.words).options.flatMap((o) => [o.short, o.long]).filter((f): f is string => !!f);
    const refused = REFUSED_FLAGS[name] ?? [];
    for (const f of options) expect([...verb.flags, ...refused, '-h', '--help'], `${name} ${f}`).toContain(f);
    for (const f of verb.flags) expect(options, `${name} ${f}`).toContain(f);
  });
});
