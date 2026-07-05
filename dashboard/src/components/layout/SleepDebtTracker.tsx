import { useState, useRef, useEffect } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useSleep, getSleepLevelKey, getSleepMood, SLEEP_DEBT_MAX } from '../../hooks/useSleep';
import { useAgentCapabilities, isSleepAgentReady } from '../../hooks/useAgentCapabilities';
import { readAgentSettings, AGENT_SETTINGS_EVENT, type AgentSettings } from '../../lib/agentSettings';
import {
  requestSleepAgent,
  markSleepPending,
  clearSleepPending,
  sleepPendingSince,
  SLEEP_PENDING_EVENT,
} from '../../lib/sleepAgent';
import { SleepyMascot } from '../sleepy/SleepyMascot';
import './SleepDebtTracker.css';

interface SleepDebtTrackerProps {
  /** Jump to the full Sleep page (the "Show sleep details" menu item). */
  onOpen?: () => void;
}

/**
 * Header companion: a live sleep-debt readout that pairs a linear progress bar
 * (debt climbing toward the "Must Sleep" ceiling) with the animated Sleepy face,
 * whose mood mirrors the same debt — wide awake while fresh, lids dropping as it
 * builds, fully asleep once a consolidation is overdue. Debt polls with every
 * other active query (15s interval), so the bar and face track sleep in near
 * real time.
 *
 * Clicking opens a small menu: "Show sleep details" (→ Sleep page) and "Run sleep
 * agent" (→ spawns a real Claude Code consolidation session in the bottom-right
 * dock, gated on the agent prerequisites being ready). While a consolidation is
 * actually in flight (`sleep_started_at` is set) the tracker switches to a full
 * "Sleeping 💤 z z z" state so the active sleep is unmistakable.
 */
export function SleepDebtTracker({ onOpen }: SleepDebtTrackerProps) {
  const { t } = useI18n();
  const { data: sleep } = useSleep();
  const { data: caps } = useAgentCapabilities();
  const [menuOpen, setMenuOpen] = useState(false);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(() => readAgentSettings());
  const [pendingAt, setPendingAt] = useState<number | null>(() => sleepPendingSince());
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Mirror the persisted "waiting to sleep" marker (set on click, cleared once a real sleep
  // starts). Broadcast keeps us in sync instantly; the interval re-evaluates so the marker's
  // TTL self-clears the shim if the spawned agent never reaches `sleep start`.
  useEffect(() => {
    const sync = () => setPendingAt(sleepPendingSince());
    window.addEventListener(SLEEP_PENDING_EVENT, sync);
    const iv = window.setInterval(sync, 4_000);
    return () => { window.removeEventListener(SLEEP_PENDING_EVENT, sync); window.clearInterval(iv); };
  }, []);

  // Track the Agents-surface enable toggle live (Settings broadcasts on save) — a
  // disabled surface renders no dock, so "Run sleep agent" must be disabled too or a
  // click would spawn an invisible session.
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<AgentSettings>).detail;
      if (detail) setAgentSettings(detail);
    };
    window.addEventListener(AGENT_SETTINGS_EVENT, onChange);
    return () => window.removeEventListener(AGENT_SETTINGS_EVENT, onChange);
  }, []);

  // Once a real sleep actually begins (epoch stamped), retire the "waiting" shim — the
  // tracker hands off to its authoritative "Sleeping 💤" state.
  useEffect(() => {
    if (sleep?.sleep_started_at && sleepPendingSince() != null) clearSleepPending();
  }, [sleep?.sleep_started_at]);

  // Close the menu on any outside click or Esc — a lightweight popover, no backdrop.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

  // Nothing to show until the first fetch resolves — keep the header quiet.
  if (!sleep) return null;

  const debt = Math.max(0, sleep.debt);
  // A consolidation is live when the epoch is stamped (`sleep start`, cleared by
  // `sleep done`). That's the authoritative "sleep is active" signal.
  const sleeping = !!sleep.sleep_started_at;
  // The bridge between click and real sleep: a request is in flight but the agent hasn't
  // stamped the epoch yet. Suppressed once the real sleep begins.
  const waiting = !sleeping && pendingAt != null;
  const levelKey = sleeping ? 'must_sleep' : getSleepLevelKey(debt);
  const mood = sleeping ? 'sleeps' : waiting ? 'sleepy' : getSleepMood(debt);
  const pct = sleeping ? 100 : Math.min(100, (debt / SLEEP_DEBT_MAX) * 100);
  const level = t(`sleep.${levelKey}`);

  const agentReady = isSleepAgentReady(caps) && agentSettings.enabled;

  const runAgent = () => {
    setMenuOpen(false);
    markSleepPending();
    requestSleepAgent();
  };
  const showDetails = () => {
    setMenuOpen(false);
    onOpen?.();
  };

  const summary = sleeping
    ? t('sleep.active')
    : waiting ? t('sleep.waiting')
    : `${level} · ${debt}/${SLEEP_DEBT_MAX} ${t('sleep.debt')}`;

  return (
    <div className="sleep-tracker-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`sleep-tracker sleep-tracker--${levelKey}${sleeping ? ' sleep-tracker--sleeping' : ''}${waiting ? ' sleep-tracker--waiting' : ''}`}
        data-no-drag
        onClick={() => setMenuOpen((v) => !v)}
        title={summary}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={sleeping
          ? t('sleep.active')
          : waiting ? t('sleep.waiting')
          : `${t('sleep.level')}: ${level}. ${t('sleep.debt')} ${debt} / ${SLEEP_DEBT_MAX}.`}
      >
        <span className="sleep-tracker-face" aria-hidden>
          <SleepyMascot mood={mood} size={30} compact />
        </span>

        <span className="sleep-tracker-body">
          <span className="sleep-tracker-top">
            <span className="sleep-tracker-level">
              {sleeping ? t('sleep.active') : waiting ? t('sleep.waiting') : level}
            </span>
            {sleeping ? (
              <span className="sleep-tracker-zzz" aria-hidden>
                <span>z</span><span>z</span><span>z</span>
              </span>
            ) : waiting ? (
              <span className="sleep-tracker-wait-dots" aria-hidden>
                <span>·</span><span>·</span><span>·</span>
              </span>
            ) : (
              <span className="sleep-tracker-count">
                {debt}<span className="sleep-tracker-count-max">/{SLEEP_DEBT_MAX}</span>
              </span>
            )}
          </span>
          <span className="sleep-tracker-bar" aria-hidden>
            <span className="sleep-tracker-fill" style={{ width: `${pct}%` }} />
          </span>
        </span>
      </button>

      {menuOpen && (
        <div className="sleep-tracker-menu" role="menu">
          <button
            type="button"
            className="sleep-tracker-menu-item"
            role="menuitem"
            onClick={showDetails}
            disabled={!onOpen}
          >
            <span className="sleep-tracker-menu-glyph" aria-hidden>☾</span>
            <span className="sleep-tracker-menu-label">{t('sleep.menu.details')}</span>
          </button>
          <button
            type="button"
            className="sleep-tracker-menu-item"
            role="menuitem"
            onClick={runAgent}
            disabled={!agentReady || sleeping || waiting}
            title={
              sleeping ? t('sleep.menu.run.active')
                : waiting ? t('sleep.menu.run.waiting')
                : agentReady ? undefined
                : t('sleep.menu.run.disabled')
            }
          >
            <span className="sleep-tracker-menu-glyph" aria-hidden>▸</span>
            <span className="sleep-tracker-menu-label">{t('sleep.menu.run')}</span>
            {sleeping && <span className="sleep-tracker-menu-hint">{t('sleep.active')}</span>}
            {waiting && <span className="sleep-tracker-menu-hint">{t('sleep.waiting')}</span>}
          </button>
        </div>
      )}
    </div>
  );
}
