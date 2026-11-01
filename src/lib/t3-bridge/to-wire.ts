/**
 * T3 adapter events → the Claude stream-json frames our chat already reads (plan r5 §3).
 *
 * The bridge child (`dreamcontext t3-chat`) prints these frames on stdout exactly where
 * `claude -p --output-format stream-json` would, so the chat server relays them unchanged and
 * the client's `chatProtocol.ts` parses them with no tool-specific code.
 *
 * STATEFUL, because T3's events are not deltas: an `assistant_message` / `reasoning` turn item
 * arrives again and again carrying the FULL text so far (`streaming: true`), and a runtime
 * request carries no tool name, input or question: those live on the turn item it is joined to.
 * So this keeps, per turn item, the text already sent (to diff the next update into a delta)
 * and, per native item, the tool call it belongs to (to name an approval card).
 *
 * Pure: no I/O, no Effect. `session.ts` feeds it events and writes the frames it returns.
 */
import { createHash } from 'node:crypto';
import type { ProviderAdapterV2Event } from '@t3tools/provider-core/server/ProviderAdapter';
import type { OrchestrationV2TurnItem } from '@t3tools/contracts';

export type WireFrame = Record<string, unknown>;

type TurnItem = OrchestrationV2TurnItem;
type ToolCall = { toolUseId: string; name: string; input: Record<string, unknown> };

const TERMINAL_ITEM = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export interface ToWireOptions {
  /** The tool this session drives, stamped on `system/init` (`dc_tool`). */
  readonly tool: string;
  readonly model: string;
  readonly cwd: string;
  readonly permissionMode: string;
  /**
   * The chat's own app thread (the pane id). A turn item on any other thread is a sub-agent's
   * step: it goes under that sub-agent's card, never into the chat. Absent = one thread (tests).
   */
  readonly threadId?: string;
  /** A sub-agent step, for its drill-in (`subagent-log.ts`). The frame is what the card replays. */
  readonly onSidechain?: (taskId: string, frame: WireFrame) => void;
}

/** One sub-agent the tool started, drawn as Claude draws its Agent call (plan: TABLO row 41). */
interface SubRun {
  readonly itemId: string;
  readonly toolUseId: string;
  /** The card's id: short and `[a-z0-9-]`, which the drill-in route accepts (agent-chat.ts). */
  readonly taskId: string;
  childThreadId: string | null;
  description: string;
  prompt: string;
  /** The prompt came from the sub-agent's own first message: nothing overwrites it. */
  promptFromChild: boolean;
  steps: number;
  ended: boolean;
}

/** `/root/context_check` (a Codex agent path) reads as `context check`. */
function subagentName(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  if (!t) return 'Sub-agent';
  const last = t.startsWith('/') ? t.split('/').filter(Boolean).pop() ?? t : t;
  return last.replace(/_/g, ' ');
}

/** A one-line label for a step, as the card's live activity. */
function stepLabel(call: { name: string; input: Record<string, unknown> }): string {
  const i = call.input;
  const detail = [i.command, i.file_path, i.pattern, i.query, i.description].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const line = detail ? `${call.name} ${detail.replace(/\s+/g, ' ').trim()}` : call.name;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Our canonical tool name and input for one T3 tool turn item, or null for a non-tool item. */
/** T3's ACP adapter has no failure class for these, so Antigravity's own words are read. */
export function antigravityFailureKind(message: string): 'limit' | 'signed-out' | null {
  if (/resource.?exhausted|quota|rate.?limit|too many requests|\b429\b/i.test(message)) return 'limit';
  if (/\bsign(ed)?[ -]?(in(to)?|out)\b|unauthenticated|authentication.?required|re-?authenticate|\b401\b/i.test(message)) return 'signed-out';
  return null;
}

export function toolCallFor(item: TurnItem): { name: string; input: Record<string, unknown> } | null {
  switch (item.type) {
    case 'command_execution':
      return { name: 'Bash', input: { command: item.input, ...(item.title ? { description: item.title } : {}) } };
    case 'file_change': {
      // Codex reports a unified diff (`diffStr`); an Edit card with `patch` draws it as a diff.
      if (item.oldStr !== undefined || item.newStr !== undefined) {
        return { name: 'Edit', input: { file_path: item.fileName, old_string: item.oldStr ?? '', new_string: item.newStr ?? '' } };
      }
      return { name: 'Edit', input: { file_path: item.fileName, ...(item.diffStr ? { patch: item.diffStr } : {}) } };
    }
    case 'web_search':
      return { name: 'WebSearch', input: { query: (item.patterns ?? []).join(' ') } };
    case 'file_search':
      return { name: 'Grep', input: { pattern: item.pattern ?? '' } };
    case 'dynamic_tool':
      return { name: item.toolName ? `mcp__${item.toolName}` : 'mcp__tool', input: isRecord(item.input) ? item.input : { input: item.input } };
    case 'subagent':
      return { name: 'Agent', input: { description: subagentName(item.title), prompt: item.prompt } };
    default:
      return null;
  }
}

function toolResultText(item: TurnItem): { text: string; isError: boolean } {
  switch (item.type) {
    case 'command_execution':
      return {
        text: item.output ?? (item.outputOmitted ? '(output withheld)' : ''),
        // A declined or stopped command never ran: an error, so the card does not read as a success.
        isError: item.status !== 'completed' || (item.exitCode !== undefined && item.exitCode !== 0) || item.outputIndicatesFailure === true,
      };
    case 'file_change':
      return { text: item.status === 'failed' ? `Could not change ${item.fileName}` : `Changed ${item.fileName}`, isError: item.status === 'failed' };
    case 'web_search':
      return { text: (item.results ?? []).map((r) => [r.title, r.url].filter(Boolean).join(' ')).join('\n'), isError: item.status === 'failed' };
    case 'file_search':
      return { text: (item.results ?? []).map((r) => r.fileName).join('\n'), isError: item.status === 'failed' };
    case 'dynamic_tool':
      return { text: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''), isError: item.status === 'failed' };
    case 'subagent':
      return { text: item.result ?? item.progress ?? '', isError: item.status === 'failed' };
    default:
      return { text: '', isError: false };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One stateful translator per bridge session. */
/** A context this small has nothing to compact. */
const CONTEXT_FALL_FLOOR = 100_000;
const CONTEXT_FALL_RATIO = 0.6;

export class ToWire {
  private readonly opts: ToWireOptions;
  /** Text already sent per streaming item (turn item id → text). */
  private readonly sentText = new Map<string, string>();
  /** The content-block index each open streaming item uses in this turn. */
  private readonly blockIndex = new Map<string, number>();
  private nextIndex = 0;
  /** Tool calls already opened (turn item id → call), so the result closes the same card. */
  private readonly toolCalls = new Map<string, ToolCall>();
  /** The tool call a native item started (native item id → call): an approval names it. */
  private readonly toolByNative = new Map<string, ToolCall>();
  private readonly closedItems = new Set<string>();
  /** Approval / question cards open on the client, by T3 runtime request id. */
  private readonly openAsks = new Set<string>();
  /**
   * T3 runtime request ids run past 200 characters, which the chat server refuses as an answer's
   * id (agent-chat.ts `answer`). The client sees a short one (`t3r-<n>`); `t3RequestId` maps back.
   */
  private readonly wireIds = new Map<string, string>();
  private readonly t3Ids = new Map<string, string>();
  private nextAsk = 0;
  private wireIdFor(t3Id: string): string {
    let id = this.wireIds.get(t3Id);
    if (!id) {
      id = `t3r-${++this.nextAsk}`;
      this.wireIds.set(t3Id, id);
      this.t3Ids.set(id, t3Id);
    }
    return id;
  }
  /** The T3 runtime request id behind a card id the client answered (or the id itself). */
  t3RequestId(wireId: string): string {
    return this.t3Ids.get(wireId) ?? wireId;
  }
  /** Questions per request, so an AskUserQuestion answer maps back to T3 question ids. */
  readonly questionsByRequest = new Map<string, ReadonlyArray<{ id: string; question: string }>>();
  private turnOpen = false;
  private lastAssistantText = '';
  /** This turn's tokens, as T3 reported them last. */
  private turnUsage: { input: number; cached: number; output: number } | null = null;
  /** The model context in use, from `provider_thread.updated` (`contextUsage.usedTokens`). */
  contextTokens = 0;
  /** The tool compacted since {@link takeCompacted} last asked: what we sent may be gone. */
  private compacted = false;
  /** The most context seen since the last compaction. */
  private peakTokens = 0;
  /** The native thread id (`system/init` `session_id`). */
  sessionId = '';
  /** The chat's own provider thread: a terminal for any other thread is a sub-agent's. */
  providerThreadId = '';
  /** Sub-agents by their turn item id, by the thread they run on, and by T3's node id. */
  private readonly subRuns = new Map<string, SubRun>();
  private readonly runByChild = new Map<string, SubRun>();
  /** What `subagent.updated` said about a sub-agent before (or after) its turn item. */
  private readonly subNotes = new Map<string, { prompt: string; title: string | null; childThreadId: string | null; result: string | null }>();
  private turnStartedAt = 0;

  constructor(opts: ToWireOptions) {
    this.opts = opts;
  }

  /** The `system/init` every turn opens with (the server counts turns and reads `session_id` from it). */
  init(extra: Record<string, unknown> = {}): WireFrame {
    return {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      model: this.opts.model,
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode,
      tools: [],
      slash_commands: [],
      dc_tool: this.opts.tool,
      ...extra,
    };
  }

  setModel(model: string): void {
    (this.opts as { model: string }).model = model;
  }

  setPermissionMode(mode: string): void {
    (this.opts as { permissionMode: string }).permissionMode = mode;
  }

  /**
   * Antigravity says nothing when it compacts by itself: its agent has no `/compact` and sends no
   * compaction update, so T3's event never fires there, and only its context falling tells. Real
   * turns only rose (26k to 824k over a thread), so a fall this deep is not noise, and a wrong call
   * costs one repeated snapshot. `used` is the size of the last model call.
   */
  private noteUsed(used: number): void {
    this.contextTokens = used;
    if (this.opts.tool !== 'antigravity') return;
    if (this.peakTokens >= CONTEXT_FALL_FLOOR && used < this.peakTokens * CONTEXT_FALL_RATIO) {
      this.compacted = true;
      this.peakTokens = used;
    } else if (used > this.peakTokens) this.peakTokens = used;
  }

  /** A fresh thread: nothing measured yet. */
  resetContext(): void {
    this.contextTokens = 0;
    this.peakTokens = 0;
  }

  /** Did the tool compact since the last ask? Asking clears it. */
  takeCompacted(): boolean {
    const was = this.compacted;
    this.compacted = false;
    return was;
  }

  /** A turn is starting: open it with `system/init` (once). */
  beginTurn(now: number = Date.now()): WireFrame[] {
    if (this.turnOpen) return [];
    this.turnOpen = true;
    this.turnStartedAt = now;
    this.nextIndex = 0;
    this.blockIndex.clear();
    this.lastAssistantText = '';
    return [this.init()];
  }

  /** Translate one T3 event. Returns the frames to print, in order. */
  translate(event: ProviderAdapterV2Event, now: number = Date.now()): WireFrame[] {
    switch (event.type) {
      case 'provider_thread.updated': {
        // A sub-agent's thread: its context is not the chat's.
        if (this.isChildThread(event.providerThread.appThreadId)) return [];
        const used = event.providerThread.contextUsage?.usedTokens;
        if (typeof used === 'number' && used > 0) this.noteUsed(used);
        const native = event.providerThread.nativeThreadRef?.nativeId;
        if (native && !this.sessionId) this.sessionId = native;
        return [];
      }
      case 'provider_turn.updated': {
        // A sub-agent's turn starting is a step of its card, not a turn of the chat.
        if (this.isChildThread(event.threadId)) return [];
        // Codex reports the context of its last request per turn (`last.totalTokens`); T3's
        // orchestrator copies it onto the thread's `contextUsage`, which we read above too.
        const usage = event.providerTurn.tokenUsage;
        const used = usage?.usedTokens;
        if (typeof used === 'number' && used > 0) this.noteUsed(used);
        // What a headless run's cost estimate reads (run.ts). A chat never looks at it.
        if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
          this.turnUsage = { input: usage.inputTokens ?? 0, cached: usage.cachedInputTokens ?? 0, output: usage.outputTokens ?? 0 };
        }
        return event.providerTurn.status === 'running' ? this.beginTurn(now) : [];
      }
      case 'subagent.updated': {
        const t = event.subagent;
        const prior = this.subNotes.get(t.id);
        this.subNotes.set(t.id, {
          prompt: t.prompt || prior?.prompt || '',
          title: t.title ?? prior?.title ?? null,
          childThreadId: t.childThreadId ?? prior?.childThreadId ?? null,
          result: t.result ?? prior?.result ?? null,
        });
        return [];
      }
      case 'turn_item.updated': {
        const item = event.turnItem;
        // A sub-agent's own step: under its card, and never a turn of the chat.
        if (this.isChildThread(item.threadId)) return this.childItem(item);
        if (item.type === 'compaction' && item.status === 'completed') this.compacted = true;
        // A sub-agent that ends after the chat's turn did (Antigravity's run on) closes its card
        // without opening a turn the server would wait on.
        if (item.type === 'subagent') return [...(this.subRuns.has(item.id) ? [] : this.beginTurn(now)), ...this.subagentItem(item)];
        return [...this.beginTurn(now), ...this.item(item)];
      }
      case 'runtime_request.updated': {
        const req = event.runtimeRequest;
        if (req.status !== 'pending' && this.openAsks.has(req.id)) {
          this.openAsks.delete(req.id);
          return [{ type: 'control_cancel_request', request_id: this.wireIdFor(req.id) }];
        }
        return [];
      }
      case 'plan.updated':
        return [];
      case 'turn.terminal':
        // A sub-agent's turn ending: its card closes on its own item, the chat's turn runs on.
        if (this.providerThreadId && event.providerThreadId !== this.providerThreadId) return [];
        return this.terminal(event, now);
      default:
        return [];
    }
  }

  /** Is this app thread a sub-agent's (not the chat's own)? */
  private isChildThread(threadId: string | null | undefined): boolean {
    return !!this.opts.threadId && !!threadId && threadId !== this.opts.threadId;
  }

  /** The sub-agent a step on `threadId` belongs to. A thread not seen yet is the newest open
   *  sub-agent's that has none: its turn item names the thread a moment after it starts. */
  private runFor(threadId: string): SubRun | null {
    const known = this.runByChild.get(threadId);
    if (known) return known;
    const open = [...this.subRuns.values()].filter((r) => !r.ended && !r.childThreadId);
    const run = open[open.length - 1] ?? null;
    if (run) {
      run.childThreadId = threadId;
      this.runByChild.set(threadId, run);
    }
    return run;
  }

  /** The card's live line: what it is doing now, and how many steps it took. */
  private progress(run: SubRun, p: { activity?: string; lastTool?: string; summary?: string }): WireFrame {
    return {
      type: 'system',
      subtype: 'task_progress',
      task_id: run.taskId,
      tool_use_id: run.toolUseId,
      ...(p.activity ? { description: p.activity } : {}),
      ...(p.lastTool ? { last_tool_name: p.lastTool } : {}),
      ...(p.summary ? { summary: p.summary } : {}),
      usage: { tool_uses: run.steps },
      session_id: this.sessionId,
    };
  }

  /** The Agent call and its `task_started`, as Claude's CLI sends them: the card's identity. */
  private announce(run: SubRun): WireFrame[] {
    const input = { description: run.description, prompt: run.prompt };
    this.toolCalls.set(run.itemId, { toolUseId: run.toolUseId, name: 'Agent', input });
    return [
      {
        type: 'assistant',
        message: { id: `msg_${run.itemId}`, role: 'assistant', model: this.opts.model, content: [{ type: 'tool_use', id: run.toolUseId, name: 'Agent', input }] },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: run.taskId,
        tool_use_id: run.toolUseId,
        description: run.description,
        ...(run.prompt ? { prompt: run.prompt } : {}),
        task_type: 'local_agent',
        session_id: this.sessionId,
      },
    ];
  }

  /** A sub-agent the chat's agent started: one card, filled in as the tool tells more. */
  private subagentItem(item: Extract<TurnItem, { type: 'subagent' }>): WireFrame[] {
    const note = this.subNotes.get(String(item.subagentId));
    const prompt = item.prompt || note?.prompt || '';
    const named = subagentName(item.title ?? note?.title);
    const out: WireFrame[] = [];
    let run = this.subRuns.get(item.id);
    if (!run) {
      run = {
        itemId: item.id,
        toolUseId: `toolu_${item.id}`,
        taskId: `t3-${createHash('sha256').update(item.id).digest('hex').slice(0, 20)}`,
        childThreadId: null,
        description: named,
        prompt,
        promptFromChild: false,
        steps: 0,
        ended: false,
      };
      this.subRuns.set(item.id, run);
      out.push(...this.announce(run));
      const call = this.toolCalls.get(item.id);
      if (call && item.nativeItemRef?.nativeId) this.toolByNative.set(item.nativeItemRef.nativeId, call);
    } else {
      const better = !run.promptFromChild && !!prompt && prompt !== run.prompt;
      const renamed = named !== 'Sub-agent' && named !== run.description;
      if (better) run.prompt = prompt;
      if (renamed) run.description = named;
      if ((better || renamed) && !run.ended) out.push(...this.announce(run));
    }
    const child = item.childThreadId ?? note?.childThreadId ?? null;
    if (child && run.childThreadId !== child) {
      run.childThreadId = child;
      this.runByChild.set(child, run);
    }
    const terminal = TERMINAL_ITEM.has(item.status);
    if (item.progress && !terminal && !run.ended) out.push(this.progress(run, { activity: item.progress }));
    if (terminal && !run.ended) {
      run.ended = true;
      this.closedItems.add(item.id);
      const result = item.result ?? note?.result ?? item.progress ?? '';
      const status = item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'stopped';
      const summary = result.trim().split('\n')[0]?.slice(0, 200) ?? '';
      out.push({
        type: 'system',
        subtype: 'task_notification',
        task_id: run.taskId,
        tool_use_id: run.toolUseId,
        status,
        ...(summary ? { summary } : {}),
        usage: { tool_uses: run.steps },
        session_id: this.sessionId,
      });
      out.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: run.toolUseId, content: [{ type: 'text', text: result }], is_error: item.status === 'failed' }] },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      });
    }
    return out;
  }

  /**
   * A sub-agent's own step. Its words and tool calls go to the card's drill-in (`onSidechain`),
   * and the card hears what it is doing now; none of it reaches the chat, where a sub-agent's
   * text would read as the main agent's. A card it asks the owner still goes to the owner.
   */
  private childItem(item: TurnItem): WireFrame[] {
    if (item.type === 'approval_request') return this.approval(item);
    if (item.type === 'user_input_request') return this.question(item);
    const run = this.runFor(String(item.threadId));
    if (!run) return [];
    const side = (frame: WireFrame): void => { this.opts.onSidechain?.(run.taskId, frame); };
    if (item.type === 'user_message') {
      const text = item.text ?? '';
      if (run.promptFromChild || !text.trim()) return [];
      run.prompt = text;
      run.promptFromChild = true;
      side({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: run.toolUseId });
      return run.ended ? [] : this.announce(run);
    }
    if (item.type === 'assistant_message' || item.type === 'reasoning') {
      if ((item.streaming && !TERMINAL_ITEM.has(item.status)) || this.closedItems.has(item.id)) return [];
      this.closedItems.add(item.id);
      const text = item.text ?? '';
      if (!text.trim()) return [];
      const thinking = item.type === 'reasoning';
      side({
        type: 'assistant',
        message: { id: `msg_${item.id}`, role: 'assistant', model: this.opts.model, content: [thinking ? { type: 'thinking', thinking: text, signature: '' } : { type: 'text', text }] },
        parent_tool_use_id: run.toolUseId,
      });
      if (thinking || run.ended) return [];
      return [this.progress(run, { summary: text.trim().split('\n')[0]!.slice(0, 200) })];
    }
    // A sub-agent of the sub-agent: its steps are this card's too.
    if (item.type === 'subagent' && item.childThreadId && !this.runByChild.has(item.childThreadId)) this.runByChild.set(item.childThreadId, run);
    const call = toolCallFor(item);
    if (!call) return [];
    const out: WireFrame[] = [];
    let open = this.toolCalls.get(item.id);
    if (!open) {
      open = { toolUseId: `toolu_${item.id}`, ...call };
      this.toolCalls.set(item.id, open);
      if (item.nativeItemRef?.nativeId) this.toolByNative.set(item.nativeItemRef.nativeId, open);
      run.steps += 1;
      side({
        type: 'assistant',
        message: { id: `msg_${item.id}`, role: 'assistant', model: this.opts.model, content: [{ type: 'tool_use', id: open.toolUseId, name: open.name, input: open.input }] },
        parent_tool_use_id: run.toolUseId,
      });
      if (!run.ended) out.push(this.progress(run, { activity: stepLabel(open), lastTool: open.name }));
    }
    if (TERMINAL_ITEM.has(item.status) && !this.closedItems.has(item.id)) {
      this.closedItems.add(item.id);
      const { text, isError } = toolResultText(item);
      side({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: open.toolUseId, content: [{ type: 'text', text }], is_error: isError }] },
        parent_tool_use_id: run.toolUseId,
      });
    }
    return out;
  }

  private item(item: TurnItem): WireFrame[] {
    if (item.type === 'assistant_message' || item.type === 'reasoning') return this.streamingText(item);
    if (item.type === 'todo_list') return this.todo(item);
    if (item.type === 'approval_request') return this.approval(item);
    if (item.type === 'user_input_request') return this.question(item);
    const call = toolCallFor(item);
    if (!call) return [];
    const out: WireFrame[] = [];
    let open = this.toolCalls.get(item.id);
    if (!open) {
      open = { toolUseId: `toolu_${item.id}`, ...call };
      this.toolCalls.set(item.id, open);
      if (item.nativeItemRef?.nativeId) this.toolByNative.set(item.nativeItemRef.nativeId, open);
      out.push({
        type: 'assistant',
        message: { id: `msg_${item.id}`, role: 'assistant', model: this.opts.model, content: [{ type: 'tool_use', id: open.toolUseId, name: open.name, input: open.input }] },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      });
    }
    if (TERMINAL_ITEM.has(item.status) && !this.closedItems.has(item.id)) {
      this.closedItems.add(item.id);
      const { text, isError } = toolResultText(item);
      out.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: open.toolUseId, content: [{ type: 'text', text }], is_error: isError }] },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      });
    }
    return out;
  }

  private streamingText(item: Extract<TurnItem, { type: 'assistant_message' | 'reasoning' }>): WireFrame[] {
    const thinking = item.type === 'reasoning';
    const full = item.text ?? '';
    const sent = this.sentText.get(item.id) ?? '';
    const out: WireFrame[] = [];
    if (this.closedItems.has(item.id)) return out;
    let index = this.blockIndex.get(item.id);
    if (index === undefined && (full.length > 0 || !item.streaming)) {
      index = this.nextIndex++;
      this.blockIndex.set(item.id, index);
      out.push({
        type: 'stream_event',
        event: { type: 'content_block_start', index, content_block: thinking ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      });
    }
    // Cumulative text: send only what is new. A rewrite (text no longer extends what was sent)
    // cannot be expressed as a delta; the final `assistant` frame below carries the truth.
    if (index !== undefined && full.length > sent.length && full.startsWith(sent)) {
      const delta = full.slice(sent.length);
      this.sentText.set(item.id, full);
      out.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index, delta: thinking ? { type: 'thinking_delta', thinking: delta } : { type: 'text_delta', text: delta } },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      });
    }
    if (!item.streaming || TERMINAL_ITEM.has(item.status)) {
      this.closedItems.add(item.id);
      if (index !== undefined) {
        out.push({ type: 'stream_event', event: { type: 'content_block_stop', index }, parent_tool_use_id: null, session_id: this.sessionId });
      }
      if (full.length > 0) {
        if (!thinking) this.lastAssistantText = full;
        out.push({
          type: 'assistant',
          message: {
            id: `msg_${item.id}`,
            role: 'assistant',
            model: this.opts.model,
            content: [thinking ? { type: 'thinking', thinking: full, signature: '' } : { type: 'text', text: full }],
            // The context the model is holding, so the server's Eco measurement and the ring read it
            // the same way they read Claude's (`contextTokensFromUsage`).
            usage: { input_tokens: this.contextTokens, output_tokens: 0 },
          },
          parent_tool_use_id: null,
          session_id: this.sessionId,
        });
      }
    }
    return out;
  }

  private todo(item: Extract<TurnItem, { type: 'todo_list' }>): WireFrame[] {
    const todos = item.steps.map((s) => ({
      content: s.text,
      activeForm: s.text,
      status: s.status === 'completed' ? 'completed' : s.status === 'running' ? 'in_progress' : 'pending',
    }));
    const toolUseId = `toolu_${item.id}_${item.updatedAt ? String(item.updatedAt.epochMilliseconds) : '0'}`;
    return [{
      type: 'assistant',
      message: { id: `msg_${item.id}`, role: 'assistant', model: this.opts.model, content: [{ type: 'tool_use', id: toolUseId, name: 'TodoWrite', input: { todos } }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    }];
  }

  private approval(item: Extract<TurnItem, { type: 'approval_request' }>): WireFrame[] {
    if (item.status !== 'waiting' && item.status !== 'pending') return [];
    if (this.openAsks.has(item.requestId)) return [];
    this.openAsks.add(item.requestId);
    const native = item.nativeItemRef?.nativeId;
    const call = native ? this.toolByNative.get(native) : undefined;
    const fallback = item.requestKind === 'file-change'
      // Codex words a file-change prompt as "<add|update|delete> <path>".
      ? { name: 'Edit', input: { file_path: (item.prompt ?? '').replace(/^(add|update|delete|move)\s+/i, '') } }
      : item.requestKind === 'command'
        ? { name: 'Bash', input: { command: item.prompt ?? '' } }
        : { name: item.appName ? `mcp__${item.appName}` : 'Permission', input: { request: item.prompt ?? item.requestKind } };
    const name = call?.name ?? fallback.name;
    const input = call?.input ?? fallback.input;
    return [{
      type: 'control_request',
      request_id: this.wireIdFor(item.requestId),
      request: {
        subtype: 'can_use_tool',
        tool_name: name,
        input,
        ...(call ? { tool_use_id: call.toolUseId } : {}),
        ...(item.reason || item.prompt ? { description: item.reason ?? item.prompt } : {}),
      },
    }];
  }

  private question(item: Extract<TurnItem, { type: 'user_input_request' }>): WireFrame[] {
    if (item.status !== 'waiting' && item.status !== 'pending') return [];
    if (this.openAsks.has(item.requestId)) return [];
    this.openAsks.add(item.requestId);
    this.questionsByRequest.set(item.requestId, item.questions.map((q) => ({ id: q.id, question: q.question })));
    return [{
      type: 'control_request',
      request_id: this.wireIdFor(item.requestId),
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        requires_user_interaction: true,
        input: {
          questions: item.questions.map((q) => ({
            question: q.question,
            header: q.header.slice(0, 12),
            multiSelect: q.multiSelect ?? false,
            options: q.options.map((o) => ({ label: o.label, description: o.description })),
          })),
        },
      },
    }];
  }

  private terminal(event: Extract<ProviderAdapterV2Event, { type: 'turn.terminal' }>, now: number): WireFrame[] {
    const out: WireFrame[] = [];
    // Cards still open when the turn ends can no longer be answered.
    for (const id of this.openAsks) out.push({ type: 'control_cancel_request', request_id: this.wireIdFor(id) });
    this.openAsks.clear();
    const ok = event.status === 'completed';
    const failure = event.status === 'failed' ? event.failure : null;
    // A usage-limit refusal (T3 `failure.class === 'usage_limit'`): the server's switch reads it
    // like Claude's refusal frame, with the reset T3 knows (plan r5 §4d "Limit detection").
    const kind = this.opts.tool === 'antigravity' ? antigravityFailureKind(failure?.message ?? '') : null;
    const limited = failure?.class === 'usage_limit' || kind === 'limit';
    const limitResetMs = failure?.class === 'usage_limit' && failure.resetAt ? Date.parse(failure.resetAt) : NaN;
    out.push({
      type: 'result',
      subtype: ok ? 'success' : 'error_during_execution',
      is_error: !ok,
      result: ok ? this.lastAssistantText : failure?.message ?? (event.status === 'interrupted' ? 'Interrupted' : event.status),
      ...(event.status === 'interrupted' || event.status === 'cancelled' ? { terminal_reason: 'aborted' } : {}),
      num_turns: 1,
      duration_ms: this.turnStartedAt ? now - this.turnStartedAt : 0,
      total_cost_usd: 0,
      usage: { input_tokens: this.contextTokens, output_tokens: 0 },
      session_id: this.sessionId,
      dc_tool: this.opts.tool,
      ...(this.turnUsage ? { dc_turn_usage: this.turnUsage } : {}),
      ...(limited ? { dc_limit: { resetsAtMs: Number.isFinite(limitResetMs) ? limitResetMs : null } } : {}),
      ...(kind === 'signed-out' ? { dc_signed_out: true } : {}),
    });
    this.turnOpen = false;
    return out;
  }

  /** Is a turn open (between its `system/init` and its `result`)? */
  get busy(): boolean {
    return this.turnOpen;
  }

  /** Map an AskUserQuestion answer (`{answers: {questionText: label}}`) back to T3's question ids. */
  answersFor(requestId: string, updatedInput: unknown): Record<string, string> {
    const qs = this.questionsByRequest.get(this.t3RequestId(requestId)) ?? [];
    const given = isRecord(updatedInput) && isRecord(updatedInput.answers) ? updatedInput.answers : {};
    const out: Record<string, string> = {};
    for (const q of qs) {
      const a = given[q.question];
      if (typeof a === 'string' && a.length) out[q.id] = a;
    }
    return out;
  }
}
