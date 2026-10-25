import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { mentionSegments, type PeerMention } from '../../../lib/agentComposer';
import { REPLY_TO_RE } from '../../../lib/superTypes';
import { splitAbout } from '../super/superHandover';
import { useDismissOnOutside } from '../../../lib/useDismissOnOutside';
import { parseRefTokens, refTokenId } from './composerRefs';
import type { Attachment } from './composerScratch';

/**
 * The Super composer's inline reference chips, drawn (owner 2026-10-24: several references in one
 * message). The chip IS text in the textarea (a token, composerRefs.ts); what is here is what the
 * textarea cannot draw: the slot tint behind each token in the mirror, the "write about it" hint
 * after a trailing one, the popover a chip opens, and the list a screen reader reads.
 */

/** One run of the mirror: plain text, an `@mention`, or a reference token (its slot, its ref). */
export interface MirrorSegment { text: string; kind: 'text' | 'mention' | 'ref'; slot?: number; refId?: string }

/** The mirror's runs: tokens first (slot = order among the chips), mentions inside the rest. */
export function refMirrorSegments(draft: string, peers: PeerMention[], staged: readonly Attachment[]): MirrorSegment[] {
  const byId = new Map(staged.filter((a) => a.kind === 'about').map((a) => [refTokenId(a), a] as const));
  const out: MirrorSegment[] = [];
  const text = (t: string) => {
    if (!t) return;
    for (const m of mentionSegments(t, peers)) out.push({ text: m.text, kind: m.mention ? 'mention' : 'text' });
  };
  let pos = 0;
  parseRefTokens(draft).forEach((t, i) => {
    text(draft.slice(pos, t.start));
    out.push({ text: draft.slice(t.start, t.end), kind: 'ref', slot: Math.min(i + 1, 5), refId: byId.get(t.id)?.id });
    pos = t.end;
  });
  text(draft.slice(pos));
  return out;
}

/** The staged refs in the order their tokens stand in the draft. */
export function refsInOrder(draft: string, staged: readonly Attachment[]): Attachment[] {
  const byId = new Map(staged.filter((a) => a.kind === 'about').map((a) => [refTokenId(a), a] as const));
  return parseRefTokens(draft).map((t) => byId.get(t.id)).filter((a): a is Attachment => !!a);
}

/** What a ref's popover shows: where it came from and its whole line or quote. */
function refDetail(att: Attachment): { from: 'agenda' | 'super' | 'owner'; text: string; reply: { ref: string; from: 'super' | 'owner' } | null } {
  const about = splitAbout(att.text ?? '').about;
  if (about?.kind === 'reply') return { from: about.from, text: about.quote, reply: { ref: about.ref, from: about.from } };
  if (about?.kind === 'note') return { from: 'agenda', text: about.line ?? att.name, reply: null };
  return { from: 'agenda', text: att.name, reply: null };
}

/**
 * The popover a chip opens (click or tap): its whole line or quote and where it came from,
 * Remove, and for a reply "Go to message". Anchored above the chip in VIEWPORT coordinates and
 * portaled to the body, so the composer's clipped box never cuts it. A press outside closes it;
 * Esc closes it from here and from the textarea (the composer's own keydown, which stops the
 * surface's Esc from collapsing the overlay in the same keystroke).
 */
export function RefPopover({ att, slot, left, bottom, onRemove, onGoTo, onClose }: {
  att: Attachment;
  slot: number;
  left: number;
  bottom: number;
  onRemove: () => void;
  onGoTo?: (ref: string, from: 'super' | 'owner') => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(true, onClose, [ref]);
  const d = refDetail(att);
  const source = d.from === 'agenda' ? t('super.ref.fromAgenda') : d.from === 'super' ? t('super.ref.fromSuper') : t('super.ref.fromOwn');
  return createPortal(
    <div
      ref={ref}
      className="chat-cmp-ref-pop"
      role="dialog"
      aria-label={att.name}
      data-slot={String(slot)}
      data-testid="chat-cmp-ref-pop"
      style={{ left, bottom }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}
    >
      <div className="chat-cmp-ref-pop-source">
        <span className="chat-cmp-ref-pop-glyph" aria-hidden>{REPLY_TO_RE.test(att.text ?? '') ? '↩' : '●'}</span>
        {source}
      </div>
      <div className="chat-cmp-ref-pop-text">{d.text}</div>
      <div className="chat-cmp-ref-pop-actions">
        {d.reply && onGoTo && (
          <button type="button" className="chat-cmp-ref-pop-btn" onClick={() => { const r = d.reply!; onClose(); onGoTo(r.ref, r.from); }}>
            {t('super.ref.goTo')}
          </button>
        )}
        <button type="button" className="chat-cmp-ref-pop-btn" data-testid="chat-cmp-ref-remove" onClick={() => { onRemove(); onClose(); }}>
          {t('super.ref.remove')}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** The chips for a screen reader (the mirror is aria-hidden): each by name, with its own Remove. */
export function RefSrList({ id, refs, onRemove }: { id: string; refs: readonly Attachment[]; onRemove: (attId: string) => void }) {
  const { t } = useI18n();
  if (!refs.length) return null;
  return (
    <div id={id} className="chat-cmp-refs-sr">
      <span>{t('super.ref.list')}</span>
      <ul>
        {refs.map((a) => (
          <li key={a.id}>
            {a.name}
            <button type="button" onClick={() => onRemove(a.id)}>{t('super.ref.removeNamed').replace('{name}', () => a.name)}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
