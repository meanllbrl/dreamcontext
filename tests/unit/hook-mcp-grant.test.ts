/**
 * MCP tool calls reach the grant gate (uye-bildirim K3, lane w5-E).
 *
 * The owner may Allow once, or For this job, on a refused MCP call; that grant is only usable if
 * Claude runs dreamcontext's PreToolUse hook for MCP tools at all. So the installed specs carry an
 * `mcp__.*` matcher, and the hook itself must treat an MCP call as nothing but a candidate for the
 * last gate: no deny gate reads an MCP tool name (even when its input names a guarded path), an
 * unbound call prints nothing, and a bound call with a matching grant is allowed.
 *
 * The REAL `hook pre-tool-use` action runs in-process, as in hook-grant-gate.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const io = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, realpathSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const home = realpathSync(mkdtempSync(`${tmpdir()}/dc-grants-`));
  process.env.HOME = home;
  return { stdin: '', home };
});

// The hook reads its input from fd 0; everything else reads the real disk.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((p: unknown, ...rest: unknown[]) => (p === 0 ? io.stdin : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest))) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { _setGrantGateDeps, registerHookCommand } from '../../src/cli/commands/hook.js';
import { setHookTool } from '../../src/lib/hook-tool.js';
import { HOOK_SPECS, MCP_TOOL_MATCHER, hookCommand } from '../../src/cli/commands/install-skill.js';
import { listGrants, newGrantId, writeBinding, writeGrant } from '../../src/lib/grants/store.js';
import { realResolver } from '../../src/lib/grants/eligible.js';
import type { ProcSys } from '../../src/lib/grants/binding.js';
import { canonicalInput } from '../../src/lib/grants/canonical.js';
import type { Binding, Grant } from '../../src/lib/grants/types.js';

const HOME = io.home;
const CLAUDE = 500;
const STARTED = 'Tue Nov 10 22:01:00 2026';
const TOOL = 'mcp__acme-crm__create_invoice';
let project: string;
const savedCwd = process.cwd();

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

const realOr = (p: string): string | null => { try { return realpathSync.native(p); } catch { return null; } };
/** The measured chain: the hook's parent IS the spawned claude. */
const procs = (): ProcSys => ({
  selfPid: 900,
  parentOf: (pid) => ({ 900: CLAUDE, [CLAUDE]: 400, 400: 1 } as Record<number, number>)[pid] ?? null,
  startTimeOf: (pid) => (pid === CLAUDE ? STARTED : null),
  realpath: realOr,
});

const mcpInput = () => ({ customer: 'Northwind Traders', amount: 120 });
const binding = (over: Partial<Binding> = {}): Binding => ({
  pid: CLAUDE, startedAt: STARTED, pin: 'pin-scout', project, crew: 'member', member: 'scout',
  conversationIds: ['conv-1'], writtenAt: Date.now(), ...over,
});
const grant = (over: Partial<Grant> = {}): Grant => {
  const scope = over.scope ?? 'once';
  return {
    id: newGrantId(scope), scope, project, pin: 'pin-scout',
    tool: TOOL, input: canonicalInput(TOOL, mcpInput()), form: 'exact', createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, ...over,
  };
};
const hookInput = (over: Record<string, unknown> = {}) => ({
  session_id: 'conv-1', cwd: project, permission_mode: 'auto', hook_event_name: 'PreToolUse',
  tool_name: TOOL, tool_input: mcpInput(), ...over,
});

/** Run the real action; returns every line it printed and its exit code. */
async function runHook(input: unknown): Promise<{ out: Array<Record<string, unknown>>; code: number | null }> {
  io.stdin = JSON.stringify(input);
  setHookTool(null);
  const lines: string[] = [];
  let code: number | null = null;
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Exited(c ?? 0); }) as never);
  try {
    const program = new Command();
    program.exitOverride();
    registerHookCommand(program);
    await program.parseAsync(['node', 'dreamcontext', 'hook', 'pre-tool-use']);
  } catch (err) {
    if (!(err instanceof Exited)) throw err;
    code = err.code;
  } finally {
    log.mockRestore();
    exit.mockRestore();
  }
  return {
    out: lines.map((l) => { try { return (JSON.parse(l) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {}; } catch { return { raw: l }; } }),
    code,
  };
}
const decision = (out: Array<Record<string, unknown>>) => out.map((o) => o.permissionDecision).find((d) => d !== undefined) ?? null;

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hook-')));
  mkdirSync(join(project, '_dream_context', 'agents'), { recursive: true });
  // The gates that read the brain resolve it from the process folder (forks pool).
  process.chdir(project);
});
afterAll(() => {
  process.chdir(savedCwd);
  for (const p of [project, HOME]) rmSync(p, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(HOME, '.dreamcontext'), { recursive: true, force: true });
  _setGrantGateDeps({ sys: procs(), resolve: realResolver(), roots: () => [project] });
});
afterEach(() => { _setGrantGateDeps(null); });

describe('the installed hooks send MCP calls to the pre-tool-use gate', () => {
  it('one PreToolUse spec matches MCP tools, on the same command as the other gates', () => {
    const spec = HOOK_SPECS.find((s) => s.event === 'PreToolUse' && s.matcher === MCP_TOOL_MATCHER);
    expect(spec).toMatchObject({ name: 'pre-tool-use', command: hookCommand('pre-tool-use'), timeout: 5 });
  });

  it('the matcher reaches every MCP tool name and no built-in tool', () => {
    // Claude Code reads a matcher with regex characters as a regex over the tool name.
    const re = new RegExp(MCP_TOOL_MATCHER);
    for (const name of [TOOL, 'mcp__claude_ai_Claude_Docs__batch', 'mcp__x__y']) expect(re.test(name), name).toBe(true);
    for (const name of ['Bash', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Read', 'WebFetch', 'NotebookEdit']) expect(re.test(name), name).toBe(false);
  });
});

describe('the hook on an MCP call: only the grant gate acts', () => {
  it('an unbound MCP call prints nothing and exits 0 (the normal permission ladder decides)', async () => {
    const r = await runHook(hookInput());
    expect(r.code).toBe(0);
    expect(r.out).toEqual([]);
  });

  it('no deny gate reads an MCP call, even one whose input names a guarded path', async () => {
    for (const tool_input of [
      { file_path: join(project, '_dream_context', 'marketing', '.env'), content: 'x' },
      { file_path: join(project, '_dream_context', 'agents', 'scout.md'), content: 'x' },
      { file_path: join(HOME, '.dreamcontext', 'grants', 'rules.json'), content: '{}' },
      { command: 'npx vitest run' },
      { subagent_type: 'Explore', prompt: 'look around' },
    ]) {
      const r = await runHook(hookInput({ tool_input }));
      expect(decision(r.out), JSON.stringify(tool_input)).toBeNull();
      expect(r.code).toBe(0);
    }
  });

  it('a bound session with a one-shot for exactly this MCP call is allowed once, then asked again', async () => {
    writeBinding(binding(), {});
    writeGrant(grant(), {});
    const first = await runHook(hookInput());
    expect(decision(first.out)).toBe('allow');
    expect(listGrants(project).filter((g) => g.scope === 'once')).toEqual([]);
    expect(decision((await runHook(hookInput())).out)).toBeNull();
  });

  it('a job grant on an MCP call allows the same input in its session and nothing else', async () => {
    writeBinding(binding(), {});
    writeGrant(grant({ scope: 'job' }), {});
    expect(decision((await runHook(hookInput())).out)).toBe('allow');
    expect(decision((await runHook(hookInput({ tool_input: { customer: 'Northwind Traders', amount: 9999 } }))).out)).toBeNull();
    expect(decision((await runHook(hookInput({ tool_name: 'mcp__acme-crm__delete_customer' }))).out)).toBeNull();
  });

  it('an outward MCP call never runs on a job grant (it is Allow once only), but a one-shot still works', async () => {
    const send = 'mcp__acme-crm__send_email';
    writeBinding(binding(), {});
    writeGrant(grant({ scope: 'job', tool: send, input: canonicalInput(send, mcpInput()) }), {});
    expect(decision((await runHook(hookInput({ tool_name: send }))).out)).toBeNull();
    writeGrant(grant({ tool: send, input: canonicalInput(send, mcpInput()) }), {});
    expect(decision((await runHook(hookInput({ tool_name: send }))).out)).toBe('allow');
  });
});
