/**
 * super-rutin W1: `target` / `reply` on an automation, the consent gate on the approval stamp,
 * and a plain automation's results through the project's Super bot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  approveAutomation,
  canonicalApprovalPayload,
  checkApproval,
  getApproval,
  manifestHash,
} from '../../src/lib/automations/registry.js';
import { needsOwnerConsent, type AutomationManifest } from '../../src/lib/automations/types.js';
import { FakeTelegram } from '../helpers/fake-telegram.js';
import { buildRoutineForward, mintRunPostKey, runPostStamp, verifiedRunPosts, type ForwardInput } from '../../src/lib/telegram/member-forward.js';
import { scopeOfContextRoot, writeBinding } from '../../src/lib/telegram/config.js';
import { appendThreadEntry, readThreadRun } from '../../src/lib/automations/threads.js';
import { ownerAwayNow, writeAwayState } from '../../src/lib/telegram/away-state.js';

const PROJECT = '/Users/tester/projects/alpha';
let home: string;

function manifest(over: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    slug: 'sabah', id: 'auto_x', title: 'Sabah', enabled: true,
    schedule: { slots: [{ kind: 'weekly', days: 'daily', at: '09:00' }] },
    model: null, effort: null, timeoutMinutes: 15, catchupHours: 6, outputDir: null, shared: false,
    notify: true, learning: false, review: 'off', flow: null, whiteboard: null, pattern: '',
    prompt: 'Haberleri özetle.', outputInstructions: '', path: '/tmp/x/_dream_context/automations/sabah.md',
    body: '', runKind: 'automation', ...over,
  } as AutomationManifest;
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-super-rutin-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('the hash: appended last, omitted at the default', () => {
  it('a manifest without the fields (or reply: mac on a headless one) hashes as before; either field changes it', () => {
    const base = manifest();
    expect(canonicalApprovalPayload(base)).not.toContain('"target"');
    expect(canonicalApprovalPayload(base)).not.toContain('"reply"');
    expect(manifestHash(manifest({ reply: 'mac' }))).toBe(manifestHash(base));
    expect(manifestHash(manifest({ reply: 'telegram' }))).not.toBe(manifestHash(base));
    expect(manifestHash(manifest({ target: 'super' }))).not.toBe(manifestHash(base));
    // Last in the payload: the existing serialization is a strict prefix.
    const p = canonicalApprovalPayload(manifest({ target: 'super', reply: 'auto' }));
    expect(p.startsWith(canonicalApprovalPayload(base).slice(0, -1))).toBe(true);
    expect(p.endsWith(',"target":"super","reply":"auto"}')).toBe(true);
  });

  it('needsOwnerConsent: target super, reply telegram or auto; never mac or absent', () => {
    expect(needsOwnerConsent({})).toBe(false);
    expect(needsOwnerConsent({ reply: 'mac' })).toBe(false);
    expect(needsOwnerConsent({ reply: 'telegram' })).toBe(true);
    expect(needsOwnerConsent({ reply: 'auto' })).toBe(true);
    expect(needsOwnerConsent({ target: 'super' })).toBe(true);
  });
});

describe('the consent gate sits on the stamp', () => {
  it('a stamp without consent leaves a Super turn or a Telegram reply waiting; the owner\'s stamp runs it', () => {
    for (const m of [manifest({ target: 'super' }), manifest({ reply: 'telegram' })]) {
      approveAutomation(PROJECT, m, new Date(), home);
      const v = checkApproval(PROJECT, m, home, 'run', '');
      expect(v.approved).toBe(false);
      approveAutomation(PROJECT, m, new Date(), home, 'owner-page');
      expect(checkApproval(PROJECT, m, home, 'run', '').approved).toBe(true);
    }
  });

  it('an ordinary automation needs no consent (nothing existing re-blocks)', () => {
    const m = manifest();
    approveAutomation(PROJECT, m, new Date(), home);
    expect(checkApproval(PROJECT, m, home, 'run', '').approved).toBe(true);
  });

  it('a later consent-less re-stamp of the SAME hash keeps the consent; a changed hash loses it', () => {
    const m = manifest({ target: 'super' });
    approveAutomation(PROJECT, m, new Date(), home, 'super-verb');
    approveAutomation(PROJECT, m, new Date(), home);
    expect(getApproval(PROJECT, m.slug, home)?.consent).toBe('super-verb');
    expect(checkApproval(PROJECT, m, home, 'run', '').approved).toBe(true);
    const edited = manifest({ target: 'super', prompt: 'Başka bir iş.' });
    approveAutomation(PROJECT, edited, new Date(), home);
    expect(checkApproval(PROJECT, edited, home, 'run', '').approved).toBe(false);
  });
});

describe('a plain automation through the project\'s Super bot', () => {
  const TOKEN = '333333:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const RUN = '2026-11-09T06:00:00.000Z';
  let root: string; let tg: FakeTelegram; let key: string;
  function input(over: Partial<ForwardInput> = {}): ForwardInput {
    const entries = readThreadRun(root, 'sabah', RUN);
    return {
      contextRoot: root, slug: 'sabah', title: 'Sabah özeti', agent: 'sabah', approvalHash: 'h', status: 'ok', error: null,
      reviewPending: false, scheduled: true, runId: RUN, entries, verified: verifiedRunPosts(entries, RUN, key), home,
      fetchImpl: tg.fetch, sleep: async () => {}, ...over,
    };
  }
  beforeEach(() => {
    const project = mkdtempSync(join(tmpdir(), 'dc-super-rutin-proj-'));
    root = join(project, '_dream_context');
    mkdirSync(join(root, 'automations'), { recursive: true });
    writeFileSync(join(root, 'automations', 'sabah.md'), '---\ntitle: Sabah\n---\n## Prompt\n\nx\n');
    tg = new FakeTelegram(); tg.addBot(TOKEN, 'proje_super_bot');
    key = mintRunPostKey();
    writeBinding(scopeOfContextRoot(root), 'super', { token: TOKEN, botId: 333333, botUsername: 'proje_super_bot', chatId: 555, userId: 555, boundAt: 'now' }, home);
    appendThreadEntry(root, 'sabah', { runId: RUN, kind: 'agent', text: 'Bugün üç haber var.', via: 'cli', runStamp: (id: string, h: string) => runPostStamp(key, id, h) });
    appendThreadEntry(root, 'sabah', { runId: RUN, kind: 'agent', text: 'Damgasız sahte satır', via: 'runner' });
  });

  it('reply telegram: the stamped post goes, the unstamped one never', async () => {
    const send = buildRoutineForward(input({ reply: 'telegram' }));
    expect(send).not.toBeNull();
    await send!();
    const text = tg.texts().join('\n');
    expect(text).toContain('Bugün üç haber var.');
    expect(text).not.toContain('Damgasız');
  });

  it('unticked: an ok run sends nothing, a failure always goes', async () => {
    expect(buildRoutineForward(input())).toBeNull();
    await buildRoutineForward(input({ status: 'failed', error: 'zaman aşımı' }))!();
    expect(tg.texts().at(-1)).toContain('Rutin çalışamadı: zaman aşımı');
  });

  it('a question goes only while he is away', async () => {
    const q = { status: 'awaiting-review', question: 'Hangi kaynak?' };
    expect(buildRoutineForward(input({ ...q, away: () => false }))).toBeNull();
    await buildRoutineForward(input({ ...q, away: () => true }))!();
    expect(tg.texts().join('\n')).toContain('Hangi kaynak?');
  });

  it('no Super bot bound: nothing sent, and the log says why', () => {
    rmSync(join(home, '.dreamcontext', 'telegram'), { recursive: true, force: true });
    const lines: string[] = [];
    expect(buildRoutineForward(input({ reply: 'telegram', log: (l) => lines.push(l) }))).toBeNull();
    expect(lines.join('\n')).toContain("Telegram'a gitmedi: bu projenin Super botu bağlı değil");
  });

  it('a member with its own bot still uses its own bot, never the Super bot', async () => {
    mkdirSync(join(root, 'agents'), { recursive: true });
    writeFileSync(join(root, 'agents', 'ua.md'), '---\nname: UA\n---\n');
    const MEMBER = '444444:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    tg.addBot(MEMBER, 'ua_bot');
    writeBinding(scopeOfContextRoot(root), 'ua', { token: MEMBER, botId: 444444, botUsername: 'ua_bot', chatId: 556, userId: 555, boundAt: 'now' }, home);
    await buildRoutineForward(input({ agent: 'ua', status: 'failed', error: 'x' }))!();
    expect(tg.sent('sendMessage').at(-1)?.token).toBe(MEMBER);
  });
});

describe('ownerAwayNow', () => {
  it('app not running: away; running: what the hub wrote, under 24 h', () => {
    expect(ownerAwayNow(home, Date.now(), () => false)).toBe(true);
    expect(ownerAwayNow(home, Date.now(), () => true)).toBe(false);
    writeAwayState(true, home, 1_000);
    expect(ownerAwayNow(home, 2_000, () => true)).toBe(true);
    expect(ownerAwayNow(home, 1_000 + 25 * 3600_000, () => true)).toBe(false);
    writeAwayState(false, home, 3_000);
    expect(ownerAwayNow(home, 4_000, () => true)).toBe(false);
  });
});

void dirname;
