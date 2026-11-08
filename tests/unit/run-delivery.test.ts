/**
 * Where a server-owned run's report goes (plan H5, I5, J1): the chat's window through
 * `hub_command run_report`; with no window, held on disk (0600) and delivered when the window
 * mounts, a restart included; a Telegram-started Super run through the hub's sink.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverReport, flushHeldReports, readHeld, setHeldHomeForTests, setTelegramRunSink } from '../../src/server/runs/delivery.js';
import { deliverHubResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const SID = '11111111-2222-4333-8444-555555555555';
const REF = 'a'.repeat(32);
const report = { exitCode: 0, withheld: false, text: '[ran in chat]\n$ ls\nexit 0 · 1s', tail: '' };
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'deliv-')); setHeldHomeForTests(home); resetWindowControl(); setTelegramRunSink(null); });
afterEach(() => { setHeldHomeForTests(null); setTelegramRunSink(null); resetWindowControl(); rmSync(home, { recursive: true, force: true }); });

function windowFor(sid: string, answer = true) {
  const frames: Array<Record<string, unknown>> = [];
  let token = '';
  const minted = mintWindowToken({
    sessionId: sid,
    send: (frame) => {
      frames.push(frame);
      if (answer) queueMicrotask(() => deliverHubResult(token, frame.id, { ok: true }));
      return true;
    },
  });
  token = minted.token;
  return { frames, release: minted.release };
}

describe('run report delivery', () => {
  it('goes to the chat\'s window as run_report', async () => {
    const w = windowFor(SID);
    expect(await deliverReport({ sessionId: SID, cardRef: REF, startedBy: 'mac', rerun: false }, report)).toBe('window');
    expect(w.frames[0]).toMatchObject({ subtype: 'hub_command', verb: 'run_report', args: { sessionId: SID, cardRef: REF, report: { text: report.text } } });
  });

  it('with no window: held (0600), then delivered once when the window mounts', async () => {
    expect(await deliverReport({ sessionId: SID, cardRef: REF, startedBy: 'phone', rerun: false }, report)).toBe('held');
    const file = join(home, '.dreamcontext', 'cards', `${SID}.held.json`);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readHeld(SID)).toHaveLength(1);
    const w = windowFor(SID);
    expect(await flushHeldReports(SID)).toBe(1);
    expect(w.frames.filter((f) => f.verb === 'run_report')).toHaveLength(1);
    expect(readHeld(SID)).toEqual([]);
    expect(await flushHeldReports(SID)).toBe(0);
  });

  it('a Telegram-started run goes through the hub; a Mac Run again never does', async () => {
    const seen: string[] = [];
    setTelegramRunSink({ deliverRunReport: async (sid, ref, text) => { seen.push(`${sid}:${ref}:${text.slice(0, 13)}`); return true; } });
    expect(await deliverReport({ sessionId: SID, cardRef: REF, startedBy: 'telegram', rerun: false }, report)).toBe('telegram');
    expect(seen).toEqual([`${SID}:${REF}:[ran in chat]`]);
    windowFor(SID);
    expect(await deliverReport({ sessionId: SID, cardRef: REF, startedBy: 'telegram', rerun: true }, report)).toBe('window');
    expect(seen).toHaveLength(1);
  });
});
