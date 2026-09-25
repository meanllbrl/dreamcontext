import { BrandMark } from '../brand/BrandMark';
import { AutomationsShowcase } from './AutomationsShowcase';
import { AutomationsDispatcherBar } from './AutomationsDispatcherBar';
import { useI18n } from '../../context/I18nContext';
import type { AgentDialogInitial } from '../agents/AgentDialog';
import type { AutomationMode, Weekday } from '../../hooks/useAutomations';
import './AutomationsEmptyState.css';

/** The three agents a first-time owner can start from. The words live in i18n; the schedule
 *  is data, and it matches the sentence each prompt says out loud. */
const STARTERS: { key: string; mode: AutomationMode; days?: Weekday[]; at?: string }[] = [
  { key: 'digest', mode: 'sched', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '09:00' },
  { key: 'weekly', mode: 'sched', days: ['fri'], at: '17:00' },
  { key: 'research', mode: 'call' },
];

/**
 * Automations' zero-state, built in the same shape as Council's and Lab's: with no agents to
 * list, the channel's chrome would be noise, so it shows a compact explainer instead — brand
 * mark · heading · lead · three agents to start from · the animated cadence stage.
 *
 * FIRST RUN STARTS SOMETHING (C9). The lead is outcome words, not implementation words (no
 * `claude -p`, no dispatcher, no hash above the fold), and the way in is three starter agents
 * that open the New agent dialog already filled in, one click from a working first agent. A
 * blank start stays, quieter. The safety line sits right under them, because "nothing runs until
 * you approve it" is what a first-time reader needs before pressing anything.
 *
 * `onNewAgent` / `onStart` are NOT optional in practice: this screen replaces the whole page
 * while a vault has zero agents, so without them the only way to a first agent is the CLI.
 */
export function AutomationsEmptyState({
  onToast,
  onNewAgent,
  onStart,
}: {
  onToast?: (msg: string) => void;
  onNewAgent?: () => void;
  onStart?: (initial: AgentDialogInitial) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="auto-intro">
      <div className="auto-intro-mark">
        <BrandMark size={40} glow />
      </div>

      <h2 className="auto-intro-title">
        Put the brain <span>on a schedule</span>.
      </h2>
      <p className="auto-intro-lead">{t('agents.empty.lead')}</p>

      {onStart && (
        <>
          <p className="auto-intro-starters-label">{t('agents.empty.starters')}</p>
          <div className="auto-intro-starters">
            {STARTERS.map((s) => (
              <button
                key={s.key}
                type="button"
                className="auto-intro-starter"
                onClick={() => onStart({
                  title: t(`agents.starter.${s.key}.title`),
                  description: t(`agents.starter.${s.key}.prompt`),
                  mode: s.mode,
                  days: s.days,
                  at: s.at,
                })}
              >
                <span className="auto-intro-starter-title">{t(`agents.starter.${s.key}.title`)}</span>
                <span className="auto-intro-starter-sub">{t(`agents.starter.${s.key}.sub`)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {onNewAgent && (
        <button type="button" className="auto-intro-new-btn" onClick={onNewAgent}>
          {t('agents.empty.blank')}
        </button>
      )}

      <p className="auto-intro-safety">{t('agents.empty.safety')}</p>

      <AutomationsShowcase />

      <AutomationsDispatcherBar onToast={onToast} />

      <p className="auto-intro-scaffold">Or scaffold one from the CLI:</p>
      <code className="auto-intro-cmd">
        dreamcontext automations create &lt;slug&gt; --title "Daily digest" --days daily --at 18:00
      </code>
    </div>
  );
}
