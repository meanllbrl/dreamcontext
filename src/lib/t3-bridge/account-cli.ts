/**
 * `dreamcontext t3-account` (bridge bundle): the two account jobs that need T3's own code, run in
 * a short child so Effect never loads in the dashboard server (plan r5 §4b, W2).
 *
 *   prepare --account <id>   lay out the account's shadow home with T3's `materializeCodexShadowHome`
 *                            (private auth, every other entry linked to `~/.codex`), before a sign-in
 *   probe [--account <id>]   ask `codex app-server` who is signed in and how full its windows are
 *                            (`account/read` + `account/rateLimits/read`): NO model call. The windows
 *                            go through T3's `codexRateLimitsToLimits`, unchanged.
 *   seed --in <raw> --out <md>  render a chat for another tool with T3's `handoffBudget` and
 *                            `selectHistory` (tool-handoff.ts). No account, no model call.
 *
 * Prints ONE JSON line. Never prints a credential: `account/read` answers an email and a plan.
 */
import * as NodeServices from '@effect/platform-node/NodeServices';
import { CodexSettings } from '@t3tools/contracts';
import { withCodexAppServerClient } from '@t3tools/server/provider/CodexProvider';
import { codexRateLimitsToLimits } from '@t3tools/server/provider/codexUsageLimits';
import { materializeCodexShadowHome, resolveCodexHomeLayout } from '@t3tools/server/provider/Drivers/CodexHomeLayout';
import { DEFAULT_HANDOFF_TOKEN_CAP, handoffBudget, renderHistory, selectHistory } from '@t3tools/provider-core/server/handoffBudget';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { codexInstanceSettings } from './accounts.js';
import { scrubbedCodexEnv } from './launch.js';
import { fenceSeed, type RawHandoff } from './tool-handoff.js';

export interface T3AccountOptions {
  action: 'prepare' | 'probe' | 'seed';
  account?: string;
  home?: string;
  in?: string;
  out?: string;
}

/** What `probe` prints. `windows` is T3's `ServerProviderUsageWindow[]`, as T3 builds it. */
export interface CodexProbeResult {
  ok: boolean;
  signedIn: boolean;
  email?: string;
  planType?: string;
  checkedAt?: string;
  windows?: ReadonlyArray<{ id: string; kind: string; label: string; usedPercent: number; resetsAt?: string; windowDurationMins?: number }>;
  error?: string;
}

const decodeSettings = Schema.decodeSync(CodexSettings);
const PROBE_TIMEOUT_MS = 20_000;

function settingsFor(home: string, account: string | undefined) {
  const s = codexInstanceSettings(home, account && account !== 'primary' ? account : null);
  return { s, settings: decodeSettings({ enabled: true, homePath: s.homePath, shadowHomePath: s.shadowHomePath, launchArgs: s.launchArgs }) };
}

/** Lay the shadow home out (a no-op for account #0). */
export function prepareProgram(home: string, account: string | undefined) {
  const { settings } = settingsFor(home, account);
  return Effect.gen(function* () {
    const layout = yield* resolveCodexHomeLayout(settings);
    yield* materializeCodexShadowHome(layout);
    return { ok: true, home: layout.effectiveHomePath ?? layout.sharedHomePath };
  });
}

export function probeProgram(home: string, account: string | undefined, env: NodeJS.ProcessEnv) {
  const { s, settings } = settingsFor(home, account);
  return Effect.scoped(Effect.gen(function* () {
    const layout = yield* resolveCodexHomeLayout(settings);
    yield* materializeCodexShadowHome(layout);
    const { client } = yield* withCodexAppServerClient({
      binaryPath: 'codex',
      ...(layout.effectiveHomePath ? { homePath: layout.effectiveHomePath } : {}),
      ...(s.launchArgs ? { launchArgs: s.launchArgs } : {}),
      cwd: home,
      environment: scrubbedCodexEnv(env),
    });
    const acc = yield* client.request('account/read', {});
    const a = acc.account as { type?: string; email?: string | null; planType?: string | null } | null | undefined;
    if (!a) return { ok: true, signedIn: false } satisfies CodexProbeResult;
    const limits = yield* client.request('account/rateLimits/read', null).pipe(Effect.option);
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const out: CodexProbeResult = {
      ok: true,
      signedIn: true,
      ...(a.email ? { email: a.email } : {}),
      ...(a.planType ? { planType: a.planType } : {}),
      checkedAt,
    };
    if (limits._tag === 'Some' && limits.value) {
      const r = limits.value as { rateLimits: never; rateLimitsByLimitId?: never; rateLimitResetCredits?: never };
      const mapped = codexRateLimitsToLimits({ snapshot: r.rateLimits, rateLimitsByLimitId: r.rateLimitsByLimitId, resetCredits: r.rateLimitResetCredits, checkedAt });
      out.windows = mapped.windows.map((w) => ({ ...w }));
    }
    return out;
  }));
}

/** The text a chat carries to another tool: T3's budget and selection, unchanged. */
export function renderHandoff(raw: RawHandoff): { text: string; kept: number; omitted: number } {
  const coverage = `Conversation ${raw.threadId} on ${raw.fromLabel}, ${raw.messages.length} messages.`;
  const messages = raw.messages.map((m) => ({ ...m, threadId: raw.threadId, runId: null, providerThreadId: null, status: 'completed' })) as unknown as Parameters<typeof selectHistory>[0]['messages'];
  const tokenCap = Math.min(DEFAULT_HANDOFF_TOKEN_CAP, raw.cap);
  // A fresh thread: no provider thread to read a window from, T3's own defaults decide.
  const budget = handoffBudget({ tokenCap, userText: '', attachments: [], providerThread: {} as never, nativeContextEstimate: 0 });
  const picked = selectHistory({ messages, coverage, budget });
  return { text: renderHistory(picked.messages, picked.context), kept: picked.messages.length, omitted: picked.omittedItems };
}

function runSeed(i: string, o: string): number {
  try {
    const raw = JSON.parse(readFileSync(i, 'utf-8')) as RawHandoff;
    const { text, kept, omitted } = renderHandoff(raw);
    writeFileSync(o, fenceSeed(text, raw.fromLabel), { encoding: 'utf-8', mode: 0o600 });
    rmSync(i, { force: true });
    process.stdout.write(JSON.stringify({ ok: true, kept, omitted }) + '\n');
    return 0;
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err).split('\n')[0]!.slice(0, 300) }) + '\n');
    return 1;
  }
}

/** Runs one action and prints its JSON line. Exit 0 when the line says `ok`. */
export async function runT3Account(o: T3AccountOptions): Promise<number> {
  if (o.action === 'seed') return runSeed(o.in ?? '', o.out ?? '');
  const home = o.home ?? homedir();
  const program: Effect.Effect<unknown, unknown, never> = o.action === 'prepare'
    ? prepareProgram(home, o.account).pipe(Effect.provide(NodeServices.layer))
    : probeProgram(home, o.account, process.env).pipe(Effect.timeout(PROBE_TIMEOUT_MS), Effect.provide(NodeServices.layer)) as Effect.Effect<unknown, unknown, never>;
  const exit = await Effect.runPromiseExit(program);
  if (exit._tag === 'Success') {
    process.stdout.write(JSON.stringify(exit.value) + '\n');
    return 0;
  }
  // The cause names a path or a JSON-RPC code, never a credential.
  process.stdout.write(JSON.stringify({ ok: false, signedIn: false, error: String(exit.cause).split('\n')[0]!.slice(0, 300) }) + '\n');
  return 1;
}
