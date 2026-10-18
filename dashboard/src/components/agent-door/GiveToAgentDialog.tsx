import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTask, useTaskReadiness } from '../../hooks/useTasks';
import { useAgentCapabilities, isSleepAgentReady } from '../../hooks/useAgentCapabilities';
import { readAgentSettings, AGENT_SETTINGS_EVENT } from '../../lib/agentSettings';
import { useInstanceEvent, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { requestDelegateAgent } from '../../lib/delegateAgent';
import { GIVE_TO_AGENT_EVENT, type GiveToAgentDetail, type GiveToAgentPreset } from '../../lib/giveToAgent';
import { AssignToAgentComposer } from '../tasks/AssignToAgentComposer';
import { DelegateComposer } from '../tasks/DelegateComposer';
import { AuthorTaskComposer } from '../tasks/AuthorTaskComposer';
import { taskName } from '../tasks/boardModel';
import './GiveToAgentDialog.css';

const CHOICES: GiveToAgentPreset[] = ['develop', 'agent', 'custom', 'author'];

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The choices that hand over to a composer, which then owns the keyboard (its own Escape). */
const COMPOSER_CHOICES: readonly GiveToAgentPreset[] = ['agent', 'custom', 'author'];

/** Whether the in-app agent can start sessions here (desktop, prerequisites, surface on). */
function useAgentReady(): boolean {
  const { data: caps } = useAgentCapabilities();
  const [settings, setSettings] = useState(() => readAgentSettings());
  useEffect(() => {
    const on = () => setSettings(readAgentSettings());
    window.addEventListener(AGENT_SETTINGS_EVENT, on);
    return () => window.removeEventListener(AGENT_SETTINGS_EVENT, on);
  }, []);
  return isSleepAgentReady(caps, settings.chatView) && settings.enabled;
}

/**
 * The one "Give to an agent" door (plan r3 § 5e), mounted once per project. It reads the task
 * by slug (`useTask`: the list carries no body, and the composers hand over its Why and
 * criteria) and offers four choices, each reaching the call its old entry point made:
 *  - **Develop**: readiness first (gaps shown, Start disabled until ready), then
 *    `requestDelegateAgent({ mode: 'develop', taskSlug })`, which the Agent surface opens as a
 *    Develop session — the one the Plan chat's hand-off opens;
 *  - **A named agent**: the Assign-to-agent composer;
 *  - **Custom prompt**: the Delegate composer;
 *  - **Write a new task** (no slug needed): the authoring composer.
 * Develop, custom and author need the in-app agent and are offered only where it can run.
 * At a phone's width the chooser is a full-screen sheet.
 */
export function GiveToAgentDialog() {
  const { t } = useI18n();
  const { bus } = useVault();
  const agentReady = useAgentReady();
  const [open, setOpen] = useState<GiveToAgentDetail | null>(null);
  const [choice, setChoice] = useState<GiveToAgentPreset | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  // Where focus was when the door opened (the button that opened it), so closing returns it.
  const returnFocus = useRef<HTMLElement | null>(null);

  useInstanceEvent<GiveToAgentDetail | undefined>(GIVE_TO_AGENT_EVENT, (detail) => {
    const active = document.activeElement;
    // A second open while the door is up keeps the original trigger as the place to return to.
    if (active instanceof HTMLElement && !dialogRef.current?.contains(active)) returnFocus.current = active;
    setOpen(detail ?? {});
    setChoice(detail?.preset ?? (detail?.slug ? null : 'author'));
    setError(null);
  });

  const slug = open?.slug ?? '';
  const { data: task, isLoading } = useTask(slug);
  const readiness = useTaskReadiness(slug, !!open && choice === 'develop');
  const close = () => {
    setOpen(null);
    setChoice(null);
    setError(null);
    const back = returnFocus.current;
    returnFocus.current = null;
    // After React has removed the dialog, so focus lands on the trigger, not on nothing.
    if (back && back.isConnected) requestAnimationFrame(() => back.focus());
  };
  const composerOwnsKeyboard = choice !== null && COMPOSER_CHOICES.includes(choice);

  // Escape closes the door on the chooser and on the Develop panel. An embedded composer
  // handles its own Escape, so the door stays out of its way.
  useEffect(() => {
    if (!open || composerOwnsKeyboard) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, composerOwnsKeyboard]);

  // Focus moves into the dialog when it opens and when its panel changes (chooser ↔ Develop).
  useEffect(() => {
    if (!open || composerOwnsKeyboard) return;
    const root = dialogRef.current;
    if (!root) return;
    const first = root.querySelector<HTMLElement>('[data-give-choice]:not([disabled]), .gta-btn--primary:not([disabled])')
      ?? root.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, [open, choice, composerOwnsKeyboard, !!task, readiness.data?.ready]);

  /** Tab and Shift+Tab wrap inside the dialog: focus never leaves it for the page behind. */
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus(); }
  };

  if (!open) return null;

  // The composers are their own dialogs: once a choice is made, the door hands over to it.
  if (choice === 'agent' && task) return <AssignToAgentComposer task={task} onClose={close} />;
  if (choice === 'custom' && task) return <DelegateComposer task={task} onClose={close} />;
  if (choice === 'author') return <AuthorTaskComposer onClose={close} />;

  const needsAgent = (c: GiveToAgentPreset) => c !== 'agent';
  // A task's door offers what can be done with it; without one, only writing a new task.
  const offered = CHOICES.filter((c) => (c === 'author' ? !slug : !!slug) && (!needsAgent(c) || agentReady));
  const name = task ? taskName(task) : slug;

  const startDevelop = () => {
    setError(null);
    const ok = requestDelegateAgent(bus, { mode: 'develop', taskSlug: slug, title: name, prompt: '', promptToken: '', bypass: false });
    if (ok) close();
    else setError(t('giveAgent.develop.refused'));
  };

  return (
    <div className="gta-overlay" onClick={close}>
      <div
        className="gta-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gta-title"
        data-give-to-agent={slug || 'new'}
        data-give-ready={!slug || task ? 'true' : undefined}
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={trapTab}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gta-head">
          <h2 className="gta-title" id="gta-title">{t('giveAgent.title')}</h2>
          <button type="button" className="gta-close" onClick={close} aria-label={t('giveAgent.close')}>×</button>
        </div>
        {slug && <p className="gta-task" lang="und">{isLoading ? t('taskPage.loading') : name}</p>}

        {choice === 'develop' ? (
          <div className="gta-develop" data-give-choice-panel="develop">
            <p className="gta-text">{t('giveAgent.develop.body')}</p>
            {readiness.isLoading && <p className="gta-meta">{t('giveAgent.develop.checking')}</p>}
            {readiness.data && !readiness.data.ready && (
              <div className="gta-gaps" role="status">
                <p className="gta-text">{t('giveAgent.develop.notReady')}</p>
                <ul className="gta-gap-list">
                  {readiness.data.gaps.map((g) => <li key={`${g.field}-${g.problem}`}>{`${g.field}: ${g.problem}`}</li>)}
                </ul>
              </div>
            )}
            {readiness.error && <p className="gta-error" role="alert">{(readiness.error as Error).message}</p>}
            <div className="gta-actions">
              <button
                type="button"
                className="gta-btn gta-btn--primary"
                disabled={!readiness.data?.ready}
                onClick={startDevelop}
              >
                {t('giveAgent.develop.start')}
              </button>
              <button type="button" className="gta-btn" onClick={() => setChoice(null)}>{t('giveAgent.back')}</button>
            </div>
          </div>
        ) : (
          <ul className="gta-choices">
            {offered.map((c) => (
              <li key={c}>
                <button
                  type="button"
                  className="gta-choice"
                  data-give-choice={c}
                  disabled={c !== 'author' && !task}
                  onClick={() => setChoice(c)}
                >
                  <span className="gta-choice-title">{t(`giveAgent.choice.${c}`)}</span>
                  <span className="gta-meta">{t(`giveAgent.choice.${c}Hint`)}</span>
                </button>
              </li>
            ))}
            {!agentReady && <li className="gta-meta">{t('giveAgent.agentOff')}</li>}
          </ul>
        )}
        {error && <p className="gta-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
