/**
 * What a URL and a card title may become in Telegram (plan Q1-Q3, Q6, N4, P4).
 *
 *  - A web or live-browser card is NEVER a picture. Its URL decides the text: a public `https:`
 *    page (staging, production) → a link line `🔗 <host> · <title>` with a URL button to
 *    `origin + pathname` only (search, hash, userinfo dropped); anything the phone cannot open
 *    (loopback, private host, `file:`, `data:`, a non-web scheme, a tunnel domain, public `http:`)
 *    → one line "Mac'te açık: <title>", no address at all.
 *  - A pathname the redactor would change, or with a segment of 24+ base64url characters (a
 *    magic-link or share id), keeps the line but loses the button (Q6).
 *  - An agent's `dream-actions` url button is drawn `🔗 <host> · <label>`, never with a label
 *    that is or contains a system button's (Şifreyi gir, Telefonda aç, …), and only for `https:`.
 *    System URL buttons appear only under the hub's own "🔐 Mac'in kendi bağlantısı" line.
 */
import { domainToUnicode } from 'node:url';
import { remoteWebUrl } from '../super/remote-view.js';
import { isTunnelHost } from './contract.js';
import { redactSecrets, wouldRedact } from './format.js';

/** Labels only the hub's own messages carry (N4). */
export const SYSTEM_BUTTON_LABELS = [
  'Şifreyi gir', 'Telefonda aç', 'Telefon linkini aç', 'Onayla', 'Reddet', 'Çalıştır', 'İzin ver', "Super'i aç",
  'Gönder', 'Not ekle', 'Belirsiz', 'Bitti', 'Yaz', 'Sahnede aç',
] as const;

const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, "g");
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

/** NFKC, Turkish-aware casefold, invisible and bidi characters removed (P4). */
export function foldLabel(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
}

/** Does `label` equal or contain a system button's label? */
export function posesAsSystem(label: string): boolean {
  const f = foldLabel(label);
  return SYSTEM_BUTTON_LABELS.some((s) => f.includes(foldLabel(s)));
}

/** One line: control, bidi and zero-width stripped, a leading 🔐/🔗 removed, ≤80 code points,
 *  redacted (Q3 "Titles"). */
export function cleanTitle(raw: string, max = 80): string {
  let t = String(raw ?? '').replace(INVISIBLE, ' ').replace(LINE_SEPARATORS, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:\s*(?:🔐|🔗)\s*)+/u, '').trim();
  t = redactSecrets(t);
  const cps = Array.from(t);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : t;
}

/** A pathname segment that reads like a secret link id (Q6). */
const LONG_ID_SEGMENT = /(^|\/)[A-Za-z0-9_-]{24,}(?=\/|$)/;

export type WebLine =
  | { kind: 'link'; line: string; host: string; href?: string }
  | { kind: 'mac'; line: string };

/** The host as punycode, with its Unicode form beside it when they differ (Q3). */
function hostLabel(hostname: string): string {
  const uni = domainToUnicode(hostname);
  return uni && uni !== hostname ? `${hostname} (${uni})` : hostname;
}

/**
 * A web/browser card's URL as Telegram text. `tunnelHost` is the live hands-free tunnel's host
 * (a link to it is never sent). `kind:'file'` refs never come here (they keep their file path).
 */
export function webCardLine(url: string | null | undefined, title: string, tunnelHost: string | null = null): WebLine {
  const name = cleanTitle(title || 'sayfa');
  const mac: WebLine = { kind: 'mac', line: `Mac'te açık: ${name}` };
  if (!url) return mac;
  const ok = remoteWebUrl(url, tunnelHost);
  if (!ok) return mac;
  let u: URL;
  try { u = new URL(ok); } catch { return mac; }
  if (isTunnelHost(u.hostname)) return mac;
  const host = hostLabel(u.hostname);
  const href = `${u.origin}${u.pathname}`;
  const line = `🔗 ${host} · ${name}`;
  if (wouldRedact(u.pathname) || LONG_ID_SEGMENT.test(u.pathname)) return { kind: 'link', line, host };
  return { kind: 'link', line, host, href };
}

/** An agent's `dream-actions` url action: a URL button `🔗 <host> · <label>`, or a plain text
 *  line when the label poses as the hub's, the scheme is not https, or the host is local/tunnel. */
export function agentUrlButton(label: string, url: string, tunnelHost: string | null = null): { text: string; url: string } | { line: string } {
  const name = cleanTitle(label || 'bağlantı', 40);
  if (posesAsSystem(label)) return { line: `${name} (Mac'te)` };
  const w = webCardLine(url, name, tunnelHost);
  if (w.kind !== 'link' || !w.href) return { line: w.kind === 'link' ? w.line : `${name} (Mac'te)` };
  return { text: `🔗 ${w.host} · ${name}`.slice(0, 64), url: w.href };
}
