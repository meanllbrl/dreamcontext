/**
 * What a live Antigravity session reports for each tool server. `dreamcontext t3-chat --tool
 * antigravity --mcp-probe`: one JSON line with names, statuses and counts, and nothing else.
 *
 * The agent connects servers when a turn starts, so the probe starts one and stops it as soon as
 * the session's own folder shows them, which is before the model has answered. A server the agent
 * still refuses is taken out and the session asked again. No brain, no owner's words, and no row in
 * the account's history.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAcpServers, forgetProbe, refusedServer, sessionServers, type ProbeReport, type ProbeRow } from '../antigravity-mcp.js';
import { INSTANCE_PRIMARY_ID, isInstanceAccountId } from '../instance-accounts.js';
import { codexStorePlan } from '../codex-mcp.js';
import { acpStoreServers, scrubbedCodexEnv, type AcpMcpServer } from './launch.js';
import { BridgeSession } from './session.js';
import { syncAntigravityGate } from '../antigravity-gate.js';

/** The route stops a probe at 60 s: two passes of an open and a wait stay under that. */
const MAX_ATTEMPTS = 2;
const OPEN_LIMIT_MS = 15_000;
const WAIT_MS = 12_000;
const POLL_MS = 150;

export interface ProbeSession {
  /** Opens a session on these servers and starts a turn; its thread, and how the turn went. */
  open: (servers: readonly AcpMcpServer[]) => Promise<{ thread: string; said: () => string; done: () => boolean; close: () => Promise<void> } | 'signed_out' | null>;
}

/** Ask the session; one pass per server it refuses, at most {@link MAX_ATTEMPTS}. */
export async function probeSession(servers: readonly AcpMcpServer[], session: ProbeSession, read: (thread: string) => Map<string, number>, forget: (thread: string) => void, waitMs = WAIT_MS): Promise<ProbeReport> {
  const out: ProbeRow[] = [];
  let left = [...servers];
  for (let attempt = 0; attempt < MAX_ATTEMPTS && left.length; attempt += 1) {
    const open = await session.open(left);
    if (open === 'signed_out') return { state: 'signed_out', servers: out };
    if (!open) return { state: 'failed', servers: out };
    const deadline = Date.now() + waitMs;
    let refused: ReturnType<typeof refusedServer> = null;
    let seen = new Map<string, number>();
    while (Date.now() < deadline) {
      refused = refusedServer(open.said());
      seen = read(open.thread);
      if (refused || left.every((s) => seen.has(s.name)) || open.done()) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    await open.close();
    seen = read(open.thread);
    forget(open.thread);
    if (refused) {
      out.push({ name: refused.name, status: refused.unauthorized ? 'needs-auth' : 'failed' });
      left = left.filter((s) => s.name !== refused!.name);
      continue;
    }
    for (const s of left) out.push(seen.has(s.name) ? { name: s.name, status: 'connected', toolCount: seen.get(s.name)! } : { name: s.name, status: 'failed' });
    return { state: 'ok', servers: out };
  }
  return { state: 'ok', servers: [...out, ...left.map((s) => ({ name: s.name, status: 'unknown' as const }))] };
}

export async function runAntigravityMcpProbe(o: { cwd: string; account?: string }): Promise<number> {
  const home = homedir();
  const account = o.account && isInstanceAccountId(o.account) ? o.account : INSTANCE_PRIMARY_ID;
  const node = process.execPath;
  const cli = process.env.DREAMCONTEXT_CLI || process.argv[1] || '';
  const print = (r: ProbeReport): number => { process.stdout.write(`${JSON.stringify(r)}\n`); return 0; };
  const stored = acpStoreServers(codexStorePlan({ home, projectRoot: o.cwd, node, cli, listed: [], sync: false }).routes, { node, cli });
  const checked = await checkAcpServers(stored, { env: process.env });
  const rows: ProbeRow[] = stored.filter((s) => checked.get(s.name) !== 'connected').map((s) => ({ name: s.name, status: checked.get(s.name) as 'needs-auth' | 'failed' }));
  const healthy = stored.filter((s) => checked.get(s.name) === 'connected');
  if (!healthy.length) return print({ state: 'ok', servers: rows });
  // A turn must not run without the gate, even one told to do nothing.
  if (!syncAntigravityGate(account, { node, cli, home }).ok) return print({ state: 'failed', servers: rows });
  const privateTmp = mkdtempSync(join(tmpdir(), 'dc-agy-probe-'));
  let current = '';
  const cleanup = (): void => {
    if (current) forgetProbe(current, account, home);
    rmSync(privateTmp, { recursive: true, force: true });
  };
  const onStop = (): void => { cleanup(); process.exit(1); };
  process.once('SIGTERM', onStop);
  try {
    const session: ProbeSession = {
      open: async (servers) => {
        let said = '';
        let finished = false;
        try {
          const s = await BridgeSession.open({
            tool: 'antigravity', cwd: o.cwd, model: '', mode: 'default', paneId: `mcp-probe-${randomUUID()}`, launchArgs: '',
            ...(account !== INSTANCE_PRIMARY_ID ? { accountId: account } : {}), mcpServers: servers, env: scrubbedCodexEnv(process.env),
            stateRoot: join(home, '.dreamcontext', 't3'), extraRoots: [], privateTmp, openLimitMs: OPEN_LIMIT_MS,
            emit: (f) => {
              if (f.type === 'result') { finished = true; said += String(f.result ?? ''); }
              if (f.type !== 'assistant') return;
              const content = (f.message as { content?: unknown } | undefined)?.content;
              if (Array.isArray(content)) for (const b of content) said += String((b as { text?: unknown } | null)?.text ?? '');
            },
          });
          current = s.nativeThreadId;
          const close = async (): Promise<void> => { await s.interrupt().catch(() => undefined); await s.close(); };
          await s.send('Reply with the single word OK. Run no tools.').catch(async (err) => { await close(); throw err; });
          return { thread: s.nativeThreadId, said: () => said, done: () => finished, close };
        } catch (err) {
          return /sign in|signed out/i.test(String(err)) ? 'signed_out' : null;
        }
      },
    };
    const report = await probeSession(healthy, session, (t) => sessionServers(t, account, home), (t) => forgetProbe(t, account, home));
    current = '';
    return print({ state: report.state, servers: [...rows, ...report.servers] });
  } finally {
    process.off('SIGTERM', onStop);
    cleanup();
  }
}
