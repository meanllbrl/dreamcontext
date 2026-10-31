import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountIndexAt, currentLedger, ledgerRoots, loadLedger, scanLedger, sessionAccounts } from '../../src/lib/usage-ledger.js';
import { buildStats } from '../../src/lib/usage-report.js';
import { SUPER_BIRTH_OPENINGS, claudeSleepMark, initialCodexState, parseCodexRecord, parseLimitHit } from '../../src/lib/usage-readers.js';
import { resolvePrice } from '../../src/lib/usage-pricing.js';
import { closeSleepRun, logHandoff, noteSleepRunCost, openSleepRun, readLimitHistory, readSleepRuns } from '../../src/lib/usage-records.js';
import { recordUsageMeter } from '../../src/lib/claude-usage-meter.js';

const NOW = Date.parse('2026-10-20T15:30:00Z');
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();

function assistant(id: string, req: string, ts: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}, content: unknown[] = []) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, requestId: req, cwd: '/work/alpha', message: { id, model: 'claude-opus-5-5', usage, content }, ...extra });
}
const U = (i: number, o = 10) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

describe('usage ledger', () => {
  let home: string;
  let proj: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-ledger-'));
    proj = join(home, '.claude', 'projects', '-work-alpha');
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const write = (name: string, lines: string[]) => writeFileSync(join(proj, name), lines.join('\n') + '\n');
  const scan = () => scanLedger(home, ledgerRoots(home));
  const stats = (range: '24h' | '7d' = '7d') => buildStats({ range, project: null, off: new Set(), now: NOW }, home);

  it('counts one message once: the key is message.id + requestId, across files', async () => {
    write('s1.jsonl', [
      assistant('m1', 'r1', at(30), U(100)),
      assistant('m1', 'r1', at(30), U(100)),       // a second content block repeats the usage
      assistant('m1', 'r2', at(29), U(50)),        // same message, a new request: counts
    ]);
    write('s2.jsonl', [assistant('m1', 'r1', at(30), U(100)), assistant('m9', 'r9', at(20), U(7))]); // a resumed copy
    await scan();
    const s = stats();
    expect(s.totals.input).toBe(157);
    expect(s.totals.output).toBe(30);
  });

  it('skips the synthetic placeholder and never reads a tool result summary as usage', async () => {
    write('s1.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: at(5), requestId: 'x', message: { id: 'x', model: '<synthetic>', usage: U(999) } }),
      JSON.stringify({ type: 'user', timestamp: at(4), toolUseResult: { usage: U(5000), totalTokens: 5000 } }),
      assistant('m1', 'r1', at(3), U(11)),
    ]);
    await scan();
    expect(stats().totals.input).toBe(11);
  });

  it('a sub-agent counts in its own file and its specialist name comes from the meta file', async () => {
    write('s1.jsonl', [assistant('m1', 'r1', at(30), U(10))]);
    const sub = join(proj, 's1', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-a1.jsonl'), assistant('a1', 'ra', at(29), U(40)) + '\n');
    writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'sleep-tasks', effort: 'low' }));
    await scan();
    const s = stats();
    expect(s.totals.input).toBe(50);
    expect(s.dc.sleep.tokens).toBe(50); // 40 in + 10 out of the one sleep file
    expect(s.dc.sleep.runs).toHaveLength(1);
    expect(s.dc.sleep.specialists[0]).toMatchObject({ name: 'sleep-tasks', effort: 'low' });
  });

  it('sleep and memory are parts of the total; Eco stays outside it', async () => {
    const sleepCall = (cmd: string) => [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }];
    write('s1.jsonl', [
      JSON.stringify({ type: 'attachment', timestamp: at(60), attachment: { type: 'hook_success', hookEvent: 'SessionStart', command: 'dreamcontext hook session-start', content: 'x'.repeat(350), stdout: 'y'.repeat(99999) } }),
      assistant('m1', 'r1', at(50), U(1000)),
      assistant('m2', 'r2', at(40), U(2000), {}, sleepCall('dreamcontext sleep start')),
      assistant('m3', 'r3', at(30), U(4000)),
      assistant('m4', 'r4', at(20), U(8000), {}, sleepCall('dreamcontext sleep done --summary x')),
      assistant('m5', 'r5', at(10), U(16000)),
    ]);
    await scan();
    const s = stats('24h');
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(s.dc.memory.first).toBe(100);              // the 350 chars the model got, not the 99999 of stdout
    expect(s.dc.memory.carried).toBe(100 + 0);        // carried on the next normal request; sleep rows are not memory
    expect(sum(s.dc.chart.sleep)).toBe(2000 + 4000 + 8000 + 30);
    expect(sum(s.dc.chart.sleep) + sum(s.dc.chart.work) + sum(s.dc.chart.memory)).toBe(s.totals.tokens);
    expect(s.dc.sleep.runs).toHaveLength(1);
  });

  it('rereads only a changed file, and a deleted log keeps its numbers', async () => {
    write('s1.jsonl', [assistant('m1', 'r1', at(30), U(10))]);
    write('s2.jsonl', [assistant('m2', 'r2', at(30), U(20))]);
    await scan();
    const first = currentLedger(home).files[join(proj, 's1.jsonl')];
    write('s2.jsonl', [assistant('m2', 'r2', at(30), U(20)), assistant('m3', 'r3', at(20), U(5))]);
    await scan();
    expect(currentLedger(home).files[join(proj, 's1.jsonl')]).toBe(first);
    expect(stats().totals.input).toBe(35);
    rmSync(join(proj, 's1.jsonl'));
    await scan();
    expect(stats().totals.input).toBe(35);
  });

  it('a linked account folder is one root, and session-env says who ran a session', async () => {
    const sandbox = join(home, '.dreamcontext', 'claude-accounts', 'a-1');
    mkdirSync(join(sandbox, 'session-env', 'sess-1'), { recursive: true });
    symlinkSync(join(home, '.claude', 'projects'), join(sandbox, 'projects'));
    writeFileSync(join(home, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({ accounts: [{ id: 'a-1', email: 'a@example.com', configDir: sandbox }] }));
    expect(ledgerRoots(home).filter((r) => r.tool === 'claude')).toHaveLength(1);
    expect(sessionAccounts(home).get('sess-1')?.[0][1]).toBe('a-1');
    const list: Array<[number, string]> = [[100, 'a'], [200, 'b']];
    expect([accountIndexAt(list, 50), accountIndexAt(list, 150), accountIndexAt(list, 250)]).toEqual([0, 0, 1]);
  });

  it('reads the real end of a window from the limit message', () => {
    const ts = new Date(2026, 9, 20, 18, 0, 0).getTime();
    const hit = parseLimitHit("You've hit your session limit · resets 9:40pm (Europe/Istanbul)", ts);
    expect(hit.kind).toBe('session');
    expect(new Date(hit.resetsAt as number).getHours()).toBe(21);
    expect(new Date(hit.resetsAt as number).getMinutes()).toBe(40);
    expect(parseLimitHit("You've hit your weekly limit · resets Oct 25 at 4am (Europe/Istanbul)", ts).kind).toBe('weekly');
    expect(parseLimitHit('something else', ts).resetsAt).toBeNull();
  });

  it('answers yes when a window ran out with sleep as most of its spend', async () => {
    const reset = new Date(NOW + 60 * 60_000);
    const text = `You've hit your session limit · resets ${reset.getHours() % 12 || 12}${reset.getHours() >= 12 ? 'pm' : 'am'} (UTC)`;
    write('s1.jsonl', [
      assistant('m1', 'r1', at(120), U(100000, 1000)),
      JSON.stringify({ type: 'assistant', timestamp: at(5), error: 'rate_limit', message: { id: 'h', model: '<synthetic>', usage: U(0, 0), content: [{ type: 'text', text }] } }),
    ]);
    const sub = join(proj, 's1', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-a1.jsonl'), assistant('a1', 'ra', at(60), U(900000, 9000)) + '\n');
    writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'sleep-product' }));
    mkdirSync(join(home, '.claude', 'session-env', 's1'), { recursive: true });
    await scan();
    const a = stats().dc.answer;
    expect(a.verdict).toBe('yes');
    expect(a.hits).toBe(1);
    expect(a.worst?.estSleepShare).toBeGreaterThan(0.5);
  });

  it('an unknown model stays unpriced: its tokens count, its cost does not', () => {
    expect(resolvePrice('gpt-6-luna', { prices: {}, alias: {} }).price).toBeNull();
    expect(resolvePrice('claude-opus-5-5', { prices: {}, alias: {} }).source).toBe('list');
    expect(resolvePrice('gpt-6-luna', { prices: {}, alias: { 'gpt-6-luna': 'claude-opus-5-5' } }).price).not.toBeNull();
    expect(resolvePrice('x', { prices: { x: [1, 2, 3, 4] }, alias: {} }).source).toBe('yours');
  });

  it('Codex: carries the model, counts one request once, ignores a fork\'s copied history', () => {
    const st = initialCodexState();
    const ts = (s: number) => new Date(NOW + s * 1000).toISOString();
    const count = (last: object, total: object, s: number) => parseCodexRecord({ timestamp: ts(s), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } } }, st);
    parseCodexRecord({ timestamp: ts(0), type: 'session_meta', payload: { id: 'c1', cwd: '/w', creator_account_id: 'acc' } }, st);
    expect(count({ input_tokens: 10, output_tokens: 1, total_tokens: 11 }, { input_tokens: 10, output_tokens: 1, total_tokens: 11 }, 1)).toBeNull(); // no model yet
    parseCodexRecord({ timestamp: ts(2), type: 'turn_context', payload: { model: 'gpt-x' } }, st);
    const u1 = { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2, total_tokens: 22 };
    const line = count(u1, { input_tokens: 30, cached_input_tokens: 5, output_tokens: 3, total_tokens: 33 }, 3);
    expect(line?.totals).toEqual({ input: 15, cacheRead: 5, cacheWrite: 0, output: 2 });
    expect(count(u1, { input_tokens: 30, cached_input_tokens: 5, output_tokens: 3, total_tokens: 33 }, 4)).toBeNull(); // re-emitted

    const fork = initialCodexState();
    parseCodexRecord({ timestamp: ts(0), type: 'session_meta', payload: { id: 'c2', forked_from_id: 'c1' } }, fork);
    parseCodexRecord({ timestamp: ts(0), type: 'turn_context', payload: { model: 'gpt-x' } }, fork);
    expect(parseCodexRecord({ timestamp: ts(0), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: u1, total_token_usage: u1 } } }, fork)).toBeNull();
  });

  it('a sleep run keeps its lines by run id, and the newest open one is the one closed', () => {
    const root = join(home, 'v', '_dream_context');
    const run = openSleepRun(root, 63, { CLAUDE_CODE_SESSION_ID: 's9', DREAMCONTEXT_AUTO_SLEEP: '1' } as NodeJS.ProcessEnv);
    closeSleepRun(root, 7);
    noteSleepRunCost(root, 's9', 1.25);
    expect(readSleepRuns(root)).toEqual([expect.objectContaining({ run, session: 's9', trigger: 'background', debtBefore: 63, debtAfter: 7, costUsd: 1.25 })]);
  });

  it('a limit reading goes on the history only when it moved', () => {
    const dir = join(home, '.dreamcontext', 'claude-accounts', 'a-1');
    const reading = (percent: number, ms: number) => ({ limits: [{ key: 'session' as const, percent, resetsAt: NOW + 3_600_000 }], fetchedAtMs: ms });
    recordUsageMeter(dir, reading(10, NOW), home);
    recordUsageMeter(dir, reading(10, NOW + 60_000), home);
    recordUsageMeter(dir, reading(20, NOW + 120_000), home);
    expect(readLimitHistory(home).map((p) => p.percent)).toEqual([10, 20]);
  });

  it('a limit that ran out on far less spend than usual does not decide the answer', async () => {
    const stamp = (min: number, hour: number) => JSON.stringify({ type: 'assistant', timestamp: at(min), error: 'rate_limit', message: { id: `h${min}`, model: '<synthetic>', usage: U(0, 0), content: [{ type: 'text', text: `You've hit your session limit · resets ${hour % 12 || 12}${hour >= 12 ? 'pm' : 'am'}` }] } });
    const hourAfter = (min: number) => new Date(NOW - min * 60_000 + 3_600_000).getHours();
    const big = 2 * 24 * 60;
    write('s1.jsonl', [assistant('b1', 'r1', at(big + 60), U(5_000_000, 5000)), stamp(big, hourAfter(big))]);
    write('s2.jsonl', [stamp(5, hourAfter(5))]);
    const sub = join(proj, 's2', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-a1.jsonl'), assistant('a1', 'ra', at(30), U(10_000, 100)) + '\n');
    writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'sleep-state' }));
    mkdirSync(join(home, '.claude', 'session-env', 's1'), { recursive: true });
    mkdirSync(join(home, '.claude', 'session-env', 's2'), { recursive: true });
    await scan();
    const a = stats().dc.answer;
    expect(a.hits).toBe(2);
    expect(a.verdict).toBe('no');
  });

  it('a repeat raises the output to the final count and nothing else; a 1-hour write is billed at its own rate', async () => {
    write('s1.jsonl', [
      assistant('m1', 'r1', at(30), { ...U(100, 3), cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000 } }),
      assistant('m1', 'r1', at(30), { ...U(100, 90), cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000 } }),
    ]);
    await scan();
    const s = stats();
    expect(s.totals.input).toBe(100);
    expect(s.totals.output).toBe(90);
    expect(s.totals.costParts[2]).toBeCloseTo(1000 * 4 * 2 / 1e6, 9); // Opus 5.5 input is 4
  });

  it('a background run keeps the rows after its own sleep start', async () => {
    write('s1.jsonl', [
      JSON.stringify({ type: 'user', timestamp: at(40), message: { content: 'Think hard. Run a full dreamcontext memory consolidation now' } }),
      assistant('m1', 'r1', at(39), U(100, 0)),
      assistant('m2', 'r2', at(38), U(1000, 0), {}, [{ type: 'tool_use', name: 'Bash', input: { command: 'dreamcontext sleep start' } }]),
      assistant('m3', 'r3', at(37), U(10000, 0)),
    ]);
    await scan();
    const s = stats();
    expect(s.dc.sleep.tokens).toBe(11100);
    expect(s.dc.sleep.runs).toHaveLength(1);
  });

  it('prose and --help open no sleep', () => {
    const call = (command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
    expect(claudeSleepMark(call('echo "per the skill: dreamcontext sleep start, then dispatch"'))).toBeNull();
    expect(claudeSleepMark(call('dreamcontext sleep done --help'))).toBeNull();
    expect(claudeSleepMark(call('cd /x && dreamcontext sleep start --deep'))).toBe('start');
    expect(claudeSleepMark(call('FOO=1 /usr/local/bin/dreamcontext sleep done --summary x'))).toBe('done');
  });

  it('a Codex rollout moved to the archive is one set of requests', async () => {
    const dir = join(home, '.codex', 'sessions');
    const arch = join(home, '.codex', 'archived_sessions');
    mkdirSync(dir, { recursive: true });
    mkdirSync(arch, { recursive: true });
    const lines = [
      JSON.stringify({ timestamp: at(30), type: 'session_meta', payload: { id: 'c1', cwd: '/w' } }),
      JSON.stringify({ timestamp: at(30), type: 'turn_context', payload: { model: 'gpt-x' } }),
      JSON.stringify({ timestamp: at(29), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } } }),
    ].join('\n') + '\n';
    writeFileSync(join(dir, 'rollout-1.jsonl'), lines);
    await scan();
    expect(stats().totals.tokens).toBe(110);
    rmSync(join(dir, 'rollout-1.jsonl'));
    writeFileSync(join(arch, 'rollout-1.jsonl'), lines);
    await scan();
    expect(stats().totals.tokens).toBe(110);
  });

  it('hiding an account hides its rows, not the session it ended on', async () => {
    const a = join(home, '.dreamcontext', 'claude-accounts', 'a-1');
    const b = join(home, '.dreamcontext', 'claude-accounts', 'b-1');
    mkdirSync(join(a, 'session-env', 's1'), { recursive: true });
    await new Promise((r) => setTimeout(r, 20));
    const switched = Date.now();
    mkdirSync(join(b, 'session-env', 's1'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({ accounts: [{ id: 'a-1', email: 'a@example.com', configDir: a }, { id: 'b-1', email: 'b@example.com', configDir: b }] }));
    const iso = (ms: number) => new Date(ms).toISOString();
    write('s1.jsonl', [assistant('m1', 'r1', iso(switched - 3_600_000), U(100, 0)), assistant('m2', 'r2', iso(switched + 3_600_000), U(1000, 0))]);
    await scan();
    const q = (off: string[]) => buildStats({ range: '7d', project: null, off: new Set(off), now: switched + 7_200_000 }, home).totals.input;
    expect(q([])).toBe(1100);
    expect(q(['claude:b-1'])).toBe(100);
    expect(q(['claude:a-1'])).toBe(1000);
  });

  it('a logged handoff outlives the 7-day record, once', async () => {
    const root = join(home, 'v', '_dream_context');
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'alpha', path: join(home, 'v') }] }));
    logHandoff(root, { title: 'T', at: at(600), contextTokens: 300000, fromSession: 'old', toSession: 'fresh', consumedAt: at(599), actedAt: at(599) });
    write('fresh.jsonl', [assistant('m1', 'r1', at(598), U(50000, 0)), assistant('m2', 'r2', at(597), U(50000, 0))]);
    await scan();
    const eco = stats().dc.eco;
    expect(eco.rows).toHaveLength(1);
    expect(eco.rows[0]).toMatchObject({ before: 300000, after: 50000, turns: 1, kind: 'eco' });
  });

  it('a list of accounts only grows: losing one never moves what was counted', async () => {
    const a = join(home, '.dreamcontext', 'claude-accounts', 'a-1');
    const b = join(home, '.dreamcontext', 'claude-accounts', 'b-1');
    mkdirSync(join(a, 'session-env', 's1'), { recursive: true });
    await new Promise((r) => setTimeout(r, 20));
    const switched = Date.now();
    mkdirSync(join(b, 'session-env', 's1'), { recursive: true });
    const reg = join(home, '.dreamcontext', 'claude-accounts.json');
    writeFileSync(reg, JSON.stringify({ accounts: [{ id: 'a-1', email: 'a@example.com', configDir: a }, { id: 'b-1', email: 'b@example.com', configDir: b }] }));
    const iso = (ms: number) => new Date(ms).toISOString();
    write('s1.jsonl', [assistant('m1', 'r1', iso(switched - 3_600_000), U(100, 0)), assistant('m2', 'r2', iso(switched + 3_600_000), U(1000, 0))]);
    await scan();
    rmSync(join(a, 'session-env', 's1'), { recursive: true });
    writeFileSync(reg, JSON.stringify({ accounts: [{ id: 'b-1', email: 'b@example.com', configDir: b }] }));
    await scan();
    const q = buildStats({ range: '7d', project: null, off: new Set(['claude:b-1']), now: switched + 7_200_000 }, home);
    expect(q.totals.input).toBe(100);
  });

  it('a state file that is a committed symlink is never written through', () => {
    const root = join(home, 'v', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    const target = join(home, 'outside.txt');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(root, 'state', '.handoff-log.jsonl'));
    logHandoff(root, { title: '$(id)', at: at(1), contextTokens: 1, fromSession: 'x', consumedAt: at(1) });
    expect(readFileSync(target, 'utf-8')).toBe('keep');
  });

  it('limits that ran out but no window the logs explain read as unclear, never as none', async () => {
    const hour = new Date(NOW + 3_600_000).getHours();
    const text = `You've hit your session limit · resets ${hour % 12 || 12}${hour >= 12 ? 'pm' : 'am'}`;
    const big = 2 * 24 * 60;
    const stamp = (min: number, h: number) => JSON.stringify({ type: 'assistant', timestamp: at(min), error: 'rate_limit', message: { id: `h${min}`, model: '<synthetic>', usage: U(0, 0), content: [{ type: 'text', text: `You've hit your session limit · resets ${h % 12 || 12}${h >= 12 ? 'pm' : 'am'}` }] } });
    write('s1.jsonl', [assistant('b1', 'r1', at(big + 60), U(5_000_000, 5000)), stamp(big, new Date(NOW - big * 60_000 + 3_600_000).getHours())]);
    write('s2.jsonl', [JSON.stringify({ type: 'assistant', timestamp: at(5), error: 'rate_limit', message: { id: 'h2', model: '<synthetic>', usage: U(0, 0), content: [{ type: 'text', text }] } })]);
    mkdirSync(join(home, '.claude', 'session-env', 's1'), { recursive: true });
    mkdirSync(join(home, '.claude', 'session-env', 's2'), { recursive: true });
    await scan();
    const a = buildStats({ range: '24h', project: null, off: new Set(), now: NOW }, home).dc.answer;
    expect(a.hits).toBe(1);
    expect(a.verdict).toBe('unclear');
  });

  describe('prompts per project', () => {
    const user = (uuid: string, ts: string, content: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: 'user', uuid, timestamp: ts, cwd: '/work/alpha', entrypoint: 'sdk-cli', message: { role: 'user', content }, ...extra });
    const typed = (text: string) => [{ type: 'text', text }];
    const row = (s: ReturnType<typeof stats>, key = '-work-alpha') => s.dc.projects.find((p) => p.key === key) ?? s.dc.projects.find((p) => p.key === 'alpha');

    it('counts what a person wrote, once, and nothing else', async () => {
      write('s1.jsonl', [
        user('a', at(50), typed('merhaba')),
        user('b', at(49), [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }], { toolUseResult: 'ok' }),
        user('c', at(48), '<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } }),
        user('d', at(47), typed('[super events] batch=1 items=1\n- x')),
        user('e', at(46), 'hook text', { isMeta: true }),
        user('f', at(45), typed('sub agent'), { isSidechain: true }),
        user('g', at(44), typed('summary'), { isCompactSummary: true }),
        user('h', at(43), typed('Handoff: continue task x')),
        user('i', at(42), typed('[Request interrupted by user]')),
        user('j', at(41), '<command-name>/compact</command-name>'),
        user('k', at(40), typed('ikinci mesaj\n<owner-msg ref=abc123/>')),
        user('k', at(40), typed('ikinci mesaj')),
        assistant('m1', 'r1', at(39), U(100)),
      ]);
      write('fork.jsonl', [user('a', at(50), typed('merhaba')), assistant('m2', 'r2', at(38), U(100))]);
      await scan();
      expect(row(stats())?.prompts).toEqual({ owner: 2, super: 0, auto: 0 });
    });

    it('a machine run and an automation never reach the owner\'s count', async () => {
      write('auto.jsonl', [user('a', at(50), 'You are scheduled dreamcontext automation "x" in /work.'), user('b', at(49), typed('continue')), assistant('m1', 'r1', at(48), U(1))]);
      write('cli.jsonl', [user('c', at(47), 'Aşağıda bir metin var'), assistant('m2', 'r2', at(46), U(1))]);
      write('role.jsonl', [user('d', at(45), typed('You are the reviewer of this diff.')), assistant('m3', 'r3', at(44), U(1))]);
      await scan();
      expect(row(stats())?.prompts).toEqual({ owner: 0, super: 0, auto: 4 });
    });

    it('a delegated child is the Super\'s whole; in an adopted chat a send is the Super\'s and the rest the owner\'s', async () => {
      const send = (ts: string, id: string, child: string) => assistant(id, `r${id}`, ts, U(1), {}, [{ type: 'tool_use', id: `t${id}`, name: 'Bash', input: { command: `dreamcontext super send ${child} "$(cat /tmp/m.txt)"` } }]);
      write('super1.jsonl', [
        user('s1', at(100), typed('[super events] batch=1 items=1\n- x')),
        user('s2', at(99), typed('ne durumdayız?\n<owner-msg ref=abc123/>')),
        send(at(50), 'm1', 'child111'),
      ]);
      write('child111-full.jsonl', [
        user('c1', at(90), typed('If you start a dev server, pin its url (a `dream-view` pin) so the owner sees the site.\n\nGörev: x')),
        user('c2', at(50), typed('Durdun: devam et')),
        user('c3', at(20), typed('ben yazdım')),
        assistant('m9', 'r9', at(19), U(1)),
      ]);
      write('adopted1.jsonl', [
        user('o1', at(80), typed('kendi sohbetim')),
        user('o2', at(40), typed('Super devraldı, devam et')),
        assistant('m8', 'r8', at(39), U(1)),
      ]);
      write('super2.jsonl', [send(at(40), 'm2', 'adopted1')]);
      await scan();
      expect(row(stats())?.prompts).toEqual({ owner: 2, super: 4, auto: 0 });
    });

    it('a row holds the cards\' numbers, the net is saved minus eaten, and the range cuts prompts', async () => {
      write('s1.jsonl', [
        user('old', at(26 * 60), typed('dün')),
        JSON.stringify({ type: 'attachment', timestamp: at(50), attachment: { type: 'hook_success', hookEvent: 'SessionStart', command: 'dreamcontext hook session-start', content: 'x'.repeat(3500) } }),
        user('new', at(49), typed('bugün')),
        assistant('m1', 'r1', at(48), U(5000)),
      ]);
      await scan();
      const week = stats('7d');
      const r = week.dc.projects[0];
      expect(r.prompts?.owner).toBe(2);
      expect(stats('24h').dc.projects[0].prompts?.owner).toBe(1);
      expect(r.estMemory.tokens).toBe(1000);
      expect(r.estMemory.tokens).toBe(week.dc.memory.first + week.dc.memory.carried);
      expect(r.estMemory.cost).toBeGreaterThan(0);
      expect(r.sleep.cost).toBe(week.dc.sleep.cost);
      expect(r.estSaved.tokens).toBe(week.dc.eco.estSaved);
      expect(r.estNet.cost).toBeCloseTo(r.estSaved.cost - r.sleep.cost - r.estMemory.cost, 10);
      expect(buildStats({ range: '7d', project: null, off: new Set(['claude']), now: NOW }, home).dc.projects).toEqual([]);
    });

    it('with no Eco record every row says so; an older record covers the range; a project filter leaves its one row', async () => {
      write('s1.jsonl', [user('a', at(50), typed('x')), assistant('m1', 'r1', at(49), U(100))]);
      await scan();
      expect(stats().dc.ecoPartial).toBe(true);
      expect(stats().dc.ecoFrom).toBeNull();
      const key = stats().dc.projects[0].key;
      expect(buildStats({ range: '7d', project: key, off: new Set(), now: NOW }, home).dc.projects.map((p) => p.key)).toEqual([key]);
      expect(buildStats({ range: '7d', project: 'nothing-here', off: new Set(), now: NOW }, home).dc.projects).toEqual([]);
      const root = join(home, 'v', '_dream_context');
      mkdirSync(join(root, 'state'), { recursive: true });
      writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ version: 1, vaults: [{ name: 'v', path: join(home, 'v') }] }));
      logHandoff(root, { title: 't', at: at(10 * 1440), contextTokens: 900_000, fromSession: 'x', consumedAt: at(10 * 1440) });
      expect(stats().dc.ecoPartial).toBe(false);
      expect(buildStats({ range: '90d', project: null, off: new Set(), now: NOW }, home).dc.ecoPartial).toBe(true);
    });

    it('an old cache is read again, so no count stays empty', () => {
      writeFileSync(join(home, '.dreamcontext', 'usage-scan-cache.json'), JSON.stringify({ version: 2, models: [], files: { x: { rows: [] } } }));
      expect(Object.keys(loadLedger(home).files)).toEqual([]);
    });

    it('the openings of a delegate brief are the server\'s own words', () => {
      const src = readFileSync(join(process.cwd(), 'src/server/routes/super.ts'), 'utf-8');
      for (const opening of SUPER_BIRTH_OPENINGS) expect(src).toContain(opening);
    });
  });
});
