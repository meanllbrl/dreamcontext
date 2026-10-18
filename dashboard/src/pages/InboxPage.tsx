import type { ReactNode } from 'react';
import { useInbox } from '../hooks/useInbox';
import { useTaskProposals, type ProposalsPayload } from '../hooks/useTaskProposals';
import { useI18n } from '../context/I18nContext';
import type { Page } from '../components/layout/Sidebar';
import { ProposalsSection } from '../components/inbox/ProposalsSection';
import { InboxReviews } from '../components/inbox/InboxReviews';
import { InboxFlags } from '../components/inbox/InboxFlags';
import { InboxLearned } from '../components/inbox/InboxLearned';
import { InboxRecords } from '../components/inbox/InboxRecords';
import '../components/inbox/Inbox.css';

function Section({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  return (
    <section className="ibx-section" aria-labelledby={`ibx-${id}`} data-inbox-section={id}>
      <h2 className="ibx-section-title" id={`ibx-${id}`}>
        {title}
        {count !== undefined && <span className="ibx-count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

/** Whether the Proposals section has nothing to draw (the same test ProposalsSection makes). */
function proposalsEmpty(p: ProposalsPayload): boolean {
  const waiting = p.proposals.length + p.filed.length + (p.changes?.length ?? 0);
  return waiting === 0 && !p.trend.some((w) => w.kept + w.rejected > 0) && p.rules.length === 0;
}

/**
 * Everything that waits for the owner, in one place (plan r3 § 5d): reviews to approve or send
 * back, sleep's proposals and change cards, parents a sync held open, what sleep learned, and
 * the records of every owner override with who did it and through what.
 */
export function InboxPage({ onNavigate }: { onNavigate: (page: Page, id: string | null) => void }) {
  const { t } = useI18n();
  const { data, isLoading, error } = useInbox();
  // The Proposals section reads its own route: the page is ready only once every section's
  // data is in, so no section is ever drawn as a bare heading.
  const proposals = useTaskProposals();
  const openTask = (slug: string) => onNavigate('task', slug);
  const ready = !!data && !!proposals.data;

  return (
    <div className="ibx-page" data-inbox-ready={ready ? 'true' : undefined}>
      <h1 className="ibx-page-title">{t('nav.inbox')}</h1>
      {isLoading && <p className="ibx-empty">{t('taskPage.loading')}</p>}
      {error && <p className="ibx-error" role="alert">{(error as Error).message}</p>}
      {data && (
        <>
          <Section id="reviews" title={t('inbox.reviews.title')} count={data.reviews.length}>
            <InboxReviews reviews={data.reviews} onOpenTask={openTask} />
          </Section>
          <Section id="proposals" title={t('inbox.proposals.title')}>
            {!proposals.data && !proposals.error && <p className="ibx-empty">{t('taskPage.loading')}</p>}
            {proposals.error && <p className="ibx-error" role="alert">{(proposals.error as Error).message}</p>}
            {proposals.data && proposalsEmpty(proposals.data) && <p className="ibx-empty">{t('inbox.proposals.empty')}</p>}
            {proposals.data && !proposalsEmpty(proposals.data) && <ProposalsSection />}
          </Section>
          <Section id="flags" title={t('inbox.flags.title')} count={data.flags.length}>
            <InboxFlags flags={data.flags} onOpenTask={openTask} />
          </Section>
          <Section id="learned" title={t('inbox.learned.title')} count={data.learned.length}>
            <InboxLearned items={data.learned} onOpenPattern={(pattern) => onNavigate('knowledge', `patterns/${pattern}`)} />
          </Section>
          <Section id="records" title={t('inbox.records.title')} count={data.records.length}>
            <InboxRecords records={data.records} onOpenTask={openTask} />
          </Section>
        </>
      )}
    </div>
  );
}
