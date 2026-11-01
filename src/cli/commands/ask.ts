import type { Command } from 'commander';
import { ASK_TOOLS, runAsk, type AskTool } from '../../lib/cross-tool-ask.js';

/**
 * `dreamcontext ask --tool <claude|codex|antigravity> "<prompt>"`: run a prompt, or one of our agent
 * roles, on another tool and print its answer (cross-tool-ask.ts). Read-only unless `--write`.
 */
export function registerAskCommand(program: Command): void {
  program
    .command('ask')
    .description('Run a prompt or an agent role on another tool (claude, codex, antigravity) and print the answer. Read-only unless --write')
    .argument('<prompt...>', 'what to ask')
    .requiredOption('--tool <tool>', 'claude | codex | antigravity')
    .option('--model <model>', "a model of that tool (a Claude name is not sent to another tool)")
    .option('--agent <name>', 'run as this agent role (.claude/agents, ~/.claude/agents, or dreamcontext\'s own)')
    .option('--write', 'let it edit files in this project (Claude acceptEdits, Codex its sandbox, Antigravity its write gate)')
    .option('--timeout <seconds>', 'give up after this long (default 600)')
    .option('--json', 'print the result as JSON')
    .action(async (words: string[], o: { tool: string; model?: string; agent?: string; write?: boolean; timeout?: string; json?: boolean }) => {
      const tool = o.tool.toLowerCase() as AskTool;
      if (!ASK_TOOLS.includes(tool)) {
        process.stderr.write(`ask: --tool must be claude, codex or antigravity\n`);
        process.exitCode = 2;
        return;
      }
      const prompt = (words ?? []).join(' ').trim();
      if (!prompt) {
        process.stderr.write('ask: nothing to ask\n');
        process.exitCode = 2;
        return;
      }
      const seconds = o.timeout ? Number(o.timeout) : NaN;
      const r = await runAsk({
        tool, prompt, cwd: process.cwd(), write: o.write === true,
        ...(o.model ? { model: o.model } : {}), ...(o.agent ? { agent: o.agent } : {}),
        ...(Number.isFinite(seconds) && seconds > 0 ? { timeoutMs: seconds * 1000 } : {}),
      });
      const name = tool === 'claude' ? 'Claude' : tool === 'codex' ? 'Codex' : 'Antigravity';
      if (o.json) process.stdout.write(`${JSON.stringify(r)}\n`);
      else if (r.ok) process.stdout.write(`${name} answered (${r.mode === 'write' ? 'could edit' : 'read-only'}${o.agent ? `, as ${o.agent}` : ''}):\n\n${r.text}\n`);
      else process.stderr.write(`${name} did not answer: ${r.error ?? 'unknown error'}\n`);
      if (!r.ok) process.exitCode = 1;
    });
}
