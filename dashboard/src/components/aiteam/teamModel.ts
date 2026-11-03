import type {
  AgentActivity, AgentFeed, AutomationSummary, FeedMessage, RunAnswer, ThreadEntry, ThreadSummaryRow,
} from '../../hooks/useAutomations';
import type { AgentSummary } from '../../hooks/useAgents';
import type { SuperMemberSummary } from '../../lib/superTypes';

/**
 * THE AI TEAM, as data. Two pure functions and nothing that renders:
 *
 *  - `buildRoster` turns the agents, their automations and the channel feed into the list on
 *    the left: one row per agent, its status, its last line, and the order they are read in.
 *  - `buildConversation` turns one agent's feed messages (and the threads read for them) into
 *    the single conversation in the middle: day rules, "<routine> ran" event rows, the owner's
 *    bubbles, the agent's posts, an open question, a running turn.
 *
 * An AGENT is the teammate; its AUTOMATIONS ("routines") are what it does on its own. A feed
 * message belongs to the agent when it was spoken by it (`agent`), addressed to it (its own
 * call target, `slug`), or written by one of its routines.
 */

/** The automation fields the roster reads. */
export type TeamAutomation = Pick<
  AutomationSummary,
  'slug' | 'title' | 'agent' | 'runKind' | 'mode' | 'enabled' | 'approved' | 'approvalReason' | 'pendingQuestion'
  | 'nextFireAt' | 'cadenceLabel'
>;

/** The agent fields the roster reads. */
export type TeamAgent = Pick<
  AgentSummary,
  'slug' | 'title' | 'hasPhoto' | 'roleLine' | 'description' | 'approvedForChat' | 'approvedToRun' | 'approvalReason' | 'model' | 'effort'
> & Partial<Pick<AgentSummary, 'readOnly' | 'owner' | 'ownerLabel' | 'runsElsewhere' | 'scope' | 'lastTalkAt'>>;

export type TeamStatus = 'working' | 'needs' | 'approval' | 'paused' | 'idle';

export interface TeamRow {
  slug: string;
  title: string;
  hasPhoto: boolean;
  role: string;
  /** Its scheduled automations (never the agent's own call target). */
  routines: TeamAutomation[];
  status: TeamStatus;
  /** When `status === 'working'`: the turn's start, epoch ms. */
  workingSince: number | null;
  /** How many turns of this member are in flight. */
  workingCount: number;
  /** The last thing said in the conversation, one line; null before anything was. */
  preview: string | null;
  /** The newest message's time, ISO; null before anything was said. */
  lastAt: string | null;
  unread: number;
  /** Which part of the list it sits in: a teammate's agent sits in its owner's read-only part. */
  section: 'needs' | 'team' | 'readonly';
  /** Someone else's agent (B1-4): read-only here. */
  readOnly: boolean;
  /** Its owner, as a sentence reads it; null on an unstamped agent. */
  ownerLabel: string | null;
  /** The owner's other machine runs it: that machine's name. */
  elsewhere: string | null;
  /** This machine's global agent (D1): listed in every project, its chip says so. */
  global: boolean;
  /** Everything that makes this row busy is a job the Super Agent gave it (`FeedMessage.superJob`):
   *  the page shows it, the drawer does not. It reports to the Super, not to the owner. */
  superOnly: boolean;
}

/** Is this automation one of `agentSlug`'s routines? An older backend names no agent: the
 *  automation runs as itself, so its own slug is the agent's. */
function routineOf(a: TeamAutomation, agentSlug: string): boolean {
  return a.runKind !== 'agent' && a.mode === 'sched' && (a.agent ?? a.slug) === agentSlug;
}

/** The slugs whose messages are this agent's conversation: its own call target and every
 *  automation that runs as it. */
export function conversationSlugs(agentSlug: string, automations: readonly TeamAutomation[]): Set<string> {
  const out = new Set([agentSlug]);
  for (const a of automations) if ((a.agent ?? a.slug) === agentSlug) out.add(a.slug);
  return out;
}

/** One agent's messages, oldest first (the feed's own reading order). */
export function messagesOf(
  agentSlug: string,
  automations: readonly TeamAutomation[],
  messages: readonly FeedMessage[],
): FeedMessage[] {
  const slugs = conversationSlugs(agentSlug, automations);
  return messages.filter((m) => slugs.has(m.slug) || m.agent === agentSlug);
}

/** A markdown line flattened for a one-line preview. */
export function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function previewOf(m: FeedMessage): string | null {
  if (m.question) return plainLine(m.question.text);
  const text = plainLine(m.text);
  if (text) return text;
  return m.ask ? plainLine(m.ask.text) : null;
}

/**
 * The list on the left, in reading order.
 *
 * STATUS, one per row, the most urgent that holds: working (a turn is running), needs (a
 * question waits on you), approval (it may not run here until you review it), paused (every
 * routine is off), idle. ORDER: "Needs you" first, then the rest by their newest message,
 * newest first; agents nobody has talked to yet go last, by name.
 */
export function buildRoster(
  agents: readonly TeamAgent[],
  automations: readonly TeamAutomation[],
  feed: Pick<AgentFeed, 'messages' | 'unreadBySlug' | 'runSlots' | 'working'> | null | undefined,
): TeamRow[] {
  const messages = feed?.messages ?? [];
  const working: Record<string, AgentActivity> = feed?.working ?? {};
  const slots = feed?.runSlots ?? {};
  const rows = agents.map((agent): TeamRow => {
    const routines = automations.filter((a) => routineOf(a, agent.slug));
    const slugs = conversationSlugs(agent.slug, automations);
    const mine = messages.filter((m) => slugs.has(m.slug) || m.agent === agent.slug);
    const last = mine[mine.length - 1] ?? null;

    let since: number | null = null;
    for (const s of slugs) {
      const at = working[s]?.since ?? slots[s]?.startedAt;
      if (at !== undefined && (since === null || at < since)) since = at;
    }
    const running = mine.find((m) => m.status === 'running');
    if (since === null && running) since = Date.parse(running.at) || null;

    const needs = mine.some((m) => m.question !== null || m.status === 'needs-you')
      || routines.some((r) => r.pendingQuestion !== null);
    const readOnly = agent.readOnly === true;
    const approval = !readOnly && pendingApprovals(agent, routines).length > 0;
    const paused = routines.length > 0 && routines.every((r) => !r.enabled);
    // A member whose routines are all off raises no alarm: nothing will run, so nothing waits
    // on the owner. Its pending approval/question stays visible on the AI Team page itself.
    // A question outranks the clock: a run stopped on the owner stays in view beside its siblings.
    const status: TeamStatus = since !== null ? (needs ? 'needs' : 'working')
      : paused ? 'paused'
        : needs ? 'needs'
          : approval ? 'approval'
            : 'idle';

    // Whose is the work? A run nobody can name stays the owner's, so a row only leaves on proof.
    const jobs = new Set(mine.filter((m) => m.superJob).map((m) => m.runId));
    const liveRuns: Array<string | null> = [];
    for (const s of slugs) {
      if (working[s]) {
        const runs = working[s].runs?.map((r) => r.runId) ?? [working[s].runId ?? null];
        liveRuns.push(...runs, ...(working[s].queued ?? []).map((q) => q.runId));
      }
      else if (slots[s]) liveRuns.push(slots[s].runId);
    }
    const theirs = status === 'working' || status === 'needs';
    const superOnly = theirs && jobs.size > 0
      && routines.every((r) => r.pendingQuestion === null)
      && !mine.some((m) => !m.superJob && (m.status === 'running' || m.status === 'needs-you' || m.question !== null))
      && liveRuns.every((id) => id !== null && jobs.has(id));

    let unread = 0;
    for (const s of slugs) unread += feed?.unreadBySlug?.[s] ?? 0;

    return {
      slug: agent.slug,
      title: agent.title,
      hasPhoto: agent.hasPhoto,
      role: agent.roleLine || plainLine(agent.description),
      routines,
      status,
      workingSince: since,
      workingCount: since === null ? 0 : Math.max(1, [...slugs].reduce((n, s) => n + (working[s]?.count ?? (working[s] || slots[s] ? 1 : 0)), 0)),
      preview: last ? previewOf(last) : null,
      // A stage talk leaves no thread entry; the server's fact keeps a member of all projects listed.
      lastAt: [last?.at, agent.lastTalkAt].filter((x): x is string => !!x).sort().pop() ?? null,
      unread,
      section: readOnly ? 'readonly' : status === 'needs' ? 'needs' : 'team',
      readOnly,
      ownerLabel: agent.ownerLabel ?? agent.owner ?? null,
      elsewhere: agent.runsElsewhere?.name ?? null,
      global: agent.scope === 'global',
      superOnly,
    };
  });

  const order = { needs: 0, team: 1, readonly: 2 } as const;
  return rows.sort((a, b) => {
    if (a.section !== b.section) return order[a.section] - order[b.section];
    if (a.readOnly && b.readOnly && a.ownerLabel !== b.ownerLabel) return (a.ownerLabel ?? '').localeCompare(b.ownerLabel ?? '');
    if (a.lastAt && b.lastAt) return a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0;
    if (a.lastAt) return -1;
    if (b.lastAt) return 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * ONE THING WAITING FOR THE OWNER'S APPROVAL ON THIS MAC.
 *
 * Every automation needs a machine-local approval of exactly what it is (its hash): that rule
 * stays. What changes is where it is SAID: the conversation names each of these at its top,
 * in one sentence, instead of leaving them at the bottom of the profile.
 *
 *  - `agent`: the agent's own call target. `blocksTalk` when the owner's message would be
 *    refused: `say` runs a routine that shares the agent's slug when there is one, otherwise
 *    the call target, and both refuse when what they run is not approved here.
 *  - `routine`: one of its routines will not fire until approved (new here, or changed).
 */
export type PendingApproval = {
  kind: 'agent' | 'routine';
  slug: string;
  title: string;
  /** Approving this is what lets the owner's next message through. */
  blocksTalk: boolean;
  reason: string | null;
};

/** The i18n key naming a changed instruction field. */
export function amendmentFieldKey(field: 'prompt' | 'soul' | 'job'): string {
  return `aiteam.amend.field.${field}`;
}

/** Past this many lines a side, a diff is the lines one side lacks: enough to read, cheap to draw. */
const DIFF_MAX_LINES = 2000;

/**
 * A position-aware line diff, so a moved line, a dropped duplicate or a blank line shows too: what
 * the owner reads instead of two whole prompts.
 */
export function amendmentDiff(before: string, after: string): Array<{ added: boolean; text: string }> {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    const had = new Set(a);
    const has = new Set(b);
    return [...a.filter((l) => !has.has(l)).map((text) => ({ added: false, text })), ...b.filter((l) => !had.has(l)).map((text) => ({ added: true, text }))];
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ added: boolean; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i += 1; j += 1; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ added: true, text: b[j] }); j += 1; }
    else { out.push({ added: false, text: a[i] }); i += 1; }
  }
  return out;
}

/** What waits for approval, in the order it matters: what blocks talking first, then the
 *  routines, then the call target's own runs (boards and tasks). Empty when all is approved. */
export function pendingApprovals(
  agent: Pick<TeamAgent, 'slug' | 'title' | 'approvedForChat' | 'approvedToRun' | 'approvalReason'>,
  routines: readonly Pick<TeamAutomation, 'slug' | 'title' | 'approved' | 'approvalReason'>[],
): PendingApproval[] {
  // `say` runs the routine that shares the agent's slug when there is one, else the call target.
  // A teammate's agent asks nothing here: it is read-only, never "needs approval".
  if ((agent as { readOnly?: boolean }).readOnly) return [];
  const talkRoutine = routines.some((r) => r.slug === agent.slug);
  const out: PendingApproval[] = [];
  if (!agent.approvedForChat || !agent.approvedToRun) {
    out.push({
      kind: 'agent', slug: agent.slug, title: agent.title, reason: agent.approvalReason,
      blocksTalk: !agent.approvedForChat || !talkRoutine,
    });
  }
  for (const r of routines) {
    if (!r.approved) {
      out.push({ kind: 'routine', slug: r.slug, title: r.title, reason: r.approvalReason, blocksTalk: r.slug === agent.slug });
    }
  }
  return out.sort((x, y) => Number(y.blocksTalk) - Number(x.blocksTalk));
}

/** Would a message to this agent be refused here right now? */
export function talkBlocked(pending: readonly PendingApproval[]): boolean {
  return pending.some((p) => p.blocksTalk);
}

/** What one run's thread read adds to its message: the entries and the run's document. */
export interface ConversationThread {
  entries: ThreadEntry[];
  rootId?: string | null;
  answer?: RunAnswer | null;
}

/** One row of the conversation, in order. */
export type ConversationItem =
  | { kind: 'day'; key: string; at: string }
  /** A routine fired: "<title> ran · time · duration". */
  | { kind: 'ran'; key: string; title: string; at: string; durationMs: number | null; failed: boolean }
  /** Something the system recorded in the thread, said as an event ("Routine created · …"). */
  | { kind: 'event'; key: string; text: string; at: string; tone: 'good' | 'neutral' }
  | { kind: 'you'; key: string; text: string; at: string; app?: string }
  | {
    kind: 'agent';
    key: string;
    message: FeedMessage;
    text: string;
    at: string;
    summary: ThreadSummaryRow[] | null;
    files: string[];
    /** The run's document, folded under the post. */
    report: RunAnswer | null;
    question: FeedMessage['question'];
    /** This post failed: its text is the reason. */
    failed: boolean;
  }
  | { kind: 'live'; key: string; message: FeedMessage };

function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * ONE CONVERSATION out of many runs.
 *
 * Every message is a run: a routine firing on its own (an event row, then what the agent
 * said), or the owner asking (their bubble, then the answer). A run's thread, when it was
 * read, adds the turns after the first: replies both ways and the system's "Routine created"
 * line; its bookkeeping rows (started, finished) are already said by the event row and are
 * not repeated. The run's document is folded under the post that carries it. A run still
 * going ends in a "Working" row instead of a post.
 */
export function buildConversation(
  messages: readonly FeedMessage[],
  threads: Readonly<Record<string, ConversationThread | undefined>> = {},
): ConversationItem[] {
  const out: ConversationItem[] = [];
  let lastDay = '';
  // A late reply in an earlier run can come after the next run's day: the rule is drawn again
  // when the day changes back, so its key counts how often that day has been drawn.
  const drawn = new Map<string, number>();
  const day = (at: string) => {
    const k = dayKeyOf(at);
    if (k === lastDay) return;
    lastDay = k;
    const n = (drawn.get(k) ?? 0) + 1;
    drawn.set(k, n);
    out.push({ kind: 'day', key: n === 1 ? `day:${k}` : `day:${k}:${n}`, at });
  };

  for (const m of messages) {
    const thread = threads[m.key];
    const startAt = m.ask?.at ?? m.at;
    day(startAt);
    if (m.ask) out.push({ kind: 'you', key: `${m.key}:ask`, text: m.ask.text, at: m.ask.at, ...(m.ask.app ? { app: m.ask.app } : {}) });
    else if (m.status !== 'skipped') {
      out.push({
        kind: 'ran',
        key: `${m.key}:ran`,
        title: m.title,
        at: m.at,
        durationMs: m.status === 'running' ? null : m.durationMs,
        failed: m.status === 'failed' || m.status === 'timeout',
      });
    }

    const rootText = m.text.trim();
    const hasPost = m.textFrom !== 'none' && m.textFrom !== 'skipped' && (rootText !== '' || m.summary !== null);
    // The report goes under the post when its text is the document's opening line, so it is
    // not said twice; otherwise under the post too, folded, with the post's words above it.
    const report = thread?.answer ?? null;
    if (hasPost || m.question) {
      out.push({
        kind: 'agent',
        key: `${m.key}:post`,
        message: m,
        text: m.textFrom === 'result' && report ? '' : rootText,
        at: m.at,
        summary: m.summary,
        files: m.files.map((f) => f.path),
        // A failed run's "report" is its own error again: said once, in the post.
        report: m.textFrom === 'error' ? null : report,
        question: thread ? null : m.question,
        failed: m.textFrom === 'error',
      });
    }

    if (thread) {
      // The entry the feed already drew as the post (or the ask), so it is not drawn twice.
      let skippedRoot = false;
      let skippedAsk = false;
      const rest = thread.entries.filter((e) => {
        if (thread.rootId && e.id === thread.rootId) return false;
        if (!skippedRoot && e.kind === 'agent' && e.text.trim() === rootText) {
          skippedRoot = true;
          return false;
        }
        if (!skippedAsk && !thread.rootId && m.ask && e.kind === 'user' && e.text.trim() === m.ask.text.trim()) {
          skippedAsk = true;
          return false;
        }
        return true;
      });
      for (const e of rest) {
        if (e.kind === 'user') {
          day(e.at);
          out.push({ kind: 'you', key: `${m.key}:${e.id}`, text: e.text, at: e.at, ...(e.via === 'app' && e.app ? { app: e.app } : {}) });
        } else if (e.kind === 'agent') {
          day(e.at);
          out.push({
            kind: 'agent',
            key: `${m.key}:${e.id}`,
            message: m,
            text: e.text,
            at: e.at,
            summary: e.summary ?? null,
            files: e.files ?? [],
            report: null,
            question: null,
            failed: false,
          });
        } else if (e.event === 'routine') {
          day(e.at);
          out.push({ kind: 'event', key: `${m.key}:${e.id}`, text: e.text, at: e.at, tone: 'good' });
        }
      }
      // The open question is the run's newest state, so it closes the run.
      if (m.question) {
        const last = out[out.length - 1];
        if (last?.kind === 'agent' && last.message.key === m.key) last.question = m.question;
        else out.push({
          kind: 'agent', key: `${m.key}:question`, message: m, text: '', at: m.at, summary: null,
          files: [], report: null, question: m.question, failed: false,
        });
      }
    }

    if (m.status === 'running') out.push({ kind: 'live', key: `${m.key}:live`, message: m });
  }
  return out;
}

/**
 * Where a notification for `slug` lands: the newest row of that routine's (or the agent's own)
 * newest message, preferring what was said over the bookkeeping around it. Null when the
 * conversation holds nothing of it (the reader stays at the end).
 */
export function focusTargetKey(items: readonly ConversationItem[], slug: string, runId?: string | null): string | null {
  // A landing on ONE run (a boundary clicked in the stage's history): that run's post, else its
  // first row; a run outside the activity's window falls back to the routine's newest message.
  if (runId) {
    const run = `${slug}::${runId}:`;
    const rows = items.filter((it) => it.key.startsWith(run));
    const hit = rows.find((it) => it.kind === 'agent' || it.kind === 'live') ?? rows[0];
    if (hit) return hit.key;
  }
  const prefix = `${slug}::`;
  let fallback: string | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it.key.startsWith(prefix)) continue;
    if (it.kind === 'agent' || it.kind === 'live') return it.key;
    fallback ??= it.key;
  }
  return fallback;
}

/** The question the composer answers: the newest open one in this conversation. */
export function openQuestionOf(
  messages: readonly FeedMessage[],
  answered: ReadonlySet<string> = new Set(),
): FeedMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const q = messages[i].question;
    if (q && !answered.has(q.id)) return messages[i];
  }
  return null;
}

/** "2 routines" / "1 routine" / "No routines". */
export function routineCountLabel(n: number, t: (key: string) => string): string {
  if (n === 0) return t('aiteam.routines.none');
  return (n === 1 ? t('aiteam.routines.one') : t('aiteam.routines.many')).replace('{n}', String(n));
}

/** The time a roster row shows: the clock today, "Yesterday", the weekday this week, else
 *  the date. */
export function rosterTime(iso: string | null, now: Date, t: (key: string) => string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return t('aiteam.time.yesterday');
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** "Today" / "Yesterday" / "Fri 19 Sep", for a day rule. */
export function dayRuleLabel(iso: string, now: Date, t: (key: string) => string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return t('aiteam.time.today');
  if (diff === 1) return t('aiteam.time.yesterday');
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Search the list by name or role, case- and accent-insensitive enough for Turkish names. */
export function filterRoster(rows: readonly TeamRow[], query: string): TeamRow[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.title.toLocaleLowerCase().includes(q) || r.role.toLocaleLowerCase().includes(q));
}

// ── The temporary model ─────────────────────────────────────────────────────────────

/** A model + effort picked for ONE agent's conversation on this machine. */
export interface TemporaryModel {
  model: string;
  effort: string;
}

const TEMP_MODEL_KEY = 'dreamcontext.aiteam.tempModel';

/** Every agent's temporary pick, from this machine's storage. */
export function readTemporaryModels(storage: Pick<Storage, 'getItem'> | null): Record<string, TemporaryModel> {
  try {
    const raw = JSON.parse(storage?.getItem(TEMP_MODEL_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, TemporaryModel> = {};
    for (const [slug, v] of Object.entries(raw as Record<string, unknown>)) {
      const o = v as { model?: unknown; effort?: unknown };
      if (typeof o?.model === 'string' && typeof o?.effort === 'string') out[slug] = { model: o.model, effort: o.effort };
    }
    return out;
  } catch {
    return {};
  }
}

/** Set (or, with null, clear) one agent's temporary pick. */
export function writeTemporaryModel(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  slug: string,
  pick: TemporaryModel | null,
): Record<string, TemporaryModel> {
  const all = readTemporaryModels(storage);
  if (pick) all[slug] = pick;
  else delete all[slug];
  try { storage?.setItem(TEMP_MODEL_KEY, JSON.stringify(all)); } catch { /* private mode: not remembered */ }
  return all;
}

/**
 * What a send carries: the temporary pick's fields that DIFFER from the agent's default, or
 * nothing. A pick equal to the default is no override at all, and a send with none runs on
 * the agent's own settings, exactly as before.
 */
export function overrideFor(
  pick: TemporaryModel | null | undefined,
  agentDefault: { model: string | null; effort: string | null },
): { model?: string; effort?: string } {
  if (!pick) return {};
  const out: { model?: string; effort?: string } = {};
  if (pick.model && pick.model !== (agentDefault.model ?? '')) out.model = pick.model;
  if (pick.effort && pick.effort !== (agentDefault.effort ?? '')) out.effort = pick.effort;
  return out;
}

/** A working row's line: the clock, with how many jobs when there is more than one. */
export function workingLine(row: Pick<TeamRow, 'workingCount'>, time: string, t: (key: string) => string): string {
  return row.workingCount > 1
    ? t('aiteam.workingMany').replace('{n}', String(row.workingCount)).replace('{time}', time)
    : t('aiteam.working').replace('{time}', time);
}

// ── The Ekip row (plan-r10 1d, 1f) ──────────────────────────────────────────────────

/** One member as `GET /agent/sessions?summary=1` `members` names it (MIRROR of
 *  `SuperMemberSummary`, `lib/superTypes.ts`). Its `pending` (request and reply items still
 *  waiting for delivery) is MAIN's work, never the owner's: nothing here reads it (AC45; it is
 *  only the stage's spawn signal for a cold member). */
export type EkipSummary = SuperMemberSummary & { pending?: number };

/** Who a member is, from `GET /agents`: what the summary does not carry. */
export interface EkipIdentity {
  slug: string;
  title: string;
  hasPhoto: boolean;
  global?: boolean;
}

/** One member of a project's Ekip list, everything its row draws. */
export interface EkipMember {
  slug: string;
  title: string;
  hasPhoto: boolean;
  global: boolean;
  enabled: boolean;
  /** Owner-origin work running now (its children at work for the owner). */
  ownerWorking: number;
  /** A question waits on the owner. */
  asking: boolean;
  /** One approval card waits on the owner (a synced or widening change). */
  approval: boolean;
  /** Owner-origin turns the owner has not read. */
  unread: number;
  /** Everything it does now is the Super Agent's (`main:*`): listed with "Super için", no count. */
  superOnly: boolean;
  /** Epoch ms of its last work here; 0 never. */
  lastAt: number;
  /** The open question's words when the read knows them (a headless routine's), else null. */
  question: string | null;
}

/** The drawer's headless rows (`teamRowsOf`) a project may still carry: in-flight headless
 *  `team` jobs (Super's, before the member Super takes the request) and routine questions. */
export interface EkipHeadless {
  slug: string;
  status: TeamStatus;
  /** Only the Super's jobs make it busy. */
  superOnly?: boolean;
  preview?: string | null;
}

/** Does this member want the owner (a question, an approval card, unread, or work of his)? */
export function ownerFacing(m: Pick<EkipMember, 'asking' | 'approval' | 'unread' | 'ownerWorking' | 'superOnly'>): boolean {
  if (m.approval) return true;
  if (m.superOnly) return false;
  return m.asking || m.unread > 0 || m.ownerWorking > 0;
}

/** Which part of the list a member sits in: 0 owner-facing, 1 "Super için", 2 idle, 3 off. */
export function ekipRank(m: EkipMember): number {
  if (!m.enabled) return 3;
  if (ownerFacing(m)) return 0;
  if (m.superOnly) return 1;
  return 2;
}

/**
 * A project's members, in the list's order: owner-facing first (a question or an approval card
 * before unread, unread before work), then "Super için", then idle, then off; within a part the
 * newest work first, then by name. Built from the summary's `members` (the server counts
 * owner and routine work only); the identity read adds the name and face; a headless row adds
 * an in-flight headless job (working for the Super) or a routine's open question.
 */
export function buildEkip(
  summaries: readonly EkipSummary[] | null | undefined,
  identities: readonly EkipIdentity[] | null | undefined,
  headless: readonly EkipHeadless[] = [],
): EkipMember[] {
  const who = new Map((identities ?? []).map((a) => [a.slug, a] as const));
  const old = new Map(headless.map((h) => [h.slug, h] as const));
  const out = (summaries ?? []).map((s): EkipMember => {
    const id = who.get(s.slug);
    const h = old.get(s.slug);
    // A headless routine's question is the owner's; a headless team job is the Super's.
    const headlessAsk = !!h && h.status === 'needs' && !h.superOnly;
    const headlessSuper = !!h && !!h.superOnly && (h.status === 'working' || h.status === 'needs');
    const asking = s.asking || headlessAsk;
    const ownerWorking = Math.max(0, s.ownerWorking | 0);
    const unread = Math.max(0, s.unread | 0);
    // "Super için" only when nothing of the owner's is there.
    // `pending` is main's requests and replies: it never makes a member the owner's.
    const superOnly = (s.superOnly || headlessSuper) && !asking && unread === 0 && ownerWorking === 0;
    return {
      slug: s.slug,
      title: id?.title || s.slug,
      hasPhoto: !!id?.hasPhoto,
      global: s.global === true || id?.global === true,
      enabled: s.enabled !== false,
      ownerWorking,
      asking,
      approval: s.approval === true || h?.status === 'approval',
      unread,
      superOnly,
      lastAt: typeof s.lastAt === 'number' && Number.isFinite(s.lastAt) ? s.lastAt : 0,
      question: headlessAsk ? (h?.preview ?? null) : null,
    };
  });
  const sub = (m: EkipMember) => (m.asking || m.approval ? 0 : m.unread > 0 ? 1 : 2);
  return out.sort((a, b) => ekipRank(a) - ekipRank(b) || (ekipRank(a) === 0 ? sub(a) - sub(b) : 0)
    || b.lastAt - a.lastAt || a.title.localeCompare(b.title));
}

/** The Ekip row's ONE number: owner-facing questions + owner-origin unread + approval cards.
 *  A "Super için" member counts nothing (only its approval card, which is the owner's). */
export function ekipCount(members: readonly EkipMember[]): number {
  let n = 0;
  for (const m of members) {
    if (m.approval) n += 1;
    if (m.superOnly || !m.enabled) continue;
    if (m.asking) n += 1;
    n += m.unread;
  }
  return n;
}

/** The row wears the question colour: a question or an approval card waits on the owner. */
export function ekipAsking(members: readonly EkipMember[]): boolean {
  return members.some((m) => m.approval || (m.asking && !m.superOnly && m.enabled));
}

/** Up to three faces, the ones at work first (for the owner, then for the Super), then the
 *  list's order. */
export function ekipFaces(members: readonly EkipMember[], max = 3): EkipMember[] {
  const working = (m: EkipMember) => m.enabled && (m.ownerWorking > 0 || m.superOnly);
  return [...members.filter(working), ...members.filter((m) => !working(m))].slice(0, max);
}

/**
 * Who pops out under the folded Team row (plan r4 D4): a member with an approval card, a question
 * or unread for the owner (enabled, not "Super için"), in the list's order, at most `max`; `more`
 * = the rest, drawn as "+N daha". Working alone does not pop out: the row's ring says it.
 */
export function ekipPopOuts(members: readonly EkipMember[], max = 3): { shown: EkipMember[]; more: number } {
  const news = members.filter((m) => m.approval || (m.enabled && !m.superOnly && (m.asking || m.unread > 0)));
  return { shown: news.slice(0, max), more: Math.max(0, news.length - max) };
}

/** How many members work for the owner right now (the folded row's ring). */
export function ekipWorkingCount(members: readonly EkipMember[]): number {
  return members.filter((m) => m.enabled && !m.superOnly && m.ownerWorking > 0).length;
}

/** A project's own members (a member of all projects is in the Global ekip row instead). */
export function projectEkip(members: readonly EkipMember[]): EkipMember[] {
  return members.filter((m) => !m.global);
}

/** One member of the Global ekip list: its state summed over the open projects, and the project
 *  a click opens it in. */
export interface GlobalEkipMember extends EkipMember {
  /** The project of its newest owner-facing item, or null when nothing faces the owner. */
  project: string | null;
  /** Where a click opens its stage (`globalOpenVault`). */
  openIn: string | null;
}

/**
 * Where a global member opens (plan-r10 1f): the project of its newest owner-facing item, else
 * the project in view, else the project it last worked in, else the first open project.
 */
export function globalOpenVault(
  slug: string,
  perProject: ReadonlyArray<{ vault: string; members: readonly EkipMember[] }>,
  inView: string | null,
): { project: string | null; openIn: string | null } {
  const mine = perProject.flatMap((p) => p.members.filter((m) => m.slug === slug).map((m) => ({ vault: p.vault, m })));
  const facing = mine.filter((x) => ownerFacing(x.m) && x.m.enabled).sort((a, b) => b.m.lastAt - a.m.lastAt)[0];
  if (facing) return { project: facing.vault, openIn: facing.vault };
  if (inView && perProject.some((p) => p.vault === inView)) return { project: null, openIn: inView };
  const last = mine.filter((x) => x.m.lastAt > 0).sort((a, b) => b.m.lastAt - a.m.lastAt)[0];
  if (last) return { project: null, openIn: last.vault };
  return { project: null, openIn: perProject[0]?.vault ?? inView ?? null };
}

/**
 * The Global ekip row: each global member ONCE, its questions and unread summed over the open
 * projects, its approval card counted once (one machine-wide bucket), enabled when its global
 * manifest is (the same in every project), in the list's order.
 */
export function buildGlobalEkip(
  perProject: ReadonlyArray<{ vault: string; members: readonly EkipMember[] }>,
  inView: string | null,
): GlobalEkipMember[] {
  const by = new Map<string, EkipMember>();
  for (const p of perProject) {
    for (const m of p.members) {
      if (!m.global) continue;
      const had = by.get(m.slug);
      if (!had) { by.set(m.slug, { ...m }); continue; }
      by.set(m.slug, {
        ...had,
        title: had.title === had.slug ? m.title : had.title,
        hasPhoto: had.hasPhoto || m.hasPhoto,
        enabled: had.enabled && m.enabled,
        ownerWorking: had.ownerWorking + m.ownerWorking,
        asking: had.asking || m.asking,
        approval: had.approval || m.approval,
        unread: had.unread + m.unread,
        superOnly: had.superOnly && m.superOnly,
        lastAt: Math.max(had.lastAt, m.lastAt),
        question: had.question ?? m.question,
      });
    }
  }
  const rows = [...by.values()].map((m): GlobalEkipMember => {
    // "Super için" holds only when no project has the owner's work for it.
    const superOnly = m.superOnly && !m.asking && m.unread === 0 && m.ownerWorking === 0;
    return { ...m, superOnly, ...globalOpenVault(m.slug, perProject, inView) };
  });
  const sub = (m: EkipMember) => (m.asking || m.approval ? 0 : m.unread > 0 ? 1 : 2);
  return rows.sort((a, b) => ekipRank(a) - ekipRank(b) || (ekipRank(a) === 0 ? sub(a) - sub(b) : 0)
    || b.lastAt - a.lastAt || a.title.localeCompare(b.title));
}

/** The one line under a member's name in the Ekip list (r8-06), as an i18n key and its fields. */
export type EkipLine =
  | { key: 'drawer.team.question'; text: string }
  | { key: 'drawer.member.working'; n: number; q: number }
  | { key: 'drawer.team.superWorking' }
  | { key: 'drawer.team.off' }
  | { key: 'drawer.member.idle'; when: number };

export function ekipLine(m: EkipMember): EkipLine {
  if (!m.enabled) return { key: 'drawer.team.off' };
  if (m.asking && m.question) return { key: 'drawer.team.question', text: m.question };
  // No owner-origin queue count exists (the summary's `pending` is main's): the "sırada" half is
  // left out (q 0), never filled from main's requests.
  if (!m.superOnly && m.ownerWorking > 0) return { key: 'drawer.member.working', n: m.ownerWorking, q: 0 };
  if (m.superOnly) return { key: 'drawer.team.superWorking' };
  return { key: 'drawer.member.idle', when: m.lastAt };
}

/** The switch: `POST /api/agents/:slug/enabled` (the owner page only; a global member's writes
 *  its global manifest, so it is off in every project). */
export function setMemberEnabled(api: { post<T>(path: string, body: unknown): Promise<T> }, slug: string, enabled: boolean): Promise<unknown> {
  return api.post<unknown>(`/agents/${encodeURIComponent(slug)}/enabled`, { enabled });
}
