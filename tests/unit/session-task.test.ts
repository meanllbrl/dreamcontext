/**
 * Session → task binding (C2, AC6, AC8).
 *
 * One file per session under `state/.session-task/`; SessionEnd turns it into
 * a tombstone a resume re-binds from; `/clear` unbinds; idle files are reaped
 * after 7 days. Session ids and task slugs are validated before any path is
 * built, and a symlinked binding directory is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  bindSession, endBinding, readBinding, reapBindings, rebindFromTombstone, touchBinding, unbindSession,
  SESSION_TASK_IDLE_MS,
} from '../../src/lib/session-task.js';
import { READ_TASK_GUARD_HOOK } from '../../src/cli/commands/install-skill.js';

let base: string;
let root: string;

beforeEach(() => {
  const raw = join(tmpdir(), `dc-bind-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  base = realpathSync(raw);
  root = join(base, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'epic.md'), '---\nid: t1\nname: Epic\nstatus: todo\n---\n\n## Why\n\nx\n');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const live = (sid: string) => join(root, 'state', '.session-task', `${sid}.json`);
const tomb = (sid: string) => join(root, 'state', '.session-task', '.ended', `${sid}.json`);

describe('binding lifetime (AC6)', () => {
  it('bind → read → end (tombstone) → resume re-binds → clear unbinds', () => {
    expect(bindSession(root, 'sess-1', 'epic', 'cli')).toMatchObject({ session: 'sess-1', task: 'epic', via: 'cli' });
    expect(readBinding(root, 'sess-1')?.task).toBe('epic');
    expect(endBinding(root, 'sess-1')).toBe(true);
    expect(readBinding(root, 'sess-1')).toBeNull();
    expect(existsSync(tomb('sess-1'))).toBe(true);
    expect(rebindFromTombstone(root, 'sess-1')).toMatchObject({ task: 'epic', via: 'resume' });
    expect(existsSync(tomb('sess-1'))).toBe(false);
    unbindSession(root, 'sess-1');
    expect(readBinding(root, 'sess-1')).toBeNull();
  });

  it('reaps bindings idle for more than 7 days; a touched one survives', () => {
    bindSession(root, 'old', 'epic', 'cli');
    bindSession(root, 'fresh', 'epic', 'cli');
    const past = new Date(Date.now() - SESSION_TASK_IDLE_MS - 60_000);
    utimesSync(live('old'), past, past);
    utimesSync(live('fresh'), past, past);
    touchBinding(root, 'fresh');
    expect(reapBindings(root)).toBe(1);
    expect(readBinding(root, 'old')).toBeNull();
    expect(readBinding(root, 'fresh')?.task).toBe('epic');
  });
});

describe('validation (AC8)', () => {
  it('refuses unsafe session ids, unsafe or missing tasks, and a forged file', () => {
    expect(bindSession(root, '../x', 'epic', 'cli')).toBeNull();
    expect(bindSession(root, 'a/b', 'epic', 'cli')).toBeNull();
    expect(bindSession(root, 's', '../epic', 'cli')).toBeNull();
    expect(bindSession(root, 's', 'missing', 'cli')).toBeNull();
    expect(readBinding(root, '../../etc')).toBeNull();
    mkdirSync(join(root, 'state', '.session-task'), { recursive: true });
    writeFileSync(live('forged'), JSON.stringify({ session: 'forged', task: '../../secret', boundAt: '', via: 'x' }));
    expect(readBinding(root, 'forged')).toBeNull();
    writeFileSync(live('other'), JSON.stringify({ session: 'someone-else', task: 'epic', boundAt: '', via: 'x' }));
    expect(readBinding(root, 'other')).toBeNull();
  });

  it('a symlinked .session-task directory is never written through', () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'state', '.session-task'));
    expect(bindSession(root, 'sess', 'epic', 'cli')).toBeNull();
    expect(existsSync(join(outside, 'sess.json'))).toBe(false);
    expect(reapBindings(root)).toBe(0);
  });

  it('a symlinked .ended directory never aims the reaper outside the brain', () => {
    const outside = join(base, 'project');
    mkdirSync(outside);
    const victim = join(outside, 'package.json');
    writeFileSync(victim, '{}');
    const old = (Date.now() - SESSION_TASK_IDLE_MS - 60_000) / 1000;
    utimesSync(victim, old, old);
    mkdirSync(join(root, 'state', '.session-task'));
    symlinkSync(outside, join(root, 'state', '.session-task', '.ended'));
    expect(reapBindings(root)).toBe(0);
    expect(existsSync(victim)).toBe(true);
  });
});

describe('the Read guard script (AC5)', () => {
  const guard = join(__dirname, '..', '..', 'hooks', 'read-task-guard.cjs');
  const run = (payload: unknown, env: NodeJS.ProcessEnv = {}): string =>
    execFileSync(process.execPath, [guard], { input: JSON.stringify(payload), env: { ...process.env, PATH: '/nonexistent', ...env } }).toString();

  it('a non-task Read exits at once with nothing, without calling the CLI', () => {
    expect(run({ tool_name: 'Read', tool_input: { file_path: '/repo/src/index.ts' } })).toBe('');
    expect(run({ tool_name: 'Read', tool_input: { file_path: '/repo/_dream_context/state/journal/epic.md' } })).toBe('');
    expect(run({ tool_name: 'Read', tool_input: { file_path: '/repo/_dream_context/knowledge/x.md' } })).toBe('');
    expect(run('not json')).toBe('');
  });

  it('a task-card Read reaches the CLI (a missing CLI still exits 0, silently)', () => {
    expect(run({ tool_name: 'Read', tool_input: { file_path: `${root}/state/epic.md` } })).toBe('');
  });

  it('is installed as a plain node command, never npx', () => {
    expect(READ_TASK_GUARD_HOOK).toBe('node "$CLAUDE_PROJECT_DIR/.claude/hooks/read-task-guard.cjs"');
  });
});
