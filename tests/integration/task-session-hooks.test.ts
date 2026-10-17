/**
 * The Read hook and the session binding, through the built CLI (C2, AC5, AC6).
 *
 * A Read of a sub-task card adds the parent's card; a Read of anything else
 * (a top-level card, a journal, code) adds nothing. A session bound with
 * `tasks bind` (CLAUDE_CODE_SESSION_ID) is the session the hooks see
 * (`session_id`): the binding survives two Stop events and a compaction —
 * which delivers the packet again — and is gone after SessionEnd; a resume
 * re-binds it and `/clear` unbinds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const GUARD = join(__dirname, '..', '..', 'dist', 'hooks', 'read-task-guard.cjs');

let project: string;
let ctx: string;
let shimDir: string;
const SID = 'sess-abc_123';

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, DREAMCONTEXT_AUTO_DASHBOARD: '0', ...extra };
  for (const k of ['DREAMCONTEXT_CHAT_TAB', 'DREAMCONTEXT_TAB_SESSION', 'CLAUDE_CODE_SESSION_ID', 'DREAMCONTEXT_TASK']) {
    if (!(k in extra)) delete e[k];
  }
  return e;
}
function hook(name: string, payload: unknown, extra: NodeJS.ProcessEnv = {}): string {
  return execFileSync('node', [CLI, 'hook', name], { cwd: project, input: JSON.stringify(payload), env: env(extra), timeout: 60_000 }).toString();
}
function cli(args: string[], extra: NodeJS.ProcessEnv = {}): string {
  return execFileSync('node', [CLI, ...args], { cwd: project, env: env(extra), timeout: 60_000 }).toString();
}
function guard(payload: unknown): string {
  return execFileSync('node', [GUARD], { cwd: project, input: JSON.stringify(payload), env: env(), timeout: 60_000 }).toString();
}
const bindingFile = () => join(ctx, 'state', '.session-task', `${SID}.json`);
const tombFile = () => join(ctx, 'state', '.session-task', '.ended', `${SID}.json`);

beforeEach(() => {
  const raw = join(tmpdir(), `dc-sess-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  project = realpathSync(raw);
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: test\n---\nTest soul.');
  writeFileSync(join(ctx, 'state', 'epic.md'), '---\nid: task_e\nname: The epic\nstatus: in_progress\n---\n\n## Why\n\nPARENT-WHY-LINE\n\n## Constraints & Decisions\n\n- PARENT-DECISION\n');
  writeFileSync(join(ctx, 'state', 'step.md'), '---\nid: task_s\nname: A step\nstatus: in_progress\nparent_task: epic\n---\n\n## Why\n\nStep why.\n\n## Acceptance Criteria\n\n- [ ] Step works\n');
  // `dreamcontext` on PATH = the CLI under test (the guard execs it by name).
  shimDir = join(project, '.bin');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'dreamcontext'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`);
  chmodSync(join(shimDir, 'dreamcontext'), 0o755);
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('Read hook (AC5)', () => {
  it('a sub-task card Read adds the parent card; any other Read adds nothing', { timeout: 120_000 }, () => {
    const child = hook('read-task', { session_id: SID, tool_name: 'Read', tool_input: { file_path: join(ctx, 'state', 'step.md') } });
    const out = JSON.parse(child);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('PARENT-WHY-LINE');
    expect(out.hookSpecificOutput.additionalContext).toContain('- PARENT-DECISION');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/--- TASK CONTEXT [0-9a-f]+ ---/);
    expect(hook('read-task', { tool_input: { file_path: join(ctx, 'state', 'epic.md') } })).toBe('');
    expect(hook('read-task', { tool_input: { file_path: join(ctx, 'state', 'journal', 'step.md') } })).toBe('');
    expect(hook('read-task', { tool_input: { file_path: join(project, 'src', 'x.ts') } })).toBe('');
  });

  it('the installed guard script delivers the same through the CLI on PATH', { timeout: 120_000 }, () => {
    const out = guard({ session_id: SID, tool_name: 'Read', tool_input: { file_path: join(ctx, 'state', 'step.md') } });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('PARENT-WHY-LINE');
    expect(guard({ tool_name: 'Read', tool_input: { file_path: join(project, 'README.md') } })).toBe('');
  });

  it('install-skill writes the guard into .claude/hooks and registers Read + SessionEnd', { timeout: 120_000 }, () => {
    cli(['install-skill', '--platforms', 'claude'], {});
    expect(existsSync(join(project, '.claude', 'hooks', 'read-task-guard.cjs'))).toBe(true);
    const settings = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf-8'));
    const post = settings.hooks.PostToolUse.find((g: { matcher?: string }) => g.matcher === 'Read');
    expect(post.hooks[0].command).toBe('node "$CLAUDE_PROJECT_DIR/.claude/hooks/read-task-guard.cjs"');
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe('npx dreamcontext hook session-end');
  });
});

describe('session binding (AC6)', () => {
  it('survives two Stops and a compaction (packet again), dies with SessionEnd; resume re-binds; clear unbinds', { timeout: 180_000 }, () => {
    cli(['tasks', 'bind', 'step'], { CLAUDE_CODE_SESSION_ID: SID });
    expect(existsSync(bindingFile())).toBe(true);
    hook('stop', { session_id: SID, transcript_path: '' });
    hook('stop', { session_id: SID, transcript_path: '' });
    expect(existsSync(bindingFile())).toBe(true);
    const compact = hook('session-start', { session_id: SID, source: 'compact' });
    expect(compact).toContain('BOUND TASK: this session works step');
    expect(compact).toContain('PARENT-WHY-LINE');
    expect(compact).toContain('- [ ] Step works');
    expect(existsSync(bindingFile())).toBe(true);
    hook('session-end', { session_id: SID, reason: 'exit' });
    expect(existsSync(bindingFile())).toBe(false);
    expect(existsSync(tombFile())).toBe(true);
    hook('session-start', { session_id: SID, source: 'resume' });
    expect(existsSync(bindingFile())).toBe(true);
    hook('session-start', { session_id: SID, source: 'clear' });
    expect(existsSync(bindingFile())).toBe(false);
  });

  it('a run spawned for a task (DREAMCONTEXT_TASK) binds at startup; an unsafe session id binds nothing', { timeout: 120_000 }, () => {
    hook('session-start', { session_id: SID, source: 'startup' }, { DREAMCONTEXT_TASK: 'step' });
    expect(existsSync(bindingFile())).toBe(true);
    hook('session-start', { session_id: '../evil', source: 'startup' }, { DREAMCONTEXT_TASK: 'step' });
    expect(existsSync(join(ctx, 'state', 'evil.json'))).toBe(false);
  });
});

