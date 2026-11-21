/**
 * Every surface block of a Super answer has a Telegram form (plan M5, N4, S1, T1-T3).
 *
 * The text's own pictures (`![name](path)`) go first, right after it (`sendTextPictures`).
 * The text itself goes through `format.ts` with `blocks: 'hub'` (those fences left out); this
 * module sends, after it, in order:
 *  - `dream-html` → a picture built by the server from the transcript bytes (chat kit, sandboxed
 *    frame, network-less), when pictures are allowed (the text landed on Telegram and no secret
 *    card is pending); a redactor hit, no window or no picture → "Bu kart Mac'te: <başlık>";
 *  - `dream-actions` → never JSON: `url` → a link button `🔗 <host> · <label>` (no system label,
 *    https only, no local or tunnel host); `ask` → "▸ <label>: «text»" and a button that needs a
 *    second confirm tap before its text goes as an owner turn; `task`/`knowledge`/`core` → their
 *    title line; `board`/`develop`/`file`/`reveal`/anything else → "<label> (Mac'te)";
 *  - `dream-view` `insight` → its title line (inline insight pictures are a follow-up);
 *    `agent-thread` → the member named; `automation` → its approval card, whole, with Onayla /
 *    Reddet (automation-approvals.ts; the old "Onay bekliyor: <slug> · Mac'te" when it cannot go);
 *    `learned` → the rule's own receipt line (`learn`'s line 2) with a "Geri al" button for an
 *    active rule (learning loop C9); keeping or dropping a proposed one stays on the Mac.
 */
import { noteUndelivered } from '../../lib/super/undelivered.js';
import { escapeHtml, fenceTitle, imageName, markdownFileLinks, markdownImages } from '../../lib/telegram/format.js';
import { dreamHtmlPage, fenceBlocks } from '../../lib/telegram/render.js';
import { agentUrlButton, cleanTitle } from '../../lib/telegram/urls.js';
import { neutraliseHeaders } from '../../lib/telegram/inbound.js';
import { caption, pictureTitle, pngFile, sendMedia, sendPictures, type MediaItem, type Snapshotter } from './pictures.js';
import { NOT_SENT, cardWhy, notSentLine, readProjectFile, type CardContext } from './cards.js';
import { superMediaRoots } from './media-roots.js';
import { secretPending } from './present.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';
import { RULE_ID_RE, undoRule } from '../../lib/rules-store.js';
import { ownerLine } from '../../cli/commands/learn.js';
import { locateRule } from '../routes/learned.js';
import { sendAutomationCard } from './automation-approvals.js';

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_FILE = /\.(mp4|m4v|mov|webm)$/i;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

export interface BlocksDeps {
  snapshot: Snapshotter;
  /** Injectable for tests; defaults to `superMediaRoots`. */
  mediaRoots?: (contextRoot: string) => Promise<string[]>;
  isGitIgnored?: CardContext['isGitIgnored'];
  tunnelHost?: () => string | null;
  lang?: (ab: ActiveBinding) => string | undefined;
}

export interface ActionsMessage {
  lines: string[];
  /** URL rows and callback rows, in order. */
  urls: { text: string; url: string }[];
  asks: { label: string; text: string }[];
}

/** A `dream-actions` block as Telegram text + buttons (pure, unit-tested). */
export function actionsMessage(body: string, tunnelHost: string | null = null): ActionsMessage {
  const out: ActionsMessage = { lines: [], urls: [], asks: [] };
  let list: unknown;
  try { list = JSON.parse(body); } catch { out.lines.push("Düğmeler (Mac'te)"); return out; }
  if (!Array.isArray(list)) { out.lines.push("Düğmeler (Mac'te)"); return out; }
  for (const raw of list.slice(0, 8)) {
    const a = obj(raw);
    if (!a) continue;
    const label = cleanTitle(typeof a.label === 'string' ? a.label : 'düğme', 40);
    const action = typeof a.action === 'string' ? a.action : '';
    if (action === 'url' && typeof a.url === 'string') {
      const b = agentUrlButton(label, a.url, tunnelHost);
      if ('url' in b) out.urls.push(b); else out.lines.push(b.line);
    } else if (action === 'ask' && typeof a.text === 'string' && a.text.trim()) {
      const text = neutraliseHeaders(a.text.slice(0, 2000));
      out.asks.push({ label, text });
      out.lines.push(`▸ ${label}: «${cleanTitle(text, 200)}»`);
    } else if ((action === 'task' || action === 'knowledge' || action === 'core') && typeof a.id === 'string') {
      out.lines.push(`${label}: ${cleanTitle(a.id, 60)}`);
    } else {
      out.lines.push(`${label} (Mac'te)`);
    }
  }
  return out;
}

/** A `dream-view` the hub draws (insight, agent-thread, automation, app-request) as one line. */
export function viewLine(body: string): string | null {
  let v: Obj | null;
  try { v = obj(JSON.parse(body)); } catch { return null; }
  if (!v) return null;
  const id = cleanTitle(String(v.id ?? v.slug ?? ''), 60);
  if (v.type === 'insight') return `Insight: ${id || 'kart'} (Mac'te)`;
  if (v.type === 'agent-thread') return `${id || 'Üye'}: konuşma Mac'te`;
  if (v.type === 'automation') return `✋ Onay bekliyor: ${id || 'rutin'} · ${LINES.waitingOnMac}`;
  // The Onayla/Reddet buttons ride their own message (telegram/app-requests.ts) when he is away.
  if (v.type === 'app-request') return `✋ App onayı bekliyor · ${LINES.waitingOnMac}`;
  return null;
}

/** The slug an `automation` view names ('' when it names none), or null for any other block. */
export function automationViewSlug(body: string): string | null {
  let v: Obj | null;
  try { v = obj(JSON.parse(body)); } catch { return null; }
  if (!v || v.type !== 'automation') return null;
  return typeof v.slug === 'string' ? v.slug : typeof v.id === 'string' ? v.id : '';
}

/** A `learned` view as its receipt line, plus whether its Undo button is offered (pure enough to test). */
export function learnedMessage(contextRoot: string, body: string, home?: string): { line: string; id: string; undo: boolean } | null {
  let v: Obj | null;
  try { v = obj(JSON.parse(body)); } catch { return null; }
  if (!v || v.type !== 'learned' || typeof v.id !== 'string' || !RULE_ID_RE.test(v.id)) return null;
  const found = locateRule(contextRoot, v.id, home);
  if (!found) return { line: 'Bu kural bu projede yok.', id: v.id, undo: false };
  const active = found.view.status === 'active';
  const line = ownerLine(found.view, found.replacedHeadline ?? undefined).replace(/ · yanlışsa "geri al" de$/, '');
  return { line: found.view.status === 'proposed' ? `${line} · Mac'te tut ya da bırak` : line, id: v.id, undo: active };
}

/** The "Geri al" tap on a learned rule's Telegram line: his own chat, his tap. */
export async function onLearnedButton(hub: TelegramHub, ab: ActiveBinding, data: Obj, home?: string): Promise<string> {
  const id = typeof data.id === 'string' ? data.id : '';
  // The project this bot talks in (a global member's binding names none: `rootOf`).
  const root = hub.rootOf(ab);
  if (!root || !RULE_ID_RE.test(id)) return LINES.stale;
  try {
    const found = locateRule(root, id, home);
    if (!found) return 'Bu kural bu projede yok.';
    const change = undoRule(found.ref, id, { by: 'owner', conversation: 'telegram' });
    if (!change.ok) return change.reason.slice(0, 180);
    return change.restored ? `↩ Geri alındı · eskisi geri geldi: "${change.restored.headline}"`.slice(0, 190) : '↩ Geri alındı';
  } catch {
    return 'Olmadı. Mac\'te deneyin.';
  }
}

/** Pictures per album: Telegram's own limit. More pictures in one text go as more albums. */
export const MAX_TEXT_PICTURES = 10;

/**
 * The text's own pictures (`![alt](path)`), right after it: each read through H with the
 * Super's media roots (a child's worktree, a linked repo, the temp folder: media only), sent as
 * one photo or album with "N · name" captions; every picture that does not go is one line
 * saying which and why (owner 2026-11-13: never a silent drop). Web pictures stay links in the
 * text. Returns how many went.
 *
 * Every picture goes (owner 2026-11-17: a board exported section by section is one picture per
 * section): more than one album's worth goes as several albums in order, numbered on. A
 * `whiteboard render` layout check is captioned as a draft, never passed off as the board.
 */
export async function sendTextPictures(hub: TelegramHub, ab: ActiveBinding, text: string, pictures: boolean, deps: Pick<BlocksDeps, 'mediaRoots' | 'isGitIgnored'> = {}, sessionId: string | null = null): Promise<number> {
  const local = markdownImages(text).filter((i) => !i.web);
  const docSeen = new Set<string>();
  const docs = markdownFileLinks(text).filter((d) => (docSeen.has(d.src) ? false : (docSeen.add(d.src), true)));
  const root = hub.rootOf(ab);
  if (!local.length && !docs.length) return 0;
  if (!root) {
    // Never a silent drop: the text already left the picture or the file out ('hub' mode).
    const n = local.length + docs.length;
    await hub.notice(ab, 'file', `${n === 1 ? (docs.length ? 'Dosya' : 'Resim') : `${n} dosya`} gönderilemedi: bu botun projesi Mac'te bulunamadı.`);
    noteUndelivered(sessionId, 'picture', `${n} picture(s) or file(s) of your answer did not reach his phone: this bot's project was not found on the Mac.`);
    return 0;
  }
  const seen = new Set<string>();
  const wanted = local.filter((i) => (seen.has(i.src) ? false : (seen.add(i.src), true)));
  const lines: string[] = [];
  const items: MediaItem[] = [];
  const roots = pictures ? await (deps.mediaRoots ?? superMediaRoots)(root) : [];
  for (const img of wanted) {
    const name = cleanTitle(imageName(img), 80);
    if (!pictures) { lines.push(notSentLine('Resim: ', name, NOT_SENT.secret)); continue; }
    const f = readProjectFile({ contextRoot: root, mediaRoots: roots, ...(deps.isGitIgnored ? { isGitIgnored: deps.isGitIgnored } : {}) }, img.src);
    if (!f.ok) { lines.push(notSentLine('Resim: ', name, cardWhy(f.reason))); continue; }
    const kind = IMAGE_FILE.test(f.file.name) ? 'photo' : VIDEO_FILE.test(f.file.name) ? 'video' : null;
    if (!kind) { lines.push(notSentLine('Resim: ', name, NOT_SENT.format)); continue; }
    items.push({ kind, file: f.file, title: pictureTitle(f.file.data, name) });
  }
  let sent = 0;
  for (let i = 0; i < items.length; i += MAX_TEXT_PICTURES) {
    const r = await sendPictures(ab, items.slice(i, i + MAX_TEXT_PICTURES), true, i);
    sent += r.sent.length;
    for (const m of r.unsent) lines.push(notSentLine('Resim: ', m.title, NOT_SENT.refused));
  }
  // A linked PDF goes as the document itself, its label the caption (owner 2026-11-21).
  for (const d of docs) {
    const name = cleanTitle(imageName(d), 80);
    if (!pictures) { lines.push(notSentLine('Dosya: ', name, NOT_SENT.secret)); continue; }
    const f = readProjectFile({ contextRoot: root, mediaRoots: roots, ...(deps.isGitIgnored ? { isGitIgnored: deps.isGitIgnored } : {}) }, d.src);
    if (!f.ok) { lines.push(notSentLine('Dosya: ', name, cardWhy(f.reason))); continue; }
    const doc: MediaItem = { kind: 'document', file: f.file, title: name };
    if (await sendMedia(ab, doc, caption(name)).catch(() => null)) sent++;
    else lines.push(notSentLine('Dosya: ', name, NOT_SENT.refused));
  }
  if (lines.length) await hub.send(ab, lines.map((l) => `📎 <i>${escapeHtml(l)}</i>`).join('\n')).catch(() => {});
  // The Super hears it too (undelivered.ts): his note says what did not go, the Super must not say "sent".
  // Pictures held back while a secret card waits are not a failure: they go after it (as the card branch).
  if (lines.length && pictures) noteUndelivered(sessionId, 'picture', `${lines.length} of the ${wanted.length} picture(s) in your answer did not reach his phone (${lines.join('; ')}).`);
  return sent;
}

/** The answer's blocks, sent after its text. */
export async function sendAnswerBlocks(hub: TelegramHub, ab: ActiveBinding, text: string, sessionId: string, deps: BlocksDeps): Promise<void> {
  // Called only after this text landed on Telegram (hub.onAssistantText): its pictures go with
  // it, whatever made the text go (a Telegram turn, a routable Telegram ref, the owner on
  // Telegram, streaming). None while a secret card is pending (L3).
  const pictures = !secretPending(sessionId);
  await sendTextPictures(hub, ab, text, pictures, deps, sessionId).catch(() => 0);
  for (const b of fenceBlocks(text)) {
    if (b.lang === 'dream-html') {
      const title = cleanTitle(fenceTitle('dream-html', b.body));
      const plan = pictures ? dreamHtmlPage(b.body, { lang: deps.lang?.(ab) }) : null;
      const pngs = plan?.ok ? await deps.snapshot(sessionId, plan.page, plan.width) : null;
      if (pngs?.length) {
        const items = pngs.map((p, i) => ({ kind: 'photo' as const, file: pngFile(`kart-${i + 1}`, p), title }));
        const { sent } = await sendPictures(ab, items);
        if (!sent.length) {
          await hub.notice(ab, 'info', `Bu kart Telegram'a gitmedi, Mac'te: ${title}`);
          noteUndelivered(sessionId, 'card', `Your drawing "${title}" did not reach his phone (Telegram refused its picture); it is on the Mac only.`);
        } else if (pngs.length > 3) await hub.notice(ab, 'info', "Kartın devamı Mac'te.");
      } else {
        await hub.notice(ab, 'info', `Bu kart Telegram'a gitmedi, Mac'te: ${title}`);
        if (pictures) noteUndelivered(sessionId, 'card', `Your drawing "${title}" did not reach his phone (it could not be drawn as a picture); it is on the Mac only.`);
      }
    } else if (b.lang === 'dream-actions') {
      const m = actionsMessage(b.body, deps.tunnelHost?.() ?? null);
      const rows: unknown[][] = m.urls.map((u) => [{ text: u.text, url: u.url }]);
      const html = m.lines.map(escapeHtml).join('\n') || escapeHtml('Bağlantılar');
      if (m.asks.length) {
        // Asks need a confirm tap (N4): the record carries each ask's text, the URL rows ride along.
        const id = await hub.sendButtons(ab, html, m.asks.map((a) => [`▸ ${a.label}`.slice(0, 60)]),
          { kind: 'confirm', singleUse: false }, { action: 'ask-pick', asks: m.asks, session: sessionId }, rows).catch(() => null);
        if (id === null) await hub.reply(ab, m.lines.join('\n'));
      } else {
        await hub.send(ab, html, rows.length ? { reply_markup: { inline_keyboard: rows } } : {}).catch(() => {});
      }
    } else if (b.lang === 'dream-view') {
      let learned: ReturnType<typeof learnedMessage> = null;
      const root = hub.rootOf(ab);
      try { learned = root ? learnedMessage(root, b.body) : null; } catch { learned = null; }
      if (learned?.undo) {
        const sent = await hub.sendButtons(ab, escapeHtml(learned.line), [['Geri al']], { kind: 'confirm', singleUse: true }, { action: 'learned-undo', id: learned.id }).catch(() => null);
        if (sent === null) await hub.reply(ab, learned.line);
        continue;
      }
      if (learned) { await hub.reply(ab, learned.line); continue; }
      // An automation's approval card: the whole card with Onayla / Reddet (automation-approvals.ts).
      const auto = automationViewSlug(b.body);
      if (auto !== null) { await sendAutomationCard(hub, ab, auto, sessionId).catch(() => false); continue; }
      const line = viewLine(b.body);
      if (line) await hub.reply(ab, line);
    }
  }
}

/** The ask buttons: the first tap asks to confirm, the second sends the text as an owner turn. */
export async function onAskButton(hub: TelegramHub, ab: ActiveBinding, data: Obj, idx: number): Promise<string | null> {
  const asks = Array.isArray(data.asks) ? (data.asks as { label: string; text: string }[]) : [];
  const ask = data.action === 'ask-confirm' ? asks[0] : asks[idx];
  if (!ask || typeof ask.text !== 'string') return LINES.stale;
  if (data.action === 'ask-pick') {
    await hub.sendButtons(ab, escapeHtml(`Gönderilsin mi?\n«${cleanTitle(ask.text, 300)}»`), [['Gönder', 'Vazgeç']],
      { kind: 'confirm', singleUse: true }, { action: 'ask-confirm', asks: [ask], session: data.session });
    return null;
  }
  if (idx !== 0) return 'Vazgeçildi';
  // The Super this bot talks to: main's, or the member's own.
  const s = await hub.readBound(ab);
  if (!s) return LINES.stale;
  if (!s.enabled || !s.session) return LINES.superOff;
  const ok = await hub.injectText(ab, hub.syntheticUpdateId(), ask.text, s.session);
  return ok ? '✓ Gönderildi' : null;
}
