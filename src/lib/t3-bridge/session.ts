/**
 * One chat session on a T3 provider adapter (plan r5 §3), with plain async edges.
 *
 * This is the only module that runs Effect: it builds the runtime the vendored adapter needs,
 * opens T3's `CodexAdapterV2` session, and turns our chat verbs (send, steer, interrupt, answer,
 * new thread, mode, model) into adapter calls. Every adapter event goes through `ToWire` and out
 * as Claude stream-json frames through `emit`.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderApprovalDecision,
} from '@t3tools/contracts';
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator';
import * as McpProviderSessions from '@t3tools/provider-core/server/McpProviderSessions';
import type * as ProviderAdapter from '@t3tools/provider-core/server/ProviderAdapter';
import * as ProviderEventLoggers from '@t3tools/provider-core/server/ProviderEventLoggers';
import { DEFAULT_SIGNAL_EXPORT } from '@t3tools/shared/observability';
import * as OtelEnvironment from '@t3tools/shared/otelEnvironment';
import * as CodexAdapterV2 from '@t3tools/server/orchestration-v2/Adapters/CodexAdapterV2';
import type * as ServerConfig from '@t3tools/server/config';
import * as Crypto from 'effect/Crypto';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Schema from 'effect/Schema';
import * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import { codexRuntimePolicy, type CodexRuntimePolicy } from './policy.js';
import { ToWire, type WireFrame } from './to-wire.js';

export type ClientFactory = CodexAdapterV2.CodexAppServerClientFactoryShape;

export interface BridgeSessionOptions {
  readonly tool: 'codex';
  readonly cwd: string;
  readonly model: string;
  readonly effort?: string;
  readonly mode: string;
  /** The pane's stable id: T3's app thread id, so every T3 id stays scoped to this pane. */
  readonly paneId: string;
  /** A native Codex thread to resume (a reopened pane). */
  readonly resumeNativeThreadId?: string;
  /** Codex binary (default `codex` on PATH). */
  readonly binaryPath?: string;
  /** Codex `-c` launch arguments (developer instructions, profiles). */
  readonly launchArgs?: string;
  /** The environment the Codex process inherits (already scrubbed by the caller). */
  readonly env: NodeJS.ProcessEnv;
  /** dreamcontext's T3 state root (`~/.dreamcontext/t3`). Logs go under `logs/` (0700). */
  readonly stateRoot: string;
  readonly extraRoots?: readonly string[];
  readonly privateTmp?: string | null;
  /** Tests only: the exact policy a recorded transcript expects on `turn/start`. */
  readonly runtimePolicyOverride?: CodexRuntimePolicy;
  /** The adapter's event stream ended while the session was open (Codex died): the caller ends
   *  the bridge. An open turn has already been closed with an error `result`. */
  readonly onFatal?: (message: string) => void;
  /** Tests inject T3's replay client here; production spawns `codex app-server`. */
  readonly clientFactory?: ClientFactory;
  readonly emit: (frame: WireFrame) => void;
  /** A frame that is not chat output (bridge diagnostics) — never anything secret. */
  readonly log?: (line: string) => void;
}

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/** The fixed `ServerConfig` T3's adapter reads: paths under our state root, no telemetry. */
export function bridgeServerConfig(stateRoot: string, cwd: string): ServerConfig.ServerConfig['Service'] {
  const stateDir = join(stateRoot, 'state');
  const logsDir = join(stateRoot, 'logs');
  const providerLogsDir = join(logsDir, 'provider');
  for (const d of [stateRoot, stateDir, logsDir, providerLogsDir, join(stateDir, 'attachments')]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try { chmodSync(d, 0o700); } catch { /* best effort */ }
  }
  return {
    logLevel: 'Error',
    traceMinLevel: 'Info',
    traceTimingEnabled: false,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 1,
    otelEnvironment: OtelEnvironment.none,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    mode: 'web',
    port: 0,
    host: undefined,
    cwd,
    baseDir: stateRoot,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: 'headless',
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    stateDir,
    dbPath: join(stateDir, 'unused.sqlite'),
    keybindingsConfigPath: join(stateDir, 'keybindings.json'),
    settingsPath: join(stateDir, 'settings.json'),
    environmentThemesDir: join(stateDir, 'themes'),
    providerStatusCacheDir: join(stateRoot, 'caches'),
    worktreesDir: join(stateRoot, 'worktrees'),
    attachmentsDir: join(stateDir, 'attachments'),
    browserArtifactsDir: join(stateDir, 'browser-artifacts'),
    logsDir,
    serverTracePath: join(logsDir, 'server.trace.ndjson'),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, 'events.log'),
    terminalLogsDir: join(logsDir, 'terminals'),
    anonymousIdPath: join(stateDir, 'anonymous-id'),
    environmentIdPath: join(stateDir, 'environment-id'),
    serverRuntimeStatePath: join(stateDir, 'server-runtime.json'),
    secretsDir: join(stateDir, 'secrets'),
  };
}

/** The runtime layer: Node services, T3's id allocator and MCP sessions, no provider event logs. */
function bridgeLayer(clientFactory: ClientFactory | undefined) {
  const base = Layer.mergeAll(
    NodeServices.layer,
    IdAllocator.layer,
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, ProviderEventLoggers.NoOpProviderEventLoggers),
  );
  const factory = clientFactory
    ? Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, CodexAdapterV2.CodexAppServerClientFactory.of(clientFactory))
    : CodexAdapterV2.layerAppServerClientFactory.pipe(Layer.provide(base));
  return Layer.mergeAll(base, McpProviderSessions.layer, factory);
}

type Runtime = ManagedRuntime.ManagedRuntime<
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | CodexAdapterV2.CodexAppServerClientFactory
  | Crypto.Crypto
  | FileSystem.FileSystem,
  never
>;

export class BridgeSession {
  readonly wire: ToWire;
  private readonly opts: BridgeSessionOptions;
  private runtime: Runtime | null = null;
  private scope: Scope.Closeable | null = null;
  private session: ProviderAdapter.ProviderAdapterV2SessionRuntime | null = null;
  private providerThread: OrchestrationV2ProviderThread | null = null;
  private mode: string;
  private model: string;
  private effort: string;
  private runOrdinal = 0;
  private activeRun: { runId: RunId; providerTurnId: string | null } | null = null;
  /** Resolves once the active run has its provider turn id (or ended): a Stop or a steer that
   *  arrives before Codex reported the turn running waits for it instead of being lost. */
  private turnKnown: { promise: Promise<void>; resolve: () => void } | null = null;
  private closed = false;

  private constructor(opts: BridgeSessionOptions) {
    this.opts = opts;
    this.mode = opts.mode;
    this.model = opts.model;
    this.effort = opts.effort ?? '';
    this.wire = new ToWire({ tool: opts.tool, model: opts.model, cwd: opts.cwd, permissionMode: opts.mode });
  }

  static async open(opts: BridgeSessionOptions): Promise<BridgeSession> {
    const s = new BridgeSession(opts);
    await s.start();
    return s;
  }

  private get threadId(): ThreadId {
    return ThreadId.make(this.opts.paneId);
  }

  private modelSelection(): ModelSelection {
    return {
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      model: this.model,
      ...(this.effort ? { options: [{ id: 'reasoningEffort', value: this.effort }] } : {}),
    } as ModelSelection;
  }

  policy(): CodexRuntimePolicy {
    if (this.opts.runtimePolicyOverride) return this.opts.runtimePolicyOverride;
    return codexRuntimePolicy({ mode: this.mode, cwd: this.opts.cwd, extraRoots: this.opts.extraRoots, privateTmp: this.opts.privateTmp ?? null });
  }

  private runtimePolicy(): ProviderAdapter.ProviderAdapterV2RuntimePolicy {
    return this.policy() as ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  }

  private run<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
    if (!this.runtime) throw new Error('bridge session is not open');
    return this.runtime.runPromise(effect);
  }

  private async start(): Promise<void> {
    const { opts } = this;
    this.runtime = ManagedRuntime.make(bridgeLayer(opts.clientFactory)) as unknown as Runtime;
    const scope = await this.runtime.runPromise(Scope.make());
    this.scope = scope;
    const serverConfig = bridgeServerConfig(opts.stateRoot, opts.cwd);
    const settings = decodeCodexSettings({
      enabled: true,
      ...(opts.binaryPath ? { binaryPath: opts.binaryPath } : {}),
      ...(opts.launchArgs ? { launchArgs: opts.launchArgs } : {}),
    });
    const threadId = this.threadId;
    const runtimePolicy = this.runtimePolicy();
    const modelSelection = this.modelSelection();
    const resumeNative = opts.resumeNativeThreadId;
    const providerSessionId = ProviderSessionId.make(`dc-${opts.paneId}`);
    const open = Effect.gen(function* () {
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings,
        environment: opts.env,
        clientFactory: yield* CodexAdapterV2.CodexAppServerClientFactory,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig,
      });
      return yield* adapter.openSession({ threadId, providerSessionId, modelSelection, runtimePolicy });
    }).pipe(Effect.provideService(Scope.Scope, scope));
    this.session = await this.runtime.runPromise(open);
    const session = this.session;
    // Every adapter event, translated and printed, for the life of the session.
    this.runtime.runFork(
      Stream.runForEach(session.events, (event) => Effect.sync(() => this.onEvent(event))).pipe(
        Effect.catchCause((cause) => Effect.sync(() => this.opts.log?.(`t3 event stream ended: ${String(cause).slice(0, 300)}`))),
        // Ended while open = Codex is gone: close the open turn loudly, then end the bridge.
        Effect.ensuring(Effect.sync(() => { if (!this.closed) this.fatal('Codex stopped running (its app-server exited).'); })),
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    if (resumeNative) {
      const pt = this.providerThreadFor(resumeNative, providerSessionId);
      this.providerThread = await this.run(session.resumeThread({ providerThread: pt, threadId, modelSelection, runtimePolicy }));
    } else {
      this.providerThread = await this.run(session.ensureThread({ threadId, modelSelection, runtimePolicy }));
    }
    this.wire.sessionId = this.providerThread.nativeThreadRef?.nativeId ?? '';
  }

  /** A provider thread record for a native Codex thread we hold only by id (a reopened pane). */
  private providerThreadFor(nativeId: string, providerSessionId: ProviderSessionId): OrchestrationV2ProviderThread {
    const now = DateTime.makeUnsafe(Date.now());
    return {
      id: IdAllocator.derive.providerThread({ driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeThreadId: nativeId }),
      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
      providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      providerSessionId,
      appThreadId: this.threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId, strength: 'strong' },
      nativeConversationHeadRef: null,
      status: 'idle',
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    } as OrchestrationV2ProviderThread;
  }

  private fatal(message: string): void {
    if (this.activeRun) {
      this.opts.emit({
        type: 'result', subtype: 'error_during_execution', is_error: true, result: message,
        num_turns: 0, total_cost_usd: 0, usage: {}, session_id: this.wire.sessionId, dc_tool: this.opts.tool,
      });
      this.activeRun = null;
      this.turnKnown?.resolve();
    }
    this.opts.onFatal?.(message);
  }

  /** Wait (bounded) until the active run has its provider turn id. */
  private async awaitTurnId(ms = 15_000): Promise<void> {
    if (!this.activeRun || this.activeRun.providerTurnId || !this.turnKnown) return;
    await Promise.race([this.turnKnown.promise, new Promise((r) => setTimeout(r, ms))]);
  }

  private onEvent(event: ProviderAdapter.ProviderAdapterV2Event): void {
    if (event.type === 'provider_turn.updated' && this.activeRun && event.providerTurn.status === 'running') {
      this.activeRun.providerTurnId = event.providerTurn.id;
      this.turnKnown?.resolve();
    }
    if (event.type === 'provider_thread.updated' && this.providerThread && event.providerThread.id === this.providerThread.id) {
      this.providerThread = event.providerThread;
    }
    for (const frame of this.wire.translate(event)) this.opts.emit(frame);
    if (event.type === 'turn.terminal') { this.activeRun = null; this.turnKnown?.resolve(); }
  }

  private appThread(now: DateTime.Utc): OrchestrationV2AppThread {
    const id = this.threadId;
    return {
      createdBy: 'user',
      creationSource: 'web',
      id,
      projectId: ProjectId.make(`project-${id}`),
      title: 'dreamcontext chat',
      providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      modelSelection: this.modelSelection(),
      runtimeMode: this.policy().runtimeMode,
      interactionMode: this.policy().interactionMode,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: this.providerThread!.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    } as OrchestrationV2AppThread;
  }

  /** Is a turn running? */
  get busy(): boolean {
    return this.activeRun !== null;
  }

  /**
   * One owner message. Idle: it starts a turn. Mid-turn: it steers the running turn (the same
   * behaviour Claude's CLI gives a user frame written mid-turn). `appContext` rides as untrusted
   * additional context, never as developer instructions.
   */
  async send(text: string, appContext: ReadonlyArray<{ key: string; text: string }> = []): Promise<void> {
    const session = this.session;
    const providerThread = this.providerThread;
    if (!session || !providerThread || this.closed) return;
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const message = {
      messageId: MessageId.make(`msg-${stamp}`),
      text,
      attachments: [],
      createdBy: 'user' as const,
      creationSource: 'web' as const,
    } as ProviderAdapter.ProviderAdapterV2TurnMessage;
    // A message right after the turn started steers it once Codex reported it running.
    await this.awaitTurnId();
    if (this.activeRun?.providerTurnId) {
      await this.run(session.steerTurn({
        threadId: this.threadId,
        runId: this.activeRun.runId,
        providerThread,
        providerTurnId: this.activeRun.providerTurnId as never,
        message,
      }));
      return;
    }
    this.runOrdinal += 1;
    const runId = RunId.make(`run-${stamp}`);
    this.activeRun = { runId, providerTurnId: null };
    let resolveKnown = (): void => undefined;
    this.turnKnown = { promise: new Promise<void>((r) => { resolveKnown = r; }), resolve: () => resolveKnown() };
    for (const frame of this.wire.beginTurn()) this.opts.emit(frame);
    const now = DateTime.makeUnsafe(Date.now());
    const input: ProviderAdapter.ProviderAdapterV2TurnInput = {
      appThread: this.appThread(now),
      threadId: this.threadId,
      runId,
      runOrdinal: this.runOrdinal,
      providerTurnOrdinal: this.runOrdinal,
      attemptId: RunAttemptId.make(`attempt-${stamp}`),
      rootNodeId: NodeId.make(`node-${stamp}`),
      providerThread,
      message,
      modelSelection: this.modelSelection(),
      runtimePolicy: this.runtimePolicy(),
      ...(appContext.length ? { appContext } : {}),
    };
    const exit = await this.runtime!.runPromiseExit(session.startTurn(input));
    if (Exit.isFailure(exit)) {
      this.activeRun = null;
      this.turnKnown?.resolve();
      this.opts.emit({
        type: 'result', subtype: 'error_during_execution', is_error: true,
        result: `Codex could not start the turn: ${String(exit.cause).slice(0, 400)}`,
        num_turns: 0, total_cost_usd: 0, usage: {}, session_id: this.wire.sessionId, dc_tool: this.opts.tool,
      });
    }
  }

  /** Stop the running turn. Resolves once Codex accepted the interrupt (or nothing was running). */
  async interrupt(): Promise<void> {
    const session = this.session;
    // A Stop right after a send waits for Codex to report the turn, then stops it.
    await this.awaitTurnId();
    const run = this.activeRun;
    if (!session || !this.providerThread || !run?.providerTurnId) return;
    await this.run(session.interruptTurn({ providerThread: this.providerThread, providerTurnId: run.providerTurnId as never }));
  }

  /** The owner answered an approval or a question card. */
  async answer(requestId: string, response: { behavior?: string; updatedInput?: unknown; message?: string }): Promise<void> {
    const session = this.session;
    if (!session) return;
    const t3Id = this.wire.t3RequestId(requestId);
    const questions = this.wire.questionsByRequest.has(t3Id);
    const allow = response.behavior === 'allow';
    const input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput = questions
      // A dismissed question goes back with no answers (T3 takes no decision on a question).
      ? { requestId: t3Id as never, answers: allow ? this.wire.answersFor(requestId, response.updatedInput) : {} }
      : { requestId: t3Id as never, decision: (allow ? 'accept' : 'decline') as ProviderApprovalDecision, ...(response.message ? { feedback: response.message } : {}) };
    await this.run(session.respondToRuntimeRequest(input));
  }

  /**
   * Eco rotation (`/clear`): a fresh native thread on the SAME instance. The new thread id goes
   * out on a `system/init` (the server's handoff run leaves `clearing` on it, and the Super latch
   * reads it as the clear having happened).
   */
  async newThread(): Promise<string> {
    const session = this.session;
    if (!session) return '';
    this.providerThread = await this.run(session.ensureThread({
      threadId: this.threadId,
      modelSelection: this.modelSelection(),
      runtimePolicy: this.runtimePolicy(),
      forceNewNativeThread: true,
    }));
    this.wire.sessionId = this.providerThread.nativeThreadRef?.nativeId ?? '';
    this.wire.contextTokens = 0;
    this.opts.emit(this.wire.init({ dc_rotated: true }));
    // `/clear` was written as a user turn (the server opened one for it), and Claude closes that
    // turn with a `result`; so does the bridge, or the pane would count a turn open forever.
    this.opts.emit({
      type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, duration_ms: 0,
      total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, session_id: this.wire.sessionId, dc_tool: this.opts.tool,
      dc_synthetic: true,
    });
    return this.wire.sessionId;
  }

  setMode(mode: string): void {
    this.mode = mode;
    this.wire.setPermissionMode(mode);
  }

  /** The next turn's reasoning effort (the composer's live effort switch). */
  setEffort(effort: string): void {
    this.effort = effort;
  }

  setModel(model: string): void {
    this.model = model;
    this.wire.setModel(model);
  }

  get nativeThreadId(): string {
    return this.wire.sessionId;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.scope && this.runtime) await this.runtime.runPromise(Scope.close(this.scope, Exit.void));
    } catch { /* closing anyway */ }
    try { await this.runtime?.dispose(); } catch { /* closing anyway */ }
  }
}
