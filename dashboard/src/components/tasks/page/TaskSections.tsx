import type { ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { TaskSection } from '../detail/TaskSection';
import type { SectionCollapse, SectionId } from '../detail/useSectionCollapse';
import type { BodySection } from './bodySections';
import { TaskDecisions } from './TaskDecisions';
import { TaskMarkdown } from './TaskMarkdown';

/**
 * The card's document sections, each collapsible and each through the sanitizing renderer:
 * Why, Constraints & Decisions, User Stories, Technical Details, Notes, anything else under
 * "More", and a legacy in-card Changelog last. A closed section renders nothing, so a 300 KB
 * legacy history costs nothing until it is opened.
 */
export function TaskSections({ slug, sections, collapse, criteria }: {
  slug: string;
  sections: BodySection[];
  collapse: SectionCollapse;
  /** The criteria piece, placed after Why. */
  criteria: ReactNode;
}) {
  const { t } = useI18n();
  const of = (key: BodySection['key']) => sections.filter((s) => s.key === key);
  const textOf = (key: BodySection['key']) => of(key).map((s) => s.text).filter(Boolean).join('\n\n');

  const section = (id: SectionId, title: string, body: ReactNode, count?: number) => (
    <TaskSection id={id} title={title} open={collapse.isOpen(id)} onToggle={() => collapse.toggle(id)} count={count}>
      {body}
    </TaskSection>
  );
  const md = (key: BodySection['key']) => <TaskMarkdown text={textOf(key)} idPrefix={`tkp-${key}-${slug}`} />;

  const lead = textOf('lead');
  const others = of('other');
  const legacy = textOf('changelog');

  return (
    <div className="tkp-sections">
      {lead && <TaskMarkdown text={lead} idPrefix={`tkp-lead-${slug}`} />}
      {section('why', t('taskPage.section.why'), textOf('why') ? md('why') : <p className="tkp-empty">{t('taskPage.section.whyEmpty')}</p>)}
      <section className="tkp-block" aria-labelledby={`tkp-criteria-${slug}`}>
        <h2 className="tkp-block-title" id={`tkp-criteria-${slug}`}>{t('taskPage.section.criteria')}</h2>
        {criteria}
      </section>
      {section('decisions', t('taskPage.section.decisions'), <TaskDecisions slug={slug} text={textOf('decisions')} />)}
      {textOf('stories') && section('stories', t('taskPage.section.stories'), md('stories'))}
      {textOf('details') && section('details', t('taskPage.section.details'), md('details'))}
      {textOf('notes') && section('notes', t('taskPage.section.notes'), md('notes'))}
      {others.length > 0 && section('more', t('taskPage.section.more'), (
        <div className="tkp-more">
          {others.map((s, i) => (
            <div key={`${s.title}-${i}`} className="tkp-more-item">
              <h3 className="tkp-more-title">{s.title}</h3>
              <TaskMarkdown text={s.text} idPrefix={`tkp-more-${slug}-${i}`} />
            </div>
          ))}
        </div>
      ), others.length)}
      {legacy && section('legacy', t('taskPage.section.legacy'), (
        <div className="tkp-legacy">
          <p className="tkp-meta">{t('taskPage.section.legacyHint')}</p>
          <TaskMarkdown text={legacy} idPrefix={`tkp-legacy-${slug}`} />
        </div>
      ))}
    </div>
  );
}
