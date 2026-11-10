/**
 * Telegram's answer to an AI Team member's item mirrored into main's queue (owner 2026-11-10).
 * Shared by the one-tap buttons (asks.ts) and the rich asks (rich-asks.ts).
 *
 * Every answer goes through the ONE answer function (`answerOwnerItem`, uye-bildirim K5): a job's
 * question or permission through the member's window, the member Super's OWN question or
 * permission through its own window (`answer_pending`), a refusal's Allow through the grants
 * store and a server turn. The member's own `super ask` is the one exception kept here: while its
 * Super runs, his answer goes in at once as his Telegram words (`injectText`); when it does not,
 * it waits in its queue as his reply (`answerOwnerItem`).
 */
import { memberMirrorTarget, superAnswerText, superUnclearText, unclearMessage, answerOwnerItem } from '../../lib/super/answer.js';
import { getChat } from '../../lib/assistant/chat-registry.js';
import type { GrantSize, OwnerAnswer, OwnerAnswerResult } from '../../lib/super/types.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';

/** What a tap on a member's item says back, from the shared answer's result. */
export function pickLine(r: OwnerAnswerResult, ok: string): string {
  if (r.ok) return r.outcome === 'allowed_waiting' ? "✓ İzin verildi; sohbeti açılınca çalışır" : ok;
  if (r.error === 'already_answered') return 'Zaten cevaplandı';
  if (r.error === 'no_window') return LINES.waitingOnMac;
  if (r.error === 'not_offered') return "Bu seçenek burada yok: Mac'te karar ver";
  return LINES.stale;
}

/** The label a size's answer is told with. */
export function sizeLine(size: GrantSize | 'deny' | 'not_needed'): string {
  return size === 'once' ? '✓ İzin verildi (bir kez)' : size === 'job' ? '✓ Bu iş için hep izinli' : size === 'member' ? '✓ Bu üye için hep izinli'
    : size === 'deny' ? '✗ Reddedildi' : '✓ Gerek yok';
}

/**
 * The owner's pick on a member's item (a `member` mirror): answered on the MEMBER's own item
 * (`memberMirrorTarget` finds it; `answerOwnerItem` answers it the way that item is answered).
 */
export async function answerMemberPick(hub: TelegramHub, ab: ActiveBinding, mirrorId: string, answer:
  | { kind: 'permission'; allow: boolean; size?: GrantSize }
  | { kind: 'refusal'; allow: boolean; size?: GrantSize }
  | { kind: 'question'; questions: readonly { question: string; options?: unknown[] }[]; picked: Record<string, string>; notes?: Record<string, string>; unclear?: string }): Promise<string | null> {
  const root = ab.contextRoot;
  if (!root) return LINES.stale;
  const t = await memberMirrorTarget(root, mirrorId);
  if (!t) return 'Zaten cevaplandı';
  if (answer.kind === 'permission' || answer.kind === 'refusal') {
    const a: OwnerAnswer = answer.kind === 'permission'
      ? { kind: 'permission', behavior: answer.allow ? 'allow' : 'deny', ...(answer.allow && answer.size ? { size: answer.size } : {}) }
      : { kind: 'refusal', action: answer.allow ? 'allow' : 'not_needed', ...(answer.allow && answer.size ? { size: answer.size } : {}) };
    const r = await answerOwnerItem(root, { record: 'main', item: mirrorId, answer: a, via: 'telegram' });
    return pickLine(r, sizeLine(answer.allow ? answer.size ?? 'once' : answer.kind === 'permission' ? 'deny' : 'not_needed'));
  }
  const picked = answer.unclear !== undefined ? '↺ Tekrar sorulacak' : `✓ ${Object.values(answer.picked).join(' · ')}`;
  if (t.item.kind === 'ask') {
    // Its Super runs: his words go in now, as his Telegram text (a first answer anywhere else
    // closed the mirror, so `memberMirrorTarget` above already said so).
    const live = getChat(t.session);
    if (live && live.status !== 'gone') {
      const text = answer.unclear !== undefined
        ? superUnclearText(t.item, unclearMessage(answer.unclear ? [answer.unclear] : []))
        : superAnswerText(t.item, answer.questions as { question: string }[], answer.picked, answer.notes);
      const ok = await hub.injectText(ab, hub.syntheticUpdateId(), text, t.session);
      if (ok) return picked;
    }
    // Cold (or the write did not land): his answer waits in its queue as his reply.
    const a: OwnerAnswer = answer.unclear !== undefined
      ? { kind: 'ask', text: answer.unclear || 'Anlaşılmadı, tekrar sor.' }
      : { kind: 'question', answers: answer.picked };
    return pickLine(await answerOwnerItem(root, { record: 'main', item: mirrorId, answer: a, via: 'telegram' }), picked);
  }
  if (answer.unclear !== undefined) return "Bunu Mac'te cevapla";
  const r = await answerOwnerItem(root, { record: 'main', item: mirrorId, answer: { kind: 'question', answers: answer.picked }, via: 'telegram' });
  return pickLine(r, picked);
}
