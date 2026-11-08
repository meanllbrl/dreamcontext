/**
 * `dreamcontext t3-account <action> --tool antigravity`: the account jobs that need T3's driver, in
 * a short child so Effect never loads in the dashboard server.
 *
 *   install   T3's managed runtime (a release download T3 checks against its pinned hash)
 *   signin    the install when needed, then T3's Google sign-in: the page's address is printed as
 *             `{"signInUrl":…}` for the caller to open, and the agent's own 127.0.0.1 callback
 *             finishes it. Ends with `{ok, signedIn}`.
 *   probe     how full the quota is (T3's usage probe). No model call.
 *
 * Prints JSON lines only. The sign-in address carries no credential, and no token is ever read here.
 */
import type { ProviderAuthState } from '@t3tools/contracts';
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator';
import * as McpProviderSessions from '@t3tools/provider-core/server/McpProviderSessions';
import * as ProviderEventLoggers from '@t3tools/provider-core/server/ProviderEventLoggers';
import * as AntigravityInstallation from '@t3tools/server/provider/AntigravityInstallation';
import { makeAntigravityUsageProbe } from '@t3tools/server/provider/antigravityUsageLimits';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { antigravityProfileDir, antigravitySignedIn } from '../antigravity-accounts.js';
import type { InstanceTool } from '../instance-accounts.js';
import { createInstance, instanceLayer } from './instances.js';
import { bridgeServerConfig } from './session.js';

const print = (line: unknown): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };

const OVER = new Set<string>(['succeeded', 'failed', 'cancelled', 'expired']);

function layerFor(home: string) {
  const base = Layer.mergeAll(
    NodeServices.layer,
    IdAllocator.layer,
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, ProviderEventLoggers.NoOpProviderEventLoggers),
  );
  const config = bridgeServerConfig(join(home, '.dreamcontext', 't3'), home);
  return Layer.mergeAll(base, McpProviderSessions.layer, instanceLayer(config).pipe(Layer.provide(base)));
}

const INSTALL_OVER = new Set<string>(['succeeded', 'failed', 'cancelled']);

/** Already there, or T3's own install to its end: `acquire` only finds a runtime, `start` fetches one. */
export function ensureInstalled(installation: AntigravityInstallation.AntigravityInstallation['Service']) {
  return Effect.gen(function* () {
    const found = yield* installation.resolve(undefined, process.env).pipe(Effect.option);
    if (found._tag === 'Some') return;
    yield* installation.start;
    let phase = '';
    let message: string | null = null;
    yield* installation.changes.pipe(
      Stream.takeUntil((s) => INSTALL_OVER.has(s.phase)),
      Stream.runForEach((s) => Effect.sync(() => { phase = s.phase; message = s.message; })),
    );
    if (phase !== 'succeeded') return yield* Effect.fail(new Error(message ?? 'The install did not finish.'));
  });
}

const install = AntigravityInstallation.AntigravityInstallation.pipe(Effect.flatMap(ensureInstalled));

const installProgram = install.pipe(Effect.map(() => ({ ok: true, installed: true })));

/** A person at a terminal gets the page opened; the server and the picker open it themselves. */
function openForTerminal(url: string): void {
  if (!process.stdout.isTTY || process.platform !== 'darwin') return;
  try { spawn('open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref(); } catch { /* the line is printed */ }
}

function signinProgram(tool: InstanceTool, account: string, home: string) {
  return Effect.scoped(Effect.gen(function* () {
    yield* install;
    const instance = yield* createInstance({ tool, accountId: account });
    const auth = instance.auth;
    if (!auth) return { ok: false, signedIn: false, error: 'This tool has no sign-in.' };
    const owner = randomUUID();
    const started: ProviderAuthState = yield* auth.start(owner);
    let printed = '';
    let state = started;
    yield* auth.subscribe(owner).pipe(
      Stream.takeUntil((s) => OVER.has(s.phase)),
      Stream.runForEach((s) => Effect.sync(() => {
        state = s;
        if (s.authorizationUrl && s.authorizationUrl !== printed) {
          printed = s.authorizationUrl;
          print({ signInUrl: printed });
          openForTerminal(printed);
        }
      })),
    );
    const signedIn = state.phase === 'succeeded' && antigravitySignedIn(account, home);
    return { ok: signedIn, signedIn, ...(signedIn ? {} : { error: state.message ?? 'Sign-in did not finish.' }) };
  }));
}

function probeProgram(account: string, home: string) {
  return Effect.gen(function* () {
    if (!antigravitySignedIn(account, home)) return { ok: true, signedIn: false };
    const usage = yield* makeAntigravityUsageProbe({ profileDirectory: antigravityProfileDir(account, home), authMethod: 'oauth-personal' });
    const read = (yield* usage.probe) as { checkedAt?: string; windows?: ReadonlyArray<object> };
    return { ok: true, signedIn: true, ...(read.checkedAt ? { checkedAt: read.checkedAt } : {}), windows: (read.windows ?? []).map((w) => ({ ...w })) };
  });
}

export async function runInstanceAccount(action: string, tool: InstanceTool, account: string, home: string = homedir()): Promise<number> {
  const program = (action === 'install' ? installProgram : action === 'signin' ? signinProgram(tool, account, home) : probeProgram(account, home)) as Effect.Effect<unknown, unknown, never>;
  // A caller's timeout ends this with SIGTERM: unwinding the scopes removes a half-unpacked install.
  const stop = new AbortController();
  const onStop = (): void => stop.abort();
  process.once('SIGTERM', onStop);
  process.once('SIGINT', onStop);
  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layerFor(home) as never)) as Effect.Effect<unknown, unknown, never>, { signal: stop.signal });
  process.off('SIGTERM', onStop);
  process.off('SIGINT', onStop);
  if (exit._tag === 'Success') {
    print(exit.value);
    return (exit.value as { ok?: boolean }).ok ? 0 : 1;
  }
  print({ ok: false, signedIn: false, error: String(exit.cause).split('\n')[0]!.slice(0, 300) });
  return 1;
}
