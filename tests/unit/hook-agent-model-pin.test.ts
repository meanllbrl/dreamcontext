/**
 * A sub-agent never runs on Fable (plan super-cocuk-tasarruf D5, criterion 8). The REAL
 * `hook pre-tool-use` action runs in-process with a fictional brain, rule store and parent
 * transcript: an explicit Fable model, or none under a Fable parent for an agent with no model
 * of its own, becomes opus with one line; every other dispatch is left as it came.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const io = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, realpathSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const home = realpathSync(mkdtempSync(`${tmpdir()}/dc-model-pin-`));
  process.env.HOME = home;
  return { stdin: '', home };
});

// The hook reads its input from fd 0; everything else reads the real disk.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((p: unknown, ...rest: unknown[]) => (p === 0 ? io.stdin : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest))) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerHookCommand } from '../../src/cli/commands/hook.js';
import { MODEL_PIN_LINE } from '../../src/lib/agent-model-pin.js';
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

let fableTranscript: string;
let opusTranscript: string;

const call = (parent: string, input: Record<string, unknown>, o: { tool?: 'Agent' | 'Task'; cwd?: string } = {}) => ({
  session_id: 'conv-orchard', cwd: o.cwd ?? project, permission_mode: 'bypassPermissions', hook_event_name: 'PreToolUse', transcript_path: parent,
  tool_name: o.tool ?? 'Agent', tool_input: { description: 'Scan the orchard notes', prompt: 'Find every note about pruning.', ...input },
});

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-model-pin-proj-')));
  mkdirSync(join(project, '_dream_context', 'core'), { recursive: true });
  mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(project, '.claude', 'agents', 'orchard-scout.md'), '---\nname: orchard-scout\ndescription: x\nmodel: haiku\n---\nbody\n');
  writeFileSync(join(project, '.claude', 'agents', 'orchard-heir.md'), '---\nname: orchard-heir\ndescription: x\nmodel: inherit\n---\nbody\n');
  ensureMeFile(io.home, 'gardener@example.com');
  const at = '2026-11-02T09:00:00.000Z';
  const rule: RuleRecord = {
    id: newRuleId(), scope: 'me', created: { at, by: 'owner', person: '' },
    events: [{ eid: newEventId(), at, op: 'create', by: 'owner', conversation: 'c1', status: 'active', headline: 'Plain words in every report', text: 'Plain words in every report', at_tag: 'always',
      quotes: [{ text: 'plain words', turn: 't-1', via: 'composer', occasion: 'o1' }] }],
  };
  writeStore(personalStoreRef(io.home), { version: 1, rules: [rule] });
  const parent = (model: string) => {
    const p = join(project, `${model}.jsonl`);
    writeFileSync(p, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n${JSON.stringify({ type: 'assistant', message: { model, content: [] } })}\n`);
    return p;
  };
  fableTranscript = parent('claude-fable-5-2');
  opusTranscript = parent('claude-opus-5-5');
  process.chdir(project);
});
afterAll(() => {
  process.chdir(savedCwd);
  for (const p of [project, io.home]) rmSync(p, { recursive: true, force: true });
});

describe('pre-tool-use: a sub-agent never runs on Fable', () => {
  it('explicit Fable becomes opus with one explaining line; the rules still ride', async () => {
    const u = updated(await runHook(call(opusTranscript, { subagent_type: 'reviewer', model: 'fable' })));
    expect(u?.model).toBe('opus');
    expect(u?.prompt).toEqual(expect.stringContaining(DISPATCH_RULES_OPEN));
    expect(String(u?.prompt).split(MODEL_PIN_LINE)).toHaveLength(2);
  });

  it('no model under a Fable parent: general-purpose and an inherit agent become opus, on Agent and Task', async () => {
    for (const tool of ['Agent', 'Task'] as const) {
      expect(updated(await runHook(call(fableTranscript, { subagent_type: 'general-purpose' }, { tool })))?.model).toBe('opus');
    }
    expect(updated(await runHook(call(fableTranscript, { subagent_type: 'orchard-heir' })))?.model).toBe('opus');
  });

  it('Explore outside a _dream_context/ project (no redirect there) becomes opus under a Fable parent', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'dc-model-pin-bare-')));
    process.chdir(bare);
    try {
      const u = updated(await runHook(call(fableTranscript, { subagent_type: 'Explore' }, { cwd: bare })));
      expect(u?.model).toBe('opus');
      expect(u?.prompt).toEqual(expect.stringContaining(MODEL_PIN_LINE));
    } finally {
      process.chdir(project);
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('untouched: explicit opus/sonnet/haiku, an agent\'s own model, a plugin type, any dispatch under a non-Fable parent', async () => {
    for (const model of ['opus', 'sonnet', 'haiku']) {
      expect(updated(await runHook(call(fableTranscript, { subagent_type: 'general-purpose', model })))?.model).toBe(model);
    }
    expect(updated(await runHook(call(fableTranscript, { subagent_type: 'orchard-scout' })))?.model).toBeUndefined();
    expect(updated(await runHook(call(fableTranscript, { subagent_type: 'vercel:ai-architect' })))?.model).toBeUndefined();
    const plain = updated(await runHook(call(opusTranscript, { subagent_type: 'general-purpose' })));
    expect(plain?.model).toBeUndefined();
    expect(String(plain?.prompt)).not.toContain(MODEL_PIN_LINE);
  });

  it('under auto mode nothing is rewritten, the pin included', async () => {
    const out = await runHook({ ...call(fableTranscript, { subagent_type: 'general-purpose', model: 'fable' }), permission_mode: 'auto' });
    expect(updated(out)).toBeUndefined();
  });
});
