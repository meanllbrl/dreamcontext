/**
 * The bridge child's stdio loop: `dreamcontext t3-chat` reads the stream-json frames our chat
 * server writes to a `claude` child and drives a BridgeSession; it prints Claude stream-json back.
 *
 * Input frames handled (exactly what agent-chat.ts writes to its child):
 *   - `user`                    → a turn, or a steer when one is running; `/clear` alone rotates
 *                                 into a fresh thread (Eco handoff, plan §4d)
 *   - `control_response`        → the owner's answer to an approval or question card
 *   - `control_request` interrupt / set_model / set_permission_mode → done, then acked
 *   - control_request stop_task → one sub-agent stopped when the tool can (Codex), else an error
 *   - control_request mcp_status → the servers the session holds, answered beside the queue
 *   - any other control_request → acked with an error (rewind, MCP: not on this tool yet)
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexChildEnv, codexCommand } from '../codex-bin.js';
import { BridgeOpenTimeout, BridgeSession, toolLabel, type BridgeSessionOptions } from './session.js';
import { syncAntigravitySkills } from '../antigravity-skills.js';
import { syncAntigravityRoles } from '../antigravity-roles.js';
import { findPackageDir } from '../catalog.js';
import { codexRoleArgs, prepareCodexKit, type CodexKit, type CodexKitOptions } from '../codex-skills.js';
import { toolNote, toolText } from '../tool-text.js';
import { GATE_BEAT_ENV, syncAntigravityGate } from '../antigravity-gate.js';
import { checkAcpServers } from '../antigravity-mcp.js';
import { INSTANCE_PRIMARY_ID, isInstanceAccountId, isInstanceTool } from '../instance-accounts.js';
import { carriedText, recordThreadTurn } from './instance-threads.js';
import { antigravityFailureKind } from './to-wire.js';
import { MAX_DEVELOPER_INSTRUCTIONS, acpBrainMcpServer, acpLeanMcpServers, acpStoreServers, claudeLaunchArgs, codexBrainMcpArgs, codexLaunchArgs, codexLeanMcpArgs, codexStrictArgs, leanMcpNames, parseCodexMcpList, scrubbedCodexEnv } from './launch.js';
import { codexInstanceSettings, isCodexAccountId } from './accounts.js';
import { HIDDEN_TITLE_PROMPT, TabTitler, titleBlock, titleIn } from './tab-title.js';
import type { WireFrame } from './to-wire.js';
import { fitCodexContext, type BrainContext } from './context.js';
import { appendSubagentStep } from './subagent-log.js';
import { isInjectedUserText } from './codex-history.js';
import { isCardFeedbackText } from '../chat-view-spec.js';
import { expandSlash, slashCommandNames } from './slash.js';
import { codexStorePlan, planLaunchArgs } from '../codex-mcp.js';

export type AppContext = { key: string; text: string };

export interface StdioArgs {
  readonly tool: BridgeSessionOptions['tool'];
  readonly cwd: string;
  readonly model: string;
  readonly effort?: string;
  readonly mode: string;
  readonly paneId: string;
  readonly resume?: string;
  readonly briefingFile?: string;
  readonly extraRoots?: readonly string[];
  readonly binaryPath?: string;
  /** A non-#0 Codex account id (plan r5 §4b). Absent = account #0, `~/.codex`. */
  readonly account?: string;
  /** An earlier thread whose end this fresh thread carries (a move to another account). */
  readonly carry?: string;
  /** A Super child's lean MCP subset (launch.ts `codexLeanMcpArgs`). */
  readonly mcpConfig?: string;
  /** Nothing from the owner's Codex config: no MCP servers, no web search (`codexStrictArgs`). */
  readonly strictMcp?: boolean;
  /** The owner's MCP servers from the app's stores: a chat's, as Claude gets `--mcp-config`. */
  readonly storeMcp?: boolean;
  /** Nobody is watching (a Super child on a tool with no sandbox): no card, and no gate no run. */
  readonly unattended?: boolean;
}

export interface StdioDeps {
  readonly input: NodeJS.ReadableStream;
  readonly write: (line: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly home?: string;
  /** T3's Claude driver: only the Claude engine's child has it (claude-kit.ts). */
  readonly claudeKit?: BridgeSessionOptions['claudeKit'];
  /** Tests: a replay client instead of `codex app-server`. */
  readonly clientFactory?: BridgeSessionOptions['clientFactory'];
  readonly runtimePolicyOverride?: BridgeSessionOptions['runtimePolicyOverride'];
  /** Tests: what a Codex chat reads (skills, roles); production lays it out under ~/.dreamcontext/codex. */
  readonly codexKit?: (o: CodexKitOptions) => CodexKit;
  /** Tests: stands in for `codex mcp list --json`. */
  readonly listMcp?: () => string[] | null;
  /** Called by `/clear` after the fresh thread opened (consumes the handoff record). What it
   *  returns rides the NEXT turn as untrusted app context (the handoff banner). */
  readonly onRotated?: (nativeThreadId: string) => AppContext[] | void;
  /** The real child (main.ts): end the session on SIGTERM/SIGINT. Never in tests. */
  readonly handleSignals?: boolean;
  /** Tests: stands in for asking each tool server. */
  readonly checkServers?: typeof checkAcpServers;
  /** Called once the session holds its thread (records pane → thread for resume). */
  readonly onReady?: (nativeThreadId: string) => void;
  /** Does this pane's tab still want a name from its agent? Absent = never (tests, headless). */
  readonly tabWantsTitle?: () => boolean;
  /** Called on every `result` (Eco measurement). What it returns rides the next turn. */
  readonly onResult?: (session: BridgeSession, frame: WireFrame) => AppContext[] | void;
  /** Tests: a start that never answers is refused sooner. */
  readonly openLimitMs?: number;
  /** The brain (context.ts): the snapshot at session start and after `/clear`, the prompt hook on
   *  every owner turn. Absent = no brain (tests, the T3 Claude engine). */
  readonly brain?: Pick<BrainContext, 'session' | 'prompt' | 'drain'> & Partial<Pick<BrainContext, 'takeNotice' | 'edited' | 'onStopBlock' | 'compacting'>>;
  /** The thread's transcript on disk (Codex's rollout, Antigravity's conversation), for the hooks. */
  readonly transcriptFor?: (nativeThreadId: string) => string | null;
}

const userText = (frame: Record<string, unknown>): string => {
  const msg = frame.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b) => b.text)
    .join('');
};

/** Every message down an error's causes: T3 wraps the one that says why. */
function causeChain(err: unknown): string[] {
  const out: string[] = [];
  let at: unknown = err;
  for (let i = 0; i < 8 && at; i++) {
    out.push(String((at as { detail?: unknown }).detail ?? (at as { message?: unknown }).message ?? at));
    at = (at as { cause?: unknown }).cause;
  }
  return out;
}

/** T3's own typed answer, anywhere down the causes. */
function requiresSignIn(err: unknown): boolean {
  let at: unknown = err;
  for (let i = 0; i < 8 && at; i++) {
    if ((at as { requiresSignIn?: unknown }).requiresSignIn === true) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

const CLOSE_LIMIT_MS = 5_000;
const MCP_LIST_LIMIT_MS = 15_000;

/** Run until stdin ends. Resolves with the exit code. */
/** How long a Stop's ack waits for the agent before it goes out anyway (the server kills at 5 s). */
const ACK_STOP_MS = 1_000;

/** The MCP status ask, which is answered beside the frame queue. */
function isMcpStatusAsk(obj: object): obj is Record<string, unknown> {
  const frame = obj as { type?: unknown; request?: unknown };
  return frame.type === 'control_request' && !!frame.request && typeof frame.request === 'object' && (frame.request as { subtype?: unknown }).subtype === 'mcp_status';
}

export async function runBridgeStdio(args: StdioArgs, deps: StdioDeps): Promise<number> {
  const home = deps.home ?? homedir();
  // Codex by absolute path, with a PATH its launcher's `env node` resolves on: what the readiness
  // row promised is what starts. Test doubles (a replay client) start nothing, so resolve nothing.
  const realCodex = args.tool === 'codex' && !deps.clientFactory;
  const binaryPath = args.binaryPath ?? (realCodex ? codexCommand({ home }) : undefined);
  const childEnv = realCodex ? codexChildEnv(deps.env) : deps.env;
  // Opt-in frame trace for debugging a bridge pane (`DREAMCONTEXT_T3_DEBUG=<file>`): frame types
  // and subtypes only, never their text.
  const debugFile = deps.env.DREAMCONTEXT_T3_DEBUG;
  const trace = (dir: string, f: Record<string, unknown>): void => {
    if (!debugFile) return;
    const req = (f.request ?? f.response) as { subtype?: unknown; request_id?: unknown } | undefined;
    try { appendFileSync(debugFile, `${new Date().toISOString()} ${dir} ${String(f.type)}${f.subtype ? `/${String(f.subtype)}` : ''}${req?.subtype ? ` ${String(req.subtype)}` : ''}${req?.request_id ? ` ${String(req.request_id).slice(-12)}` : ''}\n`); } catch { /* best effort */ }
  };
  const keepsThread = isInstanceTool(args.tool);
  const titler = new TabTitler(deps.tabWantsTitle ?? (() => false));
  /** A turn just ended with the tab unnamed: ask once, out of sight, then send only the name. */
  const nameTab = async (): Promise<void> => {
    const title = titleIn(await session.hiddenTurn(HIDDEN_TITLE_PROMPT));
    // `<synthetic>`: a local reply, not a turn starting; the pane stays idle.
    if (title) emit({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: titleBlock(title) }] }, parent_tool_use_id: null, session_id: session.nativeThreadId });
  };
  const emit = (frame: WireFrame): void => {
    trace('out', frame);
    deps.write(JSON.stringify(frame) + '\n');
    // After the frame, on a later tick: the session clears its run only once this `result` is out.
    if (titler.observe(frame)) setImmediate(() => { nameTab().catch((err) => { trace('err', { type: String(err).slice(0, 200) }); }); });
  };
  // A private temp folder for this process: Codex's only writable temp (plan §6).
  const privateTmp = mkdtempSync(join(tmpdir(), 'dc-codex-'));
  /** App context owed to the next turn (a handoff banner, an Eco nudge). */
  const pending: AppContext[] = [];
  const owe = (ctx: AppContext[] | void): void => { if (ctx) pending.push(...ctx); };
  /** Local answers (an `/effort` sent mid-turn) owed AFTER the running turn's result: the server
   *  counts a turn per result, so answering early would close the running turn on its books. */
  const heldAnswers: WireFrame[] = [];
  /** Owner messages sent while an Antigravity turn ran: ACP cannot steer a running turn, so each
   *  waits for the turn's end and then goes in as the next turn (TABLO row 3). */
  const heldMessages: string[] = [];
  /** A local answer the pane reads as the agent's, keeping its books (`<synthetic>`). */
  const say = (text: string): void => emit({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session?.nativeThreadId ?? '' });
  /** A local reply to a command the server opened a turn for: its text, then a synthetic result. */
  const answerLocally = (text: string): void => {
    const answer: WireFrame[] = [
      { type: 'assistant', message: { role: 'assistant', model: args.model, content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session.nativeThreadId },
      { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, total_cost_usd: 0, usage: {}, session_id: session.nativeThreadId, dc_tool: args.tool, dc_synthetic: true },
    ];
    if (session.busy) heldAnswers.push(...answer);
    else for (const f of answer) emit(f);
  };
  /** Edit cards open in this turn (tool_use id → file): a clean result runs the edit checks (row 11). */
  const openEdits = new Map<string, string>();
  const noteEdit = (frame: WireFrame): void => {
    if (!deps.brain?.edited || frame.parent_tool_use_id) return;
    const content = (frame.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const b of content as Array<Record<string, any>>) {
      if (frame.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Edit' && typeof b.input?.file_path === 'string') openEdits.set(String(b.id), b.input.file_path);
      if (frame.type === 'user' && b?.type === 'tool_result' && openEdits.has(String(b.tool_use_id))) {
        const file = openEdits.get(String(b.tool_use_id))!;
        openEdits.delete(String(b.tool_use_id));
        if (b.is_error !== true) deps.brain.edited(session.nativeThreadId, file);
      }
    }
  };
  /** Codex died: stop reading stdin so the bridge exits (non-zero) and the pane shows it ended. */
  let endInput: (() => void) | null = null;
  /** A tool without Codex's app context: has this thread really had the snapshot? */
  let brainSent = false;
  let fatal = false;
  let session: BridgeSession;
  // The account this pane runs on: its private home and its file credential store.
  const account = args.tool === 'codex' && args.account && isCodexAccountId(args.account) ? codexInstanceSettings(home, args.account) : null;
  // A narrow surface hears from Codex which servers exist, and starts with none but its own.
  const listMcp = deps.listMcp ?? (() => {
    const r = spawnSync(binaryPath ?? (process.platform === 'win32' ? 'codex.cmd' : 'codex'), ['mcp', 'list', '--json'], { cwd: args.cwd, env: scrubbedCodexEnv(childEnv), encoding: 'utf-8', timeout: MCP_LIST_LIMIT_MS, shell: process.platform === 'win32' });
    return r.status === 0 ? parseCodexMcpList(r.stdout) : null;
  });
  const strictArgs = args.strictMcp && args.tool === 'codex'
    ? codexStrictArgs(
      listMcp(),
      [...(deps.brain ? ['dreamcontext'] : []), ...leanMcpNames(args.mcpConfig)],
    )
    : '';
  if (strictArgs === null) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Codex did not start: one of the MCP servers in its config could not be switched off for this run.', num_turns: 0, total_cost_usd: 0, usage: {}, dc_tool: args.tool });
    rmSync(privateTmp, { recursive: true, force: true });
    return 1;
  }
  const instanceAccount = isInstanceTool(args.tool) && args.account && isInstanceAccountId(args.account) ? args.account : null;
  // The skills go in the account's profile as a chat opens, so no project and no sign-in owes a step.
  const skills = isInstanceTool(args.tool) ? syncAntigravitySkills(instanceAccount ?? INSTANCE_PRIMARY_ID, { home }) : null;
  // Lane 2 seam: Claude's roles as the account's sub-agents (antigravity-roles.ts), same moment.
  if (isInstanceTool(args.tool)) syncAntigravityRoles(instanceAccount ?? INSTANCE_PRIMARY_ID, { home });
  // Codex: our skills, the project's and the owner's Claude skills, and Claude's agents as roles,
  // all under ~/.dreamcontext/codex, pointed at for this app-server only (codex-skills.ts).
  // A replay client (tests) answers only what it recorded: it gets the kit only when one is given.
  const kitOf = deps.codexKit ?? (deps.clientFactory ? null : prepareCodexKit);
  const codexKit = args.tool === 'codex' && kitOf ? kitOf({ home, cwd: args.cwd }) : null;
  const toolSkills = skills ?? codexKit?.skills ?? null;
  let skillsLoss = toolSkills && !toolSkills.ok ? `${toolLabel(args.tool)} is running without dreamcontext's skills: ${toolSkills.reason}.` : null;
  // The gate hook, the same way: per account profile, as a chat opens (antigravity-gate.ts).
  const gate = isInstanceTool(args.tool) ? syncAntigravityGate(instanceAccount ?? INSTANCE_PRIMARY_ID, { node: process.execPath, cli: deps.env.DREAMCONTEXT_CLI || process.argv[1] || '', home }) : null;
  if (gate && !gate.ok && args.unattended) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `${toolLabel(args.tool)} did not start: its write gate could not be set up (${gate.reason}).`, num_turns: 0, total_cost_usd: 0, usage: {}, dc_tool: args.tool });
    rmSync(privateTmp, { recursive: true, force: true });
    return 1;
  }
  // No gate, no Bypass: the owner's card stands in, and the owner hears why.
  const gateLoss = gate && !gate.ok ? `${toolLabel(args.tool)} is running without its write gate (${gate.reason}), so every action asks you, Bypass included.` : null;
  const startMode = gateLoss ? 'default' : args.mode;
  let gateNotice = gateLoss;
  const gateBeat = args.unattended ? join(privateTmp, 'gate-beat') : '';
  if (gateBeat) deps.env[GATE_BEAT_ENV] = gateBeat;
  // The agent inherits this: the hook knows it is one of ours, and keeps the heavy-step limit.
  if (isInstanceTool(args.tool)) deps.env.DREAMCONTEXT_CONTEXT_BY = 'bridge';
  const brainServer = isInstanceTool(args.tool) && deps.brain
    ? acpBrainMcpServer({ node: process.execPath, cli: deps.env.DREAMCONTEXT_CLI || process.argv[1] || '', root: args.cwd, tabSession: deps.env.DREAMCONTEXT_TAB_SESSION })
    : null;
  const storePlan = args.storeMcp && args.tool === 'codex' && !args.strictMcp
    ? codexStorePlan({ home, projectRoot: args.cwd, node: process.execPath, cli: deps.env.DREAMCONTEXT_CLI || process.argv[1] || '', listed: listMcp() })
    : null;
  const mcpNode = process.execPath;
  const mcpCli = deps.env.DREAMCONTEXT_CLI || process.argv[1] || '';
  // The owner's servers ride `session/new` as the brain does; a child gets its lean subset only.
  const askedServers = !isInstanceTool(args.tool) ? [] : [
    ...(args.storeMcp && !args.strictMcp ? acpStoreServers(codexStorePlan({ home, projectRoot: args.cwd, node: mcpNode, cli: mcpCli, listed: [] }).routes, { node: mcpNode, cli: mcpCli }) : []),
    ...(args.mcpConfig ? acpLeanMcpServers(args.mcpConfig, { node: mcpNode, cli: mcpCli }) : []),
  ];
  // One server that will not start refuses every turn of the session (antigravity-mcp.ts): each is
  // asked first, and one that does not answer stays out and the owner hears which.
  const checked = askedServers.length ? await (deps.checkServers ?? checkAcpServers)(askedServers, { env: deps.env }) : new Map<string, string>();
  const keptServers = askedServers.filter((s) => checked.get(s.name) === 'connected');
  const leftServers = askedServers.filter((s) => checked.get(s.name) !== 'connected').map((s) => s.name);
  let serversNotice = leftServers.length ? `${toolLabel(args.tool)} is running without ${leftServers.join(', ')}: ${leftServers.length > 1 ? 'they' : 'it'} did not answer, or asked for a sign-in this tool cannot do. Settings > Tool servers shows why.` : null;
  const instanceServers = [...(brainServer ? [brainServer] : []), ...keptServers];
  /**
   * The servers this chat was given, as the tool's session reports them. Antigravity: the brain and
   * what the check before `session/new` found (a server left out stays out for the session). Codex:
   * its own app-server's server status, asked of the live thread; a store server Codex could not
   * reach is `failed`.
   */
  const mcpStatusRows = async (): Promise<Record<string, unknown>[]> => {
    if (isInstanceTool(args.tool)) {
      return [
        ...(brainServer ? [{ name: brainServer.name, status: 'connected', scope: 'dynamic' }] : []),
        ...askedServers.map((s) => {
          const said = checked.get(s.name);
          return { name: s.name, scope: 'dynamic', status: said === 'connected' ? 'connected' : said === 'needs-auth' ? 'needs-auth' : 'failed' };
        }),
      ];
    }
    if (args.tool !== 'codex') return [];
    const names = [...new Set([...(deps.brain ? ['dreamcontext'] : []), ...leanMcpNames(args.mcpConfig), ...(storePlan?.routes.map((r) => r.name) ?? [])])];
    const counts = await session.mcpToolCounts(names);
    return [
      ...names.map((name) => {
        const n = counts.get(name);
        return { name, scope: 'dynamic', status: typeof n === 'number' && n > 0 ? 'connected' : 'failed', ...(typeof n === 'number' ? { tools: Array.from({ length: n }, () => ({})) } : {}) };
      }),
      ...(storePlan?.left ?? []).filter((l) => !names.includes(l.name)).map((l) => ({ name: l.name, scope: 'dynamic', status: 'failed' })),
    ];
  };
  const launchArgs = isInstanceTool(args.tool) ? '' : args.tool === 'claude'
    ? claudeLaunchArgs({ briefingFile: args.briefingFile })
    : [
      account?.launchArgs ?? '',
      codexLaunchArgs({ ...(args.briefingFile ? { briefingFile: args.briefingFile } : {}), note: toolNote('codex', { roles: codexKit?.roles.map((r) => r.name) ?? [] }) }),
      codexKit ? codexRoleArgs(codexKit.roles) : '',
      strictArgs,
      // The brain's write path (§4a): only with a brain, i.e. when the chat gets its context.
      deps.brain ? codexBrainMcpArgs({ node: process.execPath, cli: deps.env.DREAMCONTEXT_CLI || process.argv[1] || '', root: args.cwd, tabSession: deps.env.DREAMCONTEXT_TAB_SESSION }) : '',
      args.mcpConfig ? codexLeanMcpArgs(args.mcpConfig, { node: process.execPath, cli: deps.env.DREAMCONTEXT_CLI || process.argv[1] || '' }) : '',
      storePlan ? planLaunchArgs(storePlan) : '',
    ].filter(Boolean).join(' ');
  // Before the open: a pane closed during a stuck start must still end the agent T3 started.
  const opening = new AbortController();
  let opened = false;
  const onSignal = (): void => {
    if (!opened) { opening.abort(); return; }
    // A Codex that ignores the close must not hold the exit: the app-server ends at stdin's EOF.
    setTimeout(() => { process.exit(0); }, CLOSE_LIMIT_MS).unref();
    void session.close().finally(() => { rmSync(privateTmp, { recursive: true, force: true }); process.exit(0); });
  };
  if (deps.handleSignals) { process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal); }
  try {
    session = await BridgeSession.open({
      abortOpen: opening.signal,
      tool: args.tool,
      cwd: args.cwd,
      model: args.model,
      ...(args.effort ? { effort: args.effort } : {}),
      mode: startMode,
      paneId: args.paneId || randomUUID(),
      ...(args.resume ? { resumeNativeThreadId: args.resume } : {}),
      ...(binaryPath ? { binaryPath } : {}),
      launchArgs,
      ...(account ? { codexHome: { homePath: account.homePath, shadowHomePath: account.shadowHomePath } } : {}),
      ...(instanceAccount ? { accountId: instanceAccount } : {}),
      ...(instanceServers.length ? { mcpServers: instanceServers } : {}),
      ...(deps.openLimitMs ? { openLimitMs: deps.openLimitMs } : {}),
      ...(gateBeat ? { gateBeat } : {}),
      // The account's live windows, for the server's switch and the Settings bars (never a secret).
      onUsageLimits: (u) => emit({ type: 'system', subtype: 'dc_usage', dc_tool: args.tool, windows: u.windows, checked_at: u.checkedAt }),
      // DREAMCONTEXT_CONTEXT_BY: the bridge injects the brain, so a project's opt-in `.codex/hooks.json`
      // stays quiet in this session (its `.env` gate still runs; hook.ts beginCodexHookFormat).
      // DREAMCONTEXT_AGENT_TOOL: a dreamcontext command the agent runs prints in its words (tool-text.ts).
      env: { ...scrubbedCodexEnv(childEnv), TMPDIR: privateTmp, ...(args.tool !== 'claude' ? { DREAMCONTEXT_AGENT_TOOL: args.tool } : {}), ...(deps.brain ? { DREAMCONTEXT_CONTEXT_BY: 'bridge' } : {}) },
      stateRoot: join(home, '.dreamcontext', 't3'),
      extraRoots: args.extraRoots ?? [],
      privateTmp,
      ...(deps.claudeKit ? { claudeKit: deps.claudeKit } : {}),
      ...(deps.clientFactory ? { clientFactory: deps.clientFactory } : {}),
      ...(codexKit?.skillRoots.length ? { skillRoots: codexKit.skillRoots } : {}),
      ...(deps.runtimePolicyOverride ? { runtimePolicyOverride: deps.runtimePolicyOverride } : {}),
      onFatal: (message) => {
        emit({ type: 'system', subtype: 'bridge_error', message, dc_tool: args.tool });
        endInput?.();
      },
      // A sub-agent's steps, where its card's drill-in reads them (subagent-log.ts).
      onSidechain: (taskId, frame) => { if (session) appendSubagentStep(home, session.nativeThreadId, args.cwd, taskId, frame); },
      // Codex announces a compaction as it starts: the PreCompact hook digests the thread first.
      onCompacting: () => { if (session) deps.brain?.compacting?.(session.nativeThreadId, deps.transcriptFor?.(session.nativeThreadId) ?? null); },
      emit: (frame) => {
        emit(frame);
        noteEdit(frame);
        if (keepsThread && frame.type === 'assistant' && (frame.message as { model?: unknown } | undefined)?.model !== '<synthetic>') {
          const content = (frame.message as { content?: unknown } | undefined)?.content;
          const said = Array.isArray(content) ? content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('') : '';
          recordThreadTurn(session?.nativeThreadId ?? '', args.cwd, 'assistant', said, home, args.account);
        }
        // A refused or failed turn may never have put the snapshot in the thread: the next one carries it.
        if (frame.type === 'result' && frame.is_error) brainSent = false;
        // A synthetic result (the /clear or /effort answer) is not a turn Codex ran: it records nothing.
        if (frame.type === 'result' && !frame.dc_synthetic) owe(deps.onResult?.(session, frame));
        // A local answer held behind a running turn goes out after that turn's own result.
        if (frame.type === 'result' && !frame.dc_synthetic && heldAnswers.length) for (const f of heldAnswers.splice(0)) emit(f);
        // Messages that waited for this turn go in now, as one turn, the way a steer joins one.
        if (frame.type === 'result' && !frame.dc_synthetic && heldMessages.length) {
          const text = heldMessages.splice(0).join('\n\n');
          setImmediate(() => { chain = chain.then(() => handle({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })).catch(() => undefined); });
        }
      },
    });
  } catch (err) {
    // A timeout measured nothing about the sign-in: its text must not read as a refusal from the tool.
    const signedOut = !(err instanceof BridgeOpenTimeout) && isInstanceTool(args.tool) && (requiresSignIn(err) || causeChain(err).some((m) => antigravityFailureKind(m) === 'signed-out'));
    emit({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: signedOut ? `${toolLabel(args.tool)} is signed out. Sign in from the model picker, then open this chat again.`
        : err instanceof BridgeOpenTimeout ? err.message
          : `${toolLabel(args.tool)} did not start: ${String(err).slice(0, 400)}`,
      num_turns: 0, total_cost_usd: 0, usage: {}, dc_tool: args.tool, ...(signedOut ? { dc_signed_out: true } : {}),
    });
    if (deps.handleSignals) { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); }
    rmSync(privateTmp, { recursive: true, force: true });
    return 1;
  }
  opened = true;
  session.wire.slashCommands = slashCommandNames(args.tool, args.cwd, home);
  // The thread id is known before any turn: announce it, so a reopened pane can be resumed.
  // NOT a `system/init`: the server opens a turn on an init it did not ask for ("an idle child
  // emits no init"), so the thread is announced on its own frame the client ignores.
  emit({ type: 'system', subtype: 'dc_thread', session_id: session.nativeThreadId, dc_tool: args.tool, dc_ready: true });
  deps.onReady?.(session.nativeThreadId);
  // A pane that moved to an account which cannot hold its thread opens fresh, with the old end.
  if (isInstanceTool(args.tool) && args.carry) {
    const text = carriedText(args.carry, args.cwd, home);
    if (text) {
      owe([{ key: 'dreamcontext-previous-thread', text }]);
      // Kept with the new thread, so a second move still carries it.
      recordThreadTurn(session.nativeThreadId, args.cwd, 'carried', text, home, args.account, args.carry);
    }
  }

  const ack = (requestId: unknown, error?: string): void => {
    if (typeof requestId !== 'string') return;
    emit(error
      ? { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }
      : { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
  };

  // One frame at a time: a steer must not race the turn it steers. The snapshot is read first,
  // so the first turn already carries it.
  // A tool with no launch argument for it gets the chat-surface briefing with a thread's first turn.
  const briefingOwed = (): AppContext[] => {
    if (!isInstanceTool(args.tool)) return [];
    // A project's own skills are read where they are: copying them would be a step per project.
    // The owner's own skills too (TABLO row 4): read where they are, like the project's.
    const skillDirs = [
      ...(existsSync(join(args.cwd, '.claude', 'skills')) ? ["This project's skills are in .claude/skills/<name>/SKILL.md."] : []),
      ...(existsSync(join(home, '.claude', 'skills')) ? [`The owner's own skills are in ${join(home, '.claude', 'skills')}/<name>/SKILL.md.`] : []),
    ];
    const own: AppContext[] = skillDirs.length
      ? [{ key: 'dreamcontext-project-skills', text: `${skillDirs.join(' ')} When one covers the work, read it first. A message that starts with /<name> asks for that skill.` }]
      : [];
    // A sub-agent of this agent starts with none of this (TABLO row 8, real turn 2 Nov: "No
    // dreamcontext project brain or snapshot in context"): it is told how to get the brain itself.
    // Its shell also starts outside the project (in a skills folder, measured 3 Nov): the folder is named.
    own.push({ key: 'dreamcontext-subagents', text: `Your sub-agents (invoke_subagent) start without this project's brain or these notes, and their shell starts outside the project. Begin every task you give one with: "This project's folder is ${args.cwd}: run every shell command with Cwd set to it and read files by their path in it. First run \`dreamcontext snapshot\` there and read what it prints; it is this project's memory."` });
    // The note says where a role's file is, for a project role made with define_subagent.
    const roleDirs = [findPackageDir('agents'), join(home, '.claude', 'agents'), join(args.cwd, '.claude', 'agents')].filter((d): d is string => !!d && existsSync(d));
    own.push({ key: 'dreamcontext-tools', text: toolNote('antigravity', { roleDirs }) });
    if (!args.briefingFile) return own;
    try {
      const text = readFileSync(args.briefingFile, 'utf-8').slice(0, MAX_DEVELOPER_INSTRUCTIONS);
      return text.trim() ? [{ key: 'dreamcontext-briefing', text: toolText(text, 'antigravity') }, ...own] : own;
    } catch {
      return own;
    }
  };
  owe(briefingOwed());
  // Only Codex drops a repeated snapshot itself. Here it rides the words, so it goes once a thread,
  // and again after the tool compacted (the snapshot went with its context).
  const onceAThread = (ctx: AppContext[]): AppContext[] => {
    if (!isInstanceTool(args.tool)) return ctx;
    const out = brainSent ? ctx.filter((c) => c.key !== 'dreamcontext-brain') : ctx;
    if (out.some((c) => c.key === 'dreamcontext-brain')) brainSent = true;
    return out;
  };
  // The Stop hook found type errors in what this turn edited: the turn goes on once, with its
  // reason, as Claude's does when its Stop hook blocks (the next Stop does not block again).
  if (deps.brain && 'onStopBlock' in deps.brain) {
    deps.brain.onStopBlock = (reason) => {
      chain = chain.then(() => handle({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Stop hook feedback:\n${reason}` }] } })).catch(() => undefined);
    };
  }
  let chain: Promise<void> = deps.brain
    ? deps.brain.session(args.resume ? 'resume' : 'startup', session.nativeThreadId).catch(() => undefined)
    : Promise.resolve();
  const handle = async (frame: Record<string, unknown>): Promise<void> => {
    trace('in ', frame);
    // The owner came back while a hidden turn runs: it gives way, nothing they send waits on it.
    if (frame.type === 'user' || frame.type === 'control_request') await session.cancelHidden();
    if (frame.type === 'user') {
      const text = userText(frame);
      if (!text) return;
      // The composer's live effort switch arrives as `/effort <level>`, a CLI-local command that
      // Claude answers itself: so does the bridge, without a Codex turn (the server opened one).
      const effort = /^\/effort\s+([a-z]{1,16})\s*$/.exec(text.trim());
      if (effort) {
        // Antigravity names its reasoning in the model id and takes no effort: saying "set" would be false.
        if (isInstanceTool(args.tool)) {
          answerLocally(`${toolLabel(args.tool)} has no effort setting: each of its models names how hard it thinks. Pick one in the model picker.`);
          return;
        }
        session.setEffort(effort[1]!);
        answerLocally(`Set effort level to ${effort[1]}`);
        return;
      }
      if (text.trim() === '/compact') {
        if (session.canCompact && !session.busy) { await session.compact(); return; }
        answerLocally(session.canCompact
          ? `${toolLabel(args.tool)} is busy: send /compact again when this turn ends.`
          : `${toolLabel(args.tool)} has no compact command: it compacts by itself when its context fills, and the brain is sent again after.`);
        return;
      }
      // ACP takes no message into a running turn: this one waits for the turn's end (row 3).
      // A skipped card told back (card-feedback.ts) is written only at a clean, idle turn end; busy
      // now means the owner spoke first, so it is stale. Never held nor steered in: held texts are
      // joined into one owner turn and announced to the owner, and this text is neither his nor for him.
      if (session.busy && isCardFeedbackText(text)) return;
      if (isInstanceTool(args.tool) && session.busy) {
        heldMessages.push(text);
        say(`${toolLabel(args.tool)} cannot take a message while it works: this one goes in as soon as the turn ends.`);
        return;
      }
      if (text.trim() === '/clear') {
        const id = await session.newThread();
        brainSent = false;
        session.wire.takeCompacted();
        owe(briefingOwed());
        owe(deps.onRotated?.(id));
        // A fresh thread starts with a fresh snapshot, as SessionStart(source=clear) gives Claude.
        await deps.brain?.session('clear', id).catch(() => undefined);
        return;
      }
      // The tool compacted: a fresh snapshot, as SessionStart(source=compact) gives Claude. Before a
      // steer it waits: that message carries no context.
      if (!session.busy && session.wire.takeCompacted()) {
        brainSent = false;
        // Antigravity only shows it after: its digest is taken now, from the full conversation file.
        if (isInstanceTool(args.tool)) deps.brain?.compacting?.(session.nativeThreadId, deps.transcriptFor?.(session.nativeThreadId) ?? null);
        // The briefing rode the words too (no developer channel on ACP), so it went with them (row 14).
        owe(briefingOwed());
        await deps.brain?.session('compact', session.nativeThreadId).catch(() => undefined);
      }
      // A `/name` of the project's or the owner's: a command's body or a skill to read (slash.ts).
      session.wire.slashCommands = slashCommandNames(args.tool, args.cwd, home);
      const expanded = expandSlash(text, args.cwd, home);
      // The agent's own commands (`/plan`, `/usage`, `/logout`) must arrive alone to be commands.
      const nativeCommand = !expanded && isInstanceTool(args.tool) && /^\/[a-z]+$/.test(text.trim());
      // A steer joins the running turn as Claude's mid-turn message does: no hook, no context.
      const brain = session.busy || nativeCommand || !deps.brain ? [] : await deps.brain.prompt(text, session.nativeThreadId).catch(() => []);
      // Lost context is said, once, in the owner's own chat: `<synthetic>` keeps the pane's books as they are.
      const notice = [deps.brain?.takeNotice?.(), skillsLoss, gateNotice, serversNotice].filter(Boolean).join('\n\n');
      skillsLoss = null;
      gateNotice = null;
      serversNotice = null;
      if (notice) emit({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: notice }] }, parent_tool_use_id: null, session_id: session.nativeThreadId });
      // A hidden turn the server wrote (a skipped card told back, card-feedback.ts) is no owner text.
      if (keepsThread && !isInjectedUserText(text)) recordThreadTurn(session.nativeThreadId, args.cwd, 'user', text, home, args.account);
      const context = session.busy || nativeCommand ? [] : [...titler.nudge(), ...pending.splice(0), ...onceAThread(brain)];
      await session.send(expanded ?? text, args.tool === 'codex' ? fitCodexContext(context) : context);
      return;
    }
    if (frame.type === 'control_response') {
      const r = frame.response as { request_id?: unknown; response?: Record<string, unknown>; subtype?: string } | undefined;
      if (typeof r?.request_id !== 'string') return;
      const body = r.response ?? {};
      await session.answer(r.request_id, {
        behavior: r.subtype === 'error' ? 'deny' : String(body.behavior ?? 'deny'),
        updatedInput: body.updatedInput,
        ...(typeof body.message === 'string' ? { message: body.message } : {}),
      });
      return;
    }
    if (frame.type === 'control_request') {
      const req = (frame.request ?? {}) as Record<string, unknown>;
      switch (req.subtype) {
        case 'interrupt': {
          // Always acked, and within a second: the server's watchdog kills a child whose Stop is
          // not answered in 5 s, and an ACP agent's cancel can take 15 s to come back. The turn's
          // end still follows: the agent's own, or the bridge's after STOP_CONFIRM_MS.
          const stopping = session.interrupt().then(() => undefined, (err: unknown) => String(err).slice(0, 200));
          const early = await Promise.race([stopping, new Promise<'pending'>((r) => { setTimeout(() => r('pending'), ACK_STOP_MS).unref(); })]);
          // A late refusal is not the owner's news: the turn ends either way (the agent's own end,
          // or the bridge's), and the mock's cancel answers with an error even as it ends the turn.
          ack(frame.request_id, early === 'pending' ? undefined : early);
          return;
        }
        case 'set_model':
          if (typeof req.model === 'string' && req.model) session.setModel(req.model);
          ack(frame.request_id);
          return;
        case 'stop_task': {
          // One sub-agent's card asked to stop. The tool says whether it can (Codex can close one).
          const done = typeof req.task_id === 'string' ? await session.stopSubagent(req.task_id).catch(() => false) : false;
          ack(frame.request_id, done ? undefined : `${toolLabel(args.tool)} cannot stop that sub-agent alone: Stop ends the whole turn.`);
          return;
        }
        case 'set_permission_mode':
          // No gate: Bypass stays off, whatever the composer sends.
          if (typeof req.mode === 'string' && !gateLoss) session.setMode(req.mode);
          ack(frame.request_id);
          return;
        default:
          ack(frame.request_id, `${String(req.subtype)} is not available on ${args.tool} yet`);
      }
    }
  };

  /**
   * The MCP card and the tab's server health ask this as they ask Claude (mcp-live.ts), and the
   * server polls it after every turn: Claude's raw shape, read and redacted by the server like
   * Claude's own answer. Answered beside the queue, never in it: it must not stop the hidden
   * tab-title turn or hold the owner's next message behind a slow server.
   */
  let asides: Promise<void> = Promise.resolve();
  const answerMcpStatus = async (frame: Record<string, unknown>): Promise<void> => {
    trace('in ', frame);
    const servers = await mcpStatusRows().catch(() => []);
    if (typeof frame.request_id === 'string') emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { mcpServers: servers } } });
  };

  // The server ends a pane with SIGTERM (then SIGKILL): `onSignal` closes the session first, which
  // ends the child T3 spawned in its own group, and removes the private temp folder.
  await new Promise<void>((resolve) => {
    let buf = '';
    deps.input.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        if (isMcpStatusAsk(obj)) { const ask = answerMcpStatus(obj).catch(() => undefined); asides = asides.then(() => ask); continue; }
        chain = chain.then(() => handle(obj as Record<string, unknown>)).catch((err) => {
          emit({ type: 'system', subtype: 'bridge_error', message: String(err).slice(0, 400), dc_tool: args.tool });
        });
      }
    });
    endInput = () => { fatal = true; resolve(); };
    deps.input.on('end', () => resolve());
    deps.input.on('close', () => resolve());
  });
  await chain.catch(() => undefined);
  await asides;
  if (deps.handleSignals) { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); }
  await deps.brain?.drain().catch(() => undefined);
  await session.close();
  rmSync(privateTmp, { recursive: true, force: true });
  return fatal ? 1 : 0;
}
