/**
 * Telegram while the app is quit (plan G5, F1, F4, F5, F6): one "ulaşılamıyor" per authorized
 * message, offsets untouched; a stranger gets nothing; a dead server's hands-free is restored
 * once over two ticks with one message, the marker written first; a live server → nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { AWAY_ENDED_LINE, AWAY_LINE, telegramAwayTick } from '../../src/lib/telegram/away.js';
import { bindingDir, readPollState, writeBinding } from '../../src/lib/telegram/config.js';
import { statePathOf, telegramEndedPathOf } from '../../src/lib/handsfree/mac/session.js';
import type { PowerRunner } from '../../src/lib/handsfree/mac/power.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SCOPE = 'ba9e7119eaab8c22';
let home: string; let tg: FakeTelegram; let restores: number;
const powerRun: PowerRunner = async (file, args) => {
  if (args.includes('disablesleep') && args.includes('0')) restores += 1;
  return { code: 0, stdout: file.includes('pmset') && args.includes('custom') ? 'AC Power:\n lowpowermode 0\n' : '', stderr: '' };
};
const deps = () => ({ home, fetchImpl: tg.fetch, powerRun, isAlive: () => false, commandOf: () => '', kill: () => {} });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-away-'));
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'acme_super_bot'); restores = 0;
  writeBinding(SCOPE, 'super', { token: TOKEN, botId: 123456, botUsername: 'acme_super_bot', chatId: 777, userId: 777, boundAt: 'now' }, home);
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('app quit', () => {
  it('one notice per authorized message, none for a stranger, offset never moved', async () => {
    tg.push(TOKEN, textUpdate(777, 'merhaba'));
    tg.push(TOKEN, textUpdate(555, 'yabancı'));
    await telegramAwayTick(deps());
    await telegramAwayTick(deps());
    expect(tg.texts()).toEqual([AWAY_LINE]);
    expect(readPollState(bindingDir(SCOPE, 'super', home), home).offset).toBe(0);
  });

  it('a live server does nothing', async () => {
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'handsfree-mac', 'server.json'), JSON.stringify({ pid: 4242 }));
    tg.push(TOKEN, textUpdate(777, 'merhaba'));
    await telegramAwayTick({ ...deps(), isAlive: () => true, commandOf: () => '/usr/local/bin/node /x/dreamcontext/dist/index.js dashboard' });
    expect(tg.texts()).toEqual([]);
  });

  it('a dead server\'s Telegram hands-free: two ticks → one power restore, one message, marker first', async () => {
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    writeFileSync(statePathOf(home), JSON.stringify({ on: true, serverPid: 1, tunnelPid: null, tunnelBin: null, startedAt: '2026-11-08T10:00:00.000Z', priorLpm: null, sleepDisabledByUs: true, url: null, mode: 'quick', channel: 'telegram', startedVia: { scope: SCOPE, target: 'super' } }));
    await telegramAwayTick(deps());
    await telegramAwayTick(deps());
    expect(restores).toBe(1);
    expect(tg.texts().filter((t) => t === AWAY_ENDED_LINE)).toHaveLength(1);
    expect(JSON.parse(readFileSync(telegramEndedPathOf(home), 'utf8'))).toEqual({ startedAt: '2026-11-08T10:00:00.000Z' });
    expect(existsSync(statePathOf(home))).toBe(true); // the tick never clears state (F1)
  });
});
