/**
 * An automation's approval card on Telegram (owner 2026-11-15: "Telegram'da sahibe, otomasyonun
 * adını, koşul betiğinin tam metnini, hangi sıklıkla çalışacağını ve ne yapabileceğini gösteren bir
 * onay kartı (Onayla / Reddet düğmeli) çıkar").
 *
 * Sent where the app draws its chat card: a Super's (or a member Super's) answer that lands on
 * Telegram and carries the `dream-view` `automation` block (blocks.ts). The card is DERIVED, like
 * the app's: every line comes from `approvalCardFacts`, read from the manifest, never from the
 * block the agent wrote, and the same lines the app's card shows (ne yapıyor, kimin adına, ne
 * sıklıkla, ne zamana kadar, erişim, değişiklik), with the condition script WHOLE.
 *
 * The rules, each the app card's own:
 *  - Buttons only where the app card has them: the owner's own routine that runs by itself, not
 *    yet approved (or approved and off), whose script can run. Reddet is not offered on one
 *    that is already off.
 *  - The full text before the buttons: a script too long for one message goes in parts, and the
 *    buttons ride the LAST part, sent only after every part before it went. A card the redactor
 *    would change (a secret in the script or the prompt, judged on the exact escaped HTML that
 *    goes out, `cardToSend`) is not shown whole, so it offers no Onayla, only Reddet; its fields
 *    are redacted before they are escaped, so a secret never leaves in clear.
 *  - The witness (kosullu-otomasyon C2): the buttons carry the `manifestHash` of the facts the
 *    card was built from. A tap on Onayla re-reads the manifest; a hash that moved (the script,
 *    the prompt, any hashed field) approves nothing, says so, and sends the new card. An equal
 *    hash is stamped through THE approve body (`approveAsOwner`, the one the app's routes call)
 *    with that hash as the shown witness, so the registry checks it once more.
 *  - Who: only a tap that reaches the hub's button path, which is past `isAuthorized` (the paired
 *    private chat and user, not a bot) and the button record's own checks (message, text hash,
 *    single use). No route and no CLI verb leads here: an agent cannot press it.
 */
import { dirname } from 'node:path';
import { escapeHtml, redactSecrets, showsAsWritten, wouldRedact } from '../../lib/telegram/format.js';
import { showHiddenChars } from '../../lib/hidden-chars.js';
import { approvalCardFacts, type ApprovalCardFacts } from '../../lib/automations/approval-card.js';
import { ConditionNeedsWitness, manifestHash } from '../../lib/automations/registry.js';
import { getAutomation } from '../../lib/automations/store.js';
import { foreignOwner, isNotOwnerError } from '../../lib/agents/owner.js';
import { approveAsOwner, rejectAsOwner } from '../automation-decision.js';
import type { ButtonRecord } from '../../lib/telegram/contract.js';
import { LINES, type ActiveBinding } from './hub.js';

type Obj = Record<string, unknown>;

/** The part of the hub this needs (TelegramHub fits it). */
export interface AutomationCardHub {
  rootOf(ab: ActiveBinding): string | null;
  send(ab: ActiveBinding, html: string, extra?: Obj): Promise<{ message_id: number; text?: string }>;
  sendButtons(ab: ActiveBinding, html: string, labels: string[][], rec: Omit<ButtonRecord, 'id' | 'botId' | 'chatId' | 'messageId' | 'textHash' | 'options'>, data?: Obj): Promise<string>;
}

/** One message's HTML stays under Telegram's 4096 with room for the answer line a tap appends. */
export const CARD_PART_MAX = 3800;
const SCRIPT_CHUNK_MAX = 3000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export const AUTO_LINES = {
  title: 'Otomasyon onayı',
  state: { waiting: 'Onayınızı bekliyor', changed: 'Onaydan sonra değişti', approved: 'Onaylandı', off: 'Kapalı, onaylanmadı' },
  does: 'Ne yapıyor',
  as: 'Kimin adına',
  often: 'Ne sıklıkla',
  until: 'Ne zamana kadar',
  untilOff: 'Siz kapatana kadar',
  untilCall: 'Yalnız çağrıldığında',
  reach: 'Erişim',
  reachComputer: 'Bu Mac: dosyalar, komutlar ve internet, sormadan',
  reachProject: "Codex'te: bu proje ve bağlı depoları, internet yok",
  reachBoard: (b: string) => `Yalnız ${b} panosu`,
  mcp: (list: string) => `Bağlı araçlar: ${list}`,
  changes: 'Değişiklik',
  changesComputer: 'Bir şeyleri değiştirebilir: dosya yazabilir, komut çalıştırabilir. Yalnız okumakla kalmaz.',
  changesBoard: 'Yalnız kendi panosunu değiştirebilir.',
  reviewOutput: 'Her raporu yayınlamadan önce size gösterir.',
  reviewAgent: 'Gerekli gördüğünde durup size sorar.',
  condition: 'Önce bakan betik',
  wakeTrue: 'Ajan yalnız bu betik 0 ile biterse uyanır.',
  wakeFalse: 'Ajan yalnız bu betik 0 ile bitmezse (1 ile biterse) uyanır.',
  shell: "Betik bu Mac'te düz bir komut olarak çalışır: sizin yetkinizle, internet açık, ajanın sınırlarının dışında.",
  conditionError: (why: string) => `Bu betik çalışamaz, bu yüzden onaylanamaz: ${why}. Ajandan düzeltmesini isteyin.`,
  scriptPart: (i: number, n: number) => `Betik (${i}/${n})`,
  footer: "Onaylarsan uygulamadaki Onayla ile aynı olur. Betik ya da istem sonradan değişirse onay düşer ve yeniden sorulur.",
  teammate: 'Bir takım arkadaşının otomasyonu: burada yalnız okunur.',
  memberCard: "Onay kartı Mac'te AI Team sayfasında bekliyor.",
  secret: "Bu kartta gizli bir değer var, Telegram'da tam gösterilemiyor: onayı Mac'te verin.",
  approve: 'Onayla',
  approveOn: 'Onayla ve aç',
  reject: 'Reddet',
  approved: '✓ Onaylandı',
  approvedOn: '✓ Onaylandı ve açıldı',
  rejected: '✗ Reddedildi. Kapalı, çalışmayacak.',
  changed: 'Bu otomasyon bu mesajdan sonra değişti; onaylanmadı. Yeni kartı aşağıda okuyup onaylayın.',
  gone: 'Bu otomasyon artık yok.',
  notSent: "Onay kartı Telegram'a tam gitmedi; onayı Mac'te verin.",
} as const;

type State = keyof typeof AUTO_LINES.state;

function stateOf(f: ApprovalCardFacts): State {
  return f.approved ? 'approved' : !f.enabled ? 'off' : f.approvalReason === 'never-approved' ? 'waiting' : 'changed';
}

/** What the card offers, the app card's own rule (`canAct` in AutomationApprovalCard). */
export type CardOffer = { choices: ('approve' | 'reject')[]; note: string | null };

export function cardOffer(f: ApprovalCardFacts, owned: boolean, shownWhole: boolean): CardOffer {
  const state = stateOf(f);
  if (!owned) return { choices: [], note: AUTO_LINES.teammate };
  if (f.mode !== 'sched') return { choices: [], note: state === 'approved' ? null : AUTO_LINES.memberCard };
  if (f.conditionError) return { choices: [], note: null };
  if (state === 'approved' && f.enabled) return { choices: [], note: null };
  const reject = state !== 'off' ? (['reject'] as const) : [];
  if (!shownWhole) return { choices: [...reject], note: AUTO_LINES.secret };
  return { choices: ['approve', ...reject], note: null };
}

const line = (label: string, value: string) => `${escapeHtml(label)}: ${escapeHtml(value)}`;

/** The facts as the head message (no script). Pure. */
export function cardHeadHtml(f: ApprovalCardFacts): string {
  const out = [`✋ <b>${escapeHtml(AUTO_LINES.title)}</b>: ${escapeHtml(f.title || f.slug)} · ${escapeHtml(AUTO_LINES.state[stateOf(f)])}`];
  if (f.does) out.push(line(AUTO_LINES.does, f.does));
  if (f.agentTitle) out.push(line(AUTO_LINES.as, f.agentTitle));
  out.push(line(AUTO_LINES.often, f.cadence));
  out.push(line(AUTO_LINES.until, f.until === 'only-when-called' ? AUTO_LINES.untilCall : AUTO_LINES.untilOff));
  out.push(line(AUTO_LINES.reach, f.reach === 'board' ? AUTO_LINES.reachBoard(f.board ?? '') : f.reach === 'project' ? AUTO_LINES.reachProject : AUTO_LINES.reachComputer));
  if (f.mcp.length) out.push(escapeHtml(AUTO_LINES.mcp(f.mcp.join(', '))));
  out.push(line(AUTO_LINES.changes, f.reach === 'board' ? AUTO_LINES.changesBoard : AUTO_LINES.changesComputer));
  if (f.review === 'output') out.push(escapeHtml(AUTO_LINES.reviewOutput));
  if (f.review === 'agent') out.push(escapeHtml(AUTO_LINES.reviewAgent));
  if (f.conditionError) out.push('', `⚠️ ${escapeHtml(AUTO_LINES.conditionError(f.conditionError))}`);
  else if (f.condition) out.push('', `<b>${escapeHtml(AUTO_LINES.condition)}</b>: ${escapeHtml(f.conditionWake ? AUTO_LINES.wakeTrue : AUTO_LINES.wakeFalse)}`, `<i>${escapeHtml(AUTO_LINES.shell)}</i>`);
  return out.join('\n');
}

/** The script cut on line ends (a line longer than a chunk is cut inside), every piece whole. */
export function scriptChunks(script: string, max = SCRIPT_CHUNK_MAX): string[] {
  const chunks: string[] = [];
  // null = nothing in the chunk yet: an empty string is a real blank line and is kept.
  let cur: string | null = null;
  const push = () => { if (cur !== null) chunks.push(cur); cur = null; };
  for (const raw of script.split('\n')) {
    let l = raw;
    while (escapeHtml(l).length > max) {
      push();
      // Cut on a code-point boundary, measured escaped.
      let n = 0;
      let take = '';
      for (const ch of l) { const e = escapeHtml(ch).length; if (n + e > max) break; n += e; take += ch; }
      chunks.push(take);
      l = l.slice(take.length);
    }
    const next: string = cur !== null ? `${cur}\n${l}` : l;
    if (escapeHtml(next).length > max) { push(); cur = l; } else cur = next;
  }
  push();
  return chunks.length ? chunks : [''];
}

/**
 * The card as the messages it goes in, in order: the facts, then the script whole, then the
 * footer on the last. One message when it all fits. Pure.
 */
export function cardMessages(f: ApprovalCardFacts, note: string | null): string[] {
  const head = cardHeadHtml(f);
  const tail = [`<i>${escapeHtml(AUTO_LINES.footer)}</i>`, ...(note ? [`ℹ️ ${escapeHtml(note)}`] : [])].join('\n');
  const script = f.condition && !f.conditionError ? showHiddenChars(f.condition) : null;
  if (!script) return [`${head}\n\n${tail}`];
  const whole = `${head}\n<pre>${escapeHtml(script)}</pre>\n${tail}`;
  if (whole.length <= CARD_PART_MAX) return [whole];
  const chunks = scriptChunks(script);
  const parts = [head];
  chunks.forEach((c, i) => {
    const body = `<b>${escapeHtml(AUTO_LINES.scriptPart(i + 1, chunks.length))}</b>\n<pre>${escapeHtml(c)}</pre>`;
    parts.push(i === chunks.length - 1 ? `${body}\n${tail}` : body);
  });
  return parts;
}

/** Every text field the card draws from the manifest, raw. */
function cardFields(f: ApprovalCardFacts): string[] {
  return [f.title, f.slug, f.does, f.agentTitle ?? '', f.cadence, f.board ?? '', ...f.mcp, f.condition ?? '', f.conditionError ?? ''];
}

/** The facts with every drawn field redacted BEFORE it is escaped (as every Telegram text is):
 *  a secret never leaves in clear, whatever escaping does to what the transport's rules match. */
function redactedFacts(f: ApprovalCardFacts): ApprovalCardFacts {
  const r = (s: string) => redactSecrets(s);
  return {
    ...f, title: r(f.title), slug: r(f.slug), does: r(f.does), agentTitle: f.agentTitle === null ? null : r(f.agentTitle), cadence: r(f.cadence),
    board: f.board === null ? null : r(f.board), mcp: f.mcp.map(r), condition: f.condition === null ? null : r(f.condition),
    conditionError: f.conditionError === null ? null : r(f.conditionError),
  };
}

/**
 * The card as it goes, and whether it reaches the phone exactly as written (consent matches
 * display, G2): every field unchanged by the redactor raw AND escaped (`showsAsWritten`), and
 * every HTML part unchanged by the transport's own redaction pass. Only then may it offer Onayla.
 */
export function cardToSend(f: ApprovalCardFacts, owned: boolean): { offer: CardOffer; parts: string[] } {
  const shown = redactedFacts(f);
  const whole = cardFields(f).every(showsAsWritten) && cardMessages(shown, null).every((p) => !wouldRedact(p));
  const offer = cardOffer(f, owned, whole);
  return { offer, parts: cardMessages(shown, offer.note) };
}

/**
 * Send the card for `slug` in this binding's project. True when it went (with its buttons when
 * it offers any). A card that cannot go says the old one line, so the owner still knows.
 */
export async function sendAutomationCard(hub: AutomationCardHub, ab: ActiveBinding, slug: string, sessionId: string | null): Promise<boolean> {
  const root = hub.rootOf(ab);
  const m = root && SLUG_RE.test(slug) ? safeGet(root, slug) : null;
  if (!root || !m) {
    await hub.send(ab, escapeHtml(`✋ Onay bekliyor: ${slug || 'rutin'} · ${LINES.waitingOnMac}`)).catch(() => {});
    return false;
  }
  const f = approvalCardFacts(dirname(root), m);
  // The hash of exactly the manifest these facts were read from: what the tap must still find.
  const hash = manifestHash(m);
  const { offer, parts } = cardToSend(f, foreignOwner(m) === null);
  try {
    // Every part before the last goes first: no button before the whole text is on his screen.
    for (const p of parts.slice(0, -1)) await hub.send(ab, p);
    const last = parts[parts.length - 1];
    if (!offer.choices.length) { await hub.send(ab, last); return true; }
    const labels = offer.choices.map((c) => (c === 'approve' ? (f.enabled ? AUTO_LINES.approve : AUTO_LINES.approveOn) : AUTO_LINES.reject));
    await hub.sendButtons(ab, last, [labels], { kind: 'approval', singleUse: true },
      { automation: m.slug, hash, choices: offer.choices, ...(sessionId ? { session: sessionId } : {}) });
    return true;
  } catch {
    await hub.send(ab, escapeHtml(AUTO_LINES.notSent)).catch(() => {});
    return false;
  }
}

function safeGet(root: string, slug: string) {
  try { return getAutomation(root, slug); } catch { return null; }
}

/** A tap on the card: Onayla or Reddet, by the `choices` the card was sent with. */
export async function onAutomationButton(hub: AutomationCardHub, ab: ActiveBinding, data: Obj, idx: number): Promise<string> {
  const root = hub.rootOf(ab);
  const slug = typeof data.automation === 'string' ? data.automation : '';
  const shown = typeof data.hash === 'string' ? data.hash : '';
  const choices = Array.isArray(data.choices) ? (data.choices as unknown[]) : [];
  const choice = choices[idx];
  const sessionId = typeof data.session === 'string' ? data.session : null;
  if (!root || !SLUG_RE.test(slug) || (choice !== 'approve' && choice !== 'reject')) return LINES.stale;
  const m = safeGet(root, slug);
  if (!m) return AUTO_LINES.gone;
  if (foreignOwner(m) !== null) return AUTO_LINES.teammate;
  try {
    if (choice === 'reject') {
      await rejectAsOwner(root, m, { sessionId });
      return AUTO_LINES.rejected;
    }
    // The witness: the disk must still hold exactly what the card showed. Anything moved (the
    // script, the prompt, any hashed field) approves nothing, and the new card goes.
    if (!shown || manifestHash(m) !== shown) {
      await sendAutomationCard(hub, ab, slug, sessionId);
      return AUTO_LINES.changed;
    }
    const wasOn = m.enabled;
    await approveAsOwner(root, m, { witness: { kind: 'shown', hash: shown }, enable: true, sessionId });
    return wasOn ? AUTO_LINES.approved : AUTO_LINES.approvedOn;
  } catch (err) {
    if (err instanceof ConditionNeedsWitness) {
      await sendAutomationCard(hub, ab, slug, sessionId);
      return AUTO_LINES.changed;
    }
    if (isNotOwnerError(err)) return AUTO_LINES.teammate;
    return "Olmadı. Mac'te deneyin.";
  }
}
