/**
 * The grant gate in Claude's PreToolUse hook (uye-bildirim K3, gate G1; plan criterion 4).
 *
 * The REAL `hook pre-tool-use` action runs in-process: stdin is the hook input Claude Code sends,
 * the process table is a stand-in (`_setGrantGateDeps`), and the grant store and the bindings live
 * in a temp HOME. A call runs on a grant only when a binding the SERVER wrote names the process the
 * hook runs under (its parent chain, same start time), the hook reports that binding's CURRENT
 * conversation id, the project is the binding's, a live grant matches, and no deny gate refused
 * first. Antigravity and Codex formats never allow on a grant. Anything unreadable prints nothing.
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

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { _setGrantGateDeps, grantGateAllow, registerHookCommand } from '../../src/cli/commands/hook.js';
import { setHookTool } from '../../src/lib/hook-tool.js';
import { addConversationId, grantsDir, listGrants, newGrantId, writeBinding, writeGrant } from '../../src/lib/grants/store.js';
import { realResolver, type Resolver } from '../../src/lib/grants/eligible.js';
import type { ProcSys } from '../../src/lib/grants/binding.js';
import { canonicalInput } from '../../src/lib/grants/canonical.js';
import type { Binding, Grant } from '../../src/lib/grants/types.js';

const HOME = io.home;
const CLAUDE = 500;
const STARTED = 'Tue Nov 10 22:01:00 2026';
const NODE = '/opt/fakebin/node';
let project: string;
let other: string;
const savedCwd = process.cwd();

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

const realOr = (p: string): string | null => { try { return realpathSync.native(p); } catch { return null; } };

/** The measured chain: the hook's parent IS the spawned claude. */
function procs(o: { self?: number; parents?: Record<number, number>; starts?: Record<number, string> } = {}): ProcSys {
  const self = o.self ?? 900;
  const parents = o.parents ?? { [self]: CLAUDE, [CLAUDE]: 400, 400: 1 };
  const starts = o.starts ?? { [CLAUDE]: STARTED };
  return { selfPid: self, parentOf: (pid) => parents[pid] ?? null, startTimeOf: (pid) => starts[pid] ?? null, realpath: realOr };
}

/** The real disk, with `node` resolving outside every agent-writable root. */
const resolver: Resolver = {
  which: (n) => (n === 'node' ? NODE : realResolver().which(n)),
  realpath: (p) => (p === NODE ? NODE : realOr(p)),
  isRegularFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  sha256: (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } },
};

const binding = (over: Partial<Binding> = {}): Binding => ({
  pid: CLAUDE, startedAt: STARTED, pin: 'pin-scout', project, crew: 'member', member: 'scout',
  conversationIds: ['conv-1'], writtenAt: Date.now(), ...over,
});

const grant = (over: Partial<Grant> = {}): Grant => {
  const scope = over.scope ?? 'once';
  return {
    id: newGrantId(scope), scope, project, ...(scope === 'member' ? { member: 'scout' } : { pin: 'pin-scout' }),
    tool: 'Edit', input: canonicalInput('Edit', edit()), form: 'exact', createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, ...over,
  };
};
/** The call most rows grant: an exact file edit (once and job may take it; a plain shell command
 *  takes no job grant, only a pinned script does). */
const edit = () => ({ file_path: join(project, 'notes.txt'), old_string: 'a', new_string: 'b' });
/** A one-shot for a plain shell command. */
const bashOnce = (command: string): Grant => grant({ tool: 'Bash', input: command });

const hookInput = (over: Record<string, unknown> = {}) => ({
  session_id: 'conv-1', cwd: project, permission_mode: 'auto', hook_event_name: 'PreToolUse',
  tool_name: 'Edit', tool_input: edit(), ...over,
});

/** Run the real action; returns every hookSpecificOutput it printed. */
async function runHook(input: unknown, format: 'codex' | 'antigravity' | null = null): Promise<Array<Record<string, unknown>>> {
  io.stdin = JSON.stringify(input);
  setHookTool(format);
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
    setHookTool(null);
  }
  return lines.map((l) => { try { return (JSON.parse(l) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {}; } catch { return { raw: l }; } });
}
const decision = (out: Array<Record<string, unknown>>) => out.map((o) => o.permissionDecision).find((d) => d !== undefined) ?? null;

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hook-')));
  other = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hook-')));
  for (const p of [project, other]) mkdirSync(join(p, '_dream_context', 'agents'), { recursive: true });
  mkdirSync(join(project, 'scripts'), { recursive: true });
  writeFileSync(join(project, 'scripts', 'report.mjs'), 'console.log("built")\n');
  // The gates that read the brain resolve it from the process folder (forks pool).
  process.chdir(project);
});
afterAll(() => {
  process.chdir(savedCwd);
  for (const p of [project, other, HOME]) rmSync(p, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(HOME, '.dreamcontext'), { recursive: true, force: true });
  _setGrantGateDeps({ sys: procs(), resolve: resolver, roots: () => [project] });
});
afterEach(() => { _setGrantGateDeps(null); });

describe('G1 in the hook: a bound session with a matching grant runs without asking', () => {
  it('a once grant: allow with the reason, spent, and the next identical call is asked again', async () => {
    writeBinding(binding(), {});
    writeGrant(grant(), {});
    const first = await runHook(hookInput());
    expect(decision(first)).toBe('allow');
    expect(first.find((o) => o.permissionDecision)?.permissionDecisionReason).toMatch(/allowed exactly this call, once/);
    expect(listGrants(project).filter((g) => g.scope === 'once')).toEqual([]);
    expect(decision(await runHook(hookInput()))).toBeNull();
    // A plain shell command takes a one-shot too (its exact text).
    writeGrant(bashOnce('touch granted.txt'), {});
    expect(decision(await runHook(hookInput({ tool_name: 'Bash', tool_input: { command: 'touch granted.txt' } })))).toBe('allow');
    expect(decision(await runHook(hookInput({ tool_name: 'Bash', tool_input: { command: 'touch granted.txt' } })))).toBeNull();
  });

  it('a job grant matches its own session only, never a sibling of the same member', async () => {
    writeBinding(binding(), {});
    writeGrant(grant({ scope: 'job' }), {});
    expect(decision(await runHook(hookInput()))).toBe('allow');
    expect(decision(await runHook(hookInput()))).toBe('allow'); // not spent
    // A sibling child of the same member: another process, another pin.
    writeBinding(binding({ pid: 501, pin: 'pin-sibling', conversationIds: ['conv-2'] }), {});
    _setGrantGateDeps({ sys: procs({ parents: { 900: 501, 501: 1 }, starts: { 501: STARTED } }), resolve: resolver, roots: () => [project] });
    expect(decision(await runHook(hookInput({ session_id: 'conv-2' })))).toBeNull();
  });

  it('a member rule on a pinned script: the member\'s child runs it with any arguments; an edited script asks again', async () => {
    writeBinding(binding({ crew: 'child' }), {});
    const scriptPath = realpathSync(join(project, 'scripts', 'report.mjs'));
    const sha256 = resolver.sha256(scriptPath)!;
    writeGrant(grant({ scope: 'member', tool: 'Bash', input: 'node scripts/report.mjs', form: 'script', script: { interpreter: 'node', interpreterPath: NODE, scriptPath, sha256 } }), {});
    expect(decision(await runHook(hookInput({ tool_name: 'Bash', tool_input: { command: 'node scripts/report.mjs --fast' } })))).toBe('allow');
    writeFileSync(scriptPath, 'console.log("changed")\n');
    expect(decision(await runHook(hookInput({ tool_name: 'Bash', tool_input: { command: 'node scripts/report.mjs' } })))).toBeNull();
    writeFileSync(scriptPath, 'console.log("built")\n');
  });

  it('the conversation id rotates: the grant matches again once the next init is read, never on the old id', async () => {
    writeBinding(binding(), {});
    writeGrant(grant({ scope: 'job' }), {});
    expect(decision(await runHook(hookInput({ session_id: 'conv-rotated' })))).toBeNull();
    addConversationId(CLAUDE, 'conv-rotated', {});
    expect(decision(await runHook(hookInput({ session_id: 'conv-rotated' })))).toBe('allow');
    expect(decision(await runHook(hookInput({ session_id: 'conv-1' })))).toBeNull();
  });
});

describe('G1 identity: no binding the server wrote for THIS process, no allow', () => {
  beforeEach(() => { writeGrant(grant({ scope: 'job' }), {}); });

  it('a forged environment with no binding: nothing (the markers grant nothing)', async () => {
    process.env.DREAMCONTEXT_SUPER_CREW = '1';
    process.env.DREAMCONTEXT_MEMBER_CREW = 'scout';
    try {
      expect(decision(await runHook(hookInput()))).toBeNull();
    } finally {
      delete process.env.DREAMCONTEXT_SUPER_CREW;
      delete process.env.DREAMCONTEXT_MEMBER_CREW;
    }
  });

  it('the bound conversation id reported from a process that is not under the bound pid: nothing', async () => {
    writeBinding(binding(), {});
    _setGrantGateDeps({ sys: procs({ parents: { 900: 650, 650: 1 }, starts: { [CLAUDE]: STARTED, 650: STARTED } }), resolve: resolver, roots: () => [project] });
    expect(decision(await runHook(hookInput()))).toBeNull();
  });

  it('a claude an agent started under the bound process, with its own conversation: nothing', async () => {
    writeBinding(binding(), {});
    // The nested claude is a child of the bound one, but reports its own conversation id.
    _setGrantGateDeps({ sys: procs({ parents: { 900: 777, 777: CLAUDE, [CLAUDE]: 1 }, starts: { [CLAUDE]: STARTED, 777: 'Tue Nov 10 22:05:00 2026' } }), resolve: resolver, roots: () => [project] });
    expect(decision(await runHook(hookInput({ session_id: 'conv-nested' })))).toBeNull();
  });

  it('a reused pid with another start time: nothing', async () => {
    writeBinding(binding(), {});
    _setGrantGateDeps({ sys: procs({ starts: { [CLAUDE]: 'Wed Nov 11 09:00:00 2026' } }), resolve: resolver, roots: () => [project] });
    expect(decision(await runHook(hookInput()))).toBeNull();
  });

  it('another project\'s binding: nothing', async () => {
    writeBinding(binding({ project: other }), {});
    expect(decision(await runHook(hookInput()))).toBeNull();
  });

  it('plan mode is the envelope he chose: never widened', async () => {
    writeBinding(binding(), {});
    expect(decision(await runHook(hookInput({ permission_mode: 'plan' })))).toBeNull();
  });

  it('a subfolder of the bound project is still that project', async () => {
    writeBinding(binding(), {});
    expect(decision(await runHook(hookInput({ cwd: join(project, 'scripts') })))).toBe('allow');
  });
});

describe('every existing deny gate still wins over a matching grant (one row per gate)', () => {
  beforeEach(() => { writeBinding(binding(), {}); });
  // A one-shot for exactly this call: the strongest grant there is, and it would match if reached.
  const granted = (tool: string, input: Record<string, unknown>) => writeGrant(grant({ tool, input: canonicalInput(tool, input) }), {});

  it('gate 1: the Meta token file', async () => {
    const input = { file_path: join(project, '_dream_context', 'marketing', '.env'), old_string: 'a', new_string: 'b' };
    granted('Edit', input);
    const out = await runHook(hookInput({ tool_name: 'Edit', tool_input: input }));
    expect(decision(out)).toBe('deny');
  });

  it('gate 1c: an AI Team member\'s file', async () => {
    const input = { file_path: join(project, '_dream_context', 'agents', 'scout.md'), content: 'x' };
    granted('Write', input);
    expect(decision(await runHook(hookInput({ tool_name: 'Write', tool_input: input })))).toBe('deny');
  });

  it('gate 1f: the owner\'s grant store and approval registry (a grant never opens the grants)', async () => {
    const input = { file_path: join(HOME, '.dreamcontext', 'grants', 'once', 'x.json'), content: '{}' };
    granted('Write', input);
    const out = await runHook(hookInput({ tool_name: 'Write', tool_input: input }));
    expect(decision(out)).toBe('deny');
    expect(String(out.find((o) => o.permissionDecision)?.permissionDecisionReason)).toMatch(/permission store.*ask the owner/s);
  });

  it('gate 1e: a hand-written Excalidraw scene', async () => {
    const input = { file_path: join(project, 'board.excalidraw'), content: '{"type":"excalidraw","elements":[]}' };
    granted('Write', input);
    expect(decision(await runHook(hookInput({ tool_name: 'Write', tool_input: input })))).toBe('deny');
  });

  it('gate 1d: a heavy step', async () => {
    writeGrant(bashOnce('npm test'), {});
    expect(decision(await runHook(hookInput({ tool_name: 'Bash', tool_input: { command: 'npm test' } })))).toBe('deny');
  });

  it('gate 2: the default Explore agent', async () => {
    const input = { subagent_type: 'Explore', prompt: 'look around', description: 'look' };
    granted('Agent', input);
    expect(decision(await runHook(hookInput({ tool_name: 'Agent', tool_input: input })))).toBe('deny');
  });
});

describe('formats and a store that cannot be read', () => {
  beforeEach(() => { writeBinding(binding(), {}); writeGrant(grant({ scope: 'job' }), {}); });

  it('Antigravity never allows on a grant (the bridge decides, once)', async () => {
    writeGrant(bashOnce('touch granted.txt'), {});
    const agy = { toolCall: { name: 'run_command', args: { CommandLine: 'touch granted.txt', Cwd: project } }, workspacePaths: [project], session_id: 'conv-1' };
    expect(decision(await runHook(agy, 'antigravity'))).not.toBe('allow');
  });

  it('a Codex hook never allows on a grant', async () => {
    writeGrant(bashOnce('touch granted.txt'), {});
    expect(decision(await runHook(hookInput({ tool_name: 'shell', tool_input: { command: ['touch', 'granted.txt'] } }), 'codex'))).not.toBe('allow');
  });

  it('a corrupt store: no grants, no throw, nothing printed for the grant', async () => {
    rmSync(join(HOME, '.dreamcontext', 'grants', 'jobs'), { recursive: true, force: true });
    mkdirSync(join(grantsDir(HOME), 'jobs'), { recursive: true });
    writeFileSync(join(grantsDir(HOME), 'jobs', 'job-broken.json'), '{ not json');
    expect(decision(await runHook(hookInput()))).toBeNull();
  });

  it('an unreadable store: nothing printed', async () => {
    const dir = grantsDir(HOME);
    chmodSync(dir, 0o000);
    try {
      // Root reads through 0000; the row is only meaningful for an ordinary user.
      if (process.getuid?.() !== 0) expect(decision(await runHook(hookInput()))).toBeNull();
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('one-shots and settings rules', () => {
  it('two enforcers racing on one once grant: exactly one allows', () => {
    writeBinding(binding(), {});
    writeGrant(grant(), {});
    const deps = { sys: procs(), resolve: resolver, roots: () => [project] };
    const input = hookInput();
    const a = grantGateAllow(input, 'Edit', input.tool_input as Record<string, unknown>, deps);
    const b = grantGateAllow(input, 'Edit', input.tool_input as Record<string, unknown>, deps);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  // Measured (premise step 2, Claude Code 2.1.322, tests/fixtures/refusals/rules.jsonl): a settings
  // DENY rule and an ASK rule each refuse a call a PreToolUse hook answered `allow`. The hook only
  // ever ADDS an allow; the CLI's own rules still decide after it, so a grant never beats them.
  it('a settings rule beats the hook\'s allow: the hook prints allow, the recorded CLI refused anyway', async () => {
    writeBinding(binding(), {});
    writeGrant(bashOnce('touch rule-denied.txt'), {});
    expect(decision(await runHook(hookInput({ tool_name: 'Bash', tool_input: { command: 'touch rule-denied.txt' } })))).toBe('allow');
    const frames = readFileSync(join(savedCwd, 'tests', 'fixtures', 'refusals', 'rules.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const rejects = frames.flatMap((f) => (Array.isArray(f.tool_result_meta) ? f.tool_result_meta as Array<Record<string, any>> : []))
      .filter((m) => m.permission_decision?.decision === 'reject');
    expect(rejects.length).toBe(2);
    expect(rejects.every((m) => m.permission_decision.source === 'config')).toBe(true);
  });
});
