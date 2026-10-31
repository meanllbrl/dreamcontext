import { useState } from 'react';
import { AgentIdentityDialog } from '../agents/AgentIdentityDialog';
import { useI18n } from '../../context/I18nContext';
import { phoneAllows } from '../../lib/phoneSurface';
import { useIsNewShell } from '../../lib/uxMode';
import { TeamIcon } from './TeamIcons';
import '../agents/AgentIdentityDialog.css';

/** The ready starts a new teammate can begin from. The words are the first run's starters;
 *  the schedule is said in the job, and the agent sets it up when it is asked to in the chat. */
export const TEAM_STARTERS = ['digest', 'weekly', 'research'] as const;
export type TeamStarter = (typeof TEAM_STARTERS)[number] | 'blank';

/**
 * A NEW TEAMMATE, written in the page: a starter (or blank), then the same identity form the
 * Agents page used (photo, name, job, soul, model, effort, board, learning). No schedule here:
 * a routine is set up by asking the teammate for one in its conversation.
 *
 * In the new shell the form also says where it works: this project, or all of them (this Mac's
 * global agent, created through the launcher's route, so never offered where that route is shut).
 */
export function NewTeammate({
  start = 'blank',
  whiteboard,
  onCancel,
  onCreated,
  onDraftTitle,
}: {
  start?: TeamStarter;
  whiteboard?: string;
  onCancel: () => void;
  onCreated: (slug: string, message: string) => void;
  onDraftTitle: (title: string) => void;
}) {
  const { t } = useI18n();
  const [starter, setStarter] = useState<TeamStarter>(start);
  const [everywhere, setEverywhere] = useState(false);
  const canChoose = useIsNewShell() && phoneAllows('POST', '/api/launcher/global-agents');
  const initial = starter === 'blank'
    ? undefined
    : { title: t(`agents.starter.${starter}.title`), prompt: t(`agents.starter.${starter}.prompt`) };
  return (
    <section className="aiteam-convo" aria-label={t('aiteam.newTeammate')}>
      <header className="aiteam-convo-head">
        <span className="aiteam-draft-av aiteam-draft-av--lg" aria-hidden="true"><TeamIcon name="plus" size={14} /></span>
        <div className="aiteam-convo-id">
          <span className="aiteam-convo-name">{t('aiteam.newTeammate')}</span>
          <span className="aiteam-convo-role">{t('aiteam.new.lede')}</span>
        </div>
      </header>
      <div className="aiteam-new">
        <div className="aiteam-new-card">
          <span className="aiteam-panel-label">{t('aiteam.new.startFrom')}</span>
          <div className="aiteam-starters" role="group" aria-label={t('aiteam.new.startFrom')}>
            {[...TEAM_STARTERS, 'blank' as const].map((s) => (
              <button
                key={s}
                type="button"
                className={`aiteam-starter${starter === s ? ' aiteam-starter--on' : ''}`}
                aria-pressed={starter === s}
                onClick={() => setStarter(s)}
              >
                <b>{s === 'blank' ? t('aiteam.new.blank') : t(`aiteam.starter.${s}.title`)}</b>
                <span>{s === 'blank' ? t('aiteam.new.blankSub') : t(`agents.starter.${s}.sub`)}</span>
              </button>
            ))}
          </div>
          {canChoose && (
            <>
              <span className="aiteam-panel-label">{t('aiteam.new.scope')}</span>
              <div className="aid-segmented" role="group" aria-label={t('aiteam.new.scope')}>
                {([false, true] as const).map((all) => (
                  <button
                    key={String(all)}
                    type="button"
                    className={`aid-segment${everywhere === all ? ' is-on' : ''}`}
                    aria-pressed={everywhere === all}
                    onClick={() => setEverywhere(all)}
                    data-new-scope={all ? 'all' : 'project'}
                  >
                    {t(all ? 'aiteam.new.scope.all' : 'aiteam.new.scope.project')}
                  </button>
                ))}
              </div>
            </>
          )}
          <AgentIdentityDialog
            // A different starter is a different form: remount so it opens filled with it.
            key={starter}
            inline
            slug={null}
            whiteboard={whiteboard}
            scope={everywhere ? 'global' : undefined}
            initial={initial}
            onClose={onCancel}
            onSaved={onCreated}
            onDraftTitle={onDraftTitle}
            note={t('aiteam.new.noSchedule')}
            submitLabel={t('aiteam.new.add')}
          />
        </div>
      </div>
    </section>
  );
}
