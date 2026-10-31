import { CREDENTIAL_ANYWHERE, credentialReadDenies } from './board-scope.js';
import { readToolsOf } from '../agents/read-tools.js';
import type { AutomationManifest, EffortLevel, SpawnModelOverride } from './types.js';

/**
 * A LIGHT JOB (`super team ask --light`): one small read for an AI Team member, cheap and closed.
 *
 * THE BOUNDARY IS THE TOOL ENVELOPE, NEVER THE PROMPT. A member's limits ("no message without the
 * owner's word") can live in a skill or knowledge file the job skips reading, so nothing here
 * trusts the member to know them: `dontAsk` denies every tool that is not listed, the deny list
 * then beats any allow rule, and `--setting-sources ''` drops the settings whose allow rules could
 * widen it (and their hooks, and CLAUDE.md, which is the other half of the saved tokens).
 *
 * Why not `--permission-mode plan`, the approval question's envelope: plan mode lets only tools
 * MARKED read-only through, and most MCP servers mark nothing, so a member's own read tools would
 * be denied with the send tools. Why no name matching ("get_*" is a read): a name is a claim, and a
 * `query` tool can delete. So an MCP read tool opens only when it is named, literally, in the
 * agent's own hashed `read_tools:`; with none, the job has the file readers alone and still runs.
 *
 * Replaces the whole envelope at every autonomy level and on a home board: read-only is under all
 * of them, so a level can only narrow here, never rise. Nothing of this is stored or hashed.
 */

/** The cheap default of a light job; a `--model` or `--effort` of its own wins. */
export const LIGHT_DEFAULT_MODEL = 'haiku';
export const LIGHT_DEFAULT_EFFORT: EffortLevel = 'low';

const LIGHT_BUILTIN_READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/**
 * Denied outright: deny rules outrank every allow rule, wherever one came from. A superset of the
 * approval question's list (`QUESTION_DISALLOWED_TOOLS`), plus what reaches past this machine.
 */
export const LIGHT_DISALLOWED_TOOLS = [
  'Bash', 'PowerShell', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'WebFetch', 'WebSearch',
  'Task', 'Skill', 'Agent', 'TaskCreate', 'TaskUpdate', 'TaskStop', 'Workflow',
  'CronCreate', 'CronDelete', 'CronList', 'SendMessage', 'RemoteTrigger', 'PushNotification',
  'DesignSync', 'EnterWorktree', 'ExitWorktree', 'Monitor', 'ScheduleWakeup', 'ListAgents',
  'ReportFindings', 'AskUserQuestion',
  // Neither takes a permission, so `dontAsk` alone leaves any server's resources open.
  'ListMcpResourcesTool', 'ReadMcpResourceTool',
] as const;

/**
 * A run whose session must not become the agent's conversation. A light one skipped the reading.
 * One job's `--model` on an agent with no model of its own: a resume names no model then, and a
 * claude session keeps the one it last ran on, so the job's model would outlive the job. (An agent
 * with a model pins it on every resume.) Nothing else changes: the thread and the answer stay.
 */
export function runLeavesNoSession(
  m: Pick<AutomationManifest, 'model'>,
  override: SpawnModelOverride | null | undefined,
): boolean {
  return override?.light === true || (override?.oneJob === true && !!override.model && !m.model);
}

/** Would resuming a session with this override leave its model behind? A session keeps the model
 *  it last ran on, and an agent with none names none on the next resume. One job's only: the AI
 *  Team's temporary model is a message in the conversation. */
export function wouldStickToSession(
  m: Pick<AutomationManifest, 'model'>,
  override: SpawnModelOverride | null | undefined,
): boolean {
  return (override?.light === true || override?.oneJob === true) && !!override.model && !m.model;
}

/** The light job's whole permission argv. Takes the place of `bypassPermissions` or a board scope. */
export function lightRunArgs(m: Pick<AutomationManifest, 'readTools'>, userHome?: string): string[] {
  return [
    '--permission-mode', 'dontAsk',
    '--setting-sources', '',
    '--allowedTools', ...LIGHT_BUILTIN_READ_TOOLS, ...readToolsOf(m.readTools),
    '--disallowedTools', ...LIGHT_DISALLOWED_TOOLS,
    ...credentialReadDenies(userHome),
    // Root-anchored: a bare `**/` means under the cwd, and a light job may read a sibling project.
    ...CREDENTIAL_ANYWHERE.map((g) => `Read(//${g})`),
  ];
}

/** What a light turn is told; a resume opens its prompt with it, so never with a dash (argv would
 * read it as a flag). Saving tokens is its job: the closing of the tools is the envelope's. */
export const LIGHT_JOB_BLOCK = [
  '=== THIS JOB IS LIGHT (read-only, this turn only) ===',
  'The Super Agent gave you one small read-only job. For this turn:',
  '- Skip your standing start-up reading: every "read first", "before you start" or per-session reading step in your instructions (skills, knowledge files). Read only what this job needs.',
  '- Your tools are read-only, and the run enforces it: nothing here can send a message, write a file, run a command or change an outside system. A denied tool is not something to work around.',
  '- Every limit in your instructions still holds, as written.',
  '- If the job needs a closed tool, or more than this read (a diagnosis, a draft, a send), stop and say so: it comes back to you as a full job.',
  '- Your final message IS your answer. Do not post to the thread, propose, or record a lesson this turn: those commands are closed, whatever the instructions around this block say.',
  '=== END LIGHT JOB ===',
].join('\n');
