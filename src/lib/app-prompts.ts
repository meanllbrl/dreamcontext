import { INITIALIZER_KICKOFF_PROMPT } from './onboarding/copy.js';

/**
 * The prompts dreamcontext itself types into a Claude session as a USER turn — kickoffs,
 * hand-off notices, the usage-limit continue, the delegate drafts — fingerprinted, so a reader
 * of a transcript can tell them from what the owner typed (ask-basis.ts `classify`, and through
 * it `ownerTurns`, owner corrections and sleep's `--basis ask`).
 *
 * Owner corrections on the owner's own brain (2026-10-19) counted "Do not re-plan and do not
 * widen the scope…" 19× over 12 sessions: the Develop kickoff, read as the owner speaking.
 *
 * Each prompt is a list of FIXED SENTENCES with slots. `{slug}` is one token (a slug, a path, an
 * effort, an id); `{text}` is free text inside one line (a task title); `{block}` is any text up
 * to the next fixed sentence (a task's fields, the readiness gaps). A typed turn has every fixed
 * sentence removed; when nothing but punctuation is left, no human typed it. Owner text typed
 * around a template stays (custom instructions under a delegate draft, a correction after it).
 *
 * The server's prompts live here (agent-chat.ts imports them). The dashboard's cannot be
 * imported from `src/`, so they are MIRRORED below and `tests/unit/app-prompts-mirror.test.ts`
 * renders each dashboard template and fails when anything of it is left after the strip.
 *
 * Whole turns the server writes (an Assistant or Super Agent event) open with a fixed header
 * ({@link SERVER_TURN_HEADERS}); blocks it adds to an owner turn are tags (`<live-context>`,
 * `<super-agent-note>`) that ask-basis.ts strips with the harness's own.
 */

/** Sent when a usage-limit refusal moved the chat to another account (agent-chat.ts). */
export const LIMIT_CONTINUE_TEXT =
  'The previous turn was cut off by a Claude usage limit, and this chat has moved to another account. '
  + 'Continue exactly where you stopped; do not redo finished work.';

/** The context handoff's continue turn, after its `/clear` (agent-chat.ts). */
export function handoffContinuePrompt(title: string, task: string): string {
  return `Handoff: continue task ${title} (${task}). `
    + `Run \`dreamcontext tasks show ${task}\` first (its parent task, its card and its newest journal entries), then carry on from the newest journal entry: that is the handoff.`;
}

export interface AppPrompt {
  id: string;
  /** Where the text is built (file and function), for a reader of this table. */
  source: string;
  /** The CURRENT wording's fixed sentences (pinned by the mirror test). */
  sentences: readonly string[];
  /**
   * LEGACY: earlier wordings of the same prompt, still in the last weeks' transcripts (every
   * wording since 2026-09-20), so a 7- or 30-day backfill is clean. Matched like `sentences`,
   * never pinned: no code sends them any more. Each names the commit that retired it.
   */
  legacy?: readonly string[];
}

/** The sleep request (src/lib/sleep-prompt.ts SLEEP_AGENT_PROMPT, mirrored in
 *  dashboard/src/lib/sleepAgent.ts). Held as text here (importing sleep-prompt.ts would pull the
 *  task backend into ask-basis); `tests/unit/app-prompts-mirror.test.ts` pins it to both. */
export const SLEEP_PROMPT_TEXT =
  'Think hard. Run a full dreamcontext memory consolidation ("sleep") for THIS project '
  + 'now, fully autonomously — do NOT ask any questions. Follow the project\'s dreamcontext '
  + 'sleep flow: pin the epoch with `dreamcontext sleep start`, reconcile the task / changelog '
  + '/ knowledge / feature files to current truth (prefer updating existing entities over '
  + 'creating new ones), then close the cycle with `dreamcontext sleep done "<one-paragraph '
  + 'summary>"` to reset the debt. I am explicitly requesting the sub-agent fan-out: dispatch '
  + 'the sleep specialists as PARALLEL sub-agents via the Agent tool (sleep-tasks + sleep-state '
  + 'always; sleep-product, sleep-migration and sleep-learn only when their signals fire '
  + '(sleep-product: knowledge/feature/research signals; sleep-migration: `dreamcontext '
  + 'migrations pending` has output; sleep-learn: learning is enabled and a thesis is due)) — '
  + 'do NOT run those passes inline in your own '
  + 'context. When finished, reply with a SHORT Markdown summary of what was consolidated.';

/** The secret receipt's closing sentence (src/lib/env-secrets.ts secretReceipt); the whole
 *  receipt opens with `[secret submitted` ({@link SERVER_TURN_HEADERS}). Pinned by the mirror test. */
export const SECRET_RECEIPT_TAIL =
  'The value was written to disk by the app. It was NOT sent to you and is not in this transcript: '
  + 'use it by name (the environment / the file), never read the file back or echo the value, '
  + 'and tell the user plainly that you cannot see it.';

/** The delegate drafts' shared middle: the task's own fields, then the context-packet lead. */
const TASK_BLOCK_AND_SHOW_LEAD = 'Task: {block} Run `dreamcontext tasks show {slug}` first and read it end to end: it prints the task\'s parent (the goal and decisions that bind it), then the full card (technical details, constraints, notes) and its newest journal entries. Its card is `{slug}`.';

export const APP_PROMPTS: readonly AppPrompt[] = [
  {
    id: 'develop-kickoff',
    source: 'dashboard/src/lib/agentPrompt.ts developKickoffPrompt',
    sentences: [
      'You are picking up the task `{slug}` from the planning session that just created it.',
      'First run `dreamcontext tasks show {slug}` and read it end to end: it prints its parent task (the goal and decisions that bind it) first, then its own card and newest journal entries.',
      'Then, before you write any code, restate the plan back to me in your own words — the goal, the waves, and what each acceptance criterion will actually take.',
      'Then implement it wave by wave, strictly against those acceptance criteria: build what they require, show the evidence, tick each criterion only when it is demonstrably true, and log progress with `dreamcontext tasks log {slug} "..."` as you go.',
      'Do not re-plan and do not widen the scope — the plan is already reviewed and agreed.',
      'If you find the plan is genuinely wrong, stop and say so rather than quietly redesigning it.',
    ],
    legacy: [
      // LEGACY (retired by 215ea2e1, 2026-10-17): read the card file instead of `tasks show`.
      'First read its document at `_dream_context/state/{slug}.md` end to end.',
    ],
  },
  {
    id: 'train-kickoff',
    source: 'dashboard/src/lib/agentPrompt.ts trainKickoffPrompt',
    sentences: [
      'This Train Me session is bound to the automated agent "{text}" (automation `{slug}`).',
      'What you learn here is that automation\'s own playbook. Its current playbook is the `## Pattern` section of `_dream_context/automations/{slug}.md`; read it first with `dreamcontext automations pattern {slug}` and ask me what to train it on.',
      'Then train as usual: rounds of cards, your predictions before each round, only the misses shown after.',
      'When I end it, show the revised playbook and the diff against the current one, and write nothing until I say yes.',
      'On my yes, write the full revised playbook to a temporary file and record it with `dreamcontext automations learn {slug} --playbook-file <that file>`.',
      'That is the only place this result goes. Do not create or edit anything in the project\'s knowledge for it.',
    ],
  },
  {
    id: 'initializer-kickoff',
    source: 'src/lib/onboarding/copy.ts INITIALIZER_KICKOFF_PROMPT (mirrored in dashboard/src/lib/agentPrompt.ts initializerKickoffPrompt)',
    sentences: [INITIALIZER_KICKOFF_PROMPT],
  },
  {
    id: 'develop-refused',
    source: 'dashboard/src/components/sleepy/AgentSurface.tsx handoffToDevelop (the refused "Go to development" notice)',
    sentences: [
      'The "Go to development" hand-off for `{slug}` was refused — the task is missing: {block} Fill each into the task with `dreamcontext tasks insert {slug} <section> "…"`, confirm `dreamcontext tasks ready {slug}` passes, then offer the develop button again.',
    ],
  },
  {
    id: 'limit-continue',
    source: 'src/lib/app-prompts.ts LIMIT_CONTINUE_TEXT (sent by src/server/routes/agent-chat.ts)',
    sentences: [LIMIT_CONTINUE_TEXT],
  },
  {
    id: 'handoff-continue',
    source: 'src/lib/app-prompts.ts handoffContinuePrompt (sent by src/server/routes/agent-chat.ts after the handoff /clear)',
    sentences: [handoffContinuePrompt('{text}', '{slug}')],
    legacy: [
      // LEGACY (retired by 215ea2e1, 2026-10-17): the card and the journal file by path.
      'Handoff: continue task {text} ({slug}). Read _dream_context/state/{slug}.md first, then carry on from the newest entry of _dream_context/state/journal/{slug}.md.',
      // LEGACY (retired by 176a4707, 2026-10-17): before the journal, the card's changelog.
      'Handoff: continue task {text} ({slug}). Read _dream_context/state/{slug}.md first, then carry on from its latest changelog entry.',
    ],
  },
  {
    id: 'sleep',
    source: 'src/lib/sleep-prompt.ts SLEEP_AGENT_PROMPT (mirrored in dashboard/src/lib/sleepAgent.ts)',
    sentences: [SLEEP_PROMPT_TEXT],
    legacy: [
      // LEGACY (retired by 6a1f86de, 2026-09-30): the roster before sleep-learn joined it.
      SLEEP_PROMPT_TEXT.replace(
        '(sleep-tasks + sleep-state always; sleep-product, sleep-migration and sleep-learn only when their signals fire (sleep-product: knowledge/feature/research signals; sleep-migration: `dreamcontext migrations pending` has output; sleep-learn: learning is enabled and a thesis is due))',
        '(sleep-tasks + sleep-state always; sleep-product when knowledge/feature signals warrant; sleep-migration only if `dreamcontext migrations pending` has output)',
      ),
    ],
  },
  {
    id: 'secret-receipt',
    source: 'src/lib/env-secrets.ts secretReceipt (the receipt the Chat sends after a secret is written)',
    sentences: [SECRET_RECEIPT_TAIL],
  },
  {
    id: 'delegate-autonomous',
    source: 'dashboard/src/lib/delegateAgent.ts buildDelegatePrompt (+ taskContextBlock, taskShowLead)',
    sentences: [
      'Work on this dreamcontext task and drive it to completion, fully autonomously — do NOT ask me questions (I am away). Think hard.',
      TASK_BLOCK_AND_SHOW_LEAD,
      'Log progress with `dreamcontext tasks log {slug} "<note>"` and tick acceptance criteria as you satisfy them.',
      'When everything is done and verified, reply with a SHORT Markdown summary of what you changed.',
    ],
    legacy: [
      // LEGACY (retired by 215ea2e1, 2026-10-17): the card path instead of the context packet.
      'Task: {block} The full task lives at `{slug}` — read that file for the complete spec (technical details, constraints, notes).',
    ],
  },
  {
    id: 'delegate-discuss',
    source: 'dashboard/src/lib/delegateModes.ts DISCUSS',
    sentences: [
      'Let\'s think this dreamcontext task through together before anything gets built. Do NOT edit files and do NOT implement it — this is a conversation, and I am here to answer.',
      TASK_BLOCK_AND_SHOW_LEAD,
      'Then read enough of the code it touches that your view is grounded in what the repo ACTUALLY does, not in what the task claims it does.',
      'Then come back with: (1) how you would approach it, (2) the decisions I have to make, each with your recommendation and the trade-off you are weighing, (3) anything risky, missing, or already wrong in the task as written.',
      'Ask me the questions you genuinely need answered — do not guess past them.',
      'Keep the first message short enough to read in one go; we can go deep on whatever I pick up.',
    ],
    legacy: [
      // LEGACY (retired by 215ea2e1, 2026-10-17).
      'Task: {block} Read `{slug}` for the complete spec (technical details, constraints, prior decisions), then read enough of the code it touches that your view is grounded in what the repo ACTUALLY does, not in what the task claims it does.',
    ],
  },
  {
    id: 'delegate-verify',
    source: 'dashboard/src/lib/delegateModes.ts VERIFY',
    sentences: [
      'Check whether this dreamcontext task is actually DONE. Verify, do NOT build: read the code and run whatever proves it (the test suite, a build, the CLI), but do not implement the missing parts — report them.',
      TASK_BLOCK_AND_SHOW_LEAD,
      'Then go through the acceptance criteria ONE BY ONE and give each its own verdict: DONE (name the file/line or paste the command output that proves it), PARTIAL (say exactly what is missing), or NOT DONE.',
      'Judge by the code and the commands you ran — never by the task\'s own status field, its ticked checkboxes, or its session log, which are claims rather than evidence.',
      'Tick only the criteria you PROVED and record what you checked with `dreamcontext tasks log {slug} "<note>"`.',
      'Finish with a one-line verdict: is this task complete, and if not, what is left.',
    ],
    legacy: [
      // LEGACY (retired by 215ea2e1, 2026-10-17).
      'Task: {block} Read `{slug}` for the complete spec, then go through the acceptance criteria ONE BY ONE and give each its own verdict: DONE (name the file/line or paste the command output that proves it), PARTIAL (say exactly what is missing), or NOT DONE.',
    ],
  },
  {
    id: 'delegate-summarize',
    source: 'dashboard/src/lib/delegateModes.ts SUMMARIZE',
    sentences: [
      'Summarize this dreamcontext task for me. Read-only — do NOT edit files and do NOT write code.',
      TASK_BLOCK_AND_SHOW_LEAD,
      'Read the parent\'s and the card\'s Constraints & Decisions closely, and skim whatever code it points at.',
      'Then reply with a SHORT Markdown brief: what this task is and why it exists, where it stands right now, the decisions already made (including anything explicitly REJECTED and the reason), and the next concrete step.',
      'I want to be caught up in under a minute — do not hand the file back to me in longer words.',
    ],
    legacy: [
      // LEGACY (retired by 215ea2e1, 2026-10-17).
      'Task: {block} Read `{slug}` in full — including its Constraints & Decisions and its session log — and skim whatever code it points at.',
    ],
  },
];

/**
 * Whole user turns the server writes, by their fixed first line: an Assistant wake about a
 * delegated session (assistant/delegations.ts `eventText`) and the Super Agent's events
 * (super/inbox.ts `superEventText`). Such a turn is never the owner's, whatever follows.
 */
export const SERVER_TURN_HEADERS: readonly RegExp[] = [
  /^\s*\[delegated-session event\] session=/,
  /^\s*\[super (?:handover|recap|event)\] item=/,
  // The secret receipt (env-secrets.ts secretReceipt): key names, file, size, fingerprint.
  /^\s*\[secret submitted(?: · [^\]\n]*)?\]/,
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One fixed sentence as a regex: slots are wildcards, any run of whitespace matches any other. */
function sentenceRe(sentence: string): RegExp {
  const body = sentence.split(/(\{slug\}|\{text\}|\{block\})/).map((p) => {
    if (p === '{slug}') return '\\S+?';
    if (p === '{text}') return '[^\\n]+?';
    if (p === '{block}') return '[\\s\\S]+?';
    if (!p.trim()) return p ? '\\s+' : '';
    // The spaces at a literal's edges (next to a slot) are kept, as any whitespace.
    const lead = /^\s/.test(p) ? '\\s+' : '';
    const trail = /\s$/.test(p) ? '\\s+' : '';
    return lead + p.trim().split(/\s+/).map(escapeRe).join('\\s+') + trail;
  }).join('');
  return new RegExp(body, 'g');
}

const COMPILED: ReadonlyArray<{ id: string; res: RegExp[] }> = APP_PROMPTS.map((p) => ({
  id: p.id,
  // Longest first: a sentence that contains another is removed before its part.
  res: [...p.sentences, ...(p.legacy ?? [])].sort((a, b) => b.length - a.length).map(sentenceRe),
}));

/**
 * `text` with every fixed sentence of every app prompt removed, and the ids of the prompts that
 * matched. What is left is what someone typed around them (or nothing).
 */
export function stripAppPrompts(text: string): { rest: string; matched: string[] } {
  let rest = text;
  const matched: string[] = [];
  for (const { id, res } of COMPILED) {
    let hit = false;
    for (const re of res) {
      re.lastIndex = 0;
      const next = rest.replace(re, ' ');
      if (next !== rest) { hit = true; rest = next; }
    }
    if (hit) matched.push(id);
  }
  return { rest, matched };
}

/** For each fixed sentence of prompt `id` (in table order): does it occur in `text`? (The mirror test.) */
export function sentenceHits(id: string, text: string): boolean[] {
  const p = APP_PROMPTS.find((x) => x.id === id);
  if (!p) throw new Error(`no app prompt ${id}`);
  return p.sentences.map((sentence) => { const re = sentenceRe(sentence); re.lastIndex = 0; return re.test(text); });
}

/** Is this whole turn one the server writes (an event header)? */
export function isServerTurn(text: string): boolean {
  return SERVER_TURN_HEADERS.some((re) => re.test(text));
}

/** Nothing a person could have said: no letter or digit left. */
export function isEmptyOfWords(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}
