import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

/**
 * The bridge lives in its own bundle beside this one (dist/t3-bridge.js), never inlined: a
 * non-literal import keeps the bundler out of it. From source (tests, dev) it is the module itself.
 */
async function loadBridge(tool: string): Promise<typeof import('../../lib/t3-bridge/main.js')> {
  const sibling = new URL(tool === 'claude' ? './t3-bridge-claude.js' : './t3-bridge.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) return import(sibling.href);
  const source = ['../../lib/t3-bridge', tool === 'claude' ? 'main-claude.js' : 'main.js'].join('/');
  return import(/* @vite-ignore */ source);
}

/**
 * `dreamcontext t3-chat` — the bridge child the chat server spawns for a non-Claude tool
 * (plan r5 §3). It speaks Claude's stream-json on stdin/stdout, so the chat server relays it
 * exactly like a `claude` child; inside, T3's provider adapter drives the tool. Hidden: only the
 * server runs it. The bridge (and Effect) is loaded only when this command runs.
 */
export function registerT3ChatCommand(program: Command): void {
  program
    .command('t3-chat', { hidden: true })
    .description('Run one chat on a T3 provider adapter over stream-json stdio (used by the chat server)')
    .requiredOption('--tool <tool>', 'the tool to drive (codex, antigravity, or claude through T3\'s driver)')
    .option('--cwd <path>', 'the project folder (default: the current folder)')
    .option('--model <model>', 'model id (default: the Codex account\'s own)')
    .option('--effort <effort>', 'reasoning effort')
    .option('--mode <mode>', 'permission mode', 'auto')
    .option('--pane <id>', "the pane's stable id")
    .option('--resume <threadId>', 'a native thread to resume')
    .option('--briefing-file <path>', 'chat-surface briefing, sent as developer instructions')
    .option('--extra-root <path...>', 'another folder the sandboxed tool may write (a linked repo)')
    .option('--account <id>', 'a Codex account other than #0 (its own home under ~/.dreamcontext/codex-accounts)')
    .option('--carry <threadId>', 'an earlier thread whose end a fresh thread carries')
    .option('--mcp-config <path>', 'a lean MCP subset ({ mcpServers }) a Super child may use')
    .option('--strict-mcp', 'nothing from the Codex config: no MCP servers, no web search')
    .action(async (o: {
      tool: string; cwd?: string; model?: string; effort?: string; mode: string; pane?: string;
      resume?: string; briefingFile?: string; extraRoot?: string[]; account?: string; carry?: string; mcpConfig?: string; strictMcp?: boolean;
    }) => {
      if (o.tool !== 'codex' && o.tool !== 'claude' && o.tool !== 'antigravity') {
        process.stderr.write(`t3-chat: unknown tool ${o.tool}\n`);
        process.exit(2);
      }
      let bridge: Awaited<ReturnType<typeof loadBridge>>;
      try {
        bridge = await loadBridge(o.tool);
      } catch (err) {
        // The Claude engine's Agent SDK is a real npm package: a packaged app without a global
        // CLI does not have it. The pane says so instead of ending silently.
        const why = o.tool === 'claude' ? 'The T3 Claude engine needs a global dreamcontext install. Switch Claude engine back to dreamcontext in Settings.' : `${o.tool === 'antigravity' ? 'Antigravity' : 'Codex'} could not load: ${String(err).slice(0, 300)}`;
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: why, num_turns: 0, total_cost_usd: 0, usage: {}, dc_tool: o.tool }) + '\n');
        process.exit(1);
      }
      process.exit(await bridge.runT3Chat({ ...o, tool: o.tool, cwd: o.cwd ?? process.cwd() }));
    });

  // One unattended turn on Codex (plan r5 §6, W4): the runner reads its stdout as `claude -p`'s.
  program
    .command('t3-run', { hidden: true })
    .description('Run one headless turn on Codex; prints one JSON document (used by automations)')
    .requiredOption('--surface <surface>', 'which headless surface this is (headless-envelope.ts)')
    .requiredOption('--prompt <text>', 'the turn')
    .option('--model <model>', 'model id')
    .option('--effort <effort>', 'reasoning effort')
    .option('--account <id>', 'a Codex account other than #0')
    .option('--resume <threadId>', 'a native thread to continue')
    .option('--extra-root <path...>', 'another folder the sandboxed run may write (a linked repo)')
    .action(async (o: { surface: string; prompt: string; model?: string; effort?: string; account?: string; resume?: string; extraRoot?: string[] }) => {
      let bridge: Awaited<ReturnType<typeof loadBridge>>;
      try {
        bridge = await loadBridge('codex');
      } catch (err) {
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `Codex could not load: ${String(err).slice(0, 300)}`, num_turns: 0, total_cost_usd: 0, dc_tool: 'codex' }) + '\n');
        process.exit(1);
      }
      process.exit(await bridge.runT3Headless({ ...o, surface: o.surface as never, cwd: process.cwd() }));
    });

  // The account jobs that need T3's own code (plan r5 §4b, W2): a shadow home laid out before a
  // sign-in, and a limits probe with no model call. Only the server runs it.
  program
    .command('t3-account', { hidden: true })
    .description('Prepare an account, sign it in or read its limits, through T3 (used by the server)')
    .argument('<action>', 'prepare | probe | seed | install | signin')
    .option('--account <id>', 'the account (default: #0)')
    .option('--tool <tool>', 'the tool (default: codex)')
    .option('--in <path>', 'seed: the raw messages the route wrote')
    .option('--out <path>', 'seed: where the rendered text goes')
    .action(async (action: string, o: { account?: string; tool?: string; in?: string; out?: string }) => {
      if (action !== 'prepare' && action !== 'probe' && action !== 'seed' && action !== 'install' && action !== 'signin') {
        process.stderr.write(`t3-account: unknown action ${action}\n`);
        process.exit(2);
      }
      let bridge: Awaited<ReturnType<typeof loadBridge>>;
      try {
        bridge = await loadBridge('codex');
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, signedIn: false, error: `Codex could not load: ${String(err).slice(0, 300)}` }) + '\n');
        process.exit(1);
      }
      process.exit(await bridge.runT3Account({ action, ...(o.tool ? { tool: o.tool } : {}), ...(o.account ? { account: o.account } : {}), ...(o.in ? { in: o.in } : {}), ...(o.out ? { out: o.out } : {}) }));
    });
}
