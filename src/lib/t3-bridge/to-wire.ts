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
}

/** Our canonical tool name and input for one T3 tool turn item, or null for a non-tool item. */
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
      return { name: 'Agent', input: { description: item.title ?? 'Sub-agent', prompt: item.prompt } };
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
  /** The native thread id (`system/init` `session_id`). */
  sessionId = '';
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
        const used = event.providerThread.contextUsage?.usedTokens;
        if (typeof used === 'number' && used > 0) this.contextTokens = used;
        const native = event.providerThread.nativeThreadRef?.nativeId;
        if (native && !this.sessionId) this.sessionId = native;
        return [];
      }
      case 'provider_turn.updated': {
        // Codex reports the context of its last request per turn (`last.totalTokens`); T3's
        // orchestrator copies it onto the thread's `contextUsage`, which we read above too.
        const usage = event.providerTurn.tokenUsage;
        const used = usage?.usedTokens;
        if (typeof used === 'number' && used > 0) this.contextTokens = used;
        // What a headless run's cost estimate reads (run.ts). A chat never looks at it.
        if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
          this.turnUsage = { input: usage.inputTokens ?? 0, cached: usage.cachedInputTokens ?? 0, output: usage.outputTokens ?? 0 };
        }
        return event.providerTurn.status === 'running' ? this.beginTurn(now) : [];
      }
      case 'turn_item.updated':
        return [...this.beginTurn(now), ...this.item(event.turnItem)];
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
        return this.terminal(event, now);
      default:
        return [];
    }
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
      ...(failure?.class === 'usage_limit' ? { dc_limit: { resetsAtMs: Number.isFinite(limitResetMs) ? limitResetMs : null } } : {}),
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
