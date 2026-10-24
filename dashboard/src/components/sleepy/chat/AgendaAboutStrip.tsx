import { useI18n } from '../../../context/I18nContext';
import { agendaAboutStrip, type AgendaAbout, type MessageAbout } from '../super/superHandover';
import type { ReplyHead } from './replyLinks';
import { useSuperEventContext, useSuperQuestions } from '../super/superJobsStore';

/** "About: <the agenda line>" above a message written about it. A question names whose it is
 *  only while the live record still has it open. */
export function AgendaAboutStrip({ about, superSid }: { about: AgendaAbout; superSid: string | null }) {
  const { t } = useI18n();
  const view = useSuperQuestions(about.kind === 'item' ? superSid : null);
  const ctx = useSuperEventContext(about.kind === 'item' ? superSid : null);
  const strip = agendaAboutStrip(about, view?.open ?? [], (sid) => ctx?.titleFor(sid) ?? '', {
    about: t('super.agenda.about'), question: t('super.agenda.aboutQuestion'),
    superQuestion: t('super.agenda.aboutSuperQuestion'), aQuestion: t('super.agenda.aboutAQuestion'),
  });
  return (
    <div className="chat-msg-about" data-testid="chat-msg-about" data-kind={about.kind}>
      <span className="chat-msg-about-dot" aria-hidden />
      <span className="chat-msg-about-label">{strip.label}</span>
      <span className="chat-msg-about-text" title={strip.text}>{strip.text}</span>
    </div>
  );
}

/**
 * The reply variant (owner 2026-10-23): "↩ To Super: <quote>" above his reply, or "↩ Your
 * message: <quote>" above a Super answer group. The same strip, a ↩ where the dot is; a click
 * scrolls to the message it names. One line, the quote clipped.
 */
export function ReplyStrip({ label, quotes, onJump }: { label: string; quotes: readonly string[]; onJump?: () => void }) {
  const text = quotes.join(' · ');
  const body = (
    <>
      <span className="chat-msg-about-glyph" aria-hidden>↩</span>
      <span className="chat-msg-about-label">{label}</span>
      <span className="chat-msg-about-text" title={text}>{text}</span>
    </>
  );
  return onJump
    ? <button type="button" className="chat-msg-about chat-msg-about--reply" data-testid="chat-msg-reply" onClick={onJump}>{body}</button>
    : <div className="chat-msg-about chat-msg-about--reply" data-testid="chat-msg-reply">{body}</div>;
}

/**
 * The head a section of one Super reply opens with (owner 2026-10-24, pick A): the chip of the
 * message that part answers, inside the answer's own body. About variant: the dot, "About" and
 * the agenda line (the same hooks as {@link AgendaAboutStrip}), then his words; reply variant:
 * ↩ "To your message" + his words. One line, clipped; a click lands on that message.
 * `data-reply-head` keeps it out of the spoken highlight.
 */
export function ReplySectionHead({ head, superSid, onReplyTarget }: {
  head: ReplyHead;
  superSid: string | null;
  onReplyTarget?: (targetId: string, part?: number) => void;
}) {
  const { t } = useI18n();
  const about = head.kind === 'about' ? head.about ?? null : null;
  const view = useSuperQuestions(about?.kind === 'item' ? superSid : null);
  const ctx = useSuperEventContext(about?.kind === 'item' ? superSid : null);
  const quotes = head.quotes.filter(Boolean).join(' · ');
  if (head.parts?.length && head.partAbouts?.length) {
    // A head naming PARTS of one message (rev 12): each part's chip in its slot, then his words.
    return (
      <button
        type="button"
        className="chat-msg-about chat-reply-head chat-reply-head--parts"
        data-reply-head=""
        data-testid="chat-reply-head"
        data-kind={head.kind}
        data-parts={head.parts.join(',')}
        onClick={() => onReplyTarget?.(head.targetId, head.parts?.[0])}
      >
        <RefChips abouts={head.partAbouts} parts={head.parts} superSid={superSid} />
        {quotes && <span className="chat-msg-about-text" title={quotes}>“{quotes}”</span>}
      </button>
    );
  }
  const strip = about
    ? agendaAboutStrip(about, view?.open ?? [], (sid) => ctx?.titleFor(sid) ?? '', {
      about: t('super.agenda.about'), question: t('super.agenda.aboutQuestion'),
      superQuestion: t('super.agenda.aboutSuperQuestion'), aQuestion: t('super.agenda.aboutAQuestion'),
    })
    : null;
  const label = strip?.label ?? (head.count > 1 ? t('super.reply.nMessages').replace('{n}', String(head.count)) : t('super.reply.yourMessage'));
  const title = strip ? `${strip.text}${quotes ? ` · “${quotes}”` : ''}` : quotes;
  return (
    <button
      type="button"
      className="chat-msg-about chat-reply-head"
      data-reply-head=""
      data-testid="chat-reply-head"
      data-kind={head.kind}
      onClick={() => onReplyTarget?.(head.targetId)}
    >
      {strip
        ? <span className="chat-msg-about-dot" aria-hidden />
        : <span className="chat-msg-about-glyph" aria-hidden>↩</span>}
      <span className="chat-msg-about-label">{label}</span>
      <span className="chat-msg-about-text" title={title}>
        {strip ? strip.text : quotes}
        {strip && quotes && <span className="chat-reply-head-quote"> · “{quotes}”</span>}
      </span>
    </button>
  );
}


/** At most this many chips side by side on a head or strip; the rest read "+N". */
const MAX_HEAD_CHIPS = 2;
/** A chip's label in a bubble or a head, at most this many characters (the full text in its title). */
const REF_CHIP_CHARS = 32;
const clipChip = (s: string) => { const a = Array.from(s); return a.length > REF_CHIP_CHARS ? `${a.slice(0, REF_CHIP_CHARS - 1).join('').trimEnd()}…` : s; };

/** What one reference's chip reads, in the window's language: a note's line, whose question it
 *  is, or "Super: <quote>" / "You: <quote>" for a reply. */
export function useRefChipLabel(about: MessageAbout, superSid: string | null): string {
  const { t } = useI18n();
  const view = useSuperQuestions(about.kind === 'item' ? superSid : null);
  const ctx = useSuperEventContext(about.kind === 'item' ? superSid : null);
  if (about.kind === 'reply') return `${t(about.from === 'super' ? 'super.ref.super' : 'super.ref.own')} ${about.quote}`;
  if (about.kind === 'note') return about.line ?? '';
  return agendaAboutStrip(about, view?.open ?? [], (sid) => ctx?.titleFor(sid) ?? '', {
    about: t('super.agenda.about'), question: t('super.agenda.aboutQuestion'),
    superQuestion: t('super.agenda.aboutSuperQuestion'), aQuestion: t('super.agenda.aboutAQuestion'),
  }).text;
}

/**
 * One reference as an inline chip (owner 2026-10-24: several references in one message): the
 * glyph says the KIND (● an agenda line, ↩ a reply), the slot tint the IDENTITY, the same slot
 * the composer and the Super's section heads give it. A button when it does something (a reply
 * jumps to its message, an agenda line opens its whole line); a span inside another button.
 * `data-ref-part` is what a section head's jump flashes.
 */
export function RefChip({ about, slot, part, superSid, onClick, pressed }: {
  about: MessageAbout;
  slot: number;
  part?: number;
  superSid: string | null;
  onClick?: () => void;
  /** An agenda chip whose line is open below it. */
  pressed?: boolean;
}) {
  const label = useRefChipLabel(about, superSid);
  const glyph = about.kind === 'reply' ? '↩' : '●';
  const body = (
    <>
      <span className="chat-ref-chip-glyph" aria-hidden>{glyph}</span>
      <span className="chat-ref-chip-label">{clipChip(label)}</span>
    </>
  );
  const common = {
    className: 'chat-ref-chip',
    'data-slot': String(Math.min(Math.max(slot, 1), 5)),
    'data-kind': about.kind,
    ...(part ? { 'data-ref-part': String(part) } : {}),
    title: label,
    'data-testid': 'chat-ref-chip',
  };
  return onClick
    ? <button type="button" {...common} aria-expanded={about.kind === 'reply' ? undefined : !!pressed} onClick={onClick}>{body}</button>
    : <span {...common}>{body}</span>;
}

/** The chips of the parts a head or strip names: at most {@link MAX_HEAD_CHIPS}, then "+N". */
export function RefChips({ abouts, parts, superSid }: { abouts: readonly MessageAbout[]; parts: readonly number[]; superSid: string | null }) {
  const shown = abouts.slice(0, MAX_HEAD_CHIPS);
  return (
    <span className="chat-ref-chips">
      {shown.map((a, i) => <RefChip key={parts[i] ?? i} about={a} slot={parts[i] ?? i + 1} superSid={superSid} />)}
      {abouts.length > MAX_HEAD_CHIPS && <span className="chat-ref-chips-more">+{abouts.length - MAX_HEAD_CHIPS}</span>}
    </span>
  );
}

/** The strip over an answer group whose mark names parts of one message (a single-section
 *  answer, rev 12): those parts' chips and his words; a click lands on the message and flashes
 *  the first chip. */
export function PartStrip({ abouts, parts, words, superSid, onJump }: {
  abouts: readonly MessageAbout[];
  parts: readonly number[];
  words: string;
  superSid: string | null;
  onJump?: () => void;
}) {
  const body = (
    <>
      <RefChips abouts={abouts} parts={parts} superSid={superSid} />
      {words && <span className="chat-msg-about-text" title={words}>“{words}”</span>}
    </>
  );
  return onJump
    ? <button type="button" className="chat-msg-about chat-msg-about--parts" data-testid="chat-msg-reply" onClick={onJump}>{body}</button>
    : <div className="chat-msg-about chat-msg-about--parts" data-testid="chat-msg-reply">{body}</div>;
}
