/**
 * The brain MCP server (Track T W3): a sandboxed tool writes to the brain through it, so it must
 * refuse every verb off its allowlist, every option that points at another vault, and every path
 * outside the vault or reached through a symlink below the realpath'd root.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { BRAIN_VERBS, checkBrainArgs, confinedToVault } from '../../src/lib/brain-mcp/verbs.js';
import { callBrainTool, defaultRunCli, handleBrainMessage, resolveBrainRoots, appCallEnv, APP_UNKNOWN, APP_MAX_MS, type RunCli } from '../../src/lib/brain-mcp/server.js';
import { registerApp } from '../../src/lib/apps/registry.js';
import { codexBrainMcpArgs, acpBrainMcpServer } from '../../src/lib/t3-bridge/launch.js';
import { createProgram } from '../../src/cli/program.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-brain-mcp-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const project = join(base, 'acme-shop');
const vault = join(project, '_dream_context');
mkdirSync(join(vault, 'state'), { recursive: true });
mkdirSync(join(base, 'outside'), { recursive: true });
writeFileSync(join(base, 'outside', 'secret.md'), 'not yours');
symlinkSync(join(base, 'outside'), join(vault, 'escape'));

const refused = (args: string[]) => { try { checkBrainArgs(args, vault); return null; } catch (e) { return (e as Error).message; } };

describe('the allowlist', () => {
  it('every allowlisted verb path exists in this CLI and is a LEAF command (drift)', () => {
    const program = createProgram();
    const find = (cmd: Command, path: readonly string[]): Command | null => {
      if (path.length === 0) return cmd;
      const next = cmd.commands.find((c) => c.name() === path[0] || c.aliases().includes(path[0]!));
      return next ? find(next, path.slice(1)) : null;
    };
    for (const verb of BRAIN_VERBS) {
      const cmd = find(program, verb);
      expect(cmd, verb.join(' ')).not.toBeNull();
      // A group (top-level `recall` holds on/off/cloud-key controls) would let an argument pick a subcommand.
      expect(cmd!.commands.map((c) => c.name()), verb.join(' ')).toEqual([]);
    }
  });

  it('top-level recall (recall\'s own controls: off, cloud key clear…) is refused', () => {
    for (const args of [['recall', 'off'], ['recall', 'cloud', 'key', 'clear'], ['recall', 'how does checkout work']]) expect(refused(args), args.join(' ')).toMatch(/Not allowed/);
  });

  it('allows a task log, a handoff and recall', () => {
    expect(refused(['tasks', 'log', 'checkout-flow', 'Decided: three steps, see src/cart.ts'])).toBeNull();
    expect(refused(['tasks', 'handoff', 'checkout-flow', '--done', 'tests pass', '--next', 'ship'])).toBeNull();
    expect(refused(['memory', 'recall', 'how does checkout work'])).toBeNull();
    expect(refused(['tasks', 'insert', 'checkout-flow', 'notes', '--file', 'state/notes.md'])).toBeNull();
  });

  it('refuses verbs off the list, including the ones that drive the app or the machine', () => {
    for (const args of [['window', 'new'], ['super', 'spawn'], ['automations', 'run', 'x'], ['upgrade'], ['hook', 'stop'], ['sleep', 'start'], ['tasks'], ['brain', 'sync'], ['peer', 'ask', 'x']]) {
      expect(refused(args), args.join(' ')).toMatch(/Not allowed/);
    }
  });

  it('refuses options that point at another vault, project or home', () => {
    for (const a of ['--vault', '--vault=other', '--peers', '--all-vaults', '--root=/', '--cwd', '--home']) {
      expect(refused(['memory', 'recall', 'x', a]), a).toMatch(/refused/);
    }
  });
});

describe('confinement to the vault', () => {
  it('refuses paths outside the vault, home-relative paths, and .. escapes', () => {
    expect(refused(['tasks', 'insert', 't', 'notes', '--file', '/etc/passwd'])).toMatch(/outside the vault/);
    expect(refused(['tasks', 'insert', 't', 'notes', '--file=../../outside/secret.md'])).toMatch(/outside the vault/);
    expect(refused(['tasks', 'log', 't', '~/.ssh/id_rsa'])).toMatch(/outside the vault/);
    expect(refused(['tasks', 'log', 't', join(base, 'outside', 'secret.md')])).toMatch(/outside the vault/);
  });

  it('refuses a symlink below the realpath\'d root, even when it names a path inside', () => {
    expect(confinedToVault('escape/secret.md', vault)).toBe(false);
    expect(refused(['tasks', 'insert', 't', 'notes', '--file', 'escape/secret.md'])).toMatch(/outside the vault/);
    expect(confinedToVault('state/new-file.md', vault)).toBe(true);
  });

  it('the root is realpath\'d once; a missing vault refuses to start', () => {
    expect(resolveBrainRoots(project)).toEqual({ project, vault });
    expect(() => resolveBrainRoots(join(base, 'outside'))).toThrow();
  });
});

describe('the server', () => {
  const roots = { project, vault };
  it('runs an allowed verb in the project folder, argv only', async () => {
    const runs: Array<{ args: readonly string[]; cwd: string }> = [];
    const r = await callBrainTool('dreamcontext', { args: ['tasks', 'log', 't', 'did it'] }, roots, async (args, cwd) => { runs.push({ args, cwd }); return { code: 0, output: 'Logged.' }; });
    expect(r).toEqual({ content: [{ type: 'text', text: 'Logged.' }] });
    expect(runs).toEqual([{ args: ['tasks', 'log', 't', 'did it'], cwd: project }]);
  });

  it('a refused call never runs anything and says why', async () => {
    let ran = false;
    const r = await callBrainTool('dreamcontext', { args: ['window', 'new'] }, roots, async () => { ran = true; return { code: 0, output: '' }; }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(ran).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Not allowed/);
  });

  it('speaks MCP: initialize, tools/list, tools/call', async () => {
    const run = async () => ({ code: 0, output: 'hit' });
    expect(await handleBrainMessage({ id: 1, method: 'initialize', params: {} }, roots, run)).toMatchObject({ result: { serverInfo: { name: 'dreamcontext' } } });
    const list = await handleBrainMessage({ id: 2, method: 'tools/list' }, roots, run) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['recall', 'dreamcontext', 'app']);
    expect(await handleBrainMessage({ id: 3, method: 'tools/call', params: { name: 'recall', arguments: { query: 'checkout' } } }, roots, run)).toMatchObject({ result: { content: [{ text: 'hit' }] } });
  });
});

describe('the app tool (app-araclari §3f, criteria 3 and 5)', () => {
  const roots = { project, vault };
  const home = join(base, 'home');
  const appRoot = join(base, 'acme-shop-apps', 'yuk');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, 'dreamcontext-app.json'), JSON.stringify({
    slug: 'yuk', name: 'Yük', backend: { command: 'node s.mjs', health: '/health' },
    actions: [
      { id: 'snapshot', title: 'Tek ölçüm', method: 'GET', path: '/api/snapshot' },
      { id: 'notify', title: 'Bildirim', method: 'POST', path: '/api/notify', timeoutSec: 90 },
    ],
  }));
  registerApp(home, { projectRoot: project, vault: 'v', slug: 'yuk', name: 'Yük', root: appRoot });
  const call = (input: Record<string, unknown>, run: RunCli, env: NodeJS.ProcessEnv = { DREAMCONTEXT_TAB_SESSION: 'tab-1' }) =>
    callBrainTool('app', input, roots, run, env, home) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

  it('runs `apps do <slug> <tool> --json` with the input as JSON, never a path; confirm only when set', async () => {
    const runs: Array<{ args: readonly string[]; opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv } }> = [];
    const run: RunCli = async (args, _cwd, opts) => { runs.push({ args, opts }); return { code: 0, output: '{"ok":true}' }; };
    expect((await call({ slug: 'yuk', tool: 'snapshot', input: { path: '../../etc/passwd' } }, run)).content[0]!.text).toBe('{"ok":true}');
    await call({ slug: 'yuk', tool: 'notify', confirm: true }, run);
    expect(runs[0]!.args).toEqual(['apps', 'do', 'yuk', 'snapshot', '--json', '--input', '{"path":"../../etc/passwd"}']);
    expect(runs[1]!.args).toEqual(['apps', 'do', 'yuk', 'notify', '--json', '--confirm']);
    expect(runs[0]!.opts?.timeoutMs).toBe(90_000);
    expect(runs[1]!.opts?.timeoutMs).toBe(120_000);
    expect(APP_MAX_MS).toBe(330_000);
  });

  it('a 90 s changing tool killed by the bound answers unknown and is never retried; a reading one just timed out', async () => {
    let n = 0;
    const killed: RunCli = async () => { n++; return { code: 1, output: '', killed: true }; };
    const r = await call({ slug: 'yuk', tool: 'notify', confirm: true }, killed);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(APP_UNKNOWN);
    expect(n).toBe(1);
    expect((await call({ slug: 'yuk', tool: 'snapshot' }, killed)).content[0]!.text).toMatch(/did not answer in time/);
  });

  it('an app or tool not installed on this Mac, a bad slug or a non-object input: refused, nothing runs', async () => {
    let ran = false;
    const run: RunCli = async () => { ran = true; return { code: 0, output: '' }; };
    for (const input of [{ slug: 'crm', tool: 'list' }, { slug: 'yuk', tool: 'nope' }, { slug: '../x', tool: 'snapshot' }, { slug: 'yuk', tool: 'snapshot', input: '{"a":1}' }, { slug: 'yuk', tool: 'snapshot', input: [1] }]) {
      expect((await call(input, run)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(ran).toBe(false);
  });

  it('the class marks pass through; a server nobody can place runs as spawned', () => {
    expect(appCallEnv({ DREAMCONTEXT_TAB_SESSION: 'tab-1' })).toEqual({});
    expect(appCallEnv({ DREAMCONTEXT_SUPER_CREW: '1' })).toEqual({});
    expect(appCallEnv({})).toEqual({ DREAMCONTEXT_SPAWNED: 'brain-mcp' });
    expect(appCallEnv({ DREAMCONTEXT_SUPER_CREW: '' })).toEqual({ DREAMCONTEXT_SPAWNED: 'brain-mcp' });
  });

  it('the launcher hands the brain server the pane id and the caller marks, for Codex and ACP alike', () => {
    const marks = { DREAMCONTEXT_SUPER_CREW: '1', DREAMCONTEXT_AUTOMATION_RUN: 'r-1', DREAMCONTEXT_AGENT_CHAT: '', HOME: '/x', PATH: '/bin' };
    const codex = codexBrainMcpArgs({ node: '/n', cli: '/c', root: project, tabSession: 'tab-1', marks });
    expect(codex).toContain('DREAMCONTEXT_TAB_SESSION = "tab-1"');
    expect(codex).toContain('DREAMCONTEXT_SUPER_CREW = "1"');
    expect(codex).toContain('DREAMCONTEXT_AUTOMATION_RUN = "r-1"');
    expect(codex).not.toMatch(/DREAMCONTEXT_AGENT_CHAT|HOME|PATH/);
    const acp = acpBrainMcpServer({ node: '/n', cli: '/c', root: project, marks });
    expect(acp && 'env' in acp ? acp.env : []).toEqual([{ name: 'DREAMCONTEXT_SUPER_CREW', value: '1' }, { name: 'DREAMCONTEXT_AUTOMATION_RUN', value: 'r-1' }]);
  });
});

const CLI = join(__dirname, '../..', 'dist', 'index.js');
describe.skipIf(!existsSync(CLI))('the recall tool on the real CLI (review fix)', () => {
  it('runs `memory recall` and finds a vault note; a one-word query never switches recall', async () => {
    mkdirSync(join(vault, 'core'), { recursive: true });
    mkdirSync(join(vault, 'knowledge'), { recursive: true });
    writeFileSync(join(vault, 'core', '0.soul.md'), '---\nname: "acme-shop"\ntype: soul\nupdated: "2026-01-02"\n---\n\nA fictional storefront.\n');
    writeFileSync(join(vault, 'knowledge', 'checkout.md'), '---\nname: Checkout flow\ndescription: How the checkout works\ntags: [checkout]\nupdated: "2026-01-02"\n---\n\nThe checkout has three steps: cart, address, payment.\n');
    const home = join(base, 'home');
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    const env = { ...process.env, HOME: home, DREAMCONTEXT_RECALL_CLOUD: '0', DREAMCONTEXT_VERSION_CHECK: '0' };
    const run = defaultRunCli(process.execPath, CLI, env)!;
    const hit = await callBrainTool('recall', { query: 'how does the checkout work' }, { project, vault }, run) as { isError?: boolean; content: Array<{ text: string }> };
    expect(hit.isError, hit.content[0]?.text).toBeUndefined();
    expect(hit.content[0]!.text).toContain('checkout');
    const off = await callBrainTool('recall', { query: 'off' }, { project, vault }, run) as { content: Array<{ text: string }> };
    expect(off.content[0]!.text).not.toMatch(/recall (is )?(now )?off|turned off/i);
  }, 60_000);
});
