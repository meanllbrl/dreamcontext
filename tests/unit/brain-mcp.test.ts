/**
 * The brain MCP server (Track T W3): a sandboxed tool writes to the brain through it, so it must
 * refuse every verb off its allowlist, every option that points at another vault, and every path
 * outside the vault or reached through a symlink below the realpath'd root.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { BRAIN_VERBS, checkBrainArgs, confinedToVault } from '../../src/lib/brain-mcp/verbs.js';
import { callBrainTool, handleBrainMessage, resolveBrainRoots } from '../../src/lib/brain-mcp/server.js';
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
  it('every allowlisted verb path exists in this CLI (drift)', () => {
    const program = createProgram();
    const find = (cmd: Command, path: readonly string[]): boolean => {
      if (path.length === 0) return true;
      const next = cmd.commands.find((c) => c.name() === path[0] || c.aliases().includes(path[0]!));
      return !!next && find(next, path.slice(1));
    };
    for (const verb of BRAIN_VERBS) expect(find(program, verb), verb.join(' ')).toBe(true);
  });

  it('allows a task log, a handoff and recall', () => {
    expect(refused(['tasks', 'log', 'checkout-flow', 'Decided: three steps, see src/cart.ts'])).toBeNull();
    expect(refused(['tasks', 'handoff', 'checkout-flow', '--done', 'tests pass', '--next', 'ship'])).toBeNull();
    expect(refused(['recall', 'how does checkout work'])).toBeNull();
    expect(refused(['tasks', 'insert', 'checkout-flow', 'notes', '--file', 'state/notes.md'])).toBeNull();
  });

  it('refuses verbs off the list, including the ones that drive the app or the machine', () => {
    for (const args of [['window', 'new'], ['super', 'spawn'], ['automations', 'run', 'x'], ['upgrade'], ['hook', 'stop'], ['sleep', 'start'], ['tasks'], ['brain', 'sync'], ['peer', 'ask', 'x']]) {
      expect(refused(args), args.join(' ')).toMatch(/Not allowed/);
    }
  });

  it('refuses options that point at another vault, project or home', () => {
    for (const a of ['--vault', '--vault=other', '--peers', '--all-vaults', '--root=/', '--cwd', '--home']) {
      expect(refused(['recall', 'x', a]), a).toMatch(/refused/);
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
    expect(list.result.tools.map((t) => t.name)).toEqual(['recall', 'dreamcontext']);
    expect(await handleBrainMessage({ id: 3, method: 'tools/call', params: { name: 'recall', arguments: { query: 'checkout' } } }, roots, run)).toMatchObject({ result: { content: [{ text: 'hit' }] } });
  });
});
