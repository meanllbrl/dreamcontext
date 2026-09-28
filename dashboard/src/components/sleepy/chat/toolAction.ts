import {
  condenseCommand, looksLikeHeadlessClaude, pathChipLabel, summarizeToolRun, toolRunHeadline, toolSubject,
  type ToolSubject,
} from './chatEntities';
import { isQuietDreamSegment, splitShellSegments, tokenizeShell } from './dreamCommand';
import { AGENT_ROLES, resolveAgentIdentity, type AgentRoleId } from '../../../lib/agentRoles';

/**
 * A tool call as ONE plain sentence: the team log's line for it.
 *
 * The transcript used to read like a shell log: a status dot, the tool's name (`Read`,
 * `Grep`, `Bash`), then its argument. The quest-party goal (owner, 2026-09-25) asks it to read
 * like a team at work instead, so each step is an action line whose TENSE carries its status:
 * "Reading ChatPane.tsx…" while it runs, "Read ChatPane.tsx" once it landed, "Couldn't read
 * ChatPane.tsx" when it failed. The raw tool name is never the headline; it stays in `raw`,
 * one click away with the command and its output.
 *
 * Pure and total: an unknown tool reads "Used <Name>", so a new tool still says something true.
 */

export type ActionKind = 'look' | 'search' | 'change' | 'run' | 'ask' | 'delegate' | 'plan' | 'web' | 'skill' | 'quest' | 'other';

export interface ToolAction {
  /** The sentence's head, already in the status's tense: "Read", "Searching for", "Couldn't edit". */
  verb: string;
  /** What it acted on. The header renders it as a chip (path, text) or a muted subtitle (prose). */
  subject: ToolSubject | null;
  /** Words after the subject: "on the web", or "failed" for a verb nobody named. */
  tail?: string;
  kind: ActionKind;
  /** Bookkeeping the reader should not have to notice (the quest map updating itself). */
  quiet: boolean;
  /** The step is still running: the line ends in "…". */
  ellipsis: boolean;
  /** The raw tool name, for the title and the details label. */
  raw: string;
}

type Status = 'running' | 'done' | 'error';

/** One verb in its three tenses. `failed` is the whole failure head: "Couldn't read". */
interface Tenses { done: string; running: string; failed: string }

function tenses(done: string, running: string, failed: string): Tenses {
  return { done, running, failed };
}

function pick(t: Tenses, status: Status): string {
  return status === 'running' ? t.running : status === 'error' ? t.failed : t.done;
}

/** The tools with a sentence of their own. Anything else reads "Used <Name>". */
const TOOL_VERBS: Readonly<Record<string, { tenses: Tenses; kind: ActionKind; tail?: string }>> = {
  Read: { tenses: tenses('Read', 'Reading', "Couldn't read"), kind: 'look' },
  Grep: { tenses: tenses('Searched for', 'Searching for', "Couldn't search for"), kind: 'search' },
  Glob: { tenses: tenses('Looked for files matching', 'Looking for files matching', "Couldn't look for files matching"), kind: 'search' },
  LS: { tenses: tenses('Listed', 'Listing', "Couldn't list"), kind: 'look' },
  Edit: { tenses: tenses('Edited', 'Editing', "Couldn't edit"), kind: 'change' },
  MultiEdit: { tenses: tenses('Edited', 'Editing', "Couldn't edit"), kind: 'change' },
  NotebookEdit: { tenses: tenses('Edited', 'Editing', "Couldn't edit"), kind: 'change' },
  Write: { tenses: tenses('Wrote', 'Writing', "Couldn't write"), kind: 'change' },
  WebFetch: { tenses: tenses('Read', 'Reading', "Couldn't read"), kind: 'web', tail: 'on the web' },
  WebSearch: { tenses: tenses('Searched the web for', 'Searching the web for', "Couldn't search the web for"), kind: 'web' },
  Skill: { tenses: tenses('Used', 'Using', "Couldn't use"), kind: 'skill' },
  TodoWrite: { tenses: tenses('Updated the to-do list', 'Updating the to-do list', "Couldn't update the to-do list"), kind: 'plan' },
  ExitPlanMode: { tenses: tenses('Proposed a plan', 'Proposing a plan', "Couldn't propose a plan"), kind: 'plan' },
  BashOutput: { tenses: tenses('Checked on a background job', 'Checking on a background job', "Couldn't check on a background job"), kind: 'run' },
  TaskOutput: { tenses: tenses('Checked on a background job', 'Checking on a background job', "Couldn't check on a background job"), kind: 'run' },
  KillShell: { tenses: tenses('Stopped a background job', 'Stopping a background job', "Couldn't stop a background job"), kind: 'run' },
  TaskStop: { tenses: tenses('Stopped a background job', 'Stopping a background job', "Couldn't stop a background job"), kind: 'run' },
};

/** Tools whose subject would only repeat the sentence (the to-do list, the plan, a job id). */
const SUBJECTLESS: ReadonlySet<string> = new Set(['TodoWrite', 'ExitPlanMode', 'BashOutput', 'TaskOutput', 'KillShell', 'TaskStop']);

/**
 * The leading verbs of a Bash `description`, conjugated. The agent writes descriptions in the
 * imperative ("Read the full project snapshot"), which is already the done tense for `Read`
 * and wrong for everything else. A verb missing here keeps the description verbatim.
 */
const BASH_VERBS: Readonly<Record<string, { done: string; running: string; kind: ActionKind }>> = (() => {
  const table: Record<string, { done: string; running: string; kind: ActionKind }> = {};
  const add = (kind: ActionKind, rows: [string, string, string][]) => {
    for (const [verb, done, running] of rows) table[verb.toLowerCase()] = { done, running, kind };
  };
  add('look', [
    ['Read', 'Read', 'Reading'], ['List', 'Listed', 'Listing'], ['Show', 'Showed', 'Showing'],
    ['Check', 'Checked', 'Checking'], ['Inspect', 'Inspected', 'Inspecting'], ['Find', 'Found', 'Finding'],
    ['Search', 'Searched', 'Searching'], ['Count', 'Counted', 'Counting'], ['Measure', 'Measured', 'Measuring'],
    ['Look', 'Looked', 'Looking'], ['Print', 'Printed', 'Printing'], ['Scan', 'Scanned', 'Scanning'],
    ['Verify', 'Verified', 'Verifying'],
  ]);
  add('change', [
    ['Write', 'Wrote', 'Writing'], ['Create', 'Created', 'Creating'], ['Update', 'Updated', 'Updating'],
    ['Install', 'Installed', 'Installing'], ['Build', 'Built', 'Building'], ['Add', 'Added', 'Adding'],
    ['Remove', 'Removed', 'Removing'], ['Delete', 'Deleted', 'Deleting'], ['Commit', 'Committed', 'Committing'],
    ['Push', 'Pushed', 'Pushing'], ['Move', 'Moved', 'Moving'], ['Copy', 'Copied', 'Copying'],
    ['Save', 'Saved', 'Saving'], ['Seed', 'Seeded', 'Seeding'], ['Sync', 'Synced', 'Syncing'],
    ['Set', 'Set', 'Setting'], ['Make', 'Made', 'Making'], ['Rebuild', 'Rebuilt', 'Rebuilding'],
  ]);
  add('run', [
    ['Run', 'Ran', 'Running'], ['Test', 'Tested', 'Testing'], ['Compile', 'Compiled', 'Compiling'],
    ['Start', 'Started', 'Starting'], ['Stop', 'Stopped', 'Stopping'], ['Load', 'Loaded', 'Loading'],
    ['Open', 'Opened', 'Opening'], ['Fetch', 'Fetched', 'Fetching'], ['Get', 'Got', 'Getting'],
    ['Type-check', 'Type-checked', 'Type-checking'],
  ]);
  return table;
})();

function inputStr(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function own<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** "Read" → "read", but "CI" and "PR" keep their capitals: they are names, not sentence case. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

function words(identifier: string): string {
  return identifier.replace(/_/g, ' ').trim();
}

/** `mcp__claude_ai_Claude_Docs__batch` → `Claude Docs: batch`. Null when the name is not MCP. */
function mcpLabel(name: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  return `${words(m[1].replace(/^claude_ai_/, ''))}: ${words(m[2])}`;
}

// ─── Bash ──────────────────────────────────────────────────────────────────────────

/**
 * Is this command ONLY quest-map bookkeeping (`dreamcontext goal-live …`, chained or alone)?
 * Such a call renders nothing on its own, and reads as a quiet line inside a work beat. A
 * goal-live call chained onto real work is not this: the work keeps its row.
 */
export function isQuestOnlyCommand(command: string | undefined): boolean {
  if (!command || !command.includes('goal-live')) return false;
  const segments = splitShellSegments(command);
  return segments.length > 0 && segments.every(isQuietDreamSegment);
}

type HeadlessForm = 'fork' | 'resume' | 'brief';

/**
 * Does the command start a headless teammate, and how? A copied memory (`--fork-session`)
 * outranks a return (`--resume`), which outranks a fresh brief. `looksLikeHeadlessClaude`
 * already strips a subshell opener and quotes (`(claude -p … & wait)`), so the parallel
 * builder form is recognised the same as a single call.
 */
function headlessForm(segments: readonly string[]): HeadlessForm | null {
  let form: HeadlessForm | null = null;
  for (const segment of segments) {
    if (!looksLikeHeadlessClaude(segment)) continue;
    // Tokenized, so a prompt that merely MENTIONS a flag ("never pass --resume") is one token.
    const tokens = tokenizeShell(segment);
    if (tokens.includes('--fork-session')) return 'fork';
    if (tokens.includes('--resume') || tokens.includes('-r')) form = 'resume';
    else form ??= 'brief';
  }
  return form;
}

const HEADLESS_TENSES: Readonly<Record<HeadlessForm, Tenses>> = {
  fork: tenses(
    "Started a builder with the Planner's memory",
    "Starting a builder with the Planner's memory",
    "Couldn't start a builder with the Planner's memory",
  ),
  resume: tenses(
    'Brought a teammate back where it left off',
    'Bringing a teammate back where it left off',
    "Couldn't bring a teammate back where it left off",
  ),
  brief: tenses('Briefed a new teammate', 'Briefing a new teammate', "Couldn't brief a new teammate"),
};

function bashAction(input: unknown, status: Status): Omit<ToolAction, 'ellipsis' | 'raw'> {
  const command = inputStr(input, 'command');
  const description = inputStr(input, 'description');
  if (isQuestOnlyCommand(command)) {
    return {
      verb: pick(tenses('Updated the quest map', 'Updating the quest map', "Couldn't update the quest map"), status),
      subject: null, kind: 'quest', quiet: true,
    };
  }
  // The work a command does, with the bookkeeping riding on it taken out.
  const all = command ? splitShellSegments(command) : [];
  const work = all.filter((s) => !isQuietDreamSegment(s));
  const prose: ToolSubject | null = description ? { kind: 'prose', text: description } : null;

  const headless = headlessForm(work);
  if (headless) return { verb: pick(HEADLESS_TENSES[headless], status), subject: prose, kind: 'delegate', quiet: false };

  if (description) {
    const [first, ...rest] = description.split(/\s+/);
    const known = own(BASH_VERBS, first.toLowerCase());
    const tail = rest.length ? ` ${rest.join(' ')}` : '';
    if (status === 'error') return { verb: `Tried to ${lowerFirst(description)}`, subject: null, kind: known?.kind ?? 'run', quiet: false };
    if (!known) return { verb: description, subject: null, kind: 'run', quiet: false };
    return { verb: `${status === 'running' ? known.running : known.done}${tail}`, subject: null, kind: known.kind, quiet: false };
  }

  const shown = work.length === all.length ? command : work.join(' && ');
  return {
    verb: pick(tenses('Ran a command', 'Running a command', "Couldn't run a command"), status),
    subject: shown ? { kind: 'prose', text: condenseCommand(shown) } : null,
    kind: 'run',
    quiet: false,
  };
}

// ─── The one entry point ───────────────────────────────────────────────────────────

function agentAction(input: unknown, status: Status): Omit<ToolAction, 'ellipsis' | 'raw'> {
  const description = inputStr(input, 'description');
  const { role } = resolveAgentIdentity({
    subagentType: inputStr(input, 'subagent_type'), name: description, prompt: inputStr(input, 'prompt'),
  });
  const who = `the ${AGENT_ROLES[role].label.toLowerCase()}:`;
  return {
    verb: pick(tenses(`Sent ${who}`, `Sending ${who}`, `Couldn't send ${who}`), status),
    subject: description ? { kind: 'text', text: description } : null,
    kind: 'delegate',
    quiet: false,
  };
}

function askAction(input: unknown, status: Status): Omit<ToolAction, 'ellipsis' | 'raw'> {
  const questions = input && typeof input === 'object' ? (input as Record<string, unknown>).questions : undefined;
  const n = Array.isArray(questions) ? questions.length : 1;
  const what = n === 1 ? 'a question' : `${n} questions`;
  return {
    verb: pick(tenses(`Asked you ${what}`, `Asking you ${what}`, `Couldn't ask you ${what}`), status),
    subject: null, kind: 'ask', quiet: false,
  };
}

export function toolAction(name: string, input: unknown, status: Status): ToolAction {
  const base = ((): Omit<ToolAction, 'ellipsis' | 'raw'> => {
    if (name === 'Bash') return bashAction(input, status);
    if (name === 'Agent' || name === 'Task') return agentAction(input, status);
    if (name === 'AskUserQuestion') return askAction(input, status);
    const known = own(TOOL_VERBS, name);
    if (known) {
      return {
        verb: pick(known.tenses, status),
        subject: SUBJECTLESS.has(name) ? null : toolSubject(name, input),
        tail: known.tail,
        kind: known.kind,
        quiet: false,
      };
    }
    const label = mcpLabel(name) ?? name;
    return {
      verb: pick(tenses(`Used ${label}`, `Using ${label}`, `Couldn't use ${label}`), status),
      subject: toolSubject(name, input),
      kind: 'other',
      quiet: false,
    };
  })();
  return { ...base, ellipsis: status === 'running', raw: name };
}

function subjectText(s: ToolSubject | null): string {
  if (!s) return '';
  if (s.kind === 'path') return s.label ?? pathChipLabel(s.path).name;
  return s.text;
}

/**
 * The whole line as one string: verb, subject and tail joined by single spaces, with any "…"
 * or "..." the agent already wrote taken off the end, then "…" put back only while it runs.
 * This is the header's aria-label base, so a failure's "failed" tail is always spoken.
 */
export function actionText(a: ToolAction): string {
  const text = [a.verb, subjectText(a.subject), a.tail]
    .filter((part): part is string => !!part)
    .join(' ')
    .replace(/\s*(?:…|\.\.\.)\s*$/, '');
  return a.ellipsis ? `${text}…` : text;
}

/** The thinking row's line, in the same grammar as a step. */
export function thinkingLabel(streaming: boolean): string {
  return streaming ? 'Thinking it through…' : 'Thought it through';
}

type BeatItem = { name: string; input?: unknown; status: Status; startedAt: number; endedAt?: number };

function isQuestItem(i: BeatItem): boolean {
  return i.name === 'Bash' && isQuestOnlyCommand(inputStr(i.input, 'command'));
}

/**
 * A collapsed stretch of steps, as what the team did: "Looked around: 4 steps · 2 files read
 * · 1 command". The lead word comes from what the steps were (any change wins, then all
 * looking, then mostly running), and the counts are `toolRunHeadline`'s. Quest-map
 * bookkeeping is not a step, so it is neither counted nor allowed to colour the lead word.
 */
export function workBeatHeadline(items: readonly BeatItem[]): string {
  const steps = items.filter((i) => !isQuestItem(i));
  const kinds = steps.map((i) => toolAction(i.name, i.input, i.status).kind);
  const looking = new Set<ActionKind>(['look', 'search', 'web']);
  let lead = 'Worked through it';
  if (kinds.some((k) => k === 'change')) lead = 'Made changes';
  else if (kinds.length > 0 && kinds.every((k) => looking.has(k))) lead = 'Looked around';
  else if (kinds.length > 0 && kinds.filter((k) => k === 'run').length * 2 >= kinds.length) lead = 'Ran checks';
  return `${lead}: ${toolRunHeadline(summarizeToolRun(steps))}`;
}

// ─── Stretches: who is speaking, like consecutive Slack messages ───────────────────

export interface StretchProbe {
  key: string;
  /** Renders as a step line (a tool row, a dreamcard, a thinking line, a work beat). */
  step: boolean;
  /** Draws nothing: neither joins a stretch nor breaks one. */
  invisible: boolean;
  actor: AgentRoleId;
  running: boolean;
}

/**
 * Group step lines the way a chat groups messages: the first step by an actor opens a stretch
 * and shows the avatar, the steps after it are bare lines. Anything else the reader can see
 * (a message, a card) ends the stretch; an item that draws nothing does not. Only the lead
 * carries `running`, and it is true while ANY step in its stretch runs, so exactly one avatar
 * per stretch is the one that moves.
 */
export function stepStretches(
  seq: readonly StretchProbe[],
): Map<string, { stretch: 'lead' | 'follow'; running: boolean }> {
  const out = new Map<string, { stretch: 'lead' | 'follow'; running: boolean }>();
  let lead: { key: string; actor: AgentRoleId } | null = null;
  for (const p of seq) {
    if (p.invisible) continue;
    if (!p.step) { lead = null; continue; }
    if (lead && lead.actor === p.actor) {
      out.set(p.key, { stretch: 'follow', running: false });
      if (p.running) out.get(lead.key)!.running = true;
      continue;
    }
    lead = { key: p.key, actor: p.actor };
    out.set(p.key, { stretch: 'lead', running: p.running });
  }
  return out;
}
