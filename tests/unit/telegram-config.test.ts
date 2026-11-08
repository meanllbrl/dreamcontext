/**
 * Telegram bindings live only under ~/.dreamcontext/telegram, at 0600 in 0700 folders; a symlink
 * or hardlink anywhere is refused; a bot.json the hub did not write is a tamper (plan AC1, X8, AA2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync, linkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendManagedHistory, bindingDir, bindingHashOf, listBindings, managedHistoryPath, managerDir,
  readBinding, readManagedHistory, readManagerBinding, readPollState, redactToken, removeBindingDir,
  scopeOfContextRoot, telegramBase, writeBinding, writeManagerBinding, writePollState, readTurns, writeTurns,
} from '../../src/lib/telegram/config.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const FIELDS = { token: TOKEN, botId: 123456789, botUsername: 'super_test_bot', chatId: 42, userId: 42, boundAt: '2026-11-08T10:00:00Z' };
const SCOPE = 'abcdef0123456789';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tg-config-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('bot.json storage', () => {
  it('writes 0600 in 0700 folders under ~/.dreamcontext/telegram only, and reads back', () => {
    const b = writeBinding(SCOPE, 'super', FIELDS, home);
    const dir = bindingDir(SCOPE, 'super', home);
    expect(dir.startsWith(join(home, '.dreamcontext', 'telegram'))).toBe(true);
    expect(mode(join(dir, 'bot.json'))).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(home, '.dreamcontext', 'telegram', SCOPE))).toBe(0o700);
    expect(mode(telegramBase(home))).toBe(0o700);
    const r = readBinding(SCOPE, 'super', home);
    expect(r).toEqual({ ok: true, binding: b });
  });

  it('refuses a scope or target that could climb, and the reserved manager name', () => {
    expect(() => bindingDir('../x', 'super', home)).toThrow();
    expect(() => bindingDir(SCOPE, '../../etc', home)).toThrow();
    expect(() => bindingDir(SCOPE, 'manager', home)).toThrow();
    expect(() => bindingDir(SCOPE, 'Super', home)).toThrow();
    expect(() => writeBinding(SCOPE, 'super', { ...FIELDS, token: 'not-a-token' }, home)).toThrow();
  });

  it('scope is the realpath hash of the context root (16 hex)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-root-'));
    try {
      const s = scopeOfContextRoot(root);
      expect(s).toMatch(/^[0-9a-f]{16}$/);
      const link = `${root}-link`;
      symlinkSync(root, link);
      expect(scopeOfContextRoot(link)).toBe(s);
      rmSync(link);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('symlinks and hardlinks are refused', () => {
  it('a symlinked bot.json is refused even when it points at a valid binding', () => {
    writeBinding(SCOPE, 'super', FIELDS, home);
    const real = join(bindingDir(SCOPE, 'super', home), 'bot.json');
    const elsewhere = join(home, 'elsewhere.json');
    writeFileSync(elsewhere, readFileSync(real));
    rmSync(real);
    symlinkSync(elsewhere, real);
    expect(readBinding(SCOPE, 'super', home)).toEqual({ ok: false, reason: 'symlink' });
  });

  it('a symlinked target or scope folder is refused', () => {
    writeBinding('0000000000000000', 'super', FIELDS, home);
    const scopeDir = join(telegramBase(home), SCOPE);
    symlinkSync(join(telegramBase(home), '0000000000000000'), scopeDir);
    expect(readBinding(SCOPE, 'super', home)).toEqual({ ok: false, reason: 'symlink' });
  });

  it('a symlinked telegram folder is refused', () => {
    const other = join(home, 'other');
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeBinding(SCOPE, 'super', FIELDS, other);
    symlinkSync(telegramBase(other), telegramBase(home));
    expect(readBinding(SCOPE, 'super', home).ok).toBe(false);
  });

  it('a hardlinked bot.json is refused', () => {
    writeBinding(SCOPE, 'super', FIELDS, home);
    const real = join(bindingDir(SCOPE, 'super', home), 'bot.json');
    linkSync(real, join(home, 'hard.json'));
    expect(readBinding(SCOPE, 'super', home)).toEqual({ ok: false, reason: 'hardlink' });
  });

  it('a write replaces a planted symlink instead of following it', () => {
    const dir = bindingDir(SCOPE, 'super', home);
    mkdirSync(dir, { recursive: true });
    const victim = join(home, 'victim.txt');
    writeFileSync(victim, 'keep me');
    symlinkSync(victim, join(dir, 'bot.json'));
    writeBinding(SCOPE, 'super', FIELDS, home);
    expect(readFileSync(victim, 'utf-8')).toBe('keep me');
    expect(readBinding(SCOPE, 'super', home).ok).toBe(true);
  });
});

describe('tamper alarm', () => {
  it('a bot.json the hub did not write (edited chat id) reads as tamper', () => {
    writeBinding(SCOPE, 'super', FIELDS, home);
    const file = join(bindingDir(SCOPE, 'super', home), 'bot.json');
    const j = JSON.parse(readFileSync(file, 'utf-8'));
    j.chatId = 666;
    writeFileSync(file, JSON.stringify(j));
    expect(readBinding(SCOPE, 'super', home)).toEqual({ ok: false, reason: 'tamper' });
  });

  it('a bot.json with no hash, or a hash over other fields, is refused', () => {
    const file = join(bindingDir(SCOPE, 'super', home), 'bot.json');
    writeBinding(SCOPE, 'super', FIELDS, home);
    const j = JSON.parse(readFileSync(file, 'utf-8'));
    delete j.bindingHash;
    writeFileSync(file, JSON.stringify(j));
    expect(readBinding(SCOPE, 'super', home).ok).toBe(false);
    writeFileSync(file, JSON.stringify({ ...j, bindingHash: bindingHashOf({ ...j, userId: 1 }) }));
    expect(readBinding(SCOPE, 'super', home)).toEqual({ ok: false, reason: 'tamper' });
  });

  it('the hash covers every field', () => {
    const base = { v: 1 as const, ...FIELDS };
    const h = bindingHashOf(base);
    for (const [k, v] of Object.entries({ botId: 1, chatId: 1, userId: 1, token: '1:' + 'x'.repeat(30), botUsername: 'x', boundAt: 'y', managed: true })) {
      expect(bindingHashOf({ ...base, [k]: v })).not.toBe(h);
    }
  });
});

describe('manager scope and managed history (X2, AA2)', () => {
  it('the manager binding lives at ~/.dreamcontext/telegram/manager/bot.json, 0600, symlink refused', () => {
    writeManagerBinding(FIELDS, home);
    const file = join(managerDir(home), 'bot.json');
    expect(mode(file)).toBe(0o600);
    expect(readManagerBinding(home).ok).toBe(true);
    rmSync(file);
    symlinkSync(join(home, 'x.json'), file);
    expect(readManagerBinding(home)).toEqual({ ok: false, reason: 'symlink' });
    writeFileSync(join(home, 'x.json'), '{}');
    expect(readManagerBinding(home)).toEqual({ ok: false, reason: 'symlink' });
  });

  it('managed-history.json: appended 0600, read back, malformed rows dropped, symlink refused', () => {
    const row = { target: 'ua-manager', projectKey: 'p1', botId: 7, botUsername: 'ua_bot', creatorId: 42, managerBotId: 9, adoptedAt: '2026-11-08' };
    appendManagedHistory(row, home);
    expect(mode(managedHistoryPath(home))).toBe(0o600);
    expect(readManagedHistory(home).rows).toEqual([row]);
    // A different bot for the same target + project replaces the older row (AB).
    appendManagedHistory({ ...row, botId: 8 }, home);
    expect(readManagedHistory(home).rows.map((r) => r.botId)).toEqual([8]);
    writeFileSync(managedHistoryPath(home), JSON.stringify({ v: 1, rows: [row, { target: '../x' }, { ...row, botId: 'x' }] }));
    expect(readManagedHistory(home).rows).toEqual([row]);
    const file = managedHistoryPath(home);
    const real = join(home, 'h.json');
    writeFileSync(real, JSON.stringify({ v: 1, rows: [row] }));
    rmSync(file);
    symlinkSync(real, file);
    expect(readManagedHistory(home).rows).toEqual([]);
  });

  it('listBindings shows every binding, tampered ones with their refusal', () => {
    writeBinding(SCOPE, 'super', FIELDS, home);
    writeBinding('global', 'ua-manager', { ...FIELDS, botId: 2 }, home);
    writeManagerBinding(FIELDS, home);
    const file = join(bindingDir('global', 'ua-manager', home), 'bot.json');
    writeFileSync(file, readFileSync(file, 'utf-8').replace('"chatId": 42', '"chatId": 43'));
    const list = listBindings(home);
    expect(list.map((b) => `${b.scope}/${b.target}:${b.read.ok ? 'ok' : (b.read as { reason: string }).reason}`).sort())
      .toEqual([`${SCOPE}/super:ok`, 'global/ua-manager:tamper']);
  });

  it('removeBindingDir removes the folder; a symlinked folder is unlinked, its target kept', () => {
    writeBinding(SCOPE, 'super', FIELDS, home);
    removeBindingDir(SCOPE, 'super', home);
    expect(existsSync(bindingDir(SCOPE, 'super', home))).toBe(false);
    const keep = join(home, 'keep');
    mkdirSync(keep);
    writeFileSync(join(keep, 'f'), 'x');
    mkdirSync(join(telegramBase(home), SCOPE), { recursive: true });
    symlinkSync(keep, bindingDir(SCOPE, 'super', home));
    removeBindingDir(SCOPE, 'super', home);
    expect(existsSync(join(keep, 'f'))).toBe(true);
  });
});

describe('poll.json and turns.json carry no message text', () => {
  it('normalises: unknown fields (a text) are dropped, rings capped at 200', () => {
    const dir = bindingDir(SCOPE, 'super', home);
    writePollState(dir, {
      v: 1, offset: 10, seenIds: Array.from({ length: 300 }, (_, i) => i), notifiedIds: [],
      pending: [{ updateId: 5, kind: 'text', written: false, at: 1, ref: 'ab12cd', text: 'gizli mesaj' } as never],
    }, home);
    expect(mode(join(dir, 'poll.json'))).toBe(0o600);
    const raw = readFileSync(join(dir, 'poll.json'), 'utf-8');
    expect(raw).not.toContain('gizli mesaj');
    const p = readPollState(dir, home);
    expect(p.seenIds.length).toBe(200);
    expect(p.pending).toEqual([{ updateId: 5, kind: 'text', written: false, at: 1, ref: 'ab12cd' }]);
    writeTurns(dir, { v: 1, turns: [{ ref: 'ab12cd', updateId: 5, chatId: 42, sessionId: 's', firstAt: 1 }] }, home);
    expect(readTurns(dir, home).turns.length).toBe(1);
  });

  it('a malformed poll.json reads as empty, never trusted', () => {
    const dir = bindingDir(SCOPE, 'super', home);
    writePollState(dir, { v: 1, offset: 3, seenIds: [], notifiedIds: [], pending: [] }, home);
    writeFileSync(join(dir, 'poll.json'), '{ not json');
    expect(readPollState(dir, home).offset).toBe(0);
  });
});

describe('token redaction', () => {
  it('a token never survives into a log line, a Bot API URL included', () => {
    const line = `fetch failed: https://api.telegram.org/bot${TOKEN}/getUpdates (${TOKEN})`;
    const out = redactToken(line);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(TOKEN.split(':')[1]);
    expect(redactToken('x', TOKEN)).toBe('x');
    expect(redactToken(`a ${TOKEN} b`, TOKEN)).toBe('a <token> b');
  });
});
