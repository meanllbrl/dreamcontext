import type { Command } from 'commander';

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
      const { runBridgeStdio } = await import('../../lib/t3-bridge/stdio.js');
      const { ecoJoins } = await import('../../lib/t3-bridge/eco.js');
      const cwd = o.cwd ?? process.cwd();
      const eco = ecoJoins(cwd, process.env);
      const code = await runBridgeStdio(
        {
          tool: 'codex',
          cwd,
          model: o.model,
          ...(o.effort ? { effort: o.effort } : {}),
          mode: o.mode,
          paneId: o.pane ?? '',
          ...(o.resume ? { resume: o.resume } : {}),
          ...(o.briefingFile ? { briefingFile: o.briefingFile } : {}),
          extraRoots: o.extraRoot ?? [],
        },
        {
          input: process.stdin,
          write: (line) => { process.stdout.write(line); },
          env: process.env,
          onReady: (id) => eco.onReady(id),
          onRotated: (id) => eco.onRotated(id),
          onResult: (session) => eco.onResult(session.nativeThreadId, session.wire.contextTokens),
        },
      );
      process.exit(code);
    });
}
