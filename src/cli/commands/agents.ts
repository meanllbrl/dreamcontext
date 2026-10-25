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
  createGlobalAgent,
  getAgent,
  listAgents,
  removeAgent,
  setAgentPlacement,
  setAgentShared,
  withRestamp,
} from '../../lib/agents/store.js';
import type { AgentIdentityPatch, AgentPlacementPatch } from '../../lib/agents/types.js';
import { buildTree, flattenTree } from '../../lib/agents/tree.js';
import { assertOwned, ownerLabel } from '../../lib/agents/owner.js';
import { agentSyncPreview, agentSyncState, confirmAgentSyncHere } from '../../lib/agents/agent-sync.js';
import { writeActiveHere } from '../../lib/agents/active.js';
import { scanOutsideAssignments } from '../../lib/agents/outside-assignments.js';
import { listInboxRows } from '../../lib/owner-inbox.js';
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
  AGENT_AUTONOMY_LEVELS,
  AGENT_SELF_ENV,
  APPROVAL_DIFF_FIELDS,
  AutomationError,
  EFFORT_LEVELS,
  insideAgentRun,
  type AgentAutonomy,
  type EffortLevel,
} from '../../lib/automations/types.js';

/** An `--autonomy` value. Refused inside an agent run: an agent does not set its own level. */
function readAutonomyOption(v: string | undefined): AgentAutonomy | undefined {
  if (v === undefined) return undefined;
  if (insideAgentRun()) {
    throw new AutomationError('An agent cannot change an autonomy level. Ask the owner to set it on the AI Team page.');
  }
  if (!(AGENT_AUTONOMY_LEVELS as readonly string[]).includes(v)) {
    throw new AutomationError(`Invalid autonomy "${v}": expected one of ${AGENT_AUTONOMY_LEVELS.join(', ')}.`);
  }
  return v as AgentAutonomy;
}

/** The env vars a Claude session or an agent run carries. */
const SELF_APPROVAL_ENVS = ['CLAUDECODE', AGENT_SELF_ENV, 'DREAMCONTEXT_AUTOMATION_RUN'] as const;

/** The refusal. It names the page, never a command: a session that reads it
 *  must not be one shell line away from approving the agent itself. */
export const SELF_APPROVAL_REFUSAL =
  'Approving is the owner\'s step, and this is a Claude session or an agent run. Approve it on the AI Team page in the dashboard.';

/**
 * A guard against ACCIDENTAL self-approval — not a security boundary (a session
 * with full permissions can still reach the approve route or the registry
 * file). Refuses, with or without `-y`, when the shell is a Claude session or an
 * agent run. Returns true when it refused, so the caller returns without acting.
 */
export function refuseSelfApproval(env: NodeJS.ProcessEnv): boolean {
  if (!SELF_APPROVAL_ENVS.some((k) => env[k] !== undefined)) return false;
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

function verdicts(root: string, slug: string): { chat: boolean; run: boolean; readOnlyOwner: string | null } | null {
  const target = getRunTarget(root, slug, 'agent');
  if (!target) return null;
  const projectRoot = dirname(root);
  const run = checkApproval(projectRoot, target, undefined, 'run');
  return {
    chat: checkApproval(projectRoot, target, undefined, 'identity').approved,
    run: run.approved,
    // Someone else's agent: read-only here, never "needs approval" (B1-4).
    readOnlyOwner: !run.approved && run.reason === 'not_owner' ? run.owner : null,
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
    .option('--tree', 'Draw the team as a tree: who reports to whom, and each lead\'s team')
    .action((opts: { json?: boolean; tree?: boolean }) => {
      const root = ensureContextRoot();
      const rows = listAgents(root).map((a) => {
        const v = verdicts(root, a.slug);
        return {
          slug: a.slug,
          title: a.title,
          scope: a.scope,
          approvedForChat: v?.chat ?? false,
          approvedToRun: v?.run ?? false,
          owner: a.owner,
          readOnly: !!v?.readOnlyOwner,
          implicit: a.implicit,
          reportsTo: a.reportsTo,
          team: a.team,
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
      const line = (r: (typeof rows)[number]) => {
        const state = r.readOnly
          ? chalk.dim(`${ownerLabel(r.owner ?? '')}'s · read-only`)
          : r.approvedToRun ? chalk.green('may run') : r.approvedForChat ? chalk.yellow('chat only') : chalk.red('needs approval');
        const used = r.automations.length > 0 ? chalk.dim(` · runs ${r.automations.join(', ')}`) : '';
        const scope = r.scope === 'global' ? chalk.cyan(' · global') : '';
        return `${chalk.bold(r.slug)}  ${r.title}  ${state}${scope}${used}`;
      };
      if (!opts.tree) {
        for (const r of rows) console.log(`  ${line(r)}`);
        return;
      }
      const bySlug = new Map(rows.map((r) => [r.slug, r]));
      const tree = buildTree(rows);
      console.log(chalk.dim('  You'));
      let rootLast = false;
      for (const l of flattenTree(tree, new Set())) {
        const n = tree.nodes.get(l.slug)!;
        if (l.depth === 0) rootLast = l.last;
        const rootRail = l.depth === 0 ? '' : rootLast ? '   ' : '│  ';
        const indent = rootRail + l.guides.map((g) => (g ? '│  ' : '   ')).join('');
        const elbow = l.last ? '└─ ' : '├─ ';
        const team = n.ownTeam ? chalk.cyan(` [${n.ownTeam}]`) : '';
        const note = n.missingManager
          ? chalk.dim(` (reports to ${n.missingManager}, not on this machine)`)
          : n.cycle ? chalk.dim(' (reporting loop: shown at the top)') : '';
        console.log(`  ${indent}${elbow}${line(bySlug.get(l.slug)!)}${team}${note}`);
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
            reportsTo: agent.reportsTo, team: agent.team, autonomy: agent.autonomy,
            approvedForChat: v.chat, approvedToRun: v.run, usedBy: usage,
          },
        }, null, 2));
        return;
      }
      console.log(header(`${agent.title} (${agent.slug})`));
      console.log(`  model: ${agent.model ?? 'default'}  effort: ${agent.effort ?? 'default'}  learning: ${agent.learning ? 'on' : 'off'}  autonomy: ${agent.autonomy}`);
      if (agent.whiteboard) console.log(`  home board: ${agent.whiteboard}`);
      console.log(`  reports to: ${agent.reportsTo ?? 'you'}${agent.team ? `  team: ${agent.team}` : ''}`);
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
    .option('--scope <scope>', 'project (this brain, default) or global (this machine: listed in every project, never in a brain)', 'project')
    .action((slug: string, opts: SoulOptions & { title: string; prompt: string; model?: string; effort?: string; whiteboard?: string; learning: boolean; scope: string }) => {
      if (opts.scope !== 'project' && opts.scope !== 'global') {
        fail(new Error(`--scope is project or global, not "${opts.scope}".`));
        return;
      }
      // Inside an agent run, nothing it creates is approved by it: the owner approves on the AI Team
      // page (a self-approved global agent would run in every project of this machine).
      const selfRun = insideAgentRun();
      const approve = selfRun ? {} : { approve: { now: new Date() } };
      const unapproved = selfRun ? ' It waits for the owner\'s approval on the AI Team page.' : '';
      if (opts.scope === 'global') {
        try {
          const soul = resolveSoulOption(opts);
          createGlobalAgent({
            slug,
            title: opts.title,
            prompt: opts.prompt,
            soul: soul ?? '',
            model: opts.model ?? null,
            effort: readEffort(opts.effort) ?? null,
            whiteboard: opts.whiteboard ?? null,
            learning: opts.learning,
          }, approve);
          success(`Created the global agent "${slug}" (~/.dreamcontext/agents/${slug}.md): every project lists it${selfRun ? '.' + unapproved : ', approved on this machine.'}`);
        } catch (err) {
          fail(err);
        }
        return;
      }
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
        }, approve);
        success(`Created the agent "${slug}" (agents/${slug}.md)${selfRun ? '.' + unapproved : ', approved on this machine.'}`);
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
    .option('--reports-to <agent>', 'The agent it reports to ("none" = straight to you). Unhashed: changes only how the team is drawn')
    .option('--team <name>', 'Its team\'s name, carried by a lead and inherited by its reports ("none" removes it). Unhashed')
    .option('--autonomy <level>', `How much it decides alone (${AGENT_AUTONOMY_LEVELS.join(', ')}); sets the permission mode of its sessions`)
    .action((slug: string, opts: SoulOptions & { title?: string; prompt?: string; model?: string; effort?: string; whiteboard?: string; learning?: boolean; reportsTo?: string; team?: string; autonomy?: string }) => {
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
        const autonomy = readAutonomyOption(opts.autonomy);
        if (autonomy !== undefined) patch.autonomy = autonomy;
        const place: AgentPlacementPatch = {};
        if (opts.reportsTo !== undefined) place.reportsTo = opts.reportsTo === 'none' ? null : opts.reportsTo;
        if (opts.team !== undefined) place.team = opts.team;
        if (Object.keys(patch).length === 0 && Object.keys(place).length === 0) {
          warn('Nothing to change.');
          return;
        }
        // The placement first: it is checked against the team (a loop, an unknown manager) and
        // refused before any identity change lands.
        if (Object.keys(place).length > 0) {
          const placed = setAgentPlacement(root, slug, place);
          if (place.team && !listAgents(root).some((a) => a.reportsTo === slug)) {
            warn(`"${slug}" has no reports yet: its team "${placed.team}" shows once someone reports to it.`);
          }
        }
        if (Object.keys(patch).length > 0) withRestamp(root, dirname(root), slug, patch);
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

  agents
    .command('sync')
    .description('Agents ride the brain sync: show the switch and this machine\'s state, or confirm it here')
    .option('--confirm', 'Turn agent sync on (if off) and confirm it on THIS machine: its agents start to sync')
    .option('--json', 'Emit as JSON')
    .action((opts: { confirm?: boolean; json?: boolean }) => {
      const root = ensureContextRoot();
      if (opts.confirm) {
        // The owner's call, never an agent's: confirming publishes this machine's agents.
        if (insideAgentRun()) {
          error('An agent run cannot turn on agent sync. Ask the owner to confirm it on the AI Team page.');
          process.exitCode = 1;
          return;
        }
        const r = confirmAgentSyncHere(root);
        success(`Agent sync is on for this machine${r.renamed > 0 ? ` (${r.renamed} thread day file${r.renamed === 1 ? '' : 's'} renamed for this machine)` : ''}. The next brain sync pushes your agents; run \`dreamcontext brain sync\` to send them now.`);
        return;
      }
      const state = agentSyncState(root);
      const preview = state.active ? { files: [] as string[], hits: [] as { file: string; line: number; rule: string; severity: string }[] } : agentSyncPreview(root);
      if (opts.json) {
        console.log(JSON.stringify({ ...state, filesToSync: preview.files.length, hits: preview.hits }, null, 2));
        return;
      }
      console.log(header('Agent sync'));
      console.log(`  Brain switch: ${state.switchOn ? chalk.green('on') : chalk.dim('off')}`);
      console.log(`  This machine: ${state.confirmedHere ? chalk.green('confirmed') : chalk.yellow('not confirmed')}`);
      if (!state.active) {
        console.log(chalk.dim(`  ${preview.files.length} file(s) would start to sync from here. Every machine on this brain must run this version first: an older version overwrites its own same-named agents when it pulls.`));
        for (const h of preview.hits) console.log(`  ${h.severity === 'block' ? chalk.red('held') : chalk.yellow('check')}  ${h.file}:${h.line}  ${h.rule}`);
      }
    });

  agents
    .command('bring-here')
    .argument('<slug>', 'Agent slug')
    .description('Run this agent on THIS machine from now on (same login, several machines); the other machine stops at its next pull')
    .action((slug: string) => {
      const root = ensureContextRoot();
      if (insideAgentRun()) {
        error('An agent run cannot move an agent between machines. Ask the owner.');
        process.exitCode = 1;
        return;
      }
      const agent = getAgent(root, slug);
      if (!agent) {
        error(`No agent named "${slug}" in this project.`);
        process.exitCode = 1;
        return;
      }
      try {
        assertOwned({ owner: agent.owner }, agent.title || slug);
        writeActiveHere(root, slug, agent.owner);
        success(`${agent.title || slug} runs on this machine now. Run \`dreamcontext brain sync\` so your other machine learns it at its next pull.`);
      } catch (err) {
        fail(err);
      }
    });

  agents
    .command('inbox')
    .description('What waits for you here: held secrets, tasks assigned outside the app, renamed agents, patterns to adopt')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      scanOutsideAssignments(root);
      const rows = listInboxRows(dirname(root));
      if (opts.json) {
        console.log(JSON.stringify({ rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim('Nothing waits for you.'));
        return;
      }
      console.log(header('Waiting for you'));
      for (const r of rows) console.log(`  ${chalk.bold(r.kind)}  ${r.title}${r.detail ? chalk.dim(` (${r.detail})`) : ''}`);
      console.log(chalk.dim('  Answer them on the AI Team page.'));
    });
}
