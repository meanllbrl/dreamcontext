/**
 * Telegram's answer to an AI Team member's item mirrored into main's queue (owner 2026-11-10).
 * Shared by the one-tap buttons (asks.ts) and the rich asks (rich-asks.ts).
 */
import { answerChildPermission, answerChildQuestion, memberMirrorTarget, superAnswerText, superUnclearText, unclearMessage } from '../../lib/super/answer.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';

/**
 * The owner's pick on a member's item (a `member` mirror): answered on the MEMBER's own item with
 * the path that item has (`memberMirrorTarget`). Its own ask: his answer as owner text into the
 * member's Super session; a job's question or permission: through the member's window.
 */
export async function answerMemberPick(hub: TelegramHub, ab: ActiveBinding, mirrorId: string, answer:
  | { kind: 'permission'; allow: boolean }
  | { kind: 'question'; questions: readonly { question: string; options?: unknown[] }[]; picked: Record<string, string>; notes?: Record<string, string>; unclear?: string }): Promise<string | null> {
  const root = ab.contextRoot;
  if (!root) return LINES.stale;
  const t = await memberMirrorTarget(root, mirrorId);
  if (!t) return LINES.stale;
  if (answer.kind === 'permission') {
    if (t.item.kind !== 'permission' || !t.item.requestId) return LINES.stale;
    const r = await answerChildPermission(root, t.superId, { item: t.item.id, requestId: t.item.requestId, choice: answer.allow ? 'allow' : 'deny' });
    if (!r.ok) return r.error === 'no_window' ? LINES.waitingOnMac : LINES.stale;
    return answer.allow ? '✓ İzin verildi (bir kez)' : '✗ Reddedildi';
  }
  if (t.item.kind === 'question' && t.item.requestId) {
    const r = await answerChildQuestion(root, t.superId, answer.unclear !== undefined
      ? { item: t.item.id, requestId: t.item.requestId, unclear: answer.unclear }
      : { item: t.item.id, requestId: t.item.requestId, picked: answer.picked, ...(answer.notes ? { notes: answer.notes } : {}) });
    if (!r.ok) return r.error === 'no_window' ? LINES.waitingOnMac : LINES.stale;
    return answer.unclear !== undefined ? '↺ Tekrar sorulacak' : `✓ ${Object.values(answer.picked).join(' · ')}`;
  }
  if (t.item.kind !== 'ask') return LINES.stale;
  const text = answer.unclear !== undefined
    ? superUnclearText(t.item, unclearMessage(answer.unclear ? [answer.unclear] : []))
    : superAnswerText(t.item, answer.questions as { question: string }[], answer.picked, answer.notes);
  const ok = await hub.injectText(ab, hub.syntheticUpdateId(), text, t.session);
  return ok ? (answer.unclear !== undefined ? '↺ Tekrar sorulacak' : `✓ ${Object.values(answer.picked).join(' · ')}`) : null;
}

