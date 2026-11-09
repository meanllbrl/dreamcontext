/**
 * An agent's app request on the Super's Telegram bot (app-onay-karti C6): only while the owner is
 * away; a logo's picture first, the buttons on their own text message; a tap decides with the
 * request's CURRENT hash and removes the notch card; after a Mac decision a tap is stale.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openAppRequest, resetAppRequests, appRequestStatus, decideAppRequest, type ActionPlan } from '../../src/lib/apps/share/app-request.js';
import { resetAppGrants } from '../../src/lib/apps/share/app-grant.js';
import { listProposals } from '../../src/lib/assistant/proposals.js';
import { APP_LINES, appRequestHtml, resetTelegramAppRequests, wireTelegramAppRequests, type AppRequestHub } from '../../src/server/telegram/app-requests.js';
import { LINES, type ActiveBinding } from '../../src/server/telegram/hub.js';
import type { ButtonRecord } from '../../src/lib/telegram/contract.js';

type Sent = { html: string; labels: string[][]; rec: Partial<ButtonRecord>; data?: Record<string, unknown> };

const AB = { key: 'k', projectName: 'Yayinci' } as unknown as ActiveBinding;

function fakeHub(away: boolean): AppRequestHub & { sent: Sent[]; photos: Buffer[]; away: boolean; tap: (i: number, idx: number) => Promise<string | null> } {
  const h = {
    sent: [] as Sent[],
    photos: [] as Buffer[],
    away,
    awayFlushers: new Set<(ab: ActiveBinding) => Promise<void>>(),
    extraButton: null as AppRequestHub['extraButton'],
    superBindingOfVault: (v: string) => (v === 'yayinci' ? AB : null),
    ownerAway() { return h.away; },
    async sendButtons(_ab: ActiveBinding, html: string, labels: string[][], rec: Partial<ButtonRecord>, data?: Record<string, unknown>) { h.sent.push({ html, labels, rec, data }); return 'id'; },
    async tap(i: number, idx: number) {
      const s = h.sent[i];
      return h.extraButton!(AB, { id: 'x', botId: 1, chatId: 1, messageId: 1, textHash: '', options: 2, kind: s.rec.kind as ButtonRecord['kind'], singleUse: true, data: s.data }, idx);
    },
  };
  return h;
}

const plan = (over: Partial<ActionPlan> = {}): ActionPlan => ({
  vault: 'yayinci', projectRoot: '/p', key: 'tahmin', appName: 'Tahmin <b>', title: 'Herkese açık yayınla',
  lines: [{ label: 'Nereye', value: 'yayinci/tahmin-app' }, { label: 'Görünürlük', value: 'Herkese açık', tone: 'bad' }],
  warn: 'Herkese açık yayın geri alınamaz.',
  body: { action: 'publish', slug: 'tahmin', visibility: 'public', target: 'yayinci/tahmin-app', repoName: null, invite: [], approvals: [], note: null, catalog: true, digest: 'd', date: '2026-11-09', login: 'yayinci' },
  ...over,
});
const tick = () => new Promise((r) => setImmediate(r));

let off: (() => void) | null = null;
beforeEach(() => { resetAppRequests(); resetAppGrants(); resetTelegramAppRequests(); });
afterEach(() => { off?.(); off = null; resetAppRequests(); });

describe('app requests on Telegram', () => {
  it('at the Mac: nothing goes; turning away flushes the open card once', async () => {
    const hub = fakeHub(false);
    off = wireTelegramAppRequests(hub);
    openAppRequest({ plan: plan(), stillFresh: async () => true });
    await tick();
    expect(hub.sent).toHaveLength(0);
    hub.away = true;
    for (const f of hub.awayFlushers) await f(AB);
    for (const f of hub.awayFlushers) await f(AB);
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0].labels).toEqual([['Onayla', 'Reddet']]);
    expect(hub.sent[0].rec.kind).toBe('approval');
  });

  it('the message is the card: lines, the red line, escaped agent text', () => {
    const html = appRequestHtml({ action: 'publish', appName: 'Tahmin <b>', vault: 'yayinci', title: 'Herkese açık yayınla', lines: plan().lines, warn: 'Herkese açık yayın geri alınamaz.', hash: 'h' });
    expect(html).toContain('Tahmin &lt;b&gt;');
    expect(html).toContain('Nereye: yayinci/tahmin-app');
    expect(html).toContain('⚠️ Herkese açık yayın geri alınamaz.');
    expect(html).toContain(APP_LINES.footer);
  });

  it('a tap on Onayla approves with the current hash and removes the notch card; a second tap is stale', async () => {
    const hub = fakeHub(true);
    off = wireTelegramAppRequests(hub);
    const r = openAppRequest({ plan: plan(), stillFresh: async () => true });
    await tick();
    expect(listProposals().filter((p) => p.app)).toHaveLength(1);
    expect(await hub.tap(0, 0)).toBe(APP_LINES.approved);
    expect(appRequestStatus(r.id).state).toBe('approved');
    expect(listProposals().filter((p) => p.app)).toHaveLength(0);
    expect(await hub.tap(0, 0)).toBe(LINES.stale);
  });

  it('Reddet rejects; a tap after a Mac decision is stale and mints nothing', async () => {
    const hub = fakeHub(true);
    off = wireTelegramAppRequests(hub);
    const a = openAppRequest({ plan: plan(), stillFresh: async () => true });
    await tick();
    expect(await hub.tap(0, 1)).toBe(APP_LINES.rejected);
    expect(appRequestStatus(a.id).state).toBe('rejected');

    const b = openAppRequest({ plan: plan({ key: 'sayac', body: { ...plan().body, slug: 'sayac' } as ActionPlan['body'] }), stillFresh: async () => true });
    await tick();
    const hash = hub.sent[1].data!.hash as string;
    expect((await decideAppRequest({ id: b.id }, 'reject', { by: 'owner-page', hash })).ok).toBe(true);
    expect(await hub.tap(1, 0)).toBe(LINES.stale);
    expect(appRequestStatus(b.id).state).toBe('rejected');
  });

  it('an echoed hash that is not the request\'s current one decides nothing', async () => {
    const hub = fakeHub(true);
    off = wireTelegramAppRequests(hub);
    const r = openAppRequest({ plan: plan(), stillFresh: async () => true });
    await tick();
    hub.sent[0].data = { ...hub.sent[0].data, hash: 'f'.repeat(64) };
    expect(await hub.tap(0, 0)).toBe(LINES.stale);
    expect(appRequestStatus(r.id).state).toBe('pending');
  });

  it('a stale plan at the tap: nothing approved, said so', async () => {
    const hub = fakeHub(true);
    off = wireTelegramAppRequests(hub);
    const r = openAppRequest({ plan: plan(), stillFresh: async () => false });
    await tick();
    expect(await hub.tap(0, 0)).toBe(APP_LINES.stale);
    expect(appRequestStatus(r.id).state).toBe('stale');
  });

  it('a logo: the picture first, then the buttons on their own message', async () => {
    const hub = fakeHub(true);
    const order: string[] = [];
    off = wireTelegramAppRequests(hub, { sendPhoto: async (_ab, data) => { order.push('photo'); hub.photos.push(data); } });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const orig = hub.sendButtons.bind(hub);
    hub.sendButtons = async (...a) => { order.push('buttons'); return orig(...a); };
    openAppRequest({
      plan: plan({ title: 'Logoyu değiştir', warn: undefined, lines: [{ label: 'Boyut', value: '1 KB, PNG' }], body: { action: 'logo', slug: 'tahmin', sha256: 'a'.repeat(64), type: 'image/png' } }),
      logo: png, stillFresh: async () => true,
    });
    await tick();
    expect(order).toEqual(['photo', 'buttons']);
    expect(hub.photos[0].equals(png)).toBe(true);
  });

  it('another project\'s request does not go to this bot', async () => {
    const hub = fakeHub(true);
    off = wireTelegramAppRequests(hub);
    openAppRequest({ plan: plan({ vault: 'baska' }), stillFresh: async () => true });
    await tick();
    expect(hub.sent).toHaveLength(0);
  });
});
