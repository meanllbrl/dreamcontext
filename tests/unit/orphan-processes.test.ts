import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  PsError,
  createRunPs,
  runPs,
  parseProcTable,
  parseEnvLines,
  isOwnerClaude,
  isLooseClaude,
  isDashboardServer,
  isDashboardLooking,
  ledgerProgram,
  escapedGroups,
  takeSnapshot,
  classifyOrphanGroups,
  type ProcRow,
  type RunPs,
  type Snapshot,
} from '../../src/lib/orphan-processes.js';

// Fixtures follow this Mac's REAL `ps` output: right-aligned numeric columns, the lstart column
// padded with 5 spaces before args, day-of-month space-padded, newlines in argv shown as `\012`.
// Projects and ids are fictional.

const UID = 501;
const SELF = 56232; // this dashboard server
const APP = 56219; // the Tauri shell
const DEAD_SERVER = 77418; // a dashboard server that no longer exists

const id = (n: number, kind = 'a'): string => `${kind.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TAB_LIVE = id(1, 'c'); // the tab whose claude is still running (37610)
const SESSION_ROTATED = id(2, 'e'); // the conversation the 12336 group was started from
const SESSION_LIVE = id(3, 'f');
const RESUME_ID = id(4, 'd');

const SERVER_ARGS = '/opt/homebrew/bin/node /Users/dev/.nvm/versions/node/v20.19.0/bin/dreamcontext dashboard --port 50398 --no-open --launcher';
const CHAT_CLAUDE = `claude -p --input-format stream-json --output-format stream-json --verbose --resume ${RESUME_ID}`;

interface Fx {
  uid?: number;
  pid: number;
  ppid: number;
  pgid: number;
  lstart?: string;
  args: string;
  /** Env as `ps -E` appends it; omitted = the empty env macOS shows for SIP binaries and wrappers. */
  env?: string;
}

const pad = (n: number): string => String(n).padStart(5);
const tableLine = (r: Fx): string =>
  `${pad(r.uid ?? UID)} ${pad(r.pid)} ${pad(r.ppid)} ${pad(r.pgid)} ${r.lstart ?? 'Sat Oct  3 15:35:39 2026'}${r.args ? `     ${r.args}` : '     '}`;
const envLine = (r: Fx): string => `${pad(r.pid)} ${r.args}${r.env ? ` ${r.env}` : ''}`;

const marked = (tab: string, opts: { server?: number; session?: string; extra?: string } = {}): string =>
  [
    'PATH=/usr/bin:/bin',
    `DREAMCONTEXT_SERVER_PID=${opts.server ?? DEAD_SERVER}`,
    `DREAMCONTEXT_TAB_SESSION=${tab}`,
    ...(opts.session ? [`CLAUDE_CODE_SESSION_ID=${opts.session}`] : []),
    'HOME=/Users/dev',
    ...(opts.extra ? [opts.extra] : []),
  ].join(' ');

const BASE: Fx[] = [
  { uid: 0, pid: 1, ppid: 0, pgid: 1, lstart: 'Sun Sep  6 11:56:51 2026', args: '/sbin/launchd' },
  { pid: APP, ppid: 1, pgid: APP, args: '/Applications/dreamcontext-beta.app/Contents/MacOS/dreamcontext-desktop', env: 'PATH=/usr/bin' },
  { pid: SELF, ppid: APP, pgid: SELF, args: SERVER_ARGS, env: 'PATH=/usr/bin DREAMCONTEXT_DESKTOP=1 HOME=/Users/dev' },
  // The live chat claude of tab TAB_LIVE; its conversation rotated (resume/fork/clear).
  {
    pid: 37610, ppid: SELF, pgid: SELF, args: CHAT_CLAUDE,
    env: marked(TAB_LIVE, { server: SELF, session: SESSION_LIVE }),
  },
];

/** The 8 groups measured reapable on 2026-10-03: four dead-tab `next dev`, a driver.js, three `tail -F`. */
function reapableGroups(): Fx[] {
  const rows: Fx[] = [];
  const nextDev = [40408, 56806, 60703, 70100];
  nextDev.forEach((pgid, i) => {
    const tab = id(100 + i);
    const app = `/Users/dev/projects/acme-shop-${i}/app`;
    rows.push(
      { pid: pgid + 3, ppid: 1, pgid, lstart: 'Tue Sep 22 20:29:13 2026', args: `node ${app}/node_modules/.bin/next dev -p 32${i}0`, env: marked(tab, { session: id(200 + i, 'b') }) },
      { pid: pgid + 4, ppid: pgid + 3, pgid, lstart: 'Tue Sep 22 20:29:14 2026', args: 'next-server (v16.1.1) ' },
      { pid: pgid + 5, ppid: pgid + 4, pgid, lstart: 'Tue Sep 22 20:29:20 2026', args: `node ${app}/.next/dev/build/postcss.js 55212`, env: marked(tab, { session: id(200 + i, 'b') }) },
    );
  });
  rows.push({ pid: 81002, ppid: 1, pgid: 81001, args: 'node /Users/dev/projects/acme-shop-0/scripts/driver.js --headless\\012--slow', env: marked(id(110)) });
  [82001, 83001, 84001].forEach((pgid, i) => {
    rows.push(
      { pid: pgid + 1, ppid: 1, pgid, args: `tail -F /tmp/acme-dev-${i}.log` },
      { pid: pgid + 2, ppid: 1, pgid, args: '/opt/homebrew/bin/ugrep --line-buffered -i error', env: marked(id(120 + i)) },
    );
  });
  return rows;
}
const REAPABLE_PGIDS = [40408, 56806, 60703, 70100, 81001, 82001, 83001, 84001];

/** A fake `ps` over a fixture world. Records every call so tests can read the `-p` list. */
function fakePs(
  rows: Fx[],
  opts: { omitEnv?: number[]; envCode?: 0 | 1; tableExtra?: string; fail?: 'table' | 'env' } = {},
): { run: RunPs; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunPs = async (args, okCodes) => {
    calls.push([...args]);
    if (args[0] === '-axww') {
      if (opts.fail === 'table') throw new PsError('timeout');
      return rows.map(tableLine).join('\n') + '\n' + (opts.tableExtra ?? '');
    }
    if (opts.fail === 'env') throw new PsError('enobufs');
    const wanted = new Set(args[args.length - 1].split(',').map(Number));
    const out = rows.filter((r) => wanted.has(r.pid) && !opts.omitEnv?.includes(r.pid)).map(envLine).join('\n') + '\n';
    const code = opts.envCode ?? 0;
    if (!okCodes.includes(code)) throw new PsError(`exit:${code}`);
    return out;
  };
  return { run, calls };
}

async function snap(rows: Fx[], opts: Parameters<typeof fakePs>[1] & { alive?: (pid: number) => boolean } = {}) {
  const { run, calls } = fakePs(rows, opts);
  const result = await takeSnapshot(run, opts.alive ?? (() => false), { selfPid: SELF, uid: UID });
  return { result, calls };
}

async function classify(rows: Fx[], selfEnv: NodeJS.ProcessEnv = {}) {
  const { result } = await snap(rows);
  if ('aborted' in result) throw new Error(`unexpected abort: ${result.aborted}`);
  return classifyOrphanGroups(result, SELF, selfEnv);
}

const pgids = (groups: { pgid: number }[]): number[] => groups.map((g) => g.pgid).sort((a, b) => a - b);
const envList = (calls: string[][]): number[] => {
  const envCall = calls.find((c) => c[0] === '-wwE');
  return envCall ? envCall[envCall.length - 1].split(',').map(Number) : [];
};

// ─── Parsing ──────────────────────────────────────────────────────────────────

describe('parseProcTable', () => {
  it('parses real padded lines, keeps trailing whitespace and `\\012`, tolerates empty args', () => {
    const out = [
      '    0     1     0     1 Sun Sep  6 11:56:51 2026     /sbin/launchd',
      '  501 40412 40411 40408 Tue Sep 22 20:29:14 2026     next-server (v16.1.1) ',
      '  501 81002     1 81001 Sat Oct  3 15:35:39 2026     node driver.js a\\012b',
      '  501 99001     1 99001 Sat Oct  3 15:35:39 2026',
      '',
    ].join('\n');
    const rows = parseProcTable(out)!;
    expect(rows.get(1)).toEqual({ uid: 0, pid: 1, ppid: 0, pgid: 1, lstart: 'Sun Sep  6 11:56:51 2026', args: '/sbin/launchd' });
    expect(rows.get(40412)!.args).toBe('next-server (v16.1.1) ');
    expect(rows.get(81002)!.args).toBe('node driver.js a\\012b');
    expect(rows.get(99001)!.args).toBe('');
  });

  it('returns null on any unparsable non-empty line', () => {
    expect(parseProcTable('  501 40412 40411 40408 Tue Sep 22 20:29:14 2026     ok\ngarbage line\n')).toBeNull();
  });
});

describe('parseEnvLines', () => {
  const rows = parseProcTable(BASE.map(tableLine).join('\n'))!;

  it('reads markers from the env remainder only', () => {
    const env = parseEnvLines(BASE.map(envLine).join('\n'), rows);
    expect(env.get(37610)).toEqual({ readable: true, serverPids: [SELF], tabIds: [TAB_LIVE], sessionIds: [SESSION_LIVE] });
  });

  it('a line that does not start with the table args is unknown', () => {
    const env = parseEnvLines(`37610 claude --other-args ${marked(TAB_LIVE)}`, rows);
    expect(env.get(37610)!.readable).toBe(false);
  });

  it('an empty env is unreadable', () => {
    const env = parseEnvLines(`${pad(APP)} ${BASE[1].args}`, rows);
    expect(env.get(APP)!.readable).toBe(false);
  });

  it('a marker in argv never counts', () => {
    const r: Fx = { pid: 9001, ppid: 1, pgid: 9000, args: `node x.js DREAMCONTEXT_TAB_SESSION=${id(9)} DREAMCONTEXT_SERVER_PID=${DEAD_SERVER}`, env: 'PATH=/usr/bin' };
    const env = parseEnvLines(envLine(r), parseProcTable(tableLine(r))!);
    expect(env.get(9001)).toEqual({ readable: true, serverPids: [], tabIds: [], sessionIds: [] });
  });
});

describe('predicates', () => {
  const row = (args: string): ProcRow => ({ uid: UID, pid: 2, ppid: 1, pgid: 2, lstart: '', args });

  it('ownerClaude: the claude binary or node running the npm CLI, never a wrapper', () => {
    expect(isOwnerClaude(row('claude -p hi'))).toBe(true);
    expect(isOwnerClaude(row('/Users/dev/.local/bin/claude --resume x'))).toBe(true);
    expect(isOwnerClaude(row('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js -p'))).toBe(true);
    expect(isOwnerClaude(row('caffeinate -i claude -p go'))).toBe(false);
    expect(isOwnerClaude(row('/bin/zsh -c cd x && claude -p go'))).toBe(false);
    expect(isOwnerClaude(row('node /Users/dev/.claude-worktrees/acme/next dev'))).toBe(false);
  });

  it('looseClaude matches wrappers but not ~/.claude paths', () => {
    expect(isLooseClaude(row('caffeinate -i claude -p go'))).toBe(true);
    expect(isLooseClaude(row('/bin/zsh -c source /Users/dev/.claude/shell-snapshots/s.sh && claude -p go'))).toBe(true);
    expect(isLooseClaude(row('/bin/zsh -c source /Users/dev/.claude/shell-snapshots/s.sh && npm run dev'))).toBe(false);
  });

  it('dashboardServer is strict; dashboardLooking is loose', () => {
    expect(isDashboardServer(row(SERVER_ARGS))).toBe(true);
    expect(isDashboardServer(row('node /Users/dev/projects/dreamcontext/dist/index.js dashboard --port 4000'))).toBe(true);
    expect(isDashboardServer(row('node --enable-source-maps dist/index.js dashboard'))).toBe(true);
    expect(isDashboardServer(row('/bin/zsh -c node dist/index.js dashboard --port 4000'))).toBe(false);
    expect(isDashboardServer(row('caffeinate -i node dist/index.js dashboard'))).toBe(false);
    expect(isDashboardServer(row('node dist/index.js tasks list'))).toBe(false);
    expect(isDashboardLooking(row('/bin/zsh -c node dist/index.js dashboard --port 4000'))).toBe(true);
    expect(isDashboardLooking(row('caffeinate -i node /x/bin/dreamcontext dashboard'))).toBe(true);
  });

  it('ledgerProgram is the sanitized argv0 basename and nothing else', () => {
    expect(ledgerProgram('next-server (v16.1.1) ')).toBe('next-server');
    expect(ledgerProgram('/opt/homebrew/bin/node server.js API_KEY=x Bearer y')).toBe('node');
    expect(ledgerProgram('/Applications/Weird App.app/Contents/MacOS/Weird App --flag')).toBe('Weird');
    expect(ledgerProgram('/tmp/ev$il;name`x`')).toBe('evilnamex');
    expect(ledgerProgram(`/tmp/${'a'.repeat(80)}`)).toHaveLength(40);
  });
});

// ─── The rule ─────────────────────────────────────────────────────────────────

describe('classifyOrphanGroups', () => {
  it('the 8 groups measured reapable on 2026-10-03 are candidates', async () => {
    const { candidates, paused } = await classify([...BASE, ...reapableGroups()]);
    expect(pgids(candidates)).toEqual(REAPABLE_PGIDS);
    expect(paused).toEqual([]);
    const g = candidates.find((c) => c.pgid === 40408)!;
    expect(g.tabId).toBe(id(100));
    expect(g.sessionId).toBe(id(200, 'b'));
    expect(g.members).toHaveLength(3);
  });

  it('keeps the rotated-session group whose TAB id a live claude still carries (12336 / 37610)', async () => {
    const rotated: Fx[] = [
      { pid: 22816, ppid: 1, pgid: 12336, args: 'node /Users/dev/projects/acme-pay/app/node_modules/.bin/next dev -p 3001', env: marked(TAB_LIVE, { session: SESSION_ROTATED }) },
      { pid: 49202, ppid: 22816, pgid: 12336, args: 'node /Users/dev/projects/acme-pay/app/.next/dev/build/postcss.js 64149', env: marked(TAB_LIVE, { session: SESSION_ROTATED }) },
    ];
    const { candidates } = await classify([...BASE, ...reapableGroups(), ...rotated]);
    expect(pgids(candidates)).not.toContain(12336);
    expect(pgids(candidates)).toEqual(REAPABLE_PGIDS);
  });

  it('a tab live only through a claude argv `--resume <T>` is kept', async () => {
    const t = id(300);
    const rows: Fx[] = [
      ...BASE,
      { pid: 46831, ppid: SELF, pgid: SELF, args: `claude -p --verbose --resume ${t}`, env: 'PATH=/usr/bin HOME=/Users/dev' },
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node server.js', env: marked(t) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it("a tab id only in another live dashboard server's env is kept", async () => {
    const t = id(301);
    const rows: Fx[] = [
      ...BASE,
      { pid: 60000, ppid: 1, pgid: 60000, args: 'node /Users/dev/projects/dreamcontext/dist/index.js dashboard --port 4100', env: `PATH=/usr/bin DREAMCONTEXT_TAB_SESSION=${t}` },
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node server.js', env: marked(t) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a tab id in this server\'s own process.env is kept', async () => {
    const t = id(302);
    const rows: Fx[] = [...BASE, { pid: 7001, ppid: 1, pgid: 7000, args: 'node server.js', env: marked(t) }];
    expect(pgids((await classify(rows, { DREAMCONTEXT_TAB_SESSION: t })).candidates)).toEqual([]);
    expect(pgids((await classify(rows, { CLAUDE_CODE_SESSION_ID: t })).candidates)).toEqual([]);
    expect(pgids((await classify(rows, {})).candidates)).toEqual([7000]);
  });

  it("a reparented live claude's own group is kept", async () => {
    const t = id(303);
    const rows: Fx[] = [
      ...BASE,
      { pid: 2900, ppid: 1, pgid: 2899, args: 'claude -p build it', env: 'PATH=/usr/bin' },
      { pid: 2901, ppid: 2900, pgid: 2899, args: 'node server.js', env: marked(t) },
      { pid: 2950, ppid: 2900, pgid: 2950, args: 'node other.js' },
      { pid: 2951, ppid: 2950, pgid: 2949, args: 'node grandchild.js', env: marked(t) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a group whose leader is alive is kept', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 15765, ppid: 1, pgid: 15765, args: '/usr/bin/java -jar /Users/dev/.cache/firebase/emulators/firestore.jar', env: marked(id(304)) },
      { pid: 15766, ppid: 15765, pgid: 15765, args: 'node x.js', env: marked(id(304)) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a looseClaude member or ancestor with an EMPTY env keeps the group and does not abort', async () => {
    const rows: Fx[] = [
      ...BASE,
      // member
      { pid: 40649, ppid: 1, pgid: 40648, args: '/bin/zsh -c source /Users/dev/.claude/shell-snapshots/s.sh && claude -p plan it' },
      { pid: 40650, ppid: 1, pgid: 40648, args: 'node server.js', env: marked(id(305)) },
      // ancestor
      { pid: 62241, ppid: 1, pgid: 62241, args: 'caffeinate -i claude -p You are builder w1-A' },
      { pid: 62300, ppid: 62241, pgid: 62299, args: 'node server.js', env: marked(id(306)) },
    ];
    const { result } = await snap(rows);
    expect('aborted' in result).toBe(false);
    expect(pgids(classifyOrphanGroups(result as Snapshot, SELF, {}).candidates)).toEqual([]);
  });

  it('a group without a tab id (SERVER_PID + session only) is kept', async () => {
    const rows: Fx[] = [...BASE, { pid: 7001, ppid: 1, pgid: 7000, args: 'node server.js', env: `DREAMCONTEXT_SERVER_PID=${DEAD_SERVER} CLAUDE_CODE_SESSION_ID=${id(307)}` }];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a group with a tab id but no SERVER_PID is kept', async () => {
    const rows: Fx[] = [...BASE, { pid: 7001, ppid: 1, pgid: 7000, args: 'node server.js', env: `DREAMCONTEXT_TAB_SESSION=${id(308)}` }];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a group whose members carry different tab ids is kept', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node a.js', env: marked(id(309)) },
      { pid: 7002, ppid: 1, pgid: 7000, args: 'node b.js', env: marked(id(310)) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a group with a dashboard-server member is kept', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node /Users/dev/projects/dreamcontext/dist/index.js dashboard --port 4200', env: marked(id(311)) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it("a group holding this server's ancestor is kept", async () => {
    const rows: Fx[] = [
      { uid: 0, pid: 1, ppid: 0, pgid: 1, args: '/sbin/launchd' },
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node launcher.js', env: marked(id(312)) },
      { pid: SELF, ppid: 7001, pgid: SELF, args: SERVER_ARGS, env: 'PATH=/usr/bin' },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a strict server row inside an escaped dead-leader group does not pin its tab live', async () => {
    const t = id(313);
    const rows: Fx[] = [
      ...BASE,
      // an agent's leftover verify dashboard: itself kept by rule 4
      { pid: 8001, ppid: 1, pgid: 8000, args: 'node /Users/dev/projects/dreamcontext/dist/index.js dashboard --port 4300', env: marked(t) },
      { pid: 8101, ppid: 1, pgid: 8100, args: 'node server.js', env: marked(t) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([8100]);
  });

  it('`zsh -c … node dist/index.js dashboard` and `caffeinate -i node … dashboard` wrappers with EMPTY env: no abort, group kept', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 9001, ppid: 1, pgid: 9000, args: '/bin/zsh -c node dist/index.js dashboard --port 4400 --no-open' },
      { pid: 9002, ppid: 9001, pgid: 9000, args: 'node server.js', env: marked(id(314)) },
      { pid: 9101, ppid: 1, pgid: 9101, args: 'caffeinate -i node /Users/dev/projects/dreamcontext/dist/index.js dashboard' },
    ];
    const { result } = await snap(rows);
    expect('aborted' in result).toBe(false);
    expect(pgids(classifyOrphanGroups(result as Snapshot, SELF, {}).candidates)).toEqual([]);
  });

  it('a forged second marker inside a member env value makes it ambiguous → kept', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node a.js', env: marked(id(315), { extra: `NOTE=x DREAMCONTEXT_TAB_SESSION=${id(316)}` }) },
      { pid: 7101, ppid: 1, pgid: 7100, args: 'node b.js', env: marked(id(317), { extra: `NOTE=x DREAMCONTEXT_SERVER_PID=${SELF}` }) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a forged second marker on an OWNER row makes both ids live', async () => {
    const a = id(318);
    const b = id(319);
    const rows: Fx[] = [
      ...BASE,
      { pid: 46000, ppid: SELF, pgid: SELF, args: 'claude -p go', env: `PATH=/usr/bin DREAMCONTEXT_TAB_SESSION=${a} NOTE=x DREAMCONTEXT_TAB_SESSION=${b}` },
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node a.js', env: marked(a) },
      { pid: 7101, ppid: 1, pgid: 7100, args: 'node b.js', env: marked(b) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a marker in argv of an unmarked process never attributes it', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 7001, ppid: 1, pgid: 7000, args: `node x.js DREAMCONTEXT_SERVER_PID=${DEAD_SERVER} DREAMCONTEXT_TAB_SESSION=${id(320)}`, env: 'PATH=/usr/bin' },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('SERVER_PID naming another LIVE process → paused, not a candidate', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 5555, ppid: 1, pgid: 5555, args: '/usr/sbin/cfprefsd agent' },
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node a.js', env: marked(id(321), { server: 5555 }) },
    ];
    const { candidates, paused } = await classify(rows);
    expect(pgids(candidates)).toEqual([]);
    expect(pgids(paused)).toEqual([7000]);
  });

  it('SERVER_PID dead or equal to this server → eligible', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node a.js', env: marked(id(322), { server: SELF }) },
      { pid: 7101, ppid: 1, pgid: 7100, args: 'node b.js', env: marked(id(323), { server: 99999 }) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([7000, 7100]);
  });

  it('other-uid rows are never members, owners, or abort causes', async () => {
    const t = id(324);
    const rows: Fx[] = [
      ...BASE,
      // another user's claude carrying t, with no readable env: neither owner nor abort
      { uid: 502, pid: 46100, ppid: 1, pgid: 46100, args: 'claude -p theirs' },
      { uid: 502, pid: 46101, ppid: 1, pgid: 46102, args: 'node theirs.js', env: marked(id(325)) },
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node a.js', env: marked(t) },
      // a mixed-uid group is never escaped
      { pid: 7101, ppid: 1, pgid: 7100, args: 'node b.js', env: marked(id(326)) },
      { uid: 502, pid: 7102, ppid: 1, pgid: 7100, args: 'node c.js' },
    ];
    const { result, calls } = await snap(rows);
    expect('aborted' in result).toBe(false);
    expect(envList(calls)).not.toContain(46100);
    expect(envList(calls)).not.toContain(46101);
    expect(pgids(classifyOrphanGroups(result as Snapshot, SELF, {}).candidates)).toEqual([7000]);
  });

  it('an ancestry cycle reads as a claude ancestor → kept', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 7001, ppid: 7002, pgid: 7000, args: 'node a.js', env: marked(id(327)) },
      { pid: 7002, ppid: 7001, pgid: 7003, args: 'node b.js' },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('a group whose only marked member died (SIP-only remainder) is kept', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 7001, ppid: 1, pgid: 7000, args: 'tail -F /tmp/acme.log' },
      { pid: 7002, ppid: 1, pgid: 7000, args: 'sleep 3600' },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('this server row counts as a dashboard server even when the strict predicate misses', async () => {
    const t = id(328);
    const rows: Fx[] = [
      { uid: 0, pid: 1, ppid: 0, pgid: 1, args: '/sbin/launchd' },
      { pid: SELF, ppid: 1, pgid: SELF, args: 'node --inspect /x/server-entry.js', env: `PATH=/usr/bin DREAMCONTEXT_TAB_SESSION=${t}` },
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node a.js', env: marked(t) },
    ];
    expect(pgids((await classify(rows)).candidates)).toEqual([]);
  });

  it('escapedGroups never returns pgid 0, 1 or NaN', () => {
    const rows = new Map<number, ProcRow>([
      [10, { uid: UID, pid: 10, ppid: 1, pgid: 0, lstart: '', args: 'node a.js' }],
      [11, { uid: UID, pid: 11, ppid: 1, pgid: 1, lstart: '', args: 'node b.js' }],
      [12, { uid: UID, pid: 12, ppid: 1, pgid: Number.NaN, lstart: '', args: 'node c.js' }],
    ]);
    expect([...escapedGroups(rows, UID).keys()]).toEqual([]);
  });
});

// ─── Fail closed ──────────────────────────────────────────────────────────────

describe('takeSnapshot fails closed', () => {
  it('an ownerClaude with an empty env aborts', async () => {
    const rows: Fx[] = [...BASE, { pid: 46000, ppid: SELF, pgid: SELF, args: 'claude -p go' }];
    expect((await snap(rows)).result).toEqual({ aborted: 'owner-unreadable' });
  });

  it('a strict dashboard server with an empty env aborts', async () => {
    const rows: Fx[] = [...BASE, { pid: 60000, ppid: 1, pgid: 60000, args: 'node /x/dist/index.js dashboard --port 4100' }];
    expect((await snap(rows)).result).toEqual({ aborted: 'owner-unreadable' });
  });

  it('an ownerClaude missing from the env output: dead on re-probe → not aborted, alive → aborted', async () => {
    const t = id(400);
    const rows: Fx[] = [
      ...BASE,
      { pid: 46000, ppid: SELF, pgid: SELF, args: 'claude -p go', env: marked(t, { server: SELF }) },
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node a.js', env: marked(t) },
    ];
    const dead = await snap(rows, { omitEnv: [46000], alive: () => false });
    expect('aborted' in dead.result).toBe(false);
    // gone owner: its tab is no longer live
    expect(pgids(classifyOrphanGroups(dead.result as Snapshot, SELF, {}).candidates)).toEqual([7000]);
    const alive = await snap(rows, { omitEnv: [46000], alive: (pid) => pid === 46000 });
    expect(alive.result).toEqual({ aborted: 'owner-unreadable' });
  });

  it('a hedge row with no env does not abort', async () => {
    const rows: Fx[] = [...BASE, { pid: 47000, ppid: SELF, pgid: SELF, args: 'renamed-tool --serve' }];
    const { result, calls } = await snap(rows);
    expect('aborted' in result).toBe(false);
    expect(envList(calls)).toContain(47000);
  });

  it("a tab-carrying direct child of a live dashboard server pins that tab, and its env is requested", async () => {
    const t = id(401);
    const rows: Fx[] = [
      ...BASE,
      { pid: 47000, ppid: SELF, pgid: SELF, args: 'agent-runtime (v3)', env: marked(t, { server: SELF }) },
      { pid: 7001, ppid: 1, pgid: 7000, args: 'node a.js', env: marked(t) },
    ];
    const { result, calls } = await snap(rows);
    expect(envList(calls)).toEqual(expect.arrayContaining([SELF, 37610, 47000, 7001]));
    expect(pgids(classifyOrphanGroups(result as Snapshot, SELF, {}).candidates)).toEqual([]);
  });

  it('the env -p list always holds this server and only what matters', async () => {
    const { calls } = await snap([...BASE, ...reapableGroups(), { pid: 5555, ppid: 1, pgid: 5555, args: '/usr/sbin/cfprefsd agent' }]);
    const list = envList(calls);
    expect(list).toContain(SELF);
    expect(list).toContain(37610);
    expect(list).toContain(40412); // the retitled next-server member of an escaped group
    expect(list).not.toContain(5555);
    expect(list).not.toContain(APP);
  });

  it('env exit code 1 with partial stdout is parsed', async () => {
    const { result } = await snap([...BASE, ...reapableGroups()], { envCode: 1 });
    expect(pgids(classifyOrphanGroups(result as Snapshot, SELF, {}).candidates)).toEqual(REAPABLE_PGIDS);
  });

  it('an unparsable table line aborts', async () => {
    expect((await snap(BASE, { tableExtra: 'ps: something odd\n' })).result).toEqual({ aborted: 'table' });
  });

  it('a ps throw or timeout aborts', async () => {
    expect((await snap(BASE, { fail: 'table' })).result).toEqual({ aborted: 'table' });
    expect((await snap(BASE, { fail: 'env' })).result).toEqual({ aborted: 'env' });
  });
});

describe('createRunPs', () => {
  const SECRET = `DREAMCONTEXT_TAB_SESSION=${id(500)} ANTHROPIC_API_KEY=SECRET`;
  const reject = (fields: Record<string, unknown>) => async () => {
    throw Object.assign(new Error('Command failed: ps -wwE …'), { stdout: SECRET, stderr: SECRET, cmd: `ps ${SECRET}` }, fields);
  };

  it('accepts an ok non-zero exit only with stdout', async () => {
    const run = createRunPs(reject({ code: 1 }));
    expect(await run(['-wwE'], [0, 1])).toBe(SECRET);
    const empty = createRunPs(async () => { throw Object.assign(new Error('x'), { code: 1, stdout: '' }); });
    await expect(empty(['-wwE'], [0, 1])).rejects.toMatchObject({ psClass: 'exit:1' });
  });

  it('rethrows a bare class string — no stdout, no cause', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ code: 1 }, 'exit:1'],
      [{ code: 2 }, 'exit:2'],
      [{ killed: true, signal: 'SIGTERM', code: null }, 'timeout'],
      [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'enobufs'],
      [{ code: 'ENOENT' }, 'spawn'],
    ];
    for (const [fields, cls] of cases) {
      const err = await createRunPs(reject(fields))(['-axww'], [0]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PsError);
      expect((err as PsError).psClass).toBe(cls);
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(JSON.stringify(err) + String(err) + Object.keys(err as object).join()).not.toContain('SECRET');
    }
  });
});

// ─── Real ps (darwin only) ────────────────────────────────────────────────────

describe.runIf(process.platform === 'darwin')('real ps smoke test', () => {
  let child: ChildProcess | null = null;
  afterAll(() => { child?.kill('SIGKILL'); });

  it('finds the markers of a spawned marked child through the full chain', async (ctx) => {
    const tab = id(600);
    child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], {
      env: { ...process.env, DREAMCONTEXT_SERVER_PID: '424242', DREAMCONTEXT_TAB_SESSION: tab },
      stdio: 'ignore',
    });
    const pid = child.pid!;
    let row: ProcRow | undefined;
    for (let i = 0; i < 50 && !row; i++) {
      const rows = parseProcTable(await runPs(['-axww', '-o', 'uid=,pid=,ppid=,pgid=,lstart=,args='], [0]));
      expect(rows).not.toBeNull();
      row = rows!.get(pid);
      if (!row || !row.args.includes('setTimeout')) { row = undefined; await new Promise((r) => setTimeout(r, 100)); }
    }
    expect(row).toBeDefined();
    expect(row!.uid).toBe(process.getuid!());

    const envOut = await runPs(['-wwE', '-o', 'pid=,command=', '-p', String(pid)], [0, 1]);
    if (!envOut.includes('PATH=')) ctx.skip();
    const markers = parseEnvLines(envOut, new Map([[pid, row!]])).get(pid);
    expect(markers).toEqual({ readable: true, serverPids: [424242], tabIds: [tab], sessionIds: expect.any(Array) });
  });
});
