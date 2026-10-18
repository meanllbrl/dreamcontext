import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { success, error, header, warn } from '../../lib/format.js';
import {
  agentUsage,
  createAgent,
  getAgent,
  listAgents,
  removeAgent,
  setAgentShared,
  withRestamp,
} from '../../lib/agents/store.js';
import type { AgentIdentityPatch } from '../../lib/agents/types.js';
import { getRunTarget, parsePattern, setAutomationShared } from '../../lib/automations/store.js';
import { SOUL_TEMPLATE_IDS, soulTemplate } from '../../lib/agents/soul-templates.js';
import { shareAgent, shareAutomation, unshareAgent, unshareAutomation } from '../../lib/automations/sharing.js';
import {
  approvalFields,
  approveAutomation,
  checkApproval,
  registerProject,
} from '../../lib/automations/registry.js';
import {
  AGENT_SELF_ENV,
  APPROVAL_DIFF_FIELDS,
  AutomationError,
  EFFORT_LEVELS,
  type EffortLevel,
} from '../../lib/automations/types.js';

/** The env vars a Claude session or an agent run carries. */
const SELF_APPROVAL_ENVS = ['CLAUDECODE', AGENT_SELF_ENV, 'DREAMCONTEXT_AUTOMATION_RUN'] as const;

/** True in a Claude session or an agent run (the shells that must not act as the owner). */
export function isSelfApprovalEnv(env: NodeJS.ProcessEnv): boolean {
  return SELF_APPROVAL_ENVS.some((k) => env[k] !== undefined);
}

/** The refusal. It names the page, never a command: a session that reads it
 *  must not be one shell line away from approving the agent itself. */
export const SELF_APPROVAL_REFUSAL =
  'Approving is the owner\'s step, and this is a Claude session or an agent run. Approve it on the Agents page in the dashboard.';

/**
 * A guard against ACCIDENTAL self-approval — not a security boundary (a session
 * with full permissions can still reach the approve route or the registry
 * file). Refuses, with or without `-y`, when the shell is a Claude session or an
 * agent run. Returns true when it refused, so the caller returns without acting.
 */
export function refuseSelfApproval(env: NodeJS.ProcessEnv): boolean {
  if (!isSelfApprovalEnv(env)) return false;
  error(SELF_APPROVAL_REFUSAL);
  process.exitCode = 1;
  return true;
}

function fail(err: unknown): void {
  error(err instanceof AutomationError ? err.message : ((err as Error).message ?? String(err)));
  process.exitCode = 1;
}

function readEffort(v: string | undefined): EffortLevel | null | undefined {
  if (v === undefined) return undefined;
  if (v === '' || v === 'none') return null;
  if ((EFFORT_LEVELS as readonly string[]).includes(v)) return v as EffortLevel;
  throw new AutomationError(`Invalid --effort "${v}": expected one of ${EFFORT_LEVELS.join(', ')}.`);
}

interface SoulOptions {
  soul?: string;
  soulFile?: string;
  soulTemplate?: string;
}

const SOUL_TEMPLATE_LIST = SOUL_TEMPLATE_IDS.join(', ');

/**
 * The soul from `--soul`, `--soul-file` or `--soul-template` (at most one), or
 * undefined when none is given. A template only fills the text: nothing records
 * which one it was. The store validates the text itself.
 */
export function resolveSoulOption(opts: SoulOptions): string | undefined {
  const given = [opts.soul, opts.soulFile, opts.soulTemplate].filter((v) => v !== undefined);
  if (given.length > 1) throw new AutomationError('Use only one of --soul, --soul-file and --soul-template.');
  if (opts.soul !== undefined) return opts.soul;
  if (opts.soulFile !== undefined) {
    try {
      return readFileSync(opts.soulFile, 'utf-8');
    } catch (err) {
      throw new AutomationError(`Could not read --soul-file "${opts.soulFile}": ${(err as Error).message}`);
    }
  }
  if (opts.soulTemplate !== undefined) {
    const t = soulTemplate(opts.soulTemplate);
    if (!t) throw new AutomationError(`Unknown soul template "${opts.soulTemplate}". Use one of: ${SOUL_TEMPLATE_LIST}.`);
    return t.text;
  }
  return undefined;
}

function verdicts(root: string, slug: string): { chat: boolean; run: boolean } | null {
  const target = getRunTarget(root, slug, 'agent');
  if (!target) return null;
  const projectRoot = dirname(root);
  return {
    chat: checkApproval(projectRoot, target, undefined, 'identity').approved,
    run: checkApproval(projectRoot, target, undefined, 'run').approved,
  };
}

export function registerAgentsCommand(program: Command): void {
  const agents = program
    .command('agents')
    .description('Agents — who does the work: a prompt, a model, a home board. Automations and tasks pick one');

  agents
    .command('list')
    .description('List every agent, with whether it may chat and whether it may run on this machine')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const rows = listAgents(root).map((a) => {
        const v = verdicts(root, a.slug);
        return {
          slug: a.slug,
          title: a.title,
          approvedForChat: v?.chat ?? false,
          approvedToRun: v?.run ?? false,
          implicit: a.implicit,
          automations: agentUsage(root, a.slug).automations,
        };
      });
      if (opts.json) {
        console.log(JSON.stringify({ agents: rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim('No agents yet.'));
        return;
      }
      console.log(header('Agents'));
      for (const r of rows) {
        const state = r.approvedToRun ? chalk.green('may run') : r.approvedForChat ? chalk.yellow('chat only') : chalk.red('needs approval');
        const used = r.automations.length > 0 ? chalk.dim(` · runs ${r.automations.join(', ')}`) : '';
        console.log(`  ${chalk.bold(r.slug)}  ${r.title}  ${state}${used}`);
      }
    });

  agents
    .command('show')
    .argument('<slug>', 'Agent slug')
    .description('Show an agent: its prompt, its soul, its pattern, its approval on this machine, and where it is used')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const agent = getAgent(root, slug);
      const v = verdicts(root, slug);
      if (!agent || !v) {
        error(`No agent named "${slug}" in this project.`);
        process.exitCode = 1;
        return;
      }
      const usage = agentUsage(root, slug);
      const pattern = parsePattern(agent.pattern);
      if (opts.json) {
        console.log(JSON.stringify({
          agent: {
            slug: agent.slug, title: agent.title, prompt: agent.prompt, soul: agent.soul, pattern, model: agent.model, effort: agent.effort,
            learning: agent.learning, whiteboard: agent.whiteboard, shared: agent.shared, implicit: agent.implicit,
            approvedForChat: v.chat, approvedToRun: v.run, usedBy: usage,
          },
        }, null, 2));
        return;
      }
      console.log(header(`${agent.title} (${agent.slug})`));
      console.log(`  model: ${agent.model ?? 'default'}  effort: ${agent.effort ?? 'default'}  learning: ${agent.learning ? 'on' : 'off'}`);
      if (agent.whiteboard) console.log(`  home board: ${agent.whiteboard}`);
      console.log(`  chat: ${v.chat ? 'approved' : 'not approved'}  run: ${v.run ? 'approved' : 'not approved'}`);
      if (usage.automations.length > 0) console.log(`  automations: ${usage.automations.join(', ')}`);
      if (usage.boards.length > 0) console.log(`  boards: ${usage.boards.join(', ')}`);
      if (usage.tasks.length > 0) console.log(`  tasks: ${usage.tasks.join(', ')}`);
      console.log(`  pattern: ${pattern.lessons.length} lessons, playbook ${pattern.playbook.trim() ? 'set' : 'empty'}`);
      console.log('');
      console.log(agent.prompt);
      console.log('');
      console.log(chalk.dim('soul:'));
      console.log(agent.soul ? `  ${agent.soul.replace(/\n/g, '\n  ')}` : chalk.dim('  (none)'));
    });

  agents
    .command('create')
    .argument('<slug>', 'Kebab-case agent slug')
    .description('Create an agent, approved on this machine')
    .requiredOption('--title <title>', 'Agent name')
    .requiredOption('--prompt <text>', 'Who the agent is and what it knows how to do')
    .option('--soul <text>', 'How it works: stance, tempo, tone, what it refuses (approval-hashed)')
    .option('--soul-file <path>', 'Read the soul from a file')
    .option('--soul-template <id>', `Start the soul from a template (${SOUL_TEMPLATE_LIST})`)
    .option('--model <model>', 'Model override')
    .option('--effort <level>', `Effort (${EFFORT_LEVELS.join(', ')})`)
    .option('--whiteboard <board>', 'Home board: the agent acts only on it')
    .option('--no-learning', 'Do not keep a pattern of lessons')
    .action((slug: string, opts: SoulOptions & { title: string; prompt: string; model?: string; effort?: string; whiteboard?: string; learning: boolean }) => {
      const root = ensureContextRoot();
      try {
        const soul = resolveSoulOption(opts);
        registerProject(dirname(root));
        createAgent(root, {
          slug,
          title: opts.title,
          prompt: opts.prompt,
          soul: soul ?? '',
          model: opts.model ?? null,
          effort: readEffort(opts.effort) ?? null,
          whiteboard: opts.whiteboard ?? null,
          learning: opts.learning,
        }, { approve: { now: new Date() } });
        success(`Created the agent "${slug}" (agents/${slug}.md), approved on this machine.`);
      } catch (err) {
        fail(err);
      }
    });

  agents
    .command('edit')
    .argument('<slug>', 'Agent slug')
    .description('Edit an agent\'s identity; what was approved directly here stays approved')
    .option('--title <title>', 'Agent name')
    .option('--prompt <text>', 'Its prompt')
    .option('--soul <text>', 'How it works ("" removes it)')
    .option('--soul-file <path>', 'Read the soul from a file')
    .option('--soul-template <id>', `Replace the soul with a template (${SOUL_TEMPLATE_LIST})`)
    .option('--model <model>', 'Model override ("" for the default)')
    .option('--effort <level>', `Effort (${EFFORT_LEVELS.join(', ')}, or none)`)
    .option('--whiteboard <board>', 'Home board ("" for none)')
    .option('--learning', 'Keep a pattern of lessons')
    .option('--no-learning', 'Stop keeping a pattern of lessons')
    .action((slug: string, opts: SoulOptions & { title?: string; prompt?: string; model?: string; effort?: string; whiteboard?: string; learning?: boolean }) => {
      const root = ensureContextRoot();
      try {
        const patch: AgentIdentityPatch = {};
        if (opts.title !== undefined) patch.title = opts.title;
        if (opts.prompt !== undefined) patch.prompt = opts.prompt;
        const soul = resolveSoulOption(opts);
        if (soul !== undefined) patch.soul = soul;
        if (opts.model !== undefined) patch.model = opts.model || null;
        const effort = readEffort(opts.effort);
        if (effort !== undefined) patch.effort = effort;
        if (opts.whiteboard !== undefined) patch.whiteboard = opts.whiteboard || null;
        if (opts.learning !== undefined) patch.learning = opts.learning;
        if (Object.keys(patch).length === 0) {
          warn('Nothing to change.');
          return;
        }
        withRestamp(root, dirname(root), slug, patch);
        success(`Saved "${slug}".`);
      } catch (err) {
        fail(err);
      }
    });

  agents
    .command('approve')
    .argument('<slug>', 'Agent slug')
    .description('Review and approve an agent to run on this machine (refused inside a Claude session or an agent run)')
    .option('-y, --yes', 'Skip the interactive confirmation')
    .action(async (slug: string, opts: { yes?: boolean }) => {
      if (refuseSelfApproval(process.env)) return;
      const root = ensureContextRoot();
      const target = getRunTarget(root, slug, 'agent');
      if (!target) {
        error(`No agent named "${slug}" in this project.`);
        process.exitCode = 1;
        return;
      }
      try {
        const projectRoot = dirname(root);
        if (checkApproval(projectRoot, target, undefined, 'run').approved) {
          success(`"${slug}" is already approved to run here.`);
          return;
        }
        console.log(header(`Approve: ${slug}`));
        // Every hashed field, call settings included: this is exactly what a grant covers.
        const fields = approvalFields(target);
        for (const key of APPROVAL_DIFF_FIELDS) {
          const value = fields[key];
          const shown = value === null || value === ''
            ? chalk.dim('(none)')
            : typeof value === 'object' ? JSON.stringify(value, null, 2).replace(/\n/g, '\n    ') : String(value);
          console.log(chalk.dim(`  ${key}:`));
          console.log(`    ${shown}`);
        }
        if (!opts.yes) {
          const ok = await confirm({ message: `Approve "${slug}" to run on this machine?`, default: false });
          if (!ok) {
            warn('Not approved.');
            return;
          }
        }
        registerProject(projectRoot);
        approveAutomation(projectRoot, target, new Date());
        success(`Approved "${slug}" to run on this machine.`);
      } catch (err) {
        fail(err);
      }
    });

  agents
    .command('share')
    .argument('<slug>', 'Agent slug')
    .description('Publish this agent to the synced brain — private by default')
    .action((slug: string) => {
      const root = ensureContextRoot();
      const agent = getAgent(root, slug);
      if (!agent) {
        error(`No agent named "${slug}" in this project.`);
        process.exitCode = 1;
        return;
      }
      try {
        if (agent.implicit) {
          // Not split yet: the agent IS its automation file.
          setAutomationShared(root, slug, true);
          shareAutomation(root, slug);
        } else {
          setAgentShared(root, slug, true);
          shareAgent(root, slug);
        }
        success(`"${slug}" is shared.`);
      } catch (err) {
        fail(err);
      }
    });

  agents
    .command('unshare')
    .argument('<slug>', 'Agent slug')
    .description('Stop publishing this agent from this machine (refused while a shared automation uses it)')
    .action((slug: string) => {
      const root = ensureContextRoot();
      const agent = getAgent(root, slug);
      if (!agent) {
        error(`No agent named "${slug}" in this project.`);
        process.exitCode = 1;
        return;
      }
      const sharedUsers = agentUsage(root, slug).automations
        .filter((a) => a !== slug || !agent.implicit)
        .filter((a) => getRunTarget(root, a, 'automation')?.shared === true);
      if (sharedUsers.length > 0) {
        error(`A shared automation runs as "${slug}" (${sharedUsers.join(', ')}): unshare it first, or teammates would run it with no agent.`);
        process.exitCode = 1;
        return;
      }
      try {
        if (agent.implicit) {
          setAutomationShared(root, slug, false);
          unshareAutomation(root, slug);
        } else {
          setAgentShared(root, slug, false);
          unshareAgent(root, slug);
        }
        success(`"${slug}" is no longer shared from this machine (copies already pushed stay in git history).`);
      } catch (err) {
        fail(err);
      }
    });

  agents
    .command('remove')
    .argument('<slug>', 'Agent slug')
    .description('Delete an agent (refused while an automation runs as it)')
    .option('-y, --yes', 'Skip the interactive confirmation')
    .action(async (slug: string, opts: { yes?: boolean }) => {
      const root = ensureContextRoot();
      if (!getAgent(root, slug)) {
        error(`No agent named "${slug}" in this project.`);
        process.exitCode = 1;
        return;
      }
      if (!opts.yes) {
        const ok = await confirm({ message: `Delete the agent "${slug}"?`, default: false });
        if (!ok) return;
      }
      try {
        const result = removeAgent(root, slug);
        if (!result.removed) {
          error(`"${slug}" still runs ${result.usedBy.join(', ')}. Remove those automations first.`);
          process.exitCode = 1;
          return;
        }
        success(`Deleted the agent "${slug}".`);
      } catch (err) {
        fail(err);
      }
    });
}
