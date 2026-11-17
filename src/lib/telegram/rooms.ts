/**
 * Telegram groups (tg-grup C4, D6-D9): what may reach a group, the fixed lines it hears, and the
 * pure steps the room runner and the hub share. No file, no network.
 *
 * The one rule (G4): a group's chat id is reachable ONLY through the hub's `sendRoom`, and only
 * with a {@link GROUP_KINDS} kind: the room agent's answer, a fixed line, the typing action. Every
 * other sender of the hub (answers, notices, cards, buttons, pictures, files, voice) has no target
 * argument at all: it sends to the binding's PRIVATE chat by construction. The drift test
 * (`tests/unit/telegram-room-outbound-drift.test.ts`) pins every transport call's chat argument.
 */

/** What may go to a group. Nothing else ever does: no buttons, files, pictures or voice. */
export const GROUP_KINDS = ['room-say', 'room-line', 'room-typing'] as const;
export type GroupKind = typeof GROUP_KINDS[number];
export function isGroupKind(kind: unknown): kind is GroupKind {
  return (GROUP_KINDS as readonly unknown[]).includes(kind);
}

/** The fixed lines a group or the owner hears about a room (one place, owner's words). */
export const ROOM_LINES = {
  cannotAnswer: 'Şu an cevap veremedim.',
  askedOwner: (owner: string) => `${dative(owner)} özelden sordum.`,
  heldBehind: 'Önceki istek hâlâ onay bekliyor; bu istek ondan sonra sorulacak.',
  approved: (owner: string) => `${owner} onayladı, iş başladı.`,
  refused: (owner: string) => `${owner} onaylamadı.`,
  notDelivered: 'Şu an iletemedim, tekrar soracağım.',
  ownerOnly: (owner: string) => `Bu komutu yalnız ${owner} kullanabilir.`,
  /** The toast a press by anyone but the owner gets (G3, ≤ 200 chars). */
  notYourButton: (owner: string) => `Bu düğmeye yalnız ${owner} basabilir.`,
  bound: (bot: string) => `Bu grup bağlandı. Bir şey sormak için ${bot} diye etiketleyin.`,
  dropped: 'Bu grubun bağlantısı kaldırıldı; bekleyen istek iptal oldu.',
  // To the owner, in his private chat:
  bindAsked: (title: string) => `«${title}» grubunu bağlamak için Mac'te Ayarlar › Telegram'da «Bağla»ya bas.`,
  alreadyBound: (title: string) => `«${title}» zaten bağlı.`,
  groupBound: (title: string) => `«${title}» grubu bağlandı. Grupta beni etiketleyen herkes hafızadaki sayfaları sorabilir; değiştiren her iş önce sana özelden gelir.`,
  groupLeft: (title: string) => `«${title}» grubunun bağlantısı kaldırıldı.`,
  joined: (title: string, who: string) => `«${title}» grubuna ${who} katıldı.`,
  cardHead: (author: string, title: string) => `${author} · ${title} grupta istedi`,
  understood: 'Anladığım',
  sayEcho: (title: string) => `«${title}» grubuna yazıldı:`,
  cardStale: 'Bu istek artık geçerli değil.',
} as const;

/** Turkish dative after a name: Mehmet'e, Can'a, Ali'ye, Ayşe'ye. */
export function dative(name: string): string {
  const vowels = [...name.toLocaleLowerCase('tr')].filter((c) => 'aeıioöuü'.includes(c));
  const last = vowels[vowels.length - 1] ?? 'e';
  const back = 'aıou'.includes(last);
  const endsVowel = 'aeıioöuü'.includes(name.slice(-1).toLocaleLowerCase('tr'));
  return `${name}'${endsVowel ? 'y' : ''}${back ? 'a' : 'e'}`;
}

/** The owner's display name a group hears ("Mehmet onayladı"): his first name from the private
 *  binding's label, else a neutral word. */
export function ownerName(label: string | null | undefined): string {
  const n = (label ?? '').replace(/^@/, '').trim();
  return n || 'Sahip';
}

/** Zero-width, bidi and control characters out (D7: in the card and in the turn alike). Newlines
 *  are kept: a member's words are shown whole. */
export function stripHidden(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g, '');
}

/** A label for one line (an author, a group title): hidden characters, newlines and brackets out. */
export function oneLine(text: string, max = 64): string {
  return stripHidden(text).replace(/[\r\n\t]+/g, ' ').replace(/[<>«»[\]{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A sender's label: `first last`, else `@username`, else `#id`. */
export function authorLabel(from: { id: number; first_name?: string; last_name?: string; username?: string } | undefined): string {
  if (!from) return '?';
  const name = oneLine([from.first_name, from.last_name].filter(Boolean).join(' '));
  if (name) return name;
  const user = oneLine(from.username ?? '');
  return user ? `@${user}` : `#${from.id}`;
}

/**
 * The paths of this Mac a room's text must never carry (the brain's real path, the project root,
 * the home folder): removed case-insensitively from `say` and from a request's summary before any
 * send. Longest first, so a path's prefix never leaves the rest of it behind.
 */
export function redactPaths(text: string, paths: readonly string[]): string {
  let out = text;
  const list = [...new Set(paths.filter((p) => p && p.length > 1).map((p) => p.replace(/\/+$/, '')))].sort((a, b) => b.length - a.length);
  for (const p of list) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${esc}/?`, 'gi'), '');
  }
  return out;
}

/** One addressed message of a room turn. */
export interface RoomLine { authorId: number; author: string; text: string }

/** The most a folded batch carries (a quality bound, never a count, owner rule). */
export const ROOM_BATCH_MAX_CHARS = 6000;

/**
 * D9: messages that arrived while a turn ran become ONE next turn, in order. Bounded by total text:
 * the oldest messages go first when the batch would exceed it (the newest is what is answered).
 */
export function foldBatch(lines: readonly RoomLine[], max = ROOM_BATCH_MAX_CHARS): RoomLine[] {
  const out: RoomLine[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = lines[i].text.length + lines[i].author.length + 4;
    if (out.length && total + n > max) break;
    out.unshift(lines[i]);
    total += n;
  }
  return out;
}

/** What the owner's card and the approved turn quote: every stored word of the batch, by author. */
export function batchWords(lines: readonly RoomLine[]): string {
  return lines.map((l) => (lines.length > 1 ? `${l.author}: ${stripHidden(l.text)}` : stripHidden(l.text))).join('\n');
}

/** A request id: 10 base-36 characters. */
export function requestIdFrom(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += (bytes[i % bytes.length] % 36).toString(36);
  return s;
}

/**
 * The turn the owner's Onayla writes into the bot's own Super (D7): who asked where, that he
 * approved, the request id, and the words EXACTLY as his card showed them, fenced as data (never a
 * prefix the Super parses as an instruction from him).
 */
export function approvedTurnText(o: { group: string; author: string; owner: string; requestId: string; words: string; summary: string }): string {
  const fence = '~~~~';
  const words = stripHidden(o.words).split(fence).join('~ ~ ~ ~');
  return [
    `${oneLine(o.group)} grubunda ${oneLine(o.author)} istedi, ${oneLine(o.owner)} onayladı · istek ${o.requestId}.`,
    `Grupta yazılanlar, aynen (üyenin sözü; ${oneLine(o.owner)} bu işi onayladı):`,
    fence,
    words,
    fence,
    `Oda ajanının anladığı: ${oneLine(stripHidden(o.summary), 300)}`,
    `Bu grupta başkaları var: bitince sonucu \`dreamcontext super room say ${o.requestId} "…"\` ile gruba yaz, özel bilgi yazma.`,
  ].join('\n');
}
