/**
 * Wave 5 on the hub: the Super's presentations, every surface block, rich asks, the native
 * Telegram commands and gestures (plan L-T). Each piece plugs into a named hub seam
 * (`answerExtras`, `commandHook`, `turnPrefix`, `interceptText`, `richQuestion`, `superOff`,
 * `extraButton`), so the hub's own paths stay as W2 wrote them.
 */
import type { MacStatus } from '../../lib/handsfree/mac/contract.js';
import type { StartedVia } from '../../lib/telegram/contract.js';
import { setRichAsks } from './asks.js';
import { onAskButton, sendAnswerBlocks } from './blocks.js';
import { wireCommands, type CommandsDeps } from './commands.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';
import { snapshotPage, type Snapshotter } from './pictures.js';
import { wirePresenter, type PhoneLink, type PresenterDeps } from './present.js';
import { richQuestionsOf, wireRichAsks } from './rich-asks.js';
import { insightRenderer } from './insight-render.js';

/** What W5 reads of the live hands-free session (`macSession()`). */
export interface W5Session {
  isOn(): boolean;
  readonly startedVia: StartedVia | null;
  readonly channel: 'telegram' | 'full' | null;
  status(): Pick<MacStatus, 'url'> | { url: string | null };
}

export interface W5Deps {
  snapshot?: Snapshotter;
  session?: () => W5Session | null;
  renderInsight?: PresenterDeps['renderInsight'];
  settleMs?: number;
  commands?: CommandsDeps;
  isGitIgnored?: PresenterDeps['isGitIgnored'];
}

export function wireTelegramW5(hub: TelegramHub, deps: W5Deps = {}): () => void {
  const snapshot = deps.snapshot ?? snapshotPage;
  const liveUrl = (): URL | null => {
    const s = deps.session?.();
    if (!s?.isOn()) return null;
    try { const u = s.status().url; return u ? new URL(u) : null; } catch { return null; }
  };
  const tunnelHost = () => liveUrl()?.hostname ?? null;
  /** Telegram + link hands-free started by THIS bot: its bare origin (never a login token); any
   *  other running hands-free says why there is no link; off = a tap can start one. */
  const phoneLink = (ab: ActiveBinding): PhoneLink => {
    const s = deps.session?.();
    if (!s?.isOn()) return 'off';
    const mine = s.startedVia?.scope === ab.scope && s.startedVia?.target === ab.target;
    if (mine && s.channel === 'telegram') return { why: 'telegram-only' };
    const origin = mine && s.channel === 'full' ? liveUrl()?.origin : null;
    return origin ? { origin } : { why: 'other' };
  };

  const offPresenter = wirePresenter(hub, { snapshot, phoneLink, tunnelHost, settleMs: deps.settleMs, renderInsight: deps.renderInsight ?? insightRenderer(snapshot), isGitIgnored: deps.isGitIgnored });
  const offCommands = wireCommands(hub, deps.commands);
  const rich = wireRichAsks(hub, { snapshot });
  setRichAsks(rich);

  const prevExtras = hub.answerExtras;
  hub.answerExtras = (ab, text, sid) => sendAnswerBlocks(hub, ab, text, sid, { snapshot, tunnelHost });
  const prevIntercept = hub.interceptText;
  hub.interceptText = async (ab, msg) => (await rich.takeNote(ab, msg)) || (prevIntercept ? prevIntercept(ab, msg) : false);
  const prevRich = hub.richQuestion;
  hub.richQuestion = async (ab, sid, q) => (!q.isPermission && await rich.send(ab, { kind: 'pending', sessionId: sid, requestId: q.requestId }, richQuestionsOf(q.questions), { sessionId: sid }))
    || (prevRich ? prevRich(ab, sid, q) : false);

  const prevButton = hub.extraButton;
  hub.extraButton = async (ab, rec, idx) => {
    const d = rec.data ?? {};
    if (rec.kind === 'confirm' && typeof d.rich === 'string') return rich.onButton(ab, d, idx, rec.messageId);
    if (rec.kind === 'confirm' && (d.action === 'ask-pick' || d.action === 'ask-confirm')) return onAskButton(hub, ab, d, idx);
    return prevButton ? prevButton(ab, rec, idx) : LINES.stale;
  };

  return () => {
    offPresenter();
    offCommands();
    setRichAsks(null);
    hub.answerExtras = prevExtras;
    hub.interceptText = prevIntercept;
    hub.richQuestion = prevRich;
    hub.extraButton = prevButton;
  };
}
