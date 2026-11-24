/**
 * The PreToolUse hook never changes a call's input under auto mode.
 *
 * Auto mode's classifier reviews a call BEFORE the hooks run; a hook that answers with an
 * `updatedInput` makes Claude Code refuse the call ("gave no verdict … a hook changed this call's
 * input after auto mode reviewed it"). The dispatch rule append (his always and hot rules on an
 * Agent/Task prompt) did exactly that, so every sub-agent call of an auto-mode child was refused.
 * Under auto the rules reach the sub-agent through SubagentStart instead; other modes keep the append.
 *
 * The REAL `hook pre-tool-use` action runs in-process with a fictional brain and rule store.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const io = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, realpathSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const home = realpathSync(mkdtempSync(`${tmpdir()}/dc-dispatch-auto-`));
  process.env.HOME = home;
  return { stdin: '', home };
});

// The hook reads its input from fd 0; everything else reads the real disk.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((p: unknown, ...rest: unknown[]) => (p === 0 ? io.stdin : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest))) as typeof real.readFileSync;
  // The hook reads fd 0 with readSync (`readStdinSync`): served from the same text, once, then EOF.
  let served = 0;
  const readSync = ((fd: unknown, buf: Buffer, ...rest: unknown[]) => {
    if (fd !== 0) return (real.readSync as (...a: unknown[]) => number)(fd, buf, ...rest);
    const bytes = Buffer.from(io.stdin);
    const n = Math.min(buf.length, bytes.length - served);
    bytes.copy(buf, 0, served, served + n);
    served += n;
    if (n === 0) served = 0;
    return n;
  }) as typeof real.readSync;
  return { ...real, readFileSync, readSync, default: { ...real, readFileSync, readSync } };
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerHookCommand, rewritesInput } from '../../src/cli/commands/hook.js';
import { setHookTool } from '../../src/lib/hook-tool.js';
import { ensureMeFile, newEventId, newRuleId, personalStoreRef, writeStore, type RuleRecord } from '../../src/lib/rules-store.js';
import { DISPATCH_RULES_OPEN } from '../../src/lib/rules-delivery.js';

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

let project: string;
const savedCwd = process.cwd();

async function runHook(input: unknown): Promise<Array<Record<string, unknown>>> {
  io.stdin = JSON.stringify(input);
  setHookTool(null);
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exited(code ?? 0); }) as never);
  try {
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'dreamcontext', 'hook', 'pre-tool-use']);
  } catch (err) {
    if (!(err instanceof Exited)) throw err;
  } finally {
    log.mockRestore();
    exit.mockRestore();
  }
  return lines.map((l) => { try { return (JSON.parse(l) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {}; } catch { return { raw: l }; } });
}
const updated = (out: Array<Record<string, unknown>>) => out.map((o) => o.updatedInput).find((u) => u !== undefined) as Record<string, unknown> | undefined;

const call = (tool: 'Agent' | 'Task', mode: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'conv-orchard', cwd: project, permission_mode: mode, hook_event_name: 'PreToolUse',
  tool_name: tool, tool_input: { description: 'Scan the orchard notes', prompt: 'Find every note about pruning.', subagent_type: 'general-purpose', model: 'haiku', ...extra },
});

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-dispatch-proj-')));
  mkdirSync(join(project, '_dream_context', 'core'), { recursive: true });
  ensureMeFile(io.home, 'gardener@example.com');
  const at = '2026-11-02T09:00:00.000Z';
  const rule: RuleRecord = {
    id: newRuleId(), scope: 'me', created: { at, by: 'owner', person: '' },
    events: [{ eid: newEventId(), at, op: 'create', by: 'owner', conversation: 'c1', status: 'active', headline: 'Plain words in every report', text: 'Plain words in every report', at_tag: 'always',
      quotes: [{ text: 'plain words', turn: 't-1', via: 'composer', occasion: 'o1' }] }],
  };
  writeStore(personalStoreRef(io.home), { version: 1, rules: [rule] });
  process.chdir(project);
});
afterAll(() => {
  process.chdir(savedCwd);
  for (const p of [project, io.home]) rmSync(p, { recursive: true, force: true });
});

describe('pre-tool-use: no input rewrite under auto mode', () => {
  it('the predicate: only auto forbids a rewrite', () => {
    expect(rewritesInput({ permission_mode: 'auto' })).toBe(false);
    for (const m of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', undefined]) expect(rewritesInput({ permission_mode: m })).toBe(true);
  });

  it('outside auto the dispatch carries his rules (the append still works, so the auto rows below prove something)', async () => {
    for (const tool of ['Agent', 'Task'] as const) {
      const u = updated(await runHook(call(tool, 'bypassPermissions')));
      expect(u?.prompt).toEqual(expect.stringContaining(DISPATCH_RULES_OPEN));
      expect(u?.model).toBe('haiku');
    }
  });

  it('under auto: no updatedInput for an Agent or Task dispatch, with or without an explicit model', async () => {
    for (const tool of ['Agent', 'Task'] as const) {
      expect(updated(await runHook(call(tool, 'auto')))).toBeUndefined();
      expect(updated(await runHook(call(tool, 'auto', { model: undefined })))).toBeUndefined();
    }
  });

  it('under auto: no hook answer of any kind changes the input of any tool', async () => {
    const calls = [
      { tool_name: 'Bash', tool_input: { command: 'ls', description: 'list' } },
      { tool_name: 'Read', tool_input: { file_path: join(project, 'notes.md') } },
      { tool_name: 'Agent', tool_input: { description: 'x', prompt: 'y', subagent_type: 'dreamcontext-explore' } },
    ];
    for (const c of calls) {
      const out = await runHook({ session_id: 'conv-orchard', cwd: project, permission_mode: 'auto', hook_event_name: 'PreToolUse', ...c });
      expect(updated(out)).toBeUndefined();
    }
  });
});
