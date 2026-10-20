/**
 * `dreamcontext tasks handoff <slug> [note]` — the command the agent runs to move its
 * state into the task and let a fresh session continue.
 *
 * Drives the REAL CLI command against a scratch vault (same harness shape as
 * task-backend-golden.test.ts) and asserts every effect the acceptance criterion names:
 *   - the note lands in the task changelog
 *   - the task is set in_progress (and left alone when it already is)
 *   - state/.handoff-requests/<key>.json is written with the pinned schema
 *   - a CompactionRecord {trigger:'handoff', context_tokens} is appended
 *   - state/.active-task is NEVER written (removed in review: it raced across tabs)
 *   - a second handoff OVERWRITES rather than accumulating
 *   - the key follows the pane, then the conversation
 *   - a handoff missing ANY part of the state is REFUSED and writes nothing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { readHandoffRecord, handoffDir } from '../../src/lib/context-watch.js';

const TAB = '11111111-2222-3333-4444-555555555555';
const SES = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let projectRoot: string;
let contextRoot: string;
let stateDir: string;
let prevCwd: string;
let prevEnv: Record<string, string | undefined>;

async function cli(...argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}

const taskFile = (slug: string) => readFileSync(join(stateDir, `${slug}.md`), 'utf-8');

/** Every required part, answered. A handoff without them is refused. */
const STATE = [
  '--done', 'Parser done and green: 14 unit tests pass, criteria 1-2 ticked.',
  '--next', 'Write the serializer in src/writer.ts, then tick criterion 3.',
  '--decisions', 'Kept the tokenizer streaming — the files are up to 2 GB.',
  '--learned', 'none',
  '--style', 'npm test after every edit; the user wants small commits.',
  '--files', 'src/writer.ts:40',
];

beforeEach(async () => {
  const raw = join(tmpdir(), `dc-handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  prevEnv = {
    DREAMCONTEXT_TAB_SESSION: process.env.DREAMCONTEXT_TAB_SESSION,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
  };
  delete process.env.DREAMCONTEXT_TAB_SESSION;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  await cli('tasks', 'create', 'Ship the thing', '-w', 'Because the thing must ship');
});

afterEach(() => {
  process.exitCode = undefined;
  process.chdir(prevCwd);
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('tasks handoff', () => {
  it('writes every part as ONE changelog entry and sets the task in_progress', async () => {
    await cli('tasks', 'handoff', 'ship-the-thing', ...STATE, 'Ping the owner before merging.');
    const md = taskFile('ship-the-thing');
    const entry = md.slice(md.indexOf('- Handoff'));
    expect(entry).toContain('**Done:** Parser done and green');
    expect(entry).toContain('**Next:** Write the serializer');
    expect(entry).toContain('**Decisions:** Kept the tokenizer streaming');
    expect(entry).toContain('**Learned:** none');
    expect(entry).toContain('**Working style:** npm test after every edit');
    expect(entry).toContain('**Open files:** src/writer.ts:40');
    expect(entry).toContain('**Note:** Ping the owner before merging.');
    expect(md).toContain('status: in_progress');
  });

  it('REFUSES a bare handoff and writes nothing — no entry, no status, no record, no log', async () => {
    const before = taskFile('ship-the-thing');
    await cli('tasks', 'handoff', 'ship-the-thing');
    expect(process.exitCode).toBe(1);
    expect(taskFile('ship-the-thing')).toBe(before);
    expect(existsSync(handoffDir(contextRoot))).toBe(false);
    expect(existsSync(join(stateDir, '.sleep.json'))).toBe(false);
  });

  it('REFUSES when one part is missing, and when --done / --next are too thin', async () => {
    const withoutFiles = STATE.slice(0, -2);
    await cli('tasks', 'handoff', 'ship-the-thing', ...withoutFiles);
    expect(process.exitCode).toBe(1);
    expect(existsSync(handoffDir(contextRoot))).toBe(false);

    process.exitCode = undefined;
    const thinNext = [...STATE];
    thinNext[3] = 'continue';
    await cli('tasks', 'handoff', 'ship-the-thing', ...thinNext);
    expect(process.exitCode).toBe(1);
    expect(existsSync(handoffDir(contextRoot))).toBe(false);
  });

  it('writes the handoff record with the pinned schema, keyed by the PANE', async () => {
    process.env.DREAMCONTEXT_TAB_SESSION = TAB;
    process.env.CLAUDE_CODE_SESSION_ID = SES;
    await cli('tasks', 'handoff', 'ship-the-thing', ...STATE, 'note');

    const record = readHandoffRecord(contextRoot, TAB);
    expect(record).not.toBeNull();
    expect(record!.task).toBe('ship-the-thing');
    expect(record!.title).toBe('Ship the thing');
    expect(record!.tab).toBe(TAB);
    expect(record!.fromSession).toBe(SES);
    expect(Number.isFinite(Date.parse(record!.at))).toBe(true);
    // No transcript exists in a scratch vault, so the size is honestly unknown.
    expect(record!.contextTokens).toBeNull();
    // Neither stamp is written by THIS command — agent-chat owns actedAt, the
    // SessionStart hook owns consumedAt.
    expect(record!.actedAt).toBeUndefined();
    expect(record!.consumedAt).toBeUndefined();
  });

  it('falls back to the CONVERSATION id when there is no pane', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SES;
    await cli('tasks', 'handoff', 'ship-the-thing', ...STATE);
    const record = readHandoffRecord(contextRoot, SES);
    expect(record?.task).toBe('ship-the-thing');
    expect(record?.tab).toBeNull();
  });

  it('OVERWRITES on a second handoff instead of accumulating records', async () => {
    process.env.DREAMCONTEXT_TAB_SESSION = TAB;
    await cli('tasks', 'handoff', 'ship-the-thing', ...STATE, 'first');
    await cli('tasks', 'create', 'Other work', '-w', 'Also needs doing');
    await cli('tasks', 'handoff', 'other-work', ...STATE, 'second');

    expect(readdirSync(handoffDir(contextRoot)).filter((f) => f.endsWith('.json')).length).toBe(1);
    expect(readHandoffRecord(contextRoot, TAB)?.task).toBe('other-work');
  });

  it('appends a CompactionRecord {trigger:"handoff"} to the sleep state', async () => {
    await cli('tasks', 'handoff', 'ship-the-thing', ...STATE);
    const sleepPath = join(stateDir, '.sleep.json');
    expect(existsSync(sleepPath)).toBe(true);
    const state = JSON.parse(readFileSync(sleepPath, 'utf-8')) as {
      compaction_log: Array<{ trigger: string; context_tokens?: number }>;
    };
    expect(state.compaction_log[0].trigger).toBe('handoff');
    // context_tokens is OPTIONAL — absent here because the scratch vault has no
    // transcript to measure, which is exactly the backward-compat shape.
    expect(state.compaction_log[0].context_tokens).toBeUndefined();
  });

  it('NEVER writes state/.active-task — removed in review (raced across tabs)', async () => {
    process.env.DREAMCONTEXT_TAB_SESSION = TAB;
    await cli('tasks', 'handoff', 'ship-the-thing', ...STATE, 'note');
    expect(existsSync(join(stateDir, '.active-task'))).toBe(false);
  });

  it('gitignores the handoff dir on first write', async () => {
    await cli('tasks', 'handoff', 'ship-the-thing', ...STATE);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8'))
      .toContain('_dream_context/state/.handoff-requests/');
  });

  it('does nothing for an unknown task', async () => {
    await cli('tasks', 'handoff', 'no-such-task');
    expect(existsSync(handoffDir(contextRoot))).toBe(false);
  });
});
