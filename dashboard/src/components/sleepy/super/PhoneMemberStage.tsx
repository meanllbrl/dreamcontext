import { useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { MEMBER_CARD_REFS, type MemberCardRef } from '../../../lib/superTypes';
import { PhoneSheet, PhoneSheetClose } from './PhoneSheet';
import { findAgent, useAgents } from '../../../hooks/useAgents';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { ChildTranscript } from './ChildTranscript';
import { MemberRefusalLine } from './MemberStage';
import type { MemberRefusal } from './memberStageModel';
import './TaskStrip.css';

/**
 * A member's stage on the phone (plan-r10 AC9; super-members.mjs step i). The phone draws one chat
 * and no stage, and the Mac refuses a phone's socket on a member's Super session in this wave, so
 * a mirror tab would be closed again at once ("No open chats"). The phone shows the member instead:
 * its face and name, its one conversation read from its transcript (live while it runs, through
 * the tunnel's allowed `/agent/chat-history`), and one line saying the phone reads it here and the
 * Mac writes to it. A member with no Super running says why (`MemberRefusalLine`).
 */
export function PhoneMemberStage({ slug, session, refusal, onRetry, card }: {
  slug: string;
  /** Its own cards (plan r4 G6): chips under the head, each opening in the phone sheet. */
  card?: (ref: MemberCardRef, variant: 'tile' | 'full') => ReactNode;
  /** Its Super's session, once the Mac's stage named one; null while opening or refused. */
  session: string | null;
  refusal: MemberRefusal | null;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const agent = findAgent(agents, slug);
  const name = agent?.title || slug;
  const [sheet, setSheet] = useState<MemberCardRef | null>(null);
  return (
    <section className="phone-member-stage" data-testid="phone-member-stage" data-super-id={`m:${slug}`}>
      <header className="super-member-head phone-member-head">
        <AgentAvatar of="agent" slug={slug} title={name} hasPhoto={!!agent?.hasPhoto} size={28} face={agent?.face} />
        <span className="super-member-name" data-testid="super-member-name">{name}</span>
        {agent?.roleLine && <span className="super-member-sub">{t('superStage.member.subtitle').replace('{job}', agent.roleLine)}</span>}
      </header>
      {card && (
        <div className="phone-member-chips" role="group" aria-label={name} data-testid="phone-member-chips">
          {MEMBER_CARD_REFS.map((ref) => (
            <button key={ref} type="button" className="phone-member-chip" data-testid="phone-member-chip" data-ref={ref} onClick={() => setSheet(ref)}>
              {t(`superStage.member.cards.${ref}`)}
            </button>
          ))}
        </div>
      )}
      {card && sheet && (
        <PhoneSheet testId="phone-member-card-sheet" label={t(`superStage.member.cards.${sheet}`)} onClose={() => setSheet(null)}
          handle={(
            <div className="phone-agenda-head">
              <div className="phone-agenda-titles"><h2 className="phone-agenda-title">{t(`superStage.member.cards.${sheet}`)}</h2></div>
              <PhoneSheetClose testId="phone-member-card-close" label={t('super.phoneJobs.close')} onClick={() => setSheet(null)} />
            </div>
          )}>
          <div className="phone-agenda-body">{card(sheet, 'full')}</div>
        </PhoneSheet>
      )}
      {refusal
        ? <div className="super-member-top"><MemberRefusalLine slug={slug} refusal={refusal} onRetry={onRetry} /></div>
        : session
          ? (
            <>
              <p className="super-member-refusal phone-member-note" role="status" data-testid="phone-member-readonly">
                {t('superStage.member.phoneReadOnly').replace('{name}', name)}
              </p>
              <div className="phone-member-body">
                <ChildTranscript key={session} claudeId={session} live foot="own" />
              </div>
            </>
          )
          : <p className="super-member-refusal phone-member-note" role="status">{t('superStage.member.opening').replace('{name}', name)}</p>}
    </section>
  );
}
