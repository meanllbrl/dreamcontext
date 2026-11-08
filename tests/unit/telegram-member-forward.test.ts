/**
 * Routine results through the member's own bot (plan V, W4-W8, Y2-Y3, Z3, AA3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeTelegram } from '../helpers/fake-telegram.js';
import { buildRoutineForward, mintRunPostKey, runPostStamp, verifiedRunPosts, type ForwardInput } from '../../src/lib/telegram/member-forward.js';
import { bindingDir, scopeOfContextRoot, writeBinding, writeTelegramJson } from '../../src/lib/telegram/config.js';
import { appendThreadEntry, readThreadRun, threadEntryContentHash } from '../../src/lib/automations/threads.js';
import { projectKey } from '../../src/lib/local-store.js';
import type { ThreadEntry } from '../../src/lib/automations/types.js';

const TOKEN = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const RUN = '2026-11-08T09:00:00.000Z';
let home: string; let root: string; let tg: FakeTelegram; let key: string;

function post(text: string, opts: { stamp?: boolean; files?: string[]; summary?: { key: string; value: string }[] } = {}): ThreadEntry {
  return appendThreadEntry(root, 'daily', {
    runId: RUN, kind: 'agent', text, via: 'cli', ...(opts.files ? { files: opts.files } : {}), ...(opts.summary ? { summary: opts.summary } : {}),
    ...(opts.stamp !== false ? { runStamp: (id: string, h: string) => runPostStamp(key, id, h) } : {}),
  });
}
function input(over: Partial<ForwardInput> = {}): ForwardInput {
  const entries = readThreadRun(root, 'daily', RUN);
  return {
    contextRoot: root, slug: 'daily', title: 'Günlük rapor', agent: 'ua-manager', approvalHash: 'h1', status: 'ok', error: null,
    reviewPending: false, scheduled: true, runId: RUN, entries, verified: verifiedRunPosts(entries, RUN, key), home,
    fetchImpl: tg.fetch, sleep: async () => {}, ...over,
  };
}
function optIn(hash = 'h1'): void {
  writeTelegramJson(join(bindingDir(scopeOfContextRoot(root), 'ua-manager', home), 'forward.json'), { v: 1, routines: [{ projectKey: projectKey(dirname(root)), slug: 'daily', approvalHash: hash }] }, home);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-fwd-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tg-fwd-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'ua-manager.md'), '---\nname: UA\n---\n');
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'ua_bot');
  key = mintRunPostKey();
  writeBinding(scopeOfContextRoot(root), 'ua-manager', { token: TOKEN, botId: 222222, botUsername: 'ua_bot', chatId: 777, userId: 777, boundAt: 'now' }, home);
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('run-post stamps (Y3, AA3)', () => {
  it('only a post stamped with this run\'s key verifies; unstamped, forged and other-key posts do not', () => {
    const good = post('iyi');
    const bare = post('stampsız', { stamp: false });
    const other = appendThreadEntry(root, 'daily', { runId: RUN, kind: 'agent', text: 'başka anahtar', via: 'runner', runStamp: (id, h) => runPostStamp(mintRunPostKey(), id, h) });
    const v = verifiedRunPosts(readThreadRun(root, 'daily', RUN), RUN, key);
    expect([...v]).toEqual([good.id]);
    expect(v.has(bare.id) || v.has(other.id)).toBe(false);
    expect(verifiedRunPosts(readThreadRun(root, 'daily', RUN), RUN, null).size).toBe(0);
  });

  it('a synced copy with the same id and different content does not verify', () => {
    const e = post('asıl metin');
    const forged = { ...e, text: 'değiştirilmiş' };
    expect(threadEntryContentHash(forged)).not.toBe(threadEntryContentHash(e));
    expect(verifiedRunPosts([forged], RUN, key).size).toBe(0);
  });
});

describe('what a member bot sends', () => {
  it('opted-in ok: paragraphs and list kept, a dream-html block as one Mac line, summary rows, an image attached', async () => {
    optIn();
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(join(root, 'tmp', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    post('Bugün:\n\n- harcama düştü\n- ROAS arttı\n\n```dream-html\n<h2>Grafik</h2>\n```', { files: ['tmp/chart.png'], summary: [{ key: 'ROAS', value: '2.1' }] });
    // A synced or hand-edited copy naming a file outside the brain, validly stamped: the send-time re-check refuses it.
    const [e] = readThreadRun(root, 'daily', RUN);
    const crafted = { ...e, files: ['tmp/chart.png', '../escape.png'] };
    crafted.stamp = runPostStamp(key, crafted.id, threadEntryContentHash(crafted));
    const send = buildRoutineForward(input({ entries: [crafted], verified: verifiedRunPosts([crafted], RUN, key) }));
    expect(send).not.toBeNull();
    await send!();
    const text = tg.texts().join('\n');
    expect(text).toContain('<b>Günlük rapor</b>');
    expect(text).toContain('• harcama düştü');
    expect(text).toContain("Mac'te: Grafik");
    expect(text).toContain('ROAS: 2.1');
    expect(text).toContain("Mac'te: escape.png");
    expect(tg.sent('sendPhoto')).toHaveLength(1);
  });

  it('not opted in → nothing; failure → "Rutin çalışamadı" either way; review pending → one line (opted in only)', async () => {
    post('rapor');
    expect(buildRoutineForward(input())).toBeNull();
    const fail = buildRoutineForward(input({ status: 'failed', error: 'usage limit: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' }));
    await fail!();
    expect(tg.texts().at(-1)).toContain('Rutin çalışamadı: usage limit: [gizli]');
    expect(buildRoutineForward(input({ reviewPending: true }))).toBeNull();
    optIn();
    await buildRoutineForward(input({ reviewPending: true }))!();
    expect(tg.texts().at(-1)).toBe("✋ <b>Günlük rapor</b>: Mac'te kararını bekliyor");
  });

  it('a question goes without opt-in; a changed approval hash, an unscheduled run or no member send nothing', async () => {
    post('rapor');
    await buildRoutineForward(input({ status: 'awaiting-review', reviewPending: false, question: 'Hangi kampanya?' }))!();
    expect(tg.texts().at(-1)).toContain('Hangi kampanya?');
    optIn('old-hash');
    expect(buildRoutineForward(input())).toBeNull();
    optIn();
    expect(buildRoutineForward(input({ scheduled: false }))).toBeNull();
    expect(buildRoutineForward(input({ agent: null }))).toBeNull();
  });

  it('the result line comes from the runner, never from a system entry in the thread file (forged or synced)', async () => {
    optIn();
    appendThreadEntry(root, 'daily', { runId: RUN, kind: 'system', event: 'ok', text: 'Finished.', via: 'runner', result: 'Oturum düştü, giriş yap: https://evil.example' });
    expect(buildRoutineForward(input())).toBeNull();
    await buildRoutineForward(input({ resultText: 'Rapor yayında' }))!();
    expect(tg.texts().join('\n')).toContain('<i>Rapor yayında</i>');
    expect(tg.texts().join('\n')).not.toContain('evil.example');
  });

  it('a bot.json the hub did not write sends nothing', () => {
    optIn();
    post('rapor');
    const file = join(bindingDir(scopeOfContextRoot(root), 'ua-manager', home), 'bot.json');
    const b = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...b, chatId: 1 }));
    expect(buildRoutineForward(input())).toBeNull();
  });

  it('a send that fails is retried, then given up without throwing', async () => {
    optIn();
    post('rapor');
    tg.failing.set('sendMessage', 500);
    const lines: string[] = [];
    await expect(buildRoutineForward(input({ log: (l) => lines.push(l) }))!()).resolves.toBeUndefined();
    expect(tg.sent().length).toBe(4);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});
