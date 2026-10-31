import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountAt, currentLedger, ledgerRoots, scanLedger, sessionAccounts } from '../../src/lib/usage-ledger.js';
import { buildStats } from '../../src/lib/usage-report.js';
import { initialCodexState, parseCodexRecord, parseLimitHit } from '../../src/lib/usage-readers.js';
import { resolvePrice } from '../../src/lib/usage-pricing.js';
import { closeSleepRun, noteSleepRunCost, openSleepRun, readLimitHistory, readSleepRuns } from '../../src/lib/usage-records.js';
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
    expect(accountAt({ account: 'b', accounts: [[100, 'a'], [200, 'b']] }, 150)).toBe('a');
    expect(accountAt({ account: 'b', accounts: [[100, 'a'], [200, 'b']] }, 250)).toBe('b');
    expect(accountAt({ account: 'b', accounts: [[100, 'a'], [200, 'b']] }, 50)).toBe('a');
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
});
