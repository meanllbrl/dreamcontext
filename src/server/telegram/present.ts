/**
 * The Super's stage presentations, mirrored to its Telegram bot (plan L1, L2, N1, N3, N9, S, T).
 *
 * When: a stage change the SUPER made (`open`, `half`, `present`, `shape`; the verb route fires
 * `stage-events`, the owner's layout door never does) during a Telegram turn (a live Telegram ref
 * in that chat, or an answer that carried a routable Telegram `re:` ref, M1) or while
 * Telegram-started hands-free streams (E3). Sent ONCE per turn, the final arrangement, at the
 * turn's end + 1 s settle (N9). Anything else is never sent.
 *
 * What: each card through `cards.ts`; pictures (photos and clips) as ONE album in stage order
 * with the layout and titles as its caption (one picture: a captioned photo), PDFs as documents,
 * every text card as one line in one message (a public page with its link button), then the
 * **Telefonda aç** message (N1): with Telegram + link hands-free on for this bot, the bare
 * tunnel origin to the phone page's Super chat under the hub's own "🔐 Mac'in kendi bağlantısı"
 * line; otherwise a **Telefon linkini aç** button that starts it. Only when something did not travel
 * (a text/page card or an unsent picture); an all-picture presentation sends no phone line. No picture at all while a
 * secret card is pending in that chat (L3).
 */
import { getChat, onChatAssistantText, onChatChange } from '../../lib/assistant/chat-registry.js';
import { appLinkForContextRoot } from '../../lib/app-link.js';
import { onStageVerb, type StageVerbEvent } from '../../lib/super/stage-events.js';
import { readSuperState } from '../../lib/super/store.js';
import type { SuperContainer, SuperState } from '../../lib/super/types.js';
import { escapeHtml, splitReplySections } from '../../lib/telegram/format.js';
import { cardOut, type CardContext, type CardOut } from './cards.js';
import { caption, sendMedia, sendPictures, type MediaItem, type Snapshotter } from './pictures.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';

export const PRESENT_SETTLE_MS = 1_000;
export const MAX_PRESENTED = 10;

const LAYOUT_WORD: Record<string, string> = {
  spotlight: 'Sunum', compare: 'Karşılaştırma', grid: 'Izgara', filmstrip: 'Film şeridi', review: 'İnceleme', half: 'Yan yana', open: 'Sahnede',
};

export interface PresenterDeps {
  snapshot: Snapshotter;
  /** `render_card` + server seal for an insight container (insight-render.ts). */
  renderInsight?: (ab: ActiveBinding, sessionId: string, containerId: string) => Promise<Buffer[] | null>;
  /** What a phone link can be for THIS binding: the live origin (Telegram + link started by this
   *  bot), why there is none (another hands-free is on), or `off` (a tap can start it). */
  phoneLink?: (ab: ActiveBinding) => PhoneLink;
  /** The live tunnel's host (a link to it is never sent, Q3). */
  tunnelHost?: () => string | null;
  settleMs?: number;
  isGitIgnored?: CardContext['isGitIgnored'];
}

interface Pending { key: string; verbs: StageVerbEvent[]; telegram: boolean }

export type PhoneLink = { origin: string } | { why: 'telegram-only' | 'other' | 'starting' } | 'off';
export const PHONE_LINES = {
  starting: 'Telefon linki hazırlanıyor; adres gelince buraya yazacağım.',
  offer: 'Telefonda açmak için önce telefon linki gerekir.',
} as const;

/** Is a secret card pending in this chat (no picture then, L3)? */
export function secretPending(sessionId: string): boolean {
  return !!getChat(sessionId)?.ownerWaits?.some((w) => w.kind === 'secret');
}

/** The cards a turn's stage verbs leave to present, in stage order, and the layout word. */
export function presentedCards(state: Pick<SuperState, 'containers' | 'view'>, verbs: readonly StageVerbEvent[]): { cards: SuperContainer[]; layout: string } | null {
  const byId = new Map(state.containers.map((c) => [c.id, c]));
  if (verbs.some((v) => v.verb === 'present') && state.view.mode === 'present' && state.view.cards?.length) {
    // The view's card list is the OWNER's when he set it himself: never sent. (Cards the Super's
    // own verbs named, below, are the Super's whatever view stays on screen.)
    if (state.view.by === 'owner') return null;
    const cards = state.view.cards.map((id) => byId.get(id)).filter((c): c is SuperContainer => !!c);
    return cards.length ? { cards, layout: state.view.layout ?? 'grid' } : null;
  }
  const ids: string[] = [];
  for (const v of verbs) for (const id of v.ids) if (byId.has(id) && !ids.includes(id)) ids.push(id);
  const cards = ids.map((id) => byId.get(id)!).filter((c) => c.kind !== 'agenda');
  if (!cards.length) return null;
  const half = state.view.mode === 'half' && verbs.some((v) => v.verb === 'half');
  return { cards, layout: half ? 'half' : cards.length === 1 ? 'spotlight' : 'open' };
}

/** The phone page's Super chat on the bare tunnel origin (N1): never a login token. */
export function phoneChatUrl(origin: string, ab: ActiveBinding, sessionId: string): string | null {
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const link = ab.contextRoot ? appLinkForContextRoot(ab.contextRoot, { kind: 'session', claudeId: sessionId } as never) : null;
  const q = new URLSearchParams({ vault: ab.projectName, ...(link ? { open: link } : {}) });
  return `${u.origin}/?${q.toString()}`;
}

/** The Telefonda aç message (hub-written; the only place a system URL button appears, N4). */
export async function sendPhoneButton(hub: TelegramHub, ab: ActiveBinding, sessionId: string, link: PhoneLink): Promise<void> {
  // A button only where tapping it can do what it says (a link already up, or one a tap starts).
  // Never an unasked instruction to change hands-free mode: with the link unavailable the
  // fallback line ("<title> (Mac'te)") already says where the card is.
  if (link !== 'off' && 'why' in link) { if (link.why === 'starting') await hub.reply(ab, PHONE_LINES.starting); return; }
  const url = link !== 'off' ? phoneChatUrl(link.origin, ab, sessionId) : null;
  if (link !== 'off' && !url) return;
  if (url) {
    const host = new URL(url).host;
    await hub.send(ab, escapeHtml(`🔐 Mac'in kendi bağlantısı: ${host}\nŞifreni yalnız bu adrese yaz.`), {
      reply_markup: { inline_keyboard: [[{ text: 'Telefonda aç', url }]] },
    }).catch(() => {});
    return;
  }
  await hub.sendButtons(ab, escapeHtml(PHONE_LINES.offer), [['Telefon linkini aç']],
    { kind: 'confirm', singleUse: true }, { action: 'phone-link' }).catch(() => {});
}

/** Sends one presentation. Returns what went (tests). */
export async function sendPresentation(hub: TelegramHub, ab: ActiveBinding, outs: CardOut[], layout: string, more: number, sessionId: string, deps: Pick<PresenterDeps, 'phoneLink'>): Promise<{ photos: number; album: boolean; texts: number }> {
  const titles = outs.map((o) => o.title).filter(Boolean);
  const head = `${LAYOUT_WORD[layout] ?? 'Sunum'}: ${titles.join(' · ')}${more > 0 ? ` · ve ${more} kart daha` : ''}`;
  const media: MediaItem[] = [];
  const docs: MediaItem[] = [];
  const lines: CardOut[] = [];
  for (const o of outs) {
    if (o.kind === 'media') for (const m of o.items) (m.kind === 'document' ? docs : media).push(m);
    else lines.push(o);
  }
  // Pictures Telegram refuses (too large, over the request fence, a failed send) and PDFs that
  // fail become text lines: the presentation is never just its footer.
  const { sent: pics, unsent } = await sendPictures(ab, media.slice(0, MAX_PRESENTED), caption(head));
  for (const d of docs) if (!(await sendMedia(ab, d, caption(d.title)))) unsent.push(d);
  const album = pics.length >= 2;
  const fallback = unsent.map((m) => `${m.title} (Mac'te)`);
  if (lines.length || fallback.length || !pics.length) {
    const text = [pics.length ? '' : `<b>${escapeHtml(head)}</b>`, ...lines.map((l) => escapeHtml(l.kind === 'text' ? l.line : l.title)), ...fallback.map(escapeHtml)].filter(Boolean).join('\n');
    const keyboard = lines.flatMap((l) => (l.kind === 'text' && l.button ? [[{ text: l.button.text, url: l.button.url }]] : []));
    await hub.send(ab, text, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}).catch(() => {});
  }
  // The phone line belongs only to a presentation Telegram could not carry whole (a live card,
  // a page, an unsent picture); one that arrived entirely as photos/documents needs no link.
  if (lines.length || unsent.length) await sendPhoneButton(hub, ab, sessionId, deps.phoneLink?.(ab) ?? 'off');
  return { photos: pics.length, album, texts: lines.length };
}

export function wirePresenter(hub: TelegramHub, deps: PresenterDeps): () => void {
  const pending = new Map<string, Pending>();
  const offVerb = onStageVerb((e) => {
    if (e.superId !== 'main') return;
    const ab = hub.superBindingOfVault(e.vault);
    if (!ab) return;
    const p = pending.get(e.sessionId) ?? { key: ab.key, verbs: [], telegram: false };
    p.verbs.push(e);
    if (hub.telegramTurnOf(e.sessionId) || hub.deps.handsfree?.streamsTo(ab.scope, ab.target)) p.telegram = true;
    pending.set(e.sessionId, p);
  });
  // An event turn that answers a Telegram ref counts as a Telegram turn (M1).
  const offText = onChatAssistantText((sid, text) => {
    const p = pending.get(sid);
    const ab = p ? hub.active.get(p.key) : null;
    if (!p || !ab || p.telegram) return;
    if (splitReplySections(text).some((s) => s.refs.some((r) => hub.routable(ab, r)))) p.telegram = true;
  });
  const offChange = onChatChange(({ entry, from }) => {
    // A chat that dies mid-turn takes its pending presentation with it.
    if (entry.status === 'gone') { pending.delete(entry.sessionId); return; }
    if (entry.status !== 'idle' || from === 'idle') return;
    const p = pending.get(entry.sessionId);
    if (!p) return;
    pending.delete(entry.sessionId);
    if (!p.telegram) return;
    const t = setTimeout(() => { void present(entry.sessionId, p).catch(() => {}); }, deps.settleMs ?? PRESENT_SETTLE_MS);
    t.unref?.();
  });

  async function present(sessionId: string, p: Pending): Promise<void> {
    const ab = hub.active.get(p.key);
    if (!ab || ab.disabled || !ab.contextRoot) return;
    const state = await readSuperState(ab.contextRoot);
    const picked = presentedCards(state, p.verbs);
    if (!picked) return;
    const shown = picked.cards.slice(0, MAX_PRESENTED);
    const ctx: CardContext = {
      contextRoot: ab.contextRoot, sessionId, pictures: !secretPending(sessionId), tunnelHost: deps.tunnelHost?.() ?? null,
      snapshot: deps.snapshot, isGitIgnored: deps.isGitIgnored,
      ...(deps.renderInsight ? { renderInsight: (id: string) => deps.renderInsight!(ab, sessionId, id) } : {}),
    };
    const outs: CardOut[] = [];
    for (const c of shown) outs.push(await cardOut(ctx, c));
    await sendPresentation(hub, ab, outs, picked.layout, picked.cards.length - shown.length, sessionId, deps);
  }

  const prevButton = hub.extraButton;
  hub.extraButton = async (ab, rec, idx) => {
    if (rec.kind === 'confirm' && rec.data?.action === 'phone-link') {
      return hub.deps.handsfree?.onCallback ? hub.deps.handsfree.onCallback(hub, ab.key, rec, 1) : LINES.stale;
    }
    return prevButton ? prevButton(ab, rec, idx) : LINES.stale;
  };
  return () => { offVerb(); offText(); offChange(); hub.extraButton = prevButton; pending.clear(); };
}
