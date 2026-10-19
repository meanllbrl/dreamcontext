import type { Task } from '../hooks/useTasks';
import { buildDelegatePrompt, taskContextBlock, taskSourcePath } from './delegateAgent';

/**
 * The four things you actually want from a task you're handing to Claude.
 *
 * "Delegate" used to mean exactly one thing — go build this, alone, overnight — because there
 * was one prompt. But the same task, on the same board, is just as often something you want to
 * TALK about before anyone writes code, something you suspect is already finished and want
 * PROVEN, or something you wrote three weeks ago and need read back to you. Those are not
 * edits to the autonomous prompt; they are different jobs, with different permissions and a
 * different place to land (a conversation belongs on screen, a background build does not).
 *
 * So a mode owns four things at once and the composer applies all of them together:
 *   • the prompt draft            — the instruction wrapped around the task
 *   • the bypass-permissions default — a discussion has no business editing files
 *   • where the session opens     — {@link DelegateMode.reveal} for the modes you must watch
 *   • the tab title prefix        — so four chips for one task stay tellable apart
 *
 * Every mode hands over the SAME task body ({@link taskContextBlock}) and points at the same
 * source-of-truth file, so switching modes never changes what the agent is looking at — only
 * what it is being asked to do with it.
 */

export type DelegateModeId = 'autonomous' | 'discuss' | 'verify' | 'summarize';

export interface DelegateMode {
  id: DelegateModeId;
  /** Chip label in the composer. */
  label: string;
  /** One line under the chips: what this hand-off actually does, in the user's terms. */
  hint: string;
  /**
   * Prefixed to the spawned tab/chip title (`''` = the task name alone, which is right for the
   * autonomous run — that IS the task being worked). Delegating the same task twice in two
   * modes is normal; without this the dock would show two identical chips.
   */
  titlePrefix: string;
  /** Whether the bypass-permissions toggle starts armed. The user can still flip it. */
  bypass: boolean;
  /**
   * Force the session to open as a visible pane instead of a background chip, overriding the
   * call site's default. Set only where backgrounding would break the mode: a discussion is a
   * conversation, and a conversation minimized into the corner is one nobody has.
   */
  reveal?: true;
  /** The prompt draft the composer opens with (fully editable before sending). */
  build(task: Task, title: string): string;
}

/**
 * Ask for the work, done. The original delegate prompt, unchanged — bypass armed, background
 * chip, no questions. This is still the default because it is still the common case.
 */
const AUTONOMOUS: DelegateMode = {
  id: 'autonomous',
  label: 'Autonomous',
  hint: 'Builds it end to end without asking. Starts in the background.',
  titlePrefix: '',
  bypass: true,
  build: buildDelegatePrompt,
};

/**
 * Think it through together, BEFORE code exists. Permissions stay on (a discussion that edits
 * files is not a discussion) and the session opens revealed — you are the other half of it.
 */
const DISCUSS: DelegateMode = {
  id: 'discuss',
  label: 'Discuss',
  hint: 'Talks the approach through with you first — reads the code, writes nothing.',
  titlePrefix: 'Discuss · ',
  bypass: false,
  reveal: true,
  build: (task, title) => [
    "Let's think this dreamcontext task through together before anything gets built. Do NOT edit "
    + 'files and do NOT implement it — this is a conversation, and I am here to answer.',
    taskContextBlock(task, title),
    `Read \`${taskSourcePath(task.slug)}\` for the complete spec (technical details, constraints, `
    + 'prior decisions), then read enough of the code it touches that your view is grounded in what '
    + 'the repo ACTUALLY does, not in what the task claims it does. Then come back with: (1) how you '
    + 'would approach it, (2) the decisions I have to make, each with your recommendation and the '
    + 'trade-off you are weighing, (3) anything risky, missing, or already wrong in the task as '
    + 'written. Ask me the questions you genuinely need answered — do not guess past them. Keep the '
    + 'first message short enough to read in one go; we can go deep on whatever I pick up.',
  ].join('\n\n'),
};

/**
 * The "is this actually done?" pass. Bypass armed on purpose — proving a task means running its
 * tests and its build, and a verification that stops to ask permission for `npm test` is a
 * verification you have to babysit. It reports missing work rather than filling it in.
 */
const VERIFY: DelegateMode = {
  id: 'verify',
  label: 'Is it done?',
  hint: 'Checks each acceptance criterion against the real code and reports a verdict.',
  titlePrefix: 'Check · ',
  bypass: true,
  build: (task, title) => [
    'Check whether this dreamcontext task is actually DONE. Verify, do NOT build: read the code and '
    + 'run whatever proves it (the test suite, a build, the CLI), but do not implement the missing '
    + 'parts — report them.',
    taskContextBlock(task, title),
    `Read \`${taskSourcePath(task.slug)}\` for the complete spec, then go through the acceptance `
    + 'criteria ONE BY ONE and give each its own verdict: DONE (name the file/line or paste the '
    + 'command output that proves it), PARTIAL (say exactly what is missing), or NOT DONE. Judge by '
    + "the code and the commands you ran — never by the task's own status field, its ticked "
    + 'checkboxes, or its session log, which are claims rather than evidence. Tick only the criteria '
    + `you PROVED and record what you checked with \`dreamcontext tasks log ${task.slug} "<note>"\`. `
    + 'Finish with a one-line verdict: is this task complete, and if not, what is left.',
  ].join('\n\n'),
};

/**
 * Read it back to me. Strictly read-only, and the one mode where the answer IS the deliverable —
 * so it stays short by instruction, not by hope.
 */
const SUMMARIZE: DelegateMode = {
  id: 'summarize',
  label: 'Summarize',
  hint: 'Reads the task and its history, then catches you up in under a minute.',
  titlePrefix: 'Summary · ',
  bypass: false,
  build: (task, title) => [
    'Summarize this dreamcontext task for me. Read-only — do NOT edit files and do NOT write code.',
    taskContextBlock(task, title),
    `Read \`${taskSourcePath(task.slug)}\` in full — including its Constraints & Decisions and its `
    + 'session log — and skim whatever code it points at. Then reply with a SHORT Markdown brief: '
    + 'what this task is and why it exists, where it stands right now, the decisions already made '
    + '(including anything explicitly REJECTED and the reason), and the next concrete step. I want '
    + 'to be caught up in under a minute — do not hand the file back to me in longer words.',
  ].join('\n\n'),
};

/** Display order in the composer: the common case first, then the three read-ish ones. */
export const DELEGATE_MODES: readonly DelegateMode[] = [AUTONOMOUS, DISCUSS, VERIFY, SUMMARIZE];

export const DEFAULT_DELEGATE_MODE: DelegateModeId = 'autonomous';

/** Look a mode up by id, falling back to the autonomous default rather than throwing. */
export function delegateMode(id: DelegateModeId): DelegateMode {
  return DELEGATE_MODES.find((m) => m.id === id) ?? AUTONOMOUS;
}

/**
 * The tab title for a delegated session: the task name, prefixed by the mode. Kept here (not
 * inline in the composer) so the prefix and the mode it belongs to can never drift apart.
 */
export function delegateTitle(mode: DelegateMode, taskTitle: string): string {
  return `${mode.titlePrefix}${taskTitle}`;
}
