/**
 * `dreamcontext mcp serve --root <project>` — the brain, as a small stdio MCP server, for a tool
 * that has no hooks of ours and may run sandboxed (Track T W3, plan r5 §4a). Codex starts it per
 * session (`mcp_servers.dreamcontext`, launch.ts); its env carries the pane's
 * DREAMCONTEXT_TAB_SESSION so an Eco handoff record (`tasks handoff`) is keyed by the pane exactly
 * like a Claude chat's.
 *
 * Two tools: `recall` (a query) and `dreamcontext` (an allowlisted verb, verbs.ts). Each call runs
 * this CLI as a child — argv, never a shell — in the project folder, bounded in time and output.
 * The root is realpath'd ONCE at start; nothing outside its vault is named or reached.
 */
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BrainVerbError, checkBrainArgs } from './verbs.js';

export const BRAIN_SERVER_NAME = 'dreamcontext';
const CALL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 60_000;

export interface BrainServerDeps {
  readonly root: string;
  /** Runs `dreamcontext <args>` in `cwd`; resolves with exit code and combined output. */
  readonly runCli?: (args: readonly string[], cwd: string) => Promise<{ code: number; output: string }>;
}

export interface BrainRoots { project: string; vault: string }

/** Realpath the root once; the vault must be a real folder inside it. Throws when it is not. */
export function resolveBrainRoots(root: string): BrainRoots {
  const project = realpathSync(root);
  const vault = realpathSync(join(project, '_dream_context'));
  if (!statSync(vault).isDirectory()) throw new Error(`${vault} is not a folder`);
  return { project, vault };
}

const TOOLS = [
  {
    name: 'recall',
    description: 'Search this project\'s dreamcontext brain (knowledge, features, tasks, memory, changelog) for a question. Returns the best hits with their paths.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look up, in plain words.' } }, required: ['query'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dreamcontext',
    description: 'Run one dreamcontext CLI verb on this project\'s brain, e.g. ["tasks","log","<task>","what changed"], ["tasks","insert","<task>","notes","…"], ["tasks","handoff","<task>","--done","…","--next","…"], ["memory","remember","…"], ["tasks","list"]. Only these verbs: recall, snapshot, memory recall|remember|list, tasks list|create|insert|log|handoff|status|start|complete, bookmark add|list, knowledge index. Paths must stay inside _dream_context.',
    inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' }, description: 'The verb and its arguments, one string each (no shell).' } }, required: ['args'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

export function defaultRunCli(node: string = process.execPath, cli: string = process.env.DREAMCONTEXT_CLI || process.argv[1] || '', env: NodeJS.ProcessEnv = process.env): BrainServerDeps['runCli'] {
  return (args, cwd) => new Promise((resolve) => {
    let output = '';
    const child = spawn(node, [cli, ...args], { cwd, env: { ...env, DREAMCONTEXT_VIA_BRAIN_MCP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (c: Buffer): void => { if (output.length < MAX_OUTPUT) output += c.toString('utf-8'); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, CALL_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, output: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output: output.slice(0, MAX_OUTPUT) }); });
  });
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export async function callBrainTool(name: string, input: Record<string, unknown>, roots: BrainRoots, run: NonNullable<BrainServerDeps['runCli']>): Promise<object> {
  let args: string[];
  if (name === 'recall') {
    const q = typeof input.query === 'string' ? input.query.trim() : '';
    if (!q) return text('query is required.', true);
    args = ['recall', q];
  } else if (name === 'dreamcontext') {
    args = Array.isArray(input.args) ? input.args as string[] : [];
  } else {
    return text(`Unknown tool: ${name}`, true);
  }
  try {
    checkBrainArgs(args, roots.vault);
  } catch (err) {
    return text(err instanceof BrainVerbError ? err.message : 'Refused.', true);
  }
  const r = await run(args, roots.project);
  return text(r.output.trim() || (r.code === 0 ? 'Done.' : `Exited with ${r.code}.`), r.code !== 0);
}

interface RpcMessage { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

export async function handleBrainMessage(msg: RpcMessage, roots: BrainRoots, run: NonNullable<BrainServerDeps['runCli']>): Promise<object | null> {
  const hasId = msg.id !== undefined && msg.id !== null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: BRAIN_SERVER_NAME, version: '1.0.0' },
        instructions: 'This project\'s dreamcontext brain. Use recall before answering questions about the project; log progress and decisions to the task with the dreamcontext tool.',
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      return reply(await callBrainTool(name, args, roots, run));
    }
    default:
      return hasId ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } } : null;
  }
}

export function runBrainMcpServer(deps: BrainServerDeps): void {
  const roots = resolveBrainRoots(deps.root);
  const run = deps.runCli ?? defaultRunCli()!;
  const rl = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try { msg = JSON.parse(line) as RpcMessage; } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    chain = chain.then(async () => {
      const out = await handleBrainMessage(msg, roots, run);
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    });
  });
  rl.on('close', () => { void chain.then(() => process.exit(0)); });
}
