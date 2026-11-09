/**
 * An agent's app request card on the Super's Telegram bot (app-onay-karti plan r3, C6).
 *
 * Only while the owner is away (at the Mac the notch card is the only one; the turn-away flush
 * sends what is still open). A logo request sends the picture first; the buttons ride a separate
 * text message, because a photo carries a caption, not the text the button check hashes.
 *
 * A tap decides through `decideAppRequest` with the hash of the request's CURRENT plan, never
 * the hash echoed in the button record alone: a request decided on the Mac (or replaced, or
 * stale) answers "no longer valid" and mints nothing.
 */
import { appRequestOpen, decideAppRequest, onAppRequestOpened, openAppRequests } from '../../lib/apps/share/app-request.js';
import type { AppCardView } from '../../lib/assistant/proposals.js';
import type { ButtonRecord } from '../../lib/telegram/contract.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { caption, sendMedia } from './pictures.js';
import { LINES, type ActiveBinding } from './hub.js';

type Obj = Record<string, unknown>;
type ExtraButton = (ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number) => Promise<string | null>;

/** The part of the hub this needs (TelegramHub fits it). */
export interface AppRequestHub {
  superBindingOfVault(vault: string): ActiveBinding | null;
  ownerAway(): boolean;
  sendButtons(ab: ActiveBinding, html: string, labels: string[][], rec: Omit<ButtonRecord, 'id' | 'botId' | 'chatId' | 'messageId' | 'textHash' | 'options'>, data?: Obj): Promise<string>;
  awayFlushers: Set<(ab: ActiveBinding) => Promise<void>>;
  extraButton: ExtraButton | null;
}

export interface AppRequestDeps {
  /** The picture of a logo request (tests swap it). */
  sendPhoto?: (ab: ActiveBinding, data: Buffer, type: string, captionHtml: string) => Promise<unknown>;
}

export const APP_LINES = {
  approved: '✓ Onaylandı',
  rejected: '✗ Reddedildi',
  stale: 'App bu mesajdan sonra değişti; onaylanmadı. Agent yeniden sorar.',
  footer: 'Onaylarsan agent bunu bir kez yapar. Başka bir işi bu onayla yapamaz.',
} as const;

const sent = new Set<string>();

const clean = (s: string) => escapeHtml(redactSecrets(s));

/** The message: the card's own words. Agent text only in line values, escaped and redacted. */
export function appRequestHtml(view: AppCardView): string {
  const lines = [`✋ <b>${clean(view.renewal ? 'Süresi doldu' : 'Onay')}</b>: ${clean(view.appName)} · ${clean(view.title)}`];
  for (const l of view.lines) lines.push(`${clean(l.label)}: ${l.tone ? `<b>${clean(l.value)}</b>` : clean(l.value)}`);
  if (view.warn) lines.push(`⚠️ ${clean(view.warn)}`);
  lines.push('', `<i>${clean(APP_LINES.footer)}</i>`);
  return lines.join('\n');
}

async function offer(hub: AppRequestHub, deps: AppRequestDeps, r: { id: string; vault: string; view: AppCardView; hash: string; logo: Buffer | null }): Promise<void> {
  if (sent.has(r.id) || !hub.ownerAway()) return;
  const ab = hub.superBindingOfVault(r.vault);
  if (!ab) return;
  sent.add(r.id);
  try {
    if (r.logo && r.view.action === 'logo') {
      const type = r.view.lines.some((l) => /JPEG/.test(l.value)) ? 'image/jpeg' : 'image/png';
      await (deps.sendPhoto ?? defaultPhoto)(ab, r.logo, type, caption(`${r.view.appName}: yeni logo`));
    }
    await hub.sendButtons(ab, appRequestHtml(r.view), [['Onayla', 'Reddet']],
      { kind: 'approval', requestId: r.id, singleUse: true },
      { appRequest: r.id, hash: r.hash });
  } catch {
    sent.delete(r.id);
  }
}

const defaultPhoto = (ab: ActiveBinding, data: Buffer, type: string, captionHtml: string) =>
  sendMedia(ab, { kind: 'photo', file: { name: type === 'image/jpeg' ? 'logo.jpg' : 'logo.png', data, contentType: type }, title: 'logo' }, captionHtml);

/** A tap on Onayla (0) or Reddet (1). */
export async function onAppRequestButton(rec: ButtonRecord & { data?: Obj }, idx: number): Promise<string> {
  const id = typeof rec.data?.appRequest === 'string' ? rec.data.appRequest : '';
  const open = id ? appRequestOpen(id) : null;
  // Decided on the Mac, replaced, expired or restarted: nothing to decide here.
  if (!open || open.hash !== rec.data?.hash) return LINES.stale;
  const r = await decideAppRequest({ id }, idx === 0 ? 'approve' : 'reject', { by: 'telegram', hash: open.hash });
  if (r.ok) return r.state === 'approved' ? APP_LINES.approved : APP_LINES.rejected;
  return r.error === 'stale' ? APP_LINES.stale : LINES.stale;
}

export function wireTelegramAppRequests(hub: AppRequestHub, deps: AppRequestDeps = {}): () => void {
  const off = onAppRequestOpened((r) => { void offer(hub, deps, r); });
  const flush = async (ab: ActiveBinding): Promise<void> => {
    for (const r of openAppRequests()) if (hub.superBindingOfVault(r.vault) === ab) await offer(hub, deps, r);
  };
  hub.awayFlushers.add(flush);
  const prev = hub.extraButton;
  hub.extraButton = async (ab, rec, idx) => rec.kind === 'approval' && typeof rec.data?.appRequest === 'string'
    ? onAppRequestButton(rec, idx)
    : prev ? prev(ab, rec, idx) : LINES.stale;
  return () => { off(); hub.awayFlushers.delete(flush); hub.extraButton = prev; };
}

/** Tests only. */
export function resetTelegramAppRequests(): void { sent.clear(); }
