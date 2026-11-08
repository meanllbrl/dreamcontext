/**
 * The run registry (plan H4, H5, H7, I3, J1, J4, K1): one server-owned run per chat, keyed
 * (sessionId, cardRef); the record closes itself before the report goes; Telegram lines reach
 * stdin only through the fail-closed rule.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCardsForTests, getCard, listCards, noteAssistantCards, setCardsHomeForTests } from '../../src/lib/cards/records.js';
import {
  _resetRunsForTests, attachRun, configureRuns, relayLine, runOfSession, setEchoReaderForTests, startRun,
  type RunPty, type SpawnRequest,
} from '../../src/server/runs/registry.js';
import { RELAYED_PTY_ENV } from '../../src/lib/handsfree/mac/contract.js';
import { stdoutIsOwnTerminal } from '../../src/cli/commands/handsfree-mac.js';

const SID = '11111111-2222-4333-8444-555555555555';
const card = (id: string, command: string, cwd?: string) => `\`\`\`dream-view\n${JSON.stringify({ type: 'run', id, command, ...(cwd ? { cwd } : {}) })}\n\`\`\``;

class FakePty implements RunPty {
  pid = 4242;
  ptsName = '/dev/ttys999';
  written: string[] = [];
  killed = false;
  private data: Array<(d: string) => void> = [];
  private exit: Array<(e: { exitCode: number }) => void> = [];
  onData(cb: (d: string) => void) { this.data.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void) { this.exit.push(cb); }
  write(d: string) { this.written.push(d); }
  resize() { /* ok */ }
  kill() { this.killed = true; this.end(130); }
  emit(d: string) { for (const f of this.data) f(d); }
  end(code: number) { for (const f of this.exit) f({ exitCode: code }); }
}

let home: string;
let spawned: Array<{ req: SpawnRequest; pty: FakePty }>;
let reports: Array<{ text: string; closedFirst: boolean }>;

function refOf(id: string): string {
  return listCards(SID).filter((c) => c.id === id).at(-1)!.cardRef;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'runs-home-'));
  setCardsHomeForTests(home);
  _resetCardsForTests();
  _resetRunsForTests();
  spawned = [];
  reports = [];
  configureRuns({
    spawner: (req) => { const pty = new FakePty(); spawned.push({ req, pty }); return pty; },
    projectRootOf: (v) => (v === 'acme' ? '/projects/acme' : null),
    resolveCwd: (root, rel) => (rel === 'escape' ? null : `${root}/${rel}`),
    delivery: { report: (run, rec, report) => { reports.push({ text: report.text, closedFirst: getCard(rec.sessionId, rec.cardRef)?.state === 'closed' }); } },
    trackChild: () => () => {},
    capMs: 30 * 60_000,
  });
  noteAssistantCards(SID, 'acme', 'm1', card('login', 'gh auth status', 'app'));
});
afterEach(() => {
  _resetRunsForTests();
  setCardsHomeForTests(null);
  setEchoReaderForTests(null);
  rmSync(home, { recursive: true, force: true });
});

describe('starting and attaching', () => {
  it('runs the RECORD\'s command in its contained cwd with the relayed-PTY env', () => {
    const r = startRun(SID, refOf('login'), 'telegram');
    expect('refused' in r).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].req).toEqual({ command: 'gh auth status', cwd: '/projects/acme/app', env: { [RELAYED_PTY_ENV]: '1' } });
    expect(listCards(SID)[0].run).toMatchObject({ owner: 'telegram' });
  });

  it('a Mac start then a Telegram tap is ONE process, one report', () => {
    const ref = refOf('login');
    const a = startRun(SID, ref, 'mac');
    const b = startRun(SID, ref, 'telegram');
    expect(b).toBe(a);
    expect(spawned).toHaveLength(1);
    expect(attachRun(SID, ref)).toBe(a);
    spawned[0].pty.end(0);
    expect(reports).toHaveLength(1);
  });

  it('a second card in the same chat is busy while the first runs', () => {
    noteAssistantCards(SID, 'acme', 'm2', card('other', 'ls'));
    startRun(SID, refOf('login'), 'mac');
    expect(startRun(SID, refOf('other'), 'phone')).toEqual({ refused: 'busy' });
  });

  it('a cwd that escapes the project is refused, nothing spawned', () => {
    noteAssistantCards(SID, 'acme', 'm3', card('esc', 'ls', 'escape'));
    expect(startRun(SID, refOf('esc'), 'mac')).toEqual({ refused: 'bad_cwd' });
    expect(spawned).toHaveLength(0);
  });

  it('an unknown cardRef is no_record', () => {
    expect(startRun(SID, 'f'.repeat(32), 'phone')).toEqual({ refused: 'no_record' });
  });
});

describe('the end of a run (J1, K1)', () => {
  it('closes the record BEFORE delivering one report with the exit code and tail', () => {
    const ref = refOf('login');
    startRun(SID, ref, 'telegram');
    spawned[0].pty.emit('Logged in as octo\r\n');
    spawned[0].pty.end(0);
    expect(reports).toEqual([{ text: expect.stringContaining('[ran in chat]\n$ gh auth status\nexit 0'), closedFirst: true }]);
    expect(reports[0].text).toContain('Logged in as octo');
    expect(getCard(SID, ref)?.state).toBe('closed');
    expect(runOfSession(SID)).toBeNull();
    expect(listCards(SID)[0].exit).toBe(0);
  });

  it('withheld output reports the exit code alone', () => {
    startRun(SID, refOf('login'), 'telegram', { withheld: true });
    spawned[0].pty.emit('token: ghp_secret\r\n');
    spawned[0].pty.end(1);
    expect(reports[0].text).not.toContain('ghp_secret');
    expect(reports[0].text).toContain('chose not to share');
  });

  it('a closed card: phone and Telegram refused; a Mac Run again runs and the record stays closed', () => {
    const ref = refOf('login');
    startRun(SID, ref, 'mac');
    spawned[0].pty.end(0);
    expect(startRun(SID, ref, 'phone')).toEqual({ refused: 'closed' });
    expect(startRun(SID, ref, 'telegram')).toEqual({ refused: 'closed' });
    expect(startRun(SID, ref, 'mac')).toEqual({ refused: 'closed' });
    const again = startRun(SID, ref, 'mac', { rerun: true });
    expect('refused' in again).toBe(false);
    expect((again as { rerun: boolean }).rerun).toBe(true);
    spawned[1].pty.end(0);
    expect(reports).toHaveLength(2);
    expect(getCard(SID, ref)?.state).toBe('closed');
  });

  it('the 30 minute cap kills the run', () => {
    vi.useFakeTimers();
    try {
      configureRuns({ capMs: 1000 });
      startRun(SID, refOf('login'), 'phone');
      vi.advanceTimersByTime(1001);
      expect(spawned[0].pty.killed).toBe(true);
    } finally { vi.useRealTimers(); configureRuns({ capMs: 30 * 60_000 }); }
  });
});

describe('output (H7)', () => {
  it('scrubs the hands-free login token before the replay buffer, even split across chunks', () => {
    const r = startRun(SID, refOf('login'), 'phone');
    if ('refused' in r) throw new Error('refused');
    const seen: string[] = [];
    r.onOutput((c) => seen.push(c));
    spawned[0].pty.emit('open https://x.trycloudflare.com/log');
    spawned[0].pty.emit('in?t=SECRETTOKEN123 now\r\n');
    expect(r.replay()).not.toContain('SECRETTOKEN123');
    expect(seen.join('')).not.toContain('SECRETTOKEN123');
    expect(r.replay()).toContain('https://x.trycloudflare.com/login');
  });

  it('the replay buffer keeps the newest 64 KB', () => {
    const r = startRun(SID, refOf('login'), 'phone');
    if ('refused' in r) throw new Error('refused');
    spawned[0].pty.emit('a'.repeat(70 * 1024));
    spawned[0].pty.emit('END');
    expect(r.replay().length).toBe(64 * 1024);
    expect(r.replay().endsWith('END')).toBe(true);
  });

  it('a relayed PTY is not the owner\'s terminal: the CLI prints no secret into it', () => {
    expect(stdoutIsOwnTerminal({ [RELAYED_PTY_ENV]: '1' }, true)).toBe(false);
    expect(stdoutIsOwnTerminal({}, true)).toBe(true);
  });
});

describe('a Telegram line into stdin (I3, J4)', () => {
  function live() {
    const r = startRun(SID, refOf('login'), 'telegram');
    if ('refused' in r) throw new Error('refused');
    return { r, pty: spawned[0].pty };
  }

  it('`read -p "Devam? (y/n) "` with ECHO on: accepted, one line, controls stripped', async () => {
    setEchoReaderForTests(async () => true);
    const { r, pty } = live();
    pty.emit('Devam? (y/n) ');
    expect(await relayLine(r, 'y\x1b[A\nsecond', r.seq())).toEqual({ ok: true });
    expect(pty.written).toEqual(['y[A\r']);
  });

  it('sudo -S (ECHO off) is refused', async () => {
    setEchoReaderForTests(async () => false);
    const { r, pty } = live();
    pty.emit('Enter value ');
    expect(await relayLine(r, 'hunter2', r.seq())).toEqual({ ok: false, why: 'echo_off' });
    expect(pty.written).toEqual([]);
  });

  it('`read -p "API key: "` is refused even with ECHO on', async () => {
    setEchoReaderForTests(async () => true);
    const { r, pty } = live();
    pty.emit('API key: ');
    expect(await relayLine(r, 'sk-123', r.seq())).toEqual({ ok: false, why: 'secret_prompt' });
    pty.emit('\r\n[sudo] password for octo: ');
    expect(await relayLine(r, 'x', r.seq())).toEqual({ ok: false, why: 'secret_prompt' });
  });

  it('a termios read that fails refuses', async () => {
    setEchoReaderForTests(async () => null);
    const { r, pty } = live();
    pty.emit('Name? ');
    expect(await relayLine(r, 'octo', r.seq())).toEqual({ ok: false, why: 'echo_off' });
  });

  it('output after the edit it replies to refuses, also when it lands during the ECHO read', async () => {
    const { r, pty } = live();
    pty.emit('Name? ');
    const seen = r.seq();
    pty.emit('more');
    setEchoReaderForTests(async () => true);
    expect(await relayLine(r, 'octo', seen)).toEqual({ ok: false, why: 'output_changed' });
    setEchoReaderForTests(async () => { pty.emit('late'); return true; });
    expect(await relayLine(r, 'octo', r.seq())).toEqual({ ok: false, why: 'output_changed' });
    expect(pty.written).toEqual([]);
  });
});
