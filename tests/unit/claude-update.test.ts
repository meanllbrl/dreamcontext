import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_VERSION_SCRIPT,
  claudeUpdateInFlight,
  parseShellOptOut,
  claudeUpdateStatePath,
  fetchLatestClaudeVersion,
  parseClaudeVersion,
  readClaudeUpdateRecord,
  readClaudeUpdateStatus,
  readUpdateChannel,
  readUpdateOptOut,
  runClaudeUpdateCheck,
  writeClaudeUpdateRecord,
  type ClaudeUpdateRecord,
  type ClaudeUpdateRunResult,
} from '../../src/lib/claude-update.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-claude-update-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeJson(rel: string, data: unknown): void {
  const path = join(home, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
}

function tagsFetch(tags: Record<string, string> | null, ok = true): typeof fetch {
  return vi.fn(async () => {
    if (!tags) throw new Error('offline');
    return new Response(JSON.stringify(tags), { status: ok ? 200 : 500 });
  }) as unknown as typeof fetch;
}

/**
 * A fake `$SHELL -ilc` runner: the version probe answers from `versions` (one per call), after
 * the DA=/DU= line its shell prints (`shellFlags`, empty by default). Recorded as 'claude --version'.
 */
function fakeRunner(versions: string[], update: ClaudeUpdateRunResult, shellFlags = 'DA= DU=') {
  const calls: string[] = [];
  const run = vi.fn(async (script: string): Promise<ClaudeUpdateRunResult> => {
    if (script === CLAUDE_VERSION_SCRIPT) {
      calls.push('claude --version');
      const v = versions.length > 1 ? versions.shift()! : versions[0];
      return { code: 0, output: `${shellFlags}\n${v} (Claude Code)\n` };
    }
    calls.push(script);
    return update;
  });
  return { run, calls };
}

const UP_TO_DATE = { code: 0, output: 'Current version: 2.1.289\nChecking for updates to latest version...\nClaude Code is up to date (2.1.289)\n' };

describe('parseClaudeVersion', () => {
  it('reads the CLI --version line, past login-shell noise', () => {
    expect(parseClaudeVersion('2.1.284 (Claude Code)')).toBe('2.1.284');
    expect(parseClaudeVersion('Now using node v20.1.0\n2.1.284 (Claude Code)\n')).toBe('2.1.284');
    expect(parseClaudeVersion('2.1.289')).toBe('2.1.289');
  });
  it('is null on garbage', () => {
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion('command not found: claude')).toBeNull();
    expect(parseClaudeVersion(undefined as unknown as string)).toBeNull();
  });
});

describe('readUpdateOptOut', () => {
  it('is null with nothing set', () => {
    expect(readUpdateOptOut(home, {})).toBeNull();
  });
  it.each([['1'], ['true'], ['yes']])('honours DISABLE_AUTOUPDATER=%s in the process env', (v) => {
    expect(readUpdateOptOut(home, { DISABLE_AUTOUPDATER: v })).toBe('DISABLE_AUTOUPDATER in the environment');
  });
  it.each([['0'], ['false'], ['']])('ignores DISABLE_UPDATES=%j', (v) => {
    expect(readUpdateOptOut(home, { DISABLE_UPDATES: v })).toBeNull();
  });
  it('reads the settings.json env block', () => {
    writeJson('.claude/settings.json', { env: { DISABLE_UPDATES: '1' } });
    expect(readUpdateOptOut(home, {})).toBe('DISABLE_UPDATES in ~/.claude/settings.json');
  });
  it('reads autoUpdates:false in ~/.claude.json unless a native install protects itself', () => {
    writeJson('.claude.json', { autoUpdates: false });
    expect(readUpdateOptOut(home, {})).toBe('autoUpdates: false in ~/.claude.json');
    writeJson('.claude.json', { autoUpdates: false, installMethod: 'native', autoUpdatesProtectedForNative: true });
    expect(readUpdateOptOut(home, {})).toBeNull();
    writeJson('.claude.json', { autoUpdates: false, installMethod: 'npm', autoUpdatesProtectedForNative: true });
    expect(readUpdateOptOut(home, {})).not.toBeNull();
  });
  it('survives garbage config files', () => {
    writeJson('.claude/settings.json', '{nope');
    writeJson('.claude.json', '[1,2]');
    expect(readUpdateOptOut(home, {})).toBeNull();
  });
});

describe('parseShellOptOut', () => {
  it('reads the probe shell DA=/DU= line', () => {
    expect(parseShellOptOut('DA=1 DU=\n2.1.284 (Claude Code)')).toBe('DISABLE_AUTOUPDATER in your shell profile');
    expect(parseShellOptOut('nvm noise\nDA= DU=true\n2.1.284 (Claude Code)')).toBe('DISABLE_UPDATES in your shell profile');
    expect(parseShellOptOut('DA= DU=\n2.1.284 (Claude Code)')).toBeNull();
    expect(parseShellOptOut('DA=false DU=0')).toBeNull();
    expect(parseShellOptOut('2.1.284 (Claude Code)')).toBeNull();
  });
});

describe('readUpdateChannel', () => {
  it('defaults to latest and reads stable from settings', () => {
    expect(readUpdateChannel(home)).toBe('latest');
    writeJson('.claude/settings.json', { autoUpdatesChannel: 'stable' });
    expect(readUpdateChannel(home)).toBe('stable');
  });
});

describe('fetchLatestClaudeVersion', () => {
  it('picks the channel tag', async () => {
    const f = tagsFetch({ latest: '2.1.289', stable: '2.1.285' });
    expect(await fetchLatestClaudeVersion('latest', f)).toBe('2.1.289');
    expect(await fetchLatestClaudeVersion('stable', f)).toBe('2.1.285');
  });
  it('is null when offline, on a bad status, or on a missing tag', async () => {
    expect(await fetchLatestClaudeVersion('latest', tagsFetch(null))).toBeNull();
    expect(await fetchLatestClaudeVersion('latest', tagsFetch({ latest: '2.1.289' }, false))).toBeNull();
    expect(await fetchLatestClaudeVersion('stable', tagsFetch({ latest: '2.1.289' }))).toBeNull();
  });
});

describe('state file', () => {
  it('round-trips and reads garbage as null', () => {
    const rec: ClaudeUpdateRecord = { checkedAt: 5, installed: '2.1.284', latest: '2.1.289', channel: 'latest', state: 'failed', error: 'boom' };
    writeClaudeUpdateRecord(home, rec);
    expect(readClaudeUpdateRecord(home)).toEqual(rec);
    writeFileSync(claudeUpdateStatePath(home), 'not json');
    expect(readClaudeUpdateRecord(home)).toBeNull();
    writeFileSync(claudeUpdateStatePath(home), JSON.stringify({ checkedAt: 'x', state: 'current' }));
    expect(readClaudeUpdateRecord(home)).toBeNull();
  });
});

describe('readClaudeUpdateStatus (capabilities field)', () => {
  const rec = (over: Partial<ClaudeUpdateRecord>): void =>
    writeClaudeUpdateRecord(home, { checkedAt: 1000, installed: '2.1.289', latest: '2.1.289', channel: 'latest', state: 'current', ...over });

  it('is unknown with no state file', () => {
    expect(readClaudeUpdateStatus(home, {})).toEqual({
      installed: null, latest: null, channel: 'latest', outdated: false, state: 'unknown', updateCommand: 'claude update',
    });
  });
  it('is current when installed matches latest', () => {
    rec({});
    expect(readClaudeUpdateStatus(home, {})).toMatchObject({ state: 'current', outdated: false, checkedAt: 1000 });
  });
  it('is outdated, or disabled with the source named, when behind', () => {
    rec({ installed: '2.1.284', state: 'outdated' });
    expect(readClaudeUpdateStatus(home, {})).toMatchObject({ state: 'outdated', outdated: true });
    expect(readClaudeUpdateStatus(home, { DISABLE_AUTOUPDATER: '1' })).toMatchObject({
      state: 'disabled', outdated: true, disabledBy: 'DISABLE_AUTOUPDATER in the environment',
    });
  });
  it('carries the error tail when the last update failed', () => {
    rec({ installed: '2.1.284', state: 'failed', error: 'brew upgrade claude-code' });
    expect(readClaudeUpdateStatus(home, {})).toMatchObject({ state: 'failed', outdated: true, error: 'brew upgrade claude-code' });
  });
  it('is unknown when latest is missing (offline)', () => {
    rec({ latest: null, state: 'unknown' });
    expect(readClaudeUpdateStatus(home, {})).toMatchObject({ state: 'unknown', outdated: false });
  });
  it('reports a recent recorded run as updating, a stale one by its versions', () => {
    rec({ installed: '2.1.284', state: 'updating', lastAttemptAt: 1000 });
    expect(readClaudeUpdateStatus(home, {}, 2000).state).toBe('updating');
    expect(readClaudeUpdateStatus(home, {}, 1000 + 60 * 60_000).state).toBe('outdated');
  });
});

describe('runClaudeUpdateCheck', () => {
  const fetchLatest = tagsFetch({ latest: '2.1.289', stable: '2.1.285' });

  it('updates when behind and records updated with from/to', async () => {
    const { run, calls } = fakeRunner(['2.1.284', '2.1.289'], { code: 0, output: 'Successfully updated from 2.1.284 to version 2.1.289\n' });
    const r = await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 1000 });
    expect(r).toMatchObject({ ok: true, ran: true, message: 'Updated Claude Code 2.1.284 -> 2.1.289' });
    expect(calls).toEqual(['claude --version', 'claude update', 'claude --version']);
    expect(readClaudeUpdateRecord(home)).toMatchObject({ state: 'updated', installed: '2.1.289', from: '2.1.284', to: '2.1.289', lastAttemptAt: 1000 });
    expect(readClaudeUpdateStatus(home, {}).state).toBe('updated');
  });

  it('does not run claude update when current', async () => {
    const { run, calls } = fakeRunner(['2.1.289'], UP_TO_DATE);
    const r = await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 1000 });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['claude --version']);
    expect(readClaudeUpdateRecord(home)?.state).toBe('current');
  });

  it('records failed with the last 4 output lines', async () => {
    const output = 'Current version: 2.1.284\nChecking for updates...\n\nline a\nline b\nline c\nWarning: installed via Homebrew, run brew upgrade claude-code\n';
    const { run } = fakeRunner(['2.1.284'], { code: 1, output });
    const r = await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 1000 });
    expect(r.ok).toBe(false);
    const rec = readClaudeUpdateRecord(home)!;
    expect(rec.state).toBe('failed');
    expect(rec.error).toBe('line a\nline b\nline c\nWarning: installed via Homebrew, run brew upgrade claude-code');
    expect(r.message).toBe(rec.error);
  });

  it('counts exit 0 without reaching latest as failed', async () => {
    const { run } = fakeRunner(['2.1.284'], { code: 0, output: 'something else\n' });
    const r = await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 1000 });
    expect(r.ok).toBe(false);
    expect(readClaudeUpdateRecord(home)?.state).toBe('failed');
  });

  it('honours the opt-out, unless forced', async () => {
    const env = { DISABLE_AUTOUPDATER: '1' };
    const a = fakeRunner(['2.1.284'], UP_TO_DATE);
    await runClaudeUpdateCheck({}, { home, env, run: a.run, fetch: fetchLatest, now: () => 1000 });
    expect(a.calls).not.toContain('claude update');
    expect(readClaudeUpdateRecord(home)).toMatchObject({ state: 'disabled', disabledBy: 'DISABLE_AUTOUPDATER in the environment' });

    const b = fakeRunner(['2.1.284', '2.1.289'], UP_TO_DATE);
    const r = await runClaudeUpdateCheck({ force: true }, { home, env, run: b.run, fetch: fetchLatest, now: () => 2000 });
    expect(b.calls).toContain('claude update');
    expect(r.ok).toBe(true);
  });

  it('honours an opt-out exported in the shell profile (seen only by the probe shell)', async () => {
    const { run, calls } = fakeRunner(['2.1.284'], UP_TO_DATE, 'DA=1 DU=');
    const r = await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 1000 });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['claude --version']);
    expect(readClaudeUpdateRecord(home)).toMatchObject({ state: 'disabled', disabledBy: 'DISABLE_AUTOUPDATER in your shell profile' });
    // The capabilities path cannot see the shell, so the record carries it.
    expect(readClaudeUpdateStatus(home, {})).toMatchObject({ state: 'disabled', outdated: true, disabledBy: 'DISABLE_AUTOUPDATER in your shell profile' });
  });

  it('proceeds when the shell reports both variables empty or off', async () => {
    const { run, calls } = fakeRunner(['2.1.284', '2.1.289'], UP_TO_DATE, 'DA=0 DU=');
    const r = await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 1000 });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['claude --version', 'claude update', 'claude --version']);
  });

  it('records unknown when offline, and a forced run still tries claude update', async () => {
    const a = fakeRunner(['2.1.284'], UP_TO_DATE);
    const r = await runClaudeUpdateCheck({}, { home, env: {}, run: a.run, fetch: tagsFetch(null), now: () => 1000 });
    expect(r.ok).toBe(false);
    expect(a.calls).toEqual(['claude --version']);
    expect(readClaudeUpdateRecord(home)?.state).toBe('unknown');

    const b = fakeRunner(['2.1.284', '2.1.289'], UP_TO_DATE);
    const f = await runClaudeUpdateCheck({ force: true }, { home, env: {}, run: b.run, fetch: tagsFetch(null), now: () => 2000 });
    expect(b.calls).toContain('claude update');
    expect(f.ok).toBe(true);
  });

  it('skips a non-forced check within the interval of the last one (cross-server throttle)', async () => {
    writeClaudeUpdateRecord(home, { checkedAt: 1000, installed: '2.1.284', latest: '2.1.289', channel: 'latest', state: 'outdated' });
    const { run } = fakeRunner(['2.1.284'], UP_TO_DATE);
    const r = await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 2000, intervalMs: 10_000 });
    expect(r).toMatchObject({ ran: false, ok: true });
    expect(run).not.toHaveBeenCalled();
    const later = await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 20_000, intervalMs: 10_000 });
    expect(later.ran).toBe(true);
  });

  it('joins a run already in flight and reports updating meanwhile', async () => {
    let release!: (r: ClaudeUpdateRunResult) => void;
    const gate = new Promise<ClaudeUpdateRunResult>((res) => { release = res; });
    const versions = ['2.1.284', '2.1.289'];
    const run = vi.fn(async (script: string) => (script === 'claude update' ? gate : { code: 0, output: `${versions.shift() ?? '2.1.289'} (Claude Code)` }));
    const deps = { home, env: {}, run, fetch: fetchLatest, now: () => 1000 };
    const first = runClaudeUpdateCheck({}, deps);
    const second = runClaudeUpdateCheck({}, deps);
    expect(second).toBe(first);
    expect(claudeUpdateInFlight()).toBe(true);
    expect(readClaudeUpdateStatus(home, {}).state).toBe('updating');
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('claude update', expect.any(Number)));
    release(UP_TO_DATE);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(run.mock.calls.filter(([s]) => s === 'claude update')).toHaveLength(1);
    expect(claudeUpdateInFlight()).toBe(false);
  });

  it('never throws, even when the runner does', async () => {
    const run = vi.fn(async () => { throw new Error('spawn exploded'); });
    const r = await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 1000 });
    expect(r.ok).toBe(false);
  });

  it('writes the state file atomically (no tmp file left behind)', async () => {
    const { run } = fakeRunner(['2.1.289'], UP_TO_DATE);
    await runClaudeUpdateCheck({}, { home, env: {}, run, fetch: fetchLatest, now: () => 1000 });
    expect(JSON.parse(readFileSync(claudeUpdateStatePath(home), 'utf-8')).state).toBe('current');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(home, '.dreamcontext')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
