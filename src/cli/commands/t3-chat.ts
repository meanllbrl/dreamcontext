import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

/**
 * The bridge lives in its own bundle beside this one (dist/t3-bridge.js), never inlined: a
 * non-literal import keeps the bundler out of it. From source (tests, dev) it is the module itself.
 */
async function loadBridge(): Promise<typeof import('../../lib/t3-bridge/main.js')> {
  const sibling = new URL('./t3-bridge.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) return import(sibling.href);
  const source = ['../../lib/t3-bridge', 'main.js'].join('/');
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
    .requiredOption('--tool <tool>', 'the tool to drive (codex)')
    .option('--cwd <path>', 'the project folder (default: the current folder)')
    .option('--model <model>', 'model id', 'gpt-5.5')
    .option('--effort <effort>', 'reasoning effort')
    .option('--mode <mode>', 'permission mode', 'auto')
    .option('--pane <id>', "the pane's stable id")
    .option('--resume <threadId>', 'a native thread to resume')
    .option('--briefing-file <path>', 'chat-surface briefing, sent as developer instructions')
    .option('--extra-root <path...>', 'another folder the sandboxed tool may write (a linked repo)')
    .action(async (o: {
      tool: string; cwd?: string; model: string; effort?: string; mode: string; pane?: string;
      resume?: string; briefingFile?: string; extraRoot?: string[];
    }) => {
      if (o.tool !== 'codex') {
        process.stderr.write(`t3-chat: unknown tool ${o.tool}\n`);
        process.exit(2);
      }
      const { runT3Chat } = await loadBridge();
      const code = await runT3Chat({ ...o, tool: 'codex', cwd: o.cwd ?? process.cwd() });
      process.exit(code);
    });
}
