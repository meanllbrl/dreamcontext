import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import {
  boundConditionData,
  CONDITION_DATA_MAX_BYTES,
  conditionEnv,
  conditionInvalidReason,
  conditionSha,
  conditionWakes,
  isConditionData,
  runCondition,
  scrubConditionText,
  visibleScript,
  type ConditionSpawn,
} from '../../src/lib/automations/condition.js';
import { insideAgentRun } from '../../src/lib/automations/types.js';
import { agentDriven } from '../../src/lib/agent-filing-guard.js';

const posix = process.platform !== 'win32';
const FIRE = new Date('2026-11-15T09:00:00.000Z');
const env = (): NodeJS.ProcessEnv => conditionEnv({ slug: 'new-orders-check', fireAt: FIRE });
const run = (script: string, timeoutMs?: number) => runCondition(script, { cwd: tmpdir(), env: env(), timeoutMs });

describe.skipIf(!posix)('runCondition — the exit code is the verdict', () => {
  it('exit 0 is true and carries its stdout as data', async () => {
    const r = await run('echo "2 new orders: Northwind Bakery"; exit 0');
    expect(r.verdict).toBe('true');
    expect(r.data).toBe('2 new orders: Northwind Bakery');
    expect(r.exitCode).toBe(0);
  });

  it('exit 1 is false', async () => {
    const r = await run('echo nothing; exit 1');
    expect(r.verdict).toBe('false');
    expect(r.exitCode).toBe(1);
  });

  it('any other code is a loud error with a reason and no data', async () => {
    const r = await run('echo partial; echo "boom" >&2; exit 3');
    expect(r.verdict).toBe('error');
    expect(r.reason).toBe('exit 3');
    expect(r.data).toBe('');
    expect(r.stderrTail).toContain('boom');
  });

  it('a timeout kills the whole process group, a grandchild included', async () => {
    const started = Date.now();
    const r = await run('sleep 30 & echo $! > /dev/null; sleep 30', 300);
    expect(r.verdict).toBe('error');
    expect(r.reason).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('a spawn that throws is an error, never a throw', async () => {
    const spawnFn: ConditionSpawn = () => { throw new Error('no shell here'); };
    const r = await runCondition('exit 0', { cwd: tmpdir(), env: env(), spawnFn });
    expect(r.verdict).toBe('error');
    expect(r.reason).toMatch(/could not start: no shell here/);
  });

  it('stdin is closed: a script that reads it sees end of input at once', async () => {
    const r = await run('if read line; then exit 3; else exit 1; fi');
    expect(r.verdict).toBe('false');
  });

  it('a 20 KB Turkish stdout reaches the agent bounded to 8192 bytes', async () => {
    const r = await run("i=0; while [ $i -lt 2000 ]; do printf 'şğüöçı İ '; i=$((i+1)); done; exit 0");
    expect(r.verdict).toBe('true');
    expect(Buffer.byteLength(r.data, 'utf8')).toBeLessThanOrEqual(CONDITION_DATA_MAX_BYTES);
    expect(isConditionData(r.data)).toBe(true);
    expect(r.data).not.toContain('\uFFFD');
  });

  it('a credential in stderr is scrubbed from the error tail', async () => {
    const r = await run('echo "api_key=sk-live-abcdef123456 failed" >&2; exit 2');
    expect(r.stderrTail).not.toContain('sk-live-abcdef123456');
    expect(r.stderrTail).toContain('[redacted]');
  });
});

describe('runCondition on win32 (mocked platform)', () => {
  it('runs a multi-line script as a temp .cmd through cmd.exe, then deletes it', async () => {
    let file = '';
    let args: string[] = [];
    let body = '';
    const spawnFn: ConditionSpawn = (f, a) => {
      file = f; args = a;
      body = readFileSync(a[2], 'utf8');
      const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
      setTimeout(() => child.emit('close', 1, null), 5);
      return child as unknown as ChildProcess;
    };
    const r = await runCondition('dir /b C:\\orders\necho done', { cwd: tmpdir(), env: env(), platform: 'win32', spawnFn });
    expect(r.verdict).toBe('false');
    expect(file).toBe('cmd.exe');
    expect(args.slice(0, 2)).toEqual(['/d', '/c']);
    expect(body).toBe('@echo off\r\ndir /b C:\\orders\r\necho done\r\n');
    expect(existsSync(args[2])).toBe(false);
  });
});

describe('conditionEnv', () => {
  it('marks the script as an agent-driven run and strips the window token and account dir', () => {
    const e = conditionEnv(
      { slug: 'new-orders-check', fireAt: FIRE },
      { PATH: '/usr/bin', DREAMCONTEXT_WINDOW_TOKEN: 'secret', CLAUDE_CONFIG_DIR: '/x', HOME: '/home/fictional' },
    );
    expect(e.DREAMCONTEXT_AUTOMATION_RUN).toBe(FIRE.toISOString());
    expect(e.DREAMCONTEXT_AUTOMATION_SLUG).toBe('new-orders-check');
    expect(e.DREAMCONTEXT_WINDOW_TOKEN).toBeUndefined();
    expect(e.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(e.HOME).toBe('/home/fictional');
    expect(insideAgentRun(e)).toBe(true);
    expect(agentDriven(e)).toBe(true);
  });
});

describe('agentDriven: every agent marker alone is enough, a bare env is not', () => {
  const cases: Array<[string, NodeJS.ProcessEnv]> = [
    ['CLAUDECODE', { CLAUDECODE: '1' }],
    ['CLAUDE_CODE_SESSION_ID', { CLAUDE_CODE_SESSION_ID: 'abc' }],
    ['CODEX_THREAD_ID', { CODEX_THREAD_ID: 't1' }],
    ['antigravity chat', { DREAMCONTEXT_AGENT_TOOL: 'antigravity' }],
    ['codex chat', { DREAMCONTEXT_AGENT_TOOL: 'codex' }],
    ['brain MCP child', { DREAMCONTEXT_VIA_BRAIN_MCP: '1' }],
    ['a run', { DREAMCONTEXT_AUTOMATION_RUN: FIRE.toISOString() }],
    ['a member crew', { DREAMCONTEXT_MEMBER_CREW: 'baker' }],
    ['the Super', { DREAMCONTEXT_SUPER_CREW: '1' }],
  ];
  for (const [name, e] of cases) {
    it(name, () => expect(agentDriven({ PATH: '/usr/bin', ...e })).toBe(true));
  }
  it('bare env', () => expect(agentDriven({ PATH: '/usr/bin', HOME: '/home/fictional' })).toBe(false));
});

describe('pure helpers', () => {
  it('the wake switch: true wakes on true, false wakes on not-true, an error never wakes', () => {
    expect(conditionWakes('true', true)).toBe(true);
    expect(conditionWakes('false', true)).toBe(false);
    expect(conditionWakes('false', false)).toBe(true);
    expect(conditionWakes('true', false)).toBe(false);
    expect(conditionWakes('error', true)).toBe(false);
    expect(conditionWakes('error', false)).toBe(false);
  });

  it('the sha covers the normalized script and the wake switch', () => {
    expect(conditionSha('exit 0\r\n')).toBe(conditionSha('exit 0'));
    expect(conditionSha('exit 0', false)).not.toBe(conditionSha('exit 0', true));
    expect(conditionSha('exit 1')).not.toBe(conditionSha('exit 0'));
  });

  it('refuses hidden characters but keeps TAB and LF', () => {
    expect(conditionInvalidReason('test -f a\u202Eb')).toMatch(/hidden/);
    expect(conditionInvalidReason('echo \u001b[31m')).toMatch(/hidden/);
    expect(conditionInvalidReason('echo a\u200Bb')).toMatch(/hidden/);
    expect(conditionInvalidReason('if true; then\n\texit 0\nfi')).toBeNull();
  });

  it('refuses a ## line or a fence line, keeps a # comment', () => {
    expect(conditionInvalidReason('## done\nexit 0')).toMatch(/##/);
    expect(conditionInvalidReason('  ##\tdone')).toMatch(/##/);
    expect(conditionInvalidReason('  ```\nexit 0')).toMatch(/```/);
    expect(conditionInvalidReason('# check new orders\nexit 0')).toBeNull();
    expect(conditionInvalidReason('   ')).toMatch(/empty/);
  });

  it('bounds data at a character boundary with the marker inside the limit', () => {
    const big = 'ğ'.repeat(10_000);
    const b = boundConditionData(big);
    expect(Buffer.byteLength(b, 'utf8')).toBeLessThanOrEqual(CONDITION_DATA_MAX_BYTES);
    expect(isConditionData(b)).toBe(true);
    expect(isConditionData(big)).toBe(false);
    expect(boundConditionData('short')).toBe('short');
  });

  it('scrubs a bearer header and key=value pairs', () => {
    const s = scrubConditionText('Authorization: Bearer abc.def\nTOKEN=xyz123');
    expect(s).not.toContain('abc.def');
    expect(s).not.toContain('xyz123');
  });

  it('visibleScript keeps every line, indented, hidden characters shown', () => {
    const v = visibleScript('a\nb\u202Ec');
    expect(v.split('\n')).toHaveLength(2);
    expect(v.startsWith('  a')).toBe(true);
    expect(v).not.toContain('\u202E');
  });
});
