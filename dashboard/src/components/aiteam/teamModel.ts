import type {
  AgentActivity, AgentFeed, AutomationSummary, FeedMessage, RunAnswer, ThreadEntry, ThreadSummaryRow,
} from '../../hooks/useAutomations';
import type { AgentSummary } from '../../hooks/useAgents';

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
> & Partial<Pick<AgentSummary, 'readOnly' | 'owner' | 'ownerLabel' | 'runsElsewhere' | 'scope'>>;

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
    const status: TeamStatus = since !== null ? 'working'
      : needs ? 'needs'
        : approval ? 'approval'
          : paused ? 'paused'
            : 'idle';

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
      preview: last ? previewOf(last) : null,
      lastAt: last?.at ?? null,
      unread,
      section: readOnly ? 'readonly' : status === 'needs' ? 'needs' : 'team',
      readOnly,
      ownerLabel: agent.ownerLabel ?? agent.owner ?? null,
      elsewhere: agent.runsElsewhere?.name ?? null,
      global: agent.scope === 'global',
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
 * WHERE A PICKED TEAMMATE OPENS: its conversation (the stage), where its whole history — every
 * routine run and every talk — is one flow above the composer (AI Team history, 2026-10-27).
 * Only an open routine QUESTION opens the activity, where its answer block lives.
 */
export function openingView(row: Pick<TeamRow, 'status'>): 'stage' | 'activity' {
  return row.status === 'needs' ? 'activity' : 'stage';
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
  | { kind: 'you'; key: string; text: string; at: string }
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
    if (m.ask) out.push({ kind: 'you', key: `${m.key}:ask`, text: m.ask.text, at: m.ask.at });
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
          out.push({ kind: 'you', key: `${m.key}:${e.id}`, text: e.text, at: e.at });
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
