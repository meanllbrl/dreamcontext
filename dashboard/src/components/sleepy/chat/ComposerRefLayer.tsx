import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { mentionSegments, type PeerMention } from '../../../lib/agentComposer';
import { REPLY_TO_RE } from '../../../lib/superTypes';
import { splitAbout } from '../super/superHandover';
import { useDismissOnOutside } from '../../../lib/useDismissOnOutside';
import { formatFileSize } from '../../../lib/phoneAttach';
import { isChatReply, isMediaRef, isTokenRef, parseRefTokens, refTokenId } from './composerRefs';
import type { Attachment } from './composerScratch';

/**
 * The Super composer's inline reference chips, drawn (owner 2026-10-24: several references in one
 * message). The chip IS text in the textarea (a token, composerRefs.ts); what is here is what the
 * textarea cannot draw: the slot tint behind each token in the mirror, the "write about it" hint
 * after a trailing one, the popover a chip opens, and the list a screen reader reads.
 */

/** One run of the mirror: plain text, an `@mention`, or a reference token (its slot, its ref).
 *  An inline attachment's token (a picture, a file, a picked element…) also carries its preview
 *  (`img`) or, with none, its icon (`icon`), its glyph's length (`lead`, the room the thumbnail
 *  is painted in) and its upload state. */
export interface MirrorSegment {
  text: string;
  kind: 'text' | 'mention' | 'ref';
  slot?: number;
  refId?: string;
  img?: string;
  icon?: string;
  lead?: number;
  state?: 'uploading' | 'failed' | 'ready';
}

/** The mirror's runs: tokens first, mentions inside the rest. An About chip's slot is its order
 *  among the About chips (the hue its bubble section wears); a picture wears no slot. */
export function refMirrorSegments(draft: string, peers: PeerMention[], staged: readonly Attachment[]): MirrorSegment[] {
  const byId = new Map(staged.filter(isTokenRef).map((a) => [refTokenId(a), a] as const));
  const out: MirrorSegment[] = [];
  const text = (t: string) => {
    if (!t) return;
    for (const m of mentionSegments(t, peers)) out.push({ text: m.text, kind: m.mention ? 'mention' : 'text' });
  };
  let pos = 0;
  let about = 0;
  parseRefTokens(draft).forEach((t) => {
    text(draft.slice(pos, t.start));
    // The isolate and the chip's air on each side stay untinted: the room between a chip and
    // the words beside it (owner 2026-10-30).
    out.push({ text: draft.slice(t.start, t.start + t.lead), kind: 'text' });
    const core = draft.slice(t.start + t.lead, t.end - t.tail);
    const att = byId.get(t.id);
    if (att && isMediaRef(att)) {
      out.push({
        text: core, kind: 'ref', refId: att.id, img: att.url, icon: att.url ? undefined : chipIcon(att), lead: core.indexOf('\u00A0') >= 0 ? core.indexOf('\u00A0') : t.glyph.length,
        state: att.uploading ? 'uploading' : att.failed ? 'failed' : 'ready',
      });
    } else {
      about += 1;
      out.push({ text: core, kind: 'ref', slot: Math.min(about, 5), refId: att?.id });
    }
    out.push({ text: draft.slice(t.end - t.tail, t.end), kind: 'text' });
    pos = t.end;
  });
  text(draft.slice(pos));
  return out;
}

/** What an inline chip with no thumbnail shows in its room: what kind of thing it is. */
export function chipIcon(att: Pick<Attachment, 'kind'>): string {
  return att.kind === 'folder' ? '📁' : att.kind === 'ref' ? '📌' : att.kind === 'element' ? '◎' : att.kind === 'image' ? '🖼' : '📄';
}

/**
 * A picture chip, the ONE look it has (owner 2026-10-28: the sent bubble must read exactly like
 * the composer): the accent tint, its thumbnail painted in the blank room its glyph keeps, then
 * its name. The composer's mirror draws it behind the textarea (the words transparent, the
 * textarea paints them); a sent bubble draws it with `sent` (the words visible, a click opens
 * the picture). `lead` is the glyph's text (the thumbnail's room), `rest` everything after it.
 */
export function PictureChip({ img, icon, lead, rest, state, flash, refId, sent, title, onOpen }: {
  img?: string;
  /** No thumbnail (a file, a folder, an element with no picture): its kind's icon in the room. */
  icon?: string;
  lead: string;
  rest: string;
  state?: MirrorSegment['state'];
  flash?: boolean;
  refId?: string;
  sent?: boolean;
  title?: string;
  onOpen?: () => void;
}) {
  return (
    <mark
      className={`chat-cmp-hl-ref chat-cmp-hl-img${flash ? ' is-flash' : ''}${sent ? ' is-sent' : ''}`}
      data-ref-id={refId}
      data-state={state}
      data-testid={sent ? 'chat-msg-picture' : 'chat-cmp-hl-img'}
      title={title}
      {...(sent && onOpen ? {
        role: 'button',
        tabIndex: 0,
        onClick: onOpen,
        onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } },
      } : {})}
    >
      <span className="chat-cmp-hl-thumb" data-icon={!img && icon ? icon : undefined} style={img ? { backgroundImage: `url("${img}")` } : undefined}>{lead}</span>
      {rest}
    </mark>
  );
}

/** The staged refs in the order their tokens stand in the draft. */
export function refsInOrder(draft: string, staged: readonly Attachment[]): Attachment[] {
  const byId = new Map(staged.filter(isTokenRef).map((a) => [refTokenId(a), a] as const));
  return parseRefTokens(draft).map((t) => byId.get(t.id)).filter((a): a is Attachment => !!a);
}

/** What a ref's popover shows: where it came from and its whole line or quote. */
function refDetail(att: Attachment): { from: 'agenda' | 'super' | 'owner' | 'claude' | 'card'; text: string; reply: { ref: string; from: 'super' | 'owner' } | null } {
  if (isChatReply(att)) return { from: 'claude', text: (att.text ?? '').replace(/^> /, ''), reply: null };
  const about = splitAbout(att.text ?? '').about;
  if (about?.kind === 'reply') return { from: about.from, text: about.quote, reply: { ref: about.ref, from: about.from } };
  if (about?.kind === 'card') return { from: 'card', text: about.quote, reply: null };
  if (about?.kind === 'note') return { from: 'agenda', text: about.line ?? att.name, reply: null };
  return { from: 'agenda', text: att.name, reply: null };
}

/** Where an inline attachment's popover says it came from. */
const MEDIA_SOURCE_KEY: Partial<Record<Attachment['kind'], string>> = {
  image: 'chat.photo.chip', file: 'chat.chip.file', folder: 'chat.chip.folder', element: 'chat.chip.element', ref: 'chat.chip.ref',
};

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
  const picture = isMediaRef(att);
  const source = picture ? t(MEDIA_SOURCE_KEY[att.kind] ?? 'chat.photo.chip')
    : d.from === 'claude' ? t('chat.ref.fromClaude') : d.from === 'card' ? t('super.ref.fromCard') : d.from === 'agenda' ? t('super.ref.fromAgenda') : d.from === 'super' ? t('super.ref.fromSuper') : t('super.ref.fromOwn');
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
        {!picture && <span className="chat-cmp-ref-pop-glyph" aria-hidden>{REPLY_TO_RE.test(att.text ?? '') || isChatReply(att) ? '↩' : '●'}</span>}
        {picture && !att.url && <span className="chat-cmp-ref-pop-glyph" aria-hidden>{chipIcon(att)}</span>}
        {source}
      </div>
      {picture && att.url && <img className="chat-cmp-ref-pop-img" src={att.url} alt={att.name} data-testid="chat-cmp-ref-pop-img" />}
      <div className="chat-cmp-ref-pop-text">
        {picture ? (att.kind === 'file' || att.kind === 'folder' ? att.path ?? att.name : att.name) : d.text}
        {att.kind === 'file' && att.size !== undefined && <span className="chat-cmp-attachment-size" data-testid="phone-file-size">{formatFileSize(att.size)}</span>}
        {picture && att.uploading && <span className="chat-cmp-attachment-note">{t('chat.photo.attaching')}</span>}
        {picture && att.failed && <span className="chat-cmp-attachment-note">{att.note ?? t(att.kind === 'element' ? 'chat.chip.elementNoPicture' : 'chat.photo.notAttached')}</span>}
      </div>
      <div className="chat-cmp-ref-pop-actions">
        {!picture && d.reply && onGoTo && (
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
