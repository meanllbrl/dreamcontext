/**
 * The Accounts list and its Refresh, against the owner's report of 2026-11-03: "the usage in the
 * new settings is wrong, refresh takes needlessly long, and it does not refresh".
 *
 * Each root cause found on that machine (read-only) is pinned here:
 *   • a folder signed in as ANOTHER account drew that account's week on this row
 *     (`other-account`, nothing drawn, and the folder is never probed);
 *   • an account a turn found signed out still drew its last numbers as if it could serve
 *     (`needs-relogin`, from the signed-out record, not only from a missing credential);
 *   • Refresh probed one account after another (85s on five accounts, every probe timing out):
 *     now every account is probed AT ONCE, and a second ask for one in flight joins it;
 *   • a new chat was shown starting on a refused account while another had room
 *     (`standbyAccount`).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleAgentAccountsList, handleAgentAccountsRefresh, REFRESH_PROBE_TIMEOUT_MS, setRefreshProbeForTests,
} from '../../src/server/routes/agent-accounts.js';
import { type ClaudeAccount, sandboxDirFor, writeClaudeAccounts } from '../../src/lib/claude-accounts.js';
import { recordSignedOut, signedOutFilePath } from '../../src/lib/claude-signed-out.js';
import { standbyAccount } from '../../src/lib/automations/account.js';
import type { ProbeOutcome } from '../../src/lib/claude-usage-probe.js';
import type { UsageLimitsResponse } from '../../src/lib/claude-usage.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-acct-usage-'));
const REAL_HOME = process.env.HOME;

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  delete process.env.DREAMCONTEXT_DESKTOP;
  setRefreshProbeForTests(null);
  rmSync(HOME, { recursive: true, force: true });
});

const HOUR = 60 * 60_000;
const soon = () => new Date(Date.now() + 3 * HOUR).toISOString();

function account(id: string, email: string, sandboxed: boolean, preferred = false): ClaudeAccount {
  return {
    id, accountUuid: '', email, organizationUuid: '', organizationName: '', tier: 'team',
    configDir: sandboxed ? sandboxDirFor(id, HOME) : null, preferred,
  };
}

/** A signed-in `.claude.json` for `email`, with a fresh cache at `week`%. */
function signIn(dir: string, email: string, week: number): void {
  mkdirSync(dir, { recursive: true });
  const uuid = `uuid-${email}`;
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: uuid, emailAddress: email },
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(), accountUuid: uuid,
      utilization: { five_hour: { utilization: 2, resets_at: soon() }, seven_day: { utilization: week, resets_at: soon() } },
    },
  }), 'utf-8');
}

async function call(handler: typeof handleAgentAccountsList, body?: unknown): Promise<{ status: number; body: any }> {
  const captured = { status: 0, body: null as any };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')]) as unknown as IncomingMessage;
  (req as any).method = body === undefined ? 'GET' : 'POST';
  (req as any).headers = { host: '127.0.0.1:1234', 'content-type': 'application/json' };
  (req as any).socket = { remoteAddress: '127.0.0.1' };
  await handler(req, res);
  return captured;
}

const ME = account('me-personal', 'me@personal.example', false, true);
const TEAM = account('team', 'me@team.example', true);
const OTHER = account('other', 'me@other.example', true);

beforeEach(() => {
  process.env.HOME = HOME;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  rmSync(join(HOME, '.dreamcontext'), { recursive: true, force: true });
  rmSync(join(HOME, '.claude.json'), { force: true });
  mkdirSync(join(HOME, '.claude'), { recursive: true });
  writeClaudeAccounts([ME, TEAM, OTHER], HOME);
  setRefreshProbeForTests(null);
});

describe('GET /api/agent/accounts — whose numbers a row draws', () => {
  it('a HOME signed in as the Team account draws NOTHING on its own row, and names who is signed in', async () => {
    signIn(HOME, 'me@team.example', 92);           // the terminal sign-in landed on the Team account
    signIn(TEAM.configDir!, 'me@team.example', 92);
    signIn(OTHER.configDir!, 'me@other.example', 30);
    const { status, body } = await call(handleAgentAccountsList);
    expect(status).toBe(200);
    const row = (id: string) => body.accounts.find((a: any) => a.id === id);
    expect(row('me-personal').state).toBe('other-account');
    expect(row('me-personal').signedInAs).toBe('me@team.example');
    expect(row('me-personal').limits).toEqual([]);
    expect(row('me-personal').fetchedAtMs).toBeNull();
    // The Team account's own row keeps its own week; the identical copy is gone.
    expect(row('team').state).toBe('ok');
    expect(row('team').limits.find((l: any) => l.key === 'weekly').percent).toBe(92);
    expect(row('other').limits.find((l: any) => l.key === 'weekly').percent).toBe(30);
  });

  it('an account a turn found signed out is `needs-relogin`, not a healthy row with old numbers', async () => {
    signIn(HOME, 'me@personal.example', 10);
    signIn(TEAM.configDir!, 'me@team.example', 50);
    signIn(OTHER.configDir!, 'me@other.example', 30);
    recordSignedOut('team', HOME);
    const { body } = await call(handleAgentAccountsList);
    expect(body.accounts.find((a: any) => a.id === 'team').state).toBe('needs-relogin');
    expect(body.accounts.find((a: any) => a.id === 'me-personal').state).toBe('ok');
    rmSync(signedOutFilePath(HOME), { force: true });
  });

  it('never puts a key the wire does not declare on a row (no oauth blob rides out)', async () => {
    signIn(HOME, 'me@team.example', 92);
    signIn(TEAM.configDir!, 'me@team.example', 92);
    signIn(OTHER.configDir!, 'me@other.example', 30);
    const { body } = await call(handleAgentAccountsList);
    const allowed = new Set(['id', 'email', 'organizationName', 'tier', 'preferred', 'isPrimary', 'ownerOnly',
      'state', 'signedInAs', 'limits', 'fetchedAtMs', 'refusedUntil', 'refusedWindow']);
    for (const a of body.accounts) for (const k of Object.keys(a)) expect(allowed.has(k)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('uuid-');
  });
});

describe('POST /api/agent/accounts/refresh — every account at once, never one hanging the rest', () => {
  it('starts every probe before any finishes, with the short refresh budget and the fast path on', async () => {
    signIn(HOME, 'me@personal.example', 10);
    signIn(TEAM.configDir!, 'me@team.example', 50);
    signIn(OTHER.configDir!, 'me@other.example', 30);
    const started: Array<{ dir: string; timeoutMs?: number; trust?: boolean }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setRefreshProbeForTests(async (dir, deps) => {
      started.push({ dir, timeoutMs: deps?.timeoutMs, trust: deps?.trustCurrentCache });
      await gate;
      return { status: 'ok', limits: { limits: [], fetchedAtMs: Date.now() } } as ProbeOutcome;
    });
    const pending = call(handleAgentAccountsRefresh, {});
    await new Promise((r) => setTimeout(r, 20));
    // All three are in flight while none has answered: sequential probing would show one.
    expect(started).toHaveLength(3);
    for (const s of started) { expect(s.timeoutMs).toBe(REFRESH_PROBE_TIMEOUT_MS); expect(s.trust).toBe(true); }
    release();
    const { body } = await pending;
    expect(body.refreshed.sort()).toEqual(['me-personal', 'other', 'team']);
    expect(body.failed).toEqual([]);
  });

  it('a second ask for an account already being read joins the first probe', async () => {
    signIn(HOME, 'me@personal.example', 10);
    signIn(TEAM.configDir!, 'me@team.example', 50);
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setRefreshProbeForTests(async () => {
      runs += 1;
      await gate;
      return { status: 'unknown', reason: 'timed out' } as ProbeOutcome;
    });
    const a = call(handleAgentAccountsRefresh, { id: 'team' });
    const b = call(handleAgentAccountsRefresh, { id: 'team' });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(runs).toBe(1);
    expect(ra.body.failed).toEqual([{ id: 'team', why: 'unknown' }]);
    expect(rb.body.failed).toEqual([{ id: 'team', why: 'unknown' }]);
  });

  it('never probes a folder signed in as another account', async () => {
    signIn(HOME, 'me@team.example', 92);
    signIn(TEAM.configDir!, 'me@team.example', 92);
    signIn(OTHER.configDir!, 'me@other.example', 30);
    const probed: string[] = [];
    setRefreshProbeForTests(async (dir) => {
      probed.push(dir);
      return { status: 'ok', limits: { limits: [], fetchedAtMs: Date.now() } } as ProbeOutcome;
    });
    const { body } = await call(handleAgentAccountsRefresh, {});
    expect(probed).not.toContain(HOME);
    expect(body.failed).toEqual([{ id: 'me-personal', why: 'other-account' }]);
  });
});

describe('standbyAccount — where a new chat opens when nothing is under the threshold', () => {
  const now = Date.now();
  const reading = (week: number, session = 2): UsageLimitsResponse => ({
    limits: [
      { key: 'session', percent: session, resetsAt: now + HOUR },
      { key: 'weekly', percent: week, resetsAt: now + 50 * HOUR },
    ],
    fetchedAtMs: now,
  });
  const dirs: Record<string, UsageLimitsResponse> = {};
  const read = (dir: string) => dirs[dir] ?? { limits: [], fetchedAtMs: null };
  const A = account('a', 'a@x.example', true);
  const B = account('b', 'b@x.example', true);
  const C = account('c', 'c@x.example', true);

  it('never a refused account at 100% while a signed-in one still serves (92% weekly)', () => {
    dirs[A.configDir!] = reading(92);              // over the switch threshold, but not full
    dirs[B.configDir!] = reading(32, 100);         // the 5-hour window is full and refused
    const picked = standbyAccount([B, A], new Set(), { b: { until: now + 19 * 60_000 } }, read, HOME, now);
    expect(picked?.id).toBe('a');
  });

  it('when every signed-in account is refused, the one that comes back soonest', () => {
    const picked = standbyAccount([A, B, C], new Set(['a']), {
      b: { until: now + 5 * HOUR }, c: { until: now + 19 * 60_000 },
    }, read, HOME, now);
    expect(picked?.id).toBe('c');
  });

  it('a signed-out account is never picked while a signed-in one exists', () => {
    dirs[A.configDir!] = reading(10);
    const picked = standbyAccount([A, B], new Set(['a']), {}, read, HOME, now);
    expect(picked?.id).toBe('b');
  });
});

describe('chatSpawnAccount — a refused preferred account hands new chats to one that serves', () => {
  it('preferred refused at 100%: the 92% account takes new chats, not the refused one', async () => {
    const { chatSpawnAccount } = await import('../../src/lib/automations/account.js');
    const { recordAccountRejection } = await import('../../src/lib/claude-limit-rejections.js');
    const now = Date.now();
    const B = account('b-full', 'b@x.example', true, true);
    const A = account('a-room', 'a@x.example', true);
    writeClaudeAccounts([B, A], HOME);
    const r = (week: number, session: number): UsageLimitsResponse => ({
      limits: [{ key: 'session', percent: session, resetsAt: now + HOUR }, { key: 'weekly', percent: week, resetsAt: now + 50 * HOUR }],
      fetchedAtMs: now,
    });
    recordAccountRejection('b-full', { window: 'session', resetsAtMs: now + 19 * 60_000, via: 'rateLimitEvent' }, HOME, now);
    const readUsage = (dir: string) => (dir === B.configDir ? r(32, 100) : r(92, 2));
    expect(chatSpawnAccount({ home: HOME, now, readUsage, signedOut: new Set() }).id).toBe('a-room');
  });
});
