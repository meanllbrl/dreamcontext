/**
 * One chat session on a T3 provider adapter (plan r5 §3), with plain async edges.
 *
 * This is the only module that runs Effect: it builds the runtime the vendored adapter needs,
 * opens T3's `CodexAdapterV2` session, and turns our chat verbs (send, steer, interrupt, answer,
 * new thread, mode, model) into adapter calls. Every adapter event goes through `ToWire` and out
 * as Claude stream-json frames through `emit`.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {
  ClaudeSettings,
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
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
import { materializeCodexShadowHome, resolveCodexHomeLayout } from '@t3tools/server/provider/Drivers/CodexHomeLayout';
import type * as ServerConfig from '@t3tools/server/config';
import * as Crypto from 'effect/Crypto';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as References from 'effect/References';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Schema from 'effect/Schema';
import * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import { bypassNeedsOwner, claudeRuntimePolicy, codexRuntimePolicy, instanceRuntimePolicy, type CodexRuntimePolicy } from './policy.js';
import { ANTIGRAVITY_DEFAULT_MODEL } from '@t3tools/contracts';
import { pictureAttachments } from './pictures.js';
import { antigravityInstanceId } from '../antigravity-accounts.js';
import { isInstanceTool, type InstanceTool } from '../instance-accounts.js';
import { ToWire, type WireFrame } from './to-wire.js';
import { wordsWithContext } from './context.js';
import type { AcpMcpServer } from './launch.js';
import type { ClaudeKit } from './claude-kit.js';
import type { ClaudeAgentSdkQueryRunner } from '@t3tools/server/orchestration-v2/Adapters/ClaudeAdapterV2';

export type ClientFactory = CodexAdapterV2.CodexAppServerClientFactoryShape;

export interface BridgeSessionOptions {
  /** `claude` = T3's Claude driver, only behind the Claude engine setting (plan r5 §5). */
  readonly tool: 'codex' | 'claude' | InstanceTool;
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
  /** A non-#0 Codex account (plan r5 §4b): `homePath ~/.codex` + its private `shadowHomePath`.
   *  Absent = account #0, `~/.codex` itself. */
  readonly codexHome?: { readonly homePath: string; readonly shadowHomePath: string };
  /** The account of a tool whose accounts are T3 instances. Absent = #0. */
  readonly accountId?: string;
  /** Stdio servers for an ACP session (the brain); Codex's come on `launchArgs`. */
  readonly mcpServers?: readonly AcpMcpServer[];
  /** The bridge is being ended: a start under way stops here rather than at its limit. */
  readonly abortOpen?: AbortSignal;
  /** Nobody is watching: the file the gate hook touches, read before anything is allowed. */
  readonly gateBeat?: string;
  /** How long a start may take before it is refused. Default {@link OPEN_LIMIT_MS}. */
  readonly openLimitMs?: number;
  /** A live limit update from the account (T3 `onUsageLimits`): windows as T3 builds them. */
  readonly onUsageLimits?: (update: { readonly windows: ReadonlyArray<unknown>; readonly checkedAt: string }) => void;
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
  /** T3's Claude driver (`tool: 'claude'`): only the Claude engine's own bundle holds it. */
  readonly claudeKit?: ClaudeKit;
  /** Tests inject T3's replay client here; production spawns `codex app-server`. */
  readonly clientFactory?: ClientFactory;
  /** Folders Codex lists skills from, beside its own (codex-skills.ts): set once, right after `initialized`. */
  readonly skillRoots?: readonly string[];
  readonly emit: (frame: WireFrame) => void;
  /** A sub-agent's step, for its card's drill-in (subagent-log.ts). */
  readonly onSidechain?: (taskId: string, frame: WireFrame) => void;
  /** The tool started compacting this thread. */
  readonly onCompacting?: () => void;
  /** A frame that is not chat output (bridge diagnostics) — never anything secret. */
  readonly log?: (line: string) => void;
}

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const TOOL_LABEL: Record<BridgeSessionOptions['tool'], string> = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity' };
export const toolLabel = (tool: BridgeSessionOptions['tool']): string => TOOL_LABEL[tool];

/** The agent's own question before it loads a project's `.agents/hooks.json`. */
const WORKSPACE_TRUST_QUESTION = /trust the authors of this workspace/i;

/** A start the tool never finished: a dead sign-in or a stuck process answers nothing at all. */
export const OPEN_LIMIT_MS = 120_000;
const CLOSE_LIMIT_MS = 5_000;

/** The tool neither started nor refused in time. Its message is what the owner reads. */
export class BridgeOpenTimeout extends Error {
  constructor(tool: BridgeSessionOptions['tool'], ms: number) {
    const label = toolLabel(tool);
    super(`${label} did not answer within ${Math.round(ms / 1000)} seconds, so this chat was stopped. If its sign-in has expired, sign in again from the model picker, then open this chat again.`);
  }
}

function hasToolUse(frame: WireFrame): boolean {
  if (frame.type !== 'assistant') return false;
  const content = (frame.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) && content.some((b) => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use');
}

function hiddenText(frame: WireFrame): string {
  const content = (frame.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('');
}

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
/** The Codex settings for one account, as `createCodexAdapterV2` derives them: a shadow home is
 *  laid out (T3's `materializeCodexShadowHome`) and becomes the home Codex runs with. */
const codexAccountSettings = (settings: typeof CodexSettings.Type) => Effect.gen(function* () {
  const layout = yield* resolveCodexHomeLayout(settings);
  yield* materializeCodexShadowHome(layout);
  return { ...settings, homePath: layout.effectiveHomePath ?? '' } as typeof CodexSettings.Type;
});

type InstanceKit = typeof import('./instances.js');

/**
 * The factory's client, plus our skill folders: `skills/extraRoots/set` rides the moment the
 * adapter says `initialized` (the app-server refuses it before), so the first thread already
 * lists them. The roots live only as long as this app-server; a refusal (or no answer in 5 s)
 * leaves Codex's own list and the chat opens anyway.
 */
export function withSkillRoots(inner: ClientFactory, roots: readonly string[]): ClientFactory {
  if (!roots.length) return inner;
  return {
    open: (input) => Effect.map(inner.open(input), (client) => ({
      ...client,
      notify: ((method: string, payload: unknown) => (client.notify as (m: string, p: unknown) => Effect.Effect<void, unknown>)(method, payload).pipe(
        Effect.tap(() => (method === 'initialized'
          ? client.request('skills/extraRoots/set', { extraRoots: [...roots] }).pipe(Effect.timeout('5 seconds'), Effect.ignore)
          : Effect.void)),
      )) as typeof client.notify,
    })),
  };
}

function bridgeLayer(clientFactory: ClientFactory | undefined, kit: ClaudeKit | undefined, instance?: { kit: InstanceKit; config: ServerConfig.ServerConfig['Service'] }, skillRoots: readonly string[] = []) {
  const base = Layer.mergeAll(
    NodeServices.layer,
    IdAllocator.layer,
    // `bridgeServerConfig` says Error, and stdout is the stream-json channel: T3's warnings stay off it.
    Layer.succeed(References.MinimumLogLevel, 'Error'),
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, ProviderEventLoggers.NoOpProviderEventLoggers),
  );
  const inner = clientFactory
    ? Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, CodexAdapterV2.CodexAppServerClientFactory.of(clientFactory))
    : CodexAdapterV2.layerAppServerClientFactory.pipe(Layer.provide(base));
  const factory = skillRoots.length
    ? Layer.effect(CodexAdapterV2.CodexAppServerClientFactory, Effect.gen(function* () {
      const f = yield* CodexAdapterV2.CodexAppServerClientFactory;
      return CodexAdapterV2.CodexAppServerClientFactory.of(withSkillRoots(f, skillRoots));
    })).pipe(Layer.provide(inner))
    : inner;
  const layer = Layer.mergeAll(base, McpProviderSessions.layer, factory);
  if (instance) return Layer.mergeAll(layer, instance.kit.instanceLayer(instance.config).pipe(Layer.provide(base)));
  return kit ? Layer.merge(layer, kit.layerRunner.pipe(Layer.provide(Layer.merge(base, kit.layerPorts)))) : layer;
}

type Runtime = ManagedRuntime.ManagedRuntime<
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | CodexAdapterV2.CodexAppServerClientFactory
  | ClaudeAgentSdkQueryRunner
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path,
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
  /** Requests answered for Bypass: their cancel frames are nobody's to read. */
  private readonly bypassAnswered = new Set<string>();
  /** The native thread already has a turn on disk. The run counter is per process, so it cannot
   *  say this for a reopened pane or a fresh thread; T3's Claude driver picks resume by it. */
  private nativeHasTurns = false;
  /** A hidden turn (the tab-title follow-up): its frames are read here, never emitted. */
  private hidden: { text: string; finished: Promise<void>; finish: () => void; stopping: boolean } | null = null;
  /** T3's attachment folder: a picture the owner sent is copied here and named on the turn. */
  private attachmentsDir = '';

  private constructor(opts: BridgeSessionOptions) {
    this.opts = opts;
    this.mode = opts.mode;
    this.model = opts.model;
    this.effort = opts.effort ?? '';
    this.wire = new ToWire({ tool: opts.tool, model: opts.model, cwd: opts.cwd, permissionMode: opts.mode, threadId: opts.paneId, ...(opts.onSidechain ? { onSidechain: opts.onSidechain } : {}), ...(opts.onCompacting ? { onCompacting: opts.onCompacting } : {}) });
  }

  static async open(opts: BridgeSessionOptions): Promise<BridgeSession> {
    const s = new BridgeSession(opts);
    const ms = opts.openLimitMs ?? OPEN_LIMIT_MS;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BridgeOpenTimeout(opts.tool, ms)), ms);
      opts.abortOpen?.addEventListener('abort', () => reject(new Error('the chat was closed')), { once: true });
    });
    try {
      await Promise.race([s.start(), limit]);
      return s;
    } catch (err) {
      // Bounded too: closing asks the same process that did not answer.
      let closeTimer: NodeJS.Timeout | undefined;
      await Promise.race([s.close(), new Promise((r) => { closeTimer = setTimeout(r, CLOSE_LIMIT_MS); })]);
      clearTimeout(closeTimer);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private get threadId(): ThreadId {
    return ThreadId.make(this.opts.paneId);
  }

  private get instanceId() {
    if (isInstanceTool(this.opts.tool)) return ProviderInstanceId.make(antigravityInstanceId(this.opts.accountId ?? ''));
    return this.opts.claudeKit?.instanceId ?? CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID;
  }

  private get driver() {
    if (isInstanceTool(this.opts.tool)) return ProviderDriverKind.make(this.opts.tool);
    return this.opts.claudeKit?.driver ?? CodexAdapterV2.CODEX_DRIVER_KIND;
  }

  private modelSelection(): ModelSelection {
    // These tools name their reasoning in the model id; an empty model is the tool's own default.
    if (isInstanceTool(this.opts.tool)) return { instanceId: this.instanceId, model: this.model || ANTIGRAVITY_DEFAULT_MODEL } as ModelSelection;
    return {
      instanceId: this.instanceId,
      model: this.model,
      ...(this.effort ? { options: [{ id: this.opts.tool === 'claude' ? 'effort' : 'reasoningEffort', value: this.effort }] } : {}),
    } as ModelSelection;
  }

  policy(): CodexRuntimePolicy {
    if (this.opts.runtimePolicyOverride) return this.opts.runtimePolicyOverride;
    if (this.opts.tool === 'claude') return claudeRuntimePolicy({ mode: this.mode, cwd: this.opts.cwd });
    if (isInstanceTool(this.opts.tool)) return instanceRuntimePolicy({ mode: this.mode, cwd: this.opts.cwd });
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
    const serverConfig = bridgeServerConfig(opts.stateRoot, opts.cwd);
    this.attachmentsDir = serverConfig.attachmentsDir;
    // Loaded only for these tools: their driver reaches `node:sqlite`, which a Codex pane never needs.
    const instanceKit = isInstanceTool(opts.tool) ? await import('./instances.js') : null;
    this.runtime = ManagedRuntime.make(bridgeLayer(opts.clientFactory, opts.claudeKit, instanceKit ? { kit: instanceKit, config: serverConfig } : undefined, opts.tool === 'codex' ? opts.skillRoots : [])) as unknown as Runtime;
    const scope = await this.runtime.runPromise(Scope.make());
    this.scope = scope;
    const settingsInput = {
      enabled: true,
      ...(opts.binaryPath ? { binaryPath: opts.binaryPath } : {}),
      ...(opts.launchArgs ? { launchArgs: opts.launchArgs } : {}),
      ...(opts.codexHome && opts.tool === 'codex' ? { homePath: opts.codexHome.homePath, shadowHomePath: opts.codexHome.shadowHomePath } : {}),
    };
    const onUsageLimits = opts.onUsageLimits;
    const threadId = this.threadId;
    const runtimePolicy = this.runtimePolicy();
    const modelSelection = this.modelSelection();
    const resumeNative = opts.resumeNativeThreadId;
    const providerSessionId = ProviderSessionId.make(`dc-${opts.paneId}`);
    const open = Effect.gen(function* () {
      const kit = opts.tool === 'claude' ? opts.claudeKit : undefined;
      const adapter = instanceKit ? (yield* instanceKit.createInstance({
        tool: opts.tool as InstanceTool,
        accountId: opts.accountId ?? '',
        ...(opts.binaryPath ? { binaryPath: opts.binaryPath } : {}),
        ...(opts.mcpServers?.length ? { mcpServers: opts.mcpServers } : {}),
      })).orchestrationAdapter : kit ? yield* kit.make({
        instanceId: kit.instanceId,
        settings: decodeClaudeSettings(settingsInput),
        environment: opts.env,
        attachmentsDir: serverConfig.attachmentsDir,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: yield* kit.Runner,
      }) : yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        // What T3's `createCodexAdapterV2` does before it builds the adapter: lay the account's
        // shadow home out (authOverlay) and run Codex with CODEX_HOME = that home.
        settings: yield* codexAccountSettings(decodeCodexSettings(settingsInput)),
        ...(onUsageLimits ? { onUsageLimits: (u: { windows: ReadonlyArray<unknown>; checkedAt: string }) => Effect.sync(() => onUsageLimits(u)) } : {}),
        environment: opts.env,
        clientFactory: yield* CodexAdapterV2.CodexAppServerClientFactory,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig,
      });
      return yield* adapter.openSession({ threadId, providerSessionId, modelSelection, runtimePolicy });
    }).pipe(Effect.provideService(Scope.Scope, scope)) as Effect.Effect<ProviderAdapter.ProviderAdapterV2SessionRuntime, unknown, never>;
    this.session = await this.runtime.runPromise(open);
    const session = this.session;
    // Every adapter event, translated and printed, for the life of the session.
    this.runtime.runFork(
      Stream.runForEach(session.events, (event) => Effect.sync(() => this.onEvent(event))).pipe(
        Effect.catchCause((cause) => Effect.sync(() => this.opts.log?.(`t3 event stream ended: ${String(cause).slice(0, 300)}`))),
        // Ended while open = Codex is gone: close the open turn loudly, then end the bridge.
        Effect.ensuring(Effect.sync(() => { if (!this.closed) this.fatal(`${toolLabel(this.opts.tool)} stopped running.`); })),
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
    this.wire.providerThreadId = this.providerThread.id;
    this.nativeHasTurns = !!resumeNative;
  }

  /** A provider thread record for a native Codex thread we hold only by id (a reopened pane). */
  private providerThreadFor(nativeId: string, providerSessionId: ProviderSessionId): OrchestrationV2ProviderThread {
    const now = DateTime.makeUnsafe(Date.now());
    return {
      id: IdAllocator.derive.providerThread({ driver: this.driver, nativeThreadId: nativeId }),
      driver: this.driver,
      providerInstanceId: this.instanceId,
      providerSessionId,
      appThreadId: this.threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver: this.driver, nativeId, strength: 'strong' },
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
    if (this.hidden) {
      this.activeRun = null;
      this.turnKnown?.resolve();
      this.endHidden();
    } else if (this.activeRun) {
      this.opts.emit({
        type: 'result', subtype: 'error_during_execution', is_error: true, result: message,
        num_turns: 0, total_cost_usd: 0, usage: {}, session_id: this.wire.sessionId, dc_tool: this.opts.tool,
      });
      this.activeRun = null;
      this.turnKnown?.resolve();
    }
    this.opts.onFatal?.(message);
  }

  /**
   * Opt-in event trace (`DREAMCONTEXT_T3_EVENTS=<file>`): which thread each event is on and what
   * kind it is, never its text. How a tool's sub-agent steps are told apart was read off this.
   */
  private traceEvent(event: ProviderAdapter.ProviderAdapterV2Event): void {
    const file = this.opts.env?.DREAMCONTEXT_T3_EVENTS;
    if (!file) return;
    const e = event as unknown as Record<string, any>;
    const item = e.turnItem;
    const row = {
      t: e.type,
      ...(item ? { thread: item.threadId, item: item.type, id: String(item.id).slice(-40), status: item.status, parent: item.parentItemId ?? undefined, child: item.childThreadId ?? undefined, ptid: item.providerThreadId } : {}),
      ...(e.threadId ? { thread: e.threadId } : {}),
      ...(e.providerThread ? { app: e.providerThread.appThreadId, pt: e.providerThread.id } : {}),
      ...(e.providerThreadId ? { pt: e.providerThreadId } : {}),
      ...(e.subagent ? { sub: e.subagent.id, child: e.subagent.childThreadId, status: e.subagent.status, prompt: (e.subagent.prompt ?? '').length } : {}),
      ...(e.providerTurn ? { turn: e.providerTurn.status } : {}),
      ...(e.status && !item ? { status: e.status } : {}),
    };
    try { appendFileSync(file, JSON.stringify(row) + '\n'); } catch { /* best effort */ }
  }

  /** Wait (bounded) until the active run has its provider turn id. */
  private async awaitTurnId(ms = 15_000): Promise<void> {
    if (!this.activeRun || this.activeRun.providerTurnId || !this.turnKnown) return;
    await Promise.race([this.turnKnown.promise, new Promise((r) => setTimeout(r, ms))]);
  }

  private onEvent(event: ProviderAdapter.ProviderAdapterV2Event): void {
    this.traceEvent(event);
    // A sub-agent's turn (its own thread) is never the run a Stop or a steer is for.
    const childTurn = event.type === 'provider_turn.updated' && !!event.threadId && event.threadId !== this.threadId;
    if (event.type === 'provider_turn.updated' && !childTurn && this.activeRun && event.providerTurn.status === 'running') {
      this.activeRun.providerTurnId = event.providerTurn.id;
      this.turnKnown?.resolve();
    }
    if (event.type === 'provider_thread.updated' && this.providerThread && event.providerThread.id === this.providerThread.id) {
      this.providerThread = event.providerThread;
    }
    for (const frame of this.wire.translate(event)) {
      if (this.answeredForBypass(frame)) continue;
      if (!this.hidden) { this.opts.emit(frame); continue; }
      if (frame.type === 'assistant') this.hidden.text += hiddenText(frame);
      // It was told to run no tools: an approval card, or any tool at all, ends it, out of sight.
      if ((frame.type === 'control_request' || hasToolUse(frame)) && !this.hidden.stopping) {
        this.hidden.stopping = true;
        void this.interrupt().catch(() => undefined);
      }
    }
    if (event.type === 'turn.terminal' && (!this.providerThread || event.providerThreadId === this.providerThread.id)) {
      if (event.status === 'completed') this.nativeHasTurns = true;
      this.activeRun = null;
      this.turnKnown?.resolve();
      this.endHidden();
    }
  }

  /**
   * Bypass on a tool whose agent always asks: the bridge says yes, so the mode is read at every
   * request and turning Bypass off holds from the next one. The gated writes still reach the owner.
   */
  private answeredForBypass(frame: WireFrame): boolean {
    if (!isInstanceTool(this.opts.tool)) return false;
    const id = typeof frame.request_id === 'string' ? frame.request_id : '';
    if (frame.type === 'control_cancel_request') return this.bypassAnswered.delete(id);
    if (frame.type !== 'control_request' || !id) return false;
    const req = frame.request as { subtype?: unknown; tool_name?: unknown; input?: unknown } | undefined;
    if (this.opts.gateBeat !== undefined && req?.subtype === 'can_use_tool') return this.answeredUnattended(id, req);
    if (this.mode !== 'bypassPermissions') return false;
    if (req?.subtype !== 'can_use_tool' || req.tool_name === 'AskUserQuestion') return false;
    if (bypassNeedsOwner(String(req.tool_name), req.input, this.opts.cwd)) return false;
    this.bypassAnswered.add(id);
    void this.answer(id, { behavior: 'allow' }).catch((err) => this.opts.log?.(`bypass answer failed: ${String(err).slice(0, 200)}`));
    return true;
  }

  /**
   * A Super child: no card waits for anybody. A real question goes to the Super Agent's queue like
   * any child's. The agent's question about a project's own hooks is answered no: they stay off.
   * Anything else needs proof the gate ran for this session, and what the gate leaves to the owner
   * is refused here, since there is no owner.
   */
  private answeredUnattended(id: string, req: { tool_name?: unknown; input?: unknown }): boolean {
    const deny = (message: string): boolean => {
      this.bypassAnswered.add(id);
      void this.answer(id, { behavior: 'deny', message }).catch((err) => this.opts.log?.(`child answer failed: ${String(err).slice(0, 200)}`));
      return true;
    };
    if (req.tool_name === 'AskUserQuestion') return WORKSPACE_TRUST_QUESTION.test(JSON.stringify(req.input ?? {})) ? deny('Not in an unattended run.') : false;
    if (!existsSync(this.opts.gateBeat!)) {
      deny('The write gate did not run.');
      this.fatal(`${toolLabel(this.opts.tool)} stopped: its write gate did not run, so this child must not go on.`);
      return true;
    }
    if (bypassNeedsOwner(String(req.tool_name), req.input, this.opts.cwd)) return deny('This needs the owner, and this run has no owner watching. Leave it, and say so in your report.');
    this.bypassAnswered.add(id);
    void this.answer(id, { behavior: 'allow' }).catch((err) => this.opts.log?.(`child answer failed: ${String(err).slice(0, 200)}`));
    return true;
  }

  /** The hidden turn is really over: frames from here on are the owner's. */
  private endHidden(): void {
    const hidden = this.hidden;
    this.hidden = null;
    hidden?.finish();
  }

  private appThread(now: DateTime.Utc): OrchestrationV2AppThread {
    const id = this.threadId;
    return {
      createdBy: 'user',
      creationSource: 'web',
      id,
      projectId: ProjectId.make(`project-${id}`),
      title: 'dreamcontext chat',
      providerInstanceId: this.instanceId,
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

  /** Is a turn the owner can see running? A hidden one is not: nothing waits on its `result`. */
  get busy(): boolean {
    return this.activeRun !== null && !this.hidden;
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
    // A hidden turn that would not stop: this message must not steer into it, unseen.
    const hidden = this.hidden;
    if (hidden) await Promise.race([hidden.finished, new Promise((r) => setTimeout(r, 10_000))]);
    if (this.hidden) {
      for (const frame of this.wire.beginTurn()) this.opts.emit(frame);
      this.opts.emit({
        type: 'result', subtype: 'error_during_execution', is_error: true, result: `${toolLabel(this.opts.tool)} is still finishing. Send that again in a moment.`,
        num_turns: 0, total_cost_usd: 0, usage: {}, session_id: this.wire.sessionId, dc_tool: this.opts.tool,
      });
      return;
    }
    // Only Codex's adapter reads `appContext`, as untrusted entries. Everywhere else it rides after
    // the owner's words, in the user message (context.ts `wordsWithContext`).
    // Pictures are read from the owner's own words, never from context merged in after them.
    const message = this.turnMessage(this.opts.tool !== 'codex' ? wordsWithContext(text, appContext) : text, text);
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
    for (const frame of this.wire.beginTurn()) this.opts.emit(frame);
    const failure = await this.startRun(message, appContext);
    if (failure) {
      this.opts.emit({
        type: 'result', subtype: 'error_during_execution', is_error: true,
        result: `${toolLabel(this.opts.tool)} could not start the turn: ${failure}`,
        num_turns: 0, total_cost_usd: 0, usage: {}, session_id: this.wire.sessionId, dc_tool: this.opts.tool,
      });
    }
  }

  private turnMessage(text: string, ownerWords: string = text): ProviderAdapter.ProviderAdapterV2TurnMessage {
    return {
      messageId: MessageId.make(`msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
      text,
      // The owner's pictures (`[Picture N: path]` lines) as images the tool sees (TABLO row 12).
      attachments: this.attachmentsDir ? pictureAttachments(ownerWords, this.opts.cwd, this.attachmentsDir) : [],
      createdBy: 'user' as const,
      creationSource: 'web' as const,
    } as ProviderAdapter.ProviderAdapterV2TurnMessage;
  }

  /** Start a turn. Resolves with why it could not start, or null. */
  private async startRun(
    message: ProviderAdapter.ProviderAdapterV2TurnMessage,
    appContext: ReadonlyArray<{ key: string; text: string }>,
    op: 'startTurn' | 'compactThread' = 'startTurn',
  ): Promise<string | null> {
    const session = this.session!;
    const providerThread = this.providerThread!;
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.runOrdinal += 1;
    const runId = RunId.make(`run-${stamp}`);
    this.activeRun = { runId, providerTurnId: null };
    let resolveKnown = (): void => undefined;
    this.turnKnown = { promise: new Promise<void>((r) => { resolveKnown = r; }), resolve: () => resolveKnown() };
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
      nativeThreadHasTurns: this.nativeHasTurns,
      ...(appContext.length ? { appContext } : {}),
    };
    const run = op === 'compactThread' && session.compactThread ? session.compactThread(input) : session.startTurn(input);
    const exit = await this.runtime!.runPromiseExit(run);
    if (Exit.isFailure(exit)) {
      this.activeRun = null;
      this.turnKnown?.resolve();
      return String(exit.cause).slice(0, 400);
    }
    return null;
  }

  /** Can this tool compact a thread when asked (`/compact`)? Codex can; ACP has no such verb. */
  get canCompact(): boolean {
    return !!this.session?.compactThread && !isInstanceTool(this.opts.tool);
  }

  /** `/compact`: the tool's own compaction, as a turn the pane sees start and end. */
  async compact(): Promise<void> {
    if (!this.session || !this.providerThread || this.closed || this.activeRun) return;
    for (const frame of this.wire.beginTurn()) this.opts.emit(frame);
    const failure = await this.startRun(this.turnMessage('/compact'), [], 'compactThread');
    if (failure) {
      this.opts.emit({
        type: 'result', subtype: 'error_during_execution', is_error: true,
        result: `${toolLabel(this.opts.tool)} could not compact: ${failure}`,
        num_turns: 0, total_cost_usd: 0, usage: {}, session_id: this.wire.sessionId, dc_tool: this.opts.tool,
      });
    }
  }

  /**
   * How many tools each named server shows in the tool's live session (Codex: its app-server's own
   * server status). null = the session could not say; a tool with no such channel gives an empty map.
   */
  async mcpToolCounts(names: readonly string[], ms = 5_000): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    const apps = this.session?.mcpApps;
    const thread = this.providerThread;
    if (!apps || !thread || this.closed) return out;
    for (const server of names) {
      const ask = this.run(apps.listTools({ providerThread: thread, server })).then((tools) => tools.length);
      const late = new Promise<null>((r) => { setTimeout(() => r(null), ms).unref(); });
      out.set(server, await Promise.race([ask, late]).catch(() => null));
    }
    return out;
  }

  /** Stop one sub-agent (the card's `stop_task`). False = the tool cannot, or no such card. */
  async stopSubagent(taskId: string): Promise<boolean> {
    const session = this.session;
    const native = this.wire.nativeTaskIdFor(taskId);
    if (!session?.stopSubagent || !this.providerThread || !native) return false;
    await this.run(session.stopSubagent({ providerThread: this.providerThread, nativeTaskId: native }));
    return true;
  }

  /**
   * One turn nobody sees: what it wrote comes back, none of its frames go out. Only from idle.
   * Told to stop after `ms`. One that still has not ended 20 s later means the tool is stuck:
   * the session ends like any dead tool, and the pane offers Resume.
   */
  async hiddenTurn(text: string, ms = 45_000): Promise<string> {
    if (this.closed || this.activeRun || this.hidden || !this.session || !this.providerThread) return '';
    let finish = (): void => undefined;
    const finished = new Promise<void>((r) => { finish = r; });
    const hidden = { text: '', finished, finish, stopping: false };
    this.hidden = hidden;
    const timer = setTimeout(() => { void this.cancelHidden(); }, ms);
    const deadline = setTimeout(() => { if (this.hidden === hidden) this.fatal(`${toolLabel(this.opts.tool)} stopped responding.`); }, ms + 20_000);
    try {
      const failure = await this.startRun(this.turnMessage(text), []);
      if (failure) this.endHidden();
      else await finished;
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
    }
    return hidden.text;
  }

  /**
   * The owner came back first: a hidden turn gives way, waiting at most 5 s. One that has not
   * ended by then STAYS hidden until its own terminal: clearing it early would draw its frames
   * and let its `result` close the owner's turn on the server's books.
   */
  async cancelHidden(): Promise<void> {
    const hidden = this.hidden;
    if (!hidden) return;
    hidden.stopping = true;
    await Promise.race([
      this.interrupt().catch(() => undefined).then(() => hidden.finished),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
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
    this.wire.providerThreadId = this.providerThread.id;
    this.nativeHasTurns = false;
    this.wire.resetContext();
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
    this.hidden?.finish();
    try {
      if (this.scope && this.runtime) await this.runtime.runPromise(Scope.close(this.scope, Exit.void));
    } catch { /* closing anyway */ }
    try { await this.runtime?.dispose(); } catch { /* closing anyway */ }
  }
}
