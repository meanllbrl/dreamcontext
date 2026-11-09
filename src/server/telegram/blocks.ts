/**
 * Every surface block of a Super answer has a Telegram form (plan M5, N4, S1, T1-T3).
 *
 * The text itself goes through `format.ts` with `blocks: 'hub'` (those fences left out); this
 * module sends, after it, in order:
 *  - `dream-html` → a picture built by the server from the transcript bytes (chat kit, sandboxed
 *    frame, network-less), when pictures are allowed (a live Telegram turn or streaming, and no
 *    secret card pending); a redactor hit, no window or no picture → "Bu kart Mac'te: <başlık>";
 *  - `dream-actions` → never JSON: `url` → a link button `🔗 <host> · <label>` (no system label,
 *    https only, no local or tunnel host); `ask` → "▸ <label>: «text»" and a button that needs a
 *    second confirm tap before its text goes as an owner turn; `task`/`knowledge`/`core` → their
 *    title line; `board`/`develop`/`file`/`reveal`/anything else → "<label> (Mac'te)";
 *  - `dream-view` `insight` → its title line (inline insight pictures are a follow-up);
 *    `agent-thread` → the member named; `automation` → "Onay bekliyor: <slug> · Mac'te".
 */
import { escapeHtml, fenceTitle } from '../../lib/telegram/format.js';
import { dreamHtmlPage, fenceBlocks } from '../../lib/telegram/render.js';
import { agentUrlButton, cleanTitle } from '../../lib/telegram/urls.js';
import { neutraliseHeaders } from '../../lib/telegram/inbound.js';
import { pngFile, sendPictures, type Snapshotter } from './pictures.js';
import { secretPending } from './present.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

export interface BlocksDeps {
  snapshot: Snapshotter;
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

/** A `dream-view` the hub draws (insight, agent-thread, automation) as one line. */
export function viewLine(body: string): string | null {
  let v: Obj | null;
  try { v = obj(JSON.parse(body)); } catch { return null; }
  if (!v) return null;
  const id = cleanTitle(String(v.id ?? v.slug ?? ''), 60);
  if (v.type === 'insight') return `Insight: ${id || 'kart'} (Mac'te)`;
  if (v.type === 'agent-thread') return `${id || 'Üye'}: konuşma Mac'te`;
  if (v.type === 'automation') return `✋ Onay bekliyor: ${id || 'rutin'} · ${LINES.waitingOnMac}`;
  return null;
}

/** The answer's blocks, sent after its text. */
export async function sendAnswerBlocks(hub: TelegramHub, ab: ActiveBinding, text: string, sessionId: string, deps: BlocksDeps): Promise<void> {
  const pictures = !!(hub.telegramTurnOf(sessionId) || hub.deps.handsfree?.streamsTo(ab.scope, ab.target)) && !secretPending(sessionId);
  for (const b of fenceBlocks(text)) {
    if (b.lang === 'dream-html') {
      const title = cleanTitle(fenceTitle('dream-html', b.body));
      const plan = pictures ? dreamHtmlPage(b.body, { lang: deps.lang?.(ab) }) : null;
      const pngs = plan?.ok ? await deps.snapshot(sessionId, plan.page, plan.width) : null;
      if (pngs?.length) {
        const items = pngs.map((p, i) => ({ kind: 'photo' as const, file: pngFile(`kart-${i + 1}`, p), title }));
        const { sent } = await sendPictures(ab, items);
        if (!sent.length) await hub.notice(ab, 'info', `Bu kart Telegram'a gitmedi, Mac'te: ${title}`);
        else if (pngs.length > 3) await hub.notice(ab, 'info', "Kartın devamı Mac'te.");
      } else {
        await hub.notice(ab, 'info', `Bu kart Telegram'a gitmedi, Mac'te: ${title}`);
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
  if (!ab.contextRoot) return LINES.stale;
  const { readSuperState } = await import('../../lib/super/store.js');
  const s = await readSuperState(ab.contextRoot);
  if (!s.enabled || !s.session) return LINES.superOff;
  const ok = await hub.injectText(ab, hub.syntheticUpdateId(), ask.text, s.session);
  return ok ? '✓ Gönderildi' : null;
}
