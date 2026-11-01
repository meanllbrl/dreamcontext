import type { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ensureCodexHooks, ensureCodexUserGate } from './install-skill.js';
import { ensureAgentsMdBlock } from '../../lib/install-agents-md.js';
import { approveCodexGate, CODEX_USER_GATE_COMMAND } from '../../lib/t3-bridge/codex-user-gate.js';

/** The whole consent, word for word: what the owner reads is what the command does. */
export function codexGateConsent(home: string): string {
  return [
    'This approves, once for this whole Mac:',
    `  1. Adds one PreToolUse hook to ${join(home, '.codex', 'hooks.json')}: ${CODEX_USER_GATE_COMMAND}`,
    `  2. Asks Codex to record that hook as trusted in ${join(home, '.codex', 'config.toml')}, for your account and for any Codex account dreamcontext starts a child on, now or later.`,
    'It then runs before every tool call of every Codex session on this Mac, in any folder. It refuses file edits to marketing tokens and agent files, and lets everything else through.',
    'For a child dreamcontext starts, and in a project set up with `install --tool codex`, it also sends builds and test suites through dreamcontext\'s lock.',
    'A shell command that writes those files is not stopped; the same is true on Claude.',
    'No other hook is trusted. A later change to this hook needs this approval again.',
  ].join('\n');
}

async function approved(yes: boolean | undefined): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question('Approve? [y/N] ')).trim()); } finally { rl.close(); }
}

async function installGlobalGate(yes: boolean | undefined): Promise<void> {
  const home = homedir();
  console.log(codexGateConsent(home));
  if (!await approved(yes)) {
    process.stderr.write('install: not approved, nothing was written.\n');
    process.exit(2);
  }
  const hooks = ensureCodexUserGate(join(home, '.codex'));
  console.log(`${hooks.changed ? 'Wrote' : 'Unchanged'}: ${hooks.file}`);
  const { approved: key, problems } = approveCodexGate(process.cwd(), home);
  if (key) console.log(`Codex recorded: ${key}`);
  if (problems.length > 0) {
    process.stderr.write(`install: the gate is not live.\n${problems.join('\n')}\n`);
    process.exit(1);
  }
  console.log('Codex reports the gate as trusted. Every project on this Mac can run a Codex child.');
}

/**
 * `dreamcontext install --tool codex` — opt in, per project, to the brain in a TERMINAL Codex
 * session (Track T W3): `.codex/hooks.json` runs our hooks in Codex's shape, and a marker block in
 * `AGENTS.md` says where the memory lives. Idempotent; text that is not ours is kept. A desktop
 * Codex chat needs none of it (the bridge injects the brain itself, and these hooks stay quiet
 * there except the `.env` gate).
 *
 * `--global` is the write gate alone, for the whole Mac: what a Super child on Codex needs.
 */
export function registerInstallToolCommand(program: Command): void {
  program
    .command('install')
    .description('Opt this project in to the brain for another tool\'s own terminal sessions (writes that tool\'s hook file and instructions block)')
    .requiredOption('--tool <tool>', 'the tool: codex')
    .option('--global', 'install and approve the Codex write gate once for this whole Mac, instead of this project')
    .option('--yes', 'with --global: the owner has already approved the text this prints')
    .action(async (o: { tool: string; global?: boolean; yes?: boolean }) => {
      if (o.tool !== 'codex') {
        process.stderr.write(`install: --tool ${o.tool} is not supported (codex). Claude Code is set up by install-skill.\n`);
        process.exit(2);
      }
      const projectRoot = process.cwd();
      try {
        if (o.global) { await installGlobalGate(o.yes); return; }
        const hooks = ensureCodexHooks(projectRoot);
        const agents = ensureAgentsMdBlock(projectRoot);
        console.log(`${hooks.changed ? 'Wrote' : 'Unchanged'}: .codex/hooks.json`);
        console.log(`AGENTS.md: ${agents}`);
        console.log('Codex runs project hooks only after you trust them: open `codex` here once and trust both the folder and its hooks.');
      } catch (err) {
        process.stderr.write(`install: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });
}
