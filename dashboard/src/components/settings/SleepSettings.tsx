import { useState, type JSX } from 'react';
import { useI18n } from '../../context/I18nContext';
import { confirmAction } from '../../lib/desktop';
import { SettingGroup, SettingRow } from './SettingRow';
import { useInstantSave, SaveMark } from './useInstantSave';
import {
  useConfig,
  useUpdateConfig,
  SLEEP_SPECIALISTS,
  SLEEP_MODEL_OPTIONS,
  SLEEP_EFFORT_OPTIONS,
  useSleepSpecialistDefaults,
  type SleepSpecialist,
} from '../../hooks/useConfig';
import { useSleep, sleepThresholds, DEFAULT_SLEEP_THRESHOLDS } from '../../hooks/useSleep';
import { useAutoSleep, useSetAutoSleep, useCancelAutoSleep, type AutoSleepTrigger } from '../../hooks/useAutoSleep';
import { Toggle } from './SettingRow';
import './SleepSettings.css';

/**
 * Settings › Sleep — the per-brain sleep tuning that used to be constants in
 * `src/lib/sleep-consolidation.ts` and hardcoded `model:` lines in six agent
 * files.
 *
 * Two things this screen is careful about:
 *
 *  - The ladder is validated BEFORE it is sent. A non-monotonic set is discarded
 *    WHOLE by the reader (never half-applied), so letting someone save one would
 *    mean a saved setting that silently does nothing. The server refuses it too;
 *    this just means they find out while typing rather than after.
 *  - These values are BRAIN-level and ride to teammates in `.config.json`. The
 *    machine-local switches (background auto-sleep) are a separate block, added
 *    by Workstream C, and say so on screen.
 */

type Level = 'drowsy' | 'sleepy' | 'mustSleep';
const LEVELS: Level[] = ['drowsy', 'sleepy', 'mustSleep'];

const THRESHOLD_MIN = 1;
const THRESHOLD_MAX = 1000;
const CAP_MAX = 50;

/** Strictly ascending, or the whole ladder is ignored — mirrors validateThresholdLadder. */
function ladderViolation(t: Record<Level, number>): Level | null {
  if (!(t.drowsy < t.sleepy)) return 'sleepy';
  if (!(t.sleepy < t.mustSleep)) return 'mustSleep';
  return null;
}

export function SleepSettings(): JSX.Element {
  const { t } = useI18n();
  const { data: config } = useConfig();
  const { data: shippedDefaults } = useSleepSpecialistDefaults();
  const { data: sleep } = useSleep();
  const updateConfig = useUpdateConfig();

  const thresholdsSave = useInstantSave();
  const capSave = useInstantSave();
  const specialistSave = useInstantSave();

  // The RESOLVED ladder in force (the server derives it), so the fields show
  // what is actually running rather than only what was overridden.
  const live = sleepThresholds(sleep);
  const overrides = config?.sleep?.thresholds ?? {};

  // Local draft so a half-typed ladder doesn't fire a write on every keystroke.
  const [draft, setDraft] = useState<Record<Level, string> | null>(null);
  const current: Record<Level, number> = {
    drowsy: live.drowsy, sleepy: live.sleepy, mustSleep: live.mustSleep,
  };
  const shown: Record<Level, string> = draft ?? {
    drowsy: String(current.drowsy), sleepy: String(current.sleepy), mustSleep: String(current.mustSleep),
  };

  const parsed: Record<Level, number> = {
    drowsy: Number(shown.drowsy), sleepy: Number(shown.sleepy), mustSleep: Number(shown.mustSleep),
  };
  const rangeBad = LEVELS.find(
    (l) => !Number.isInteger(parsed[l]) || parsed[l] < THRESHOLD_MIN || parsed[l] > THRESHOLD_MAX,
  );
  const orderBad = rangeBad ? null : ladderViolation(parsed);
  const invalid = rangeBad ?? orderBad;
  const dirty = LEVELS.some((l) => parsed[l] !== current[l]);

  const saveThresholds = () => {
    if (invalid || !dirty) return;
    void thresholdsSave.save(async () => {
      await updateConfig.mutateAsync({
        sleep: { thresholds: { drowsy: parsed.drowsy, sleepy: parsed.sleepy, mustSleep: parsed.mustSleep } },
      });
      setDraft(null);
    });
  };

  const resetThresholds = () => {
    void thresholdsSave.save(async () => {
      await updateConfig.mutateAsync({ sleep: { thresholds: null } });
      setDraft(null);
    });
  };

  const cap = config?.sleep?.maxNewTasksPerCycle ?? 5;
  const capOverridden = config?.sleep?.maxNewTasksPerCycle !== undefined;
  const saveCap = (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > CAP_MAX) return;
    void capSave.save(() => updateConfig.mutateAsync({ sleep: { maxNewTasksPerCycle: n } }));
  };

  const setSpecialist = (name: SleepSpecialist, field: 'model' | 'effort', value: string) => {
    void specialistSave.save(() =>
      updateConfig.mutateAsync({
        sleep: { specialists: { [name]: { [field]: value === '' ? null : value } } as never },
      }),
    );
  };

  return (
    <>
      <SettingGroup title={t('settings.sleep.thresholds')} note={t('settings.sleep.thresholds_note')}>
        <div className="sleep-thresholds">
          {LEVELS.map((level) => (
            <label key={level} className="sleep-threshold-field">
              <span className="sleep-threshold-label">
                {t(`settings.sleep.level.${level}`)}
                {/* Name the default. The field always carries the value in force,
                    so the input's placeholder never renders — a default nobody
                    can see is one nobody can decide against. */}
                <span className="sleep-threshold-mark">
                  {overrides[level] !== undefined
                    ? t('settings.sleep.overridden')
                    : t('settings.sleep.is_default').replace('{n}', String(DEFAULT_SLEEP_THRESHOLDS[level]))}
                </span>
              </span>
              <input
                className={`settings-text-input sleep-threshold-input${invalid === level ? ' sleep-threshold-input--bad' : ''}`}
                type="number"
                inputMode="numeric"
                min={THRESHOLD_MIN}
                max={THRESHOLD_MAX}
                value={shown[level]}
                placeholder={String(DEFAULT_SLEEP_THRESHOLDS[level])}
                aria-invalid={invalid === level}
                onChange={(e) => setDraft({ ...shown, [level]: e.target.value })}
                onBlur={saveThresholds}
                onKeyDown={(e) => { if (e.key === 'Enter') saveThresholds(); }}
              />
            </label>
          ))}
        </div>

        {invalid && (
          <p className="settings-test-err" role="alert">
            ✗ {rangeBad
              ? t('settings.sleep.err_range')
              : t('settings.sleep.err_order')}
          </p>
        )}

        <p className="sleep-derived">
          {t('settings.sleep.derived')
            .replace('{deep}', String(Math.round(current.mustSleep * 1.5)))
            .replace('{cooldown}', String(current.mustSleep * 2))}
        </p>

        <div className="sleep-actions">
          <button
            type="button"
            className="settings-btn"
            disabled={!dirty || !!invalid || thresholdsSave.state.kind === 'saving'}
            onClick={saveThresholds}
          >
            {t('settings.sleep.apply')}
          </button>
          <button
            type="button"
            className="settings-btn settings-btn--quiet"
            disabled={Object.keys(overrides).length === 0}
            onClick={resetThresholds}
          >
            {t('settings.sleep.reset')}
          </button>
          <SaveMark state={thresholdsSave.state} />
        </div>
      </SettingGroup>

      <SettingGroup title={t('settings.sleep.specialists')} note={t('settings.sleep.specialists_note')}>
        <div className="sleep-specialists">
          {/* Column headers — two unlabelled dropdowns per row left you guessing
              which was the model and which the effort. */}
          <div className="sleep-specialist-row sleep-specialist-head" aria-hidden="true">
            <span />
            <span className="sleep-col-head">{t('settings.sleep.col_model')}</span>
            <span className="sleep-col-head">{t('settings.sleep.col_effort')}</span>
          </div>
          {SLEEP_SPECIALISTS.map((name) => {
            const o = config?.sleep?.specialists?.[name];
            // What the installed agent file declares — what "Package default"
            // actually resolves to. A default you cannot see is one you cannot
            // reason about, which is why it is named in the option itself.
            const shipped = shippedDefaults?.[name];
            const defaultLabel = (v: string | null | undefined) =>
              v ? `${t('settings.sleep.package_default')} (${v})` : t('settings.sleep.package_default');
            return (
              <div key={name} className="sleep-specialist-row">
                <code className="sleep-specialist-name">{name}</code>
                <select
                  className={`settings-text-input sleep-specialist-select${o?.model ? ' sleep-specialist-select--set' : ''}`}
                  aria-label={`${name} model`}
                  value={o?.model ?? ''}
                  onChange={(e) => setSpecialist(name, 'model', e.target.value)}
                >
                  <option value="">{defaultLabel(shipped?.model)}</option>
                  {SLEEP_MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <select
                  className={`settings-text-input sleep-specialist-select${o?.effort ? ' sleep-specialist-select--set' : ''}`}
                  aria-label={`${name} effort`}
                  value={o?.effort ?? ''}
                  onChange={(e) => setSpecialist(name, 'effort', e.target.value)}
                >
                  <option value="">{defaultLabel(shipped?.effort)}</option>
                  {SLEEP_EFFORT_OPTIONS.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
            );
          })}
        </div>
        <SaveMark state={specialistSave.state} />
      </SettingGroup>

      <AutoSleepBlock />

      <SettingGroup title={t('settings.sleep.filing')}>
        <SettingRow
          title={t('settings.sleep.cap')}
          hint={t('settings.sleep.cap_hint')}
          more={t('settings.sleep.cap_more')}
          control={
            <input
              className="settings-text-input sleep-cap-input"
              type="number"
              inputMode="numeric"
              min={0}
              max={CAP_MAX}
              defaultValue={String(cap)}
              placeholder="5"
              aria-label={t('settings.sleep.cap')}
              onBlur={(e) => saveCap(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveCap((e.target as HTMLInputElement).value); }}
            />
          }
          status={
            <>
              {capOverridden && <span className="sleep-threshold-mark">{t('settings.sleep.overridden')}</span>}
              <SaveMark state={capSave.state} />
            </>
          }
        />
      </SettingGroup>
    </>
  );
}


/**
 * Background auto-sleep — MACHINE-LOCAL, and the screen says so.
 *
 * The three things a person needs before handing an unattended agent their
 * brain: what it costs, what "on" actually covers, and how to stop one that is
 * running. All three are on screen, not in a doc.
 */
function AutoSleepBlock(): JSX.Element {
  const { t } = useI18n();
  const { data: auto } = useAutoSleep();
  const setAuto = useSetAutoSleep();
  const cancel = useCancelAutoSleep();
  const save = useInstantSave();

  const enabled = auto?.enabled ?? false;
  const trigger: AutoSleepTrigger = auto?.trigger ?? 'must-sleep';
  const job = auto?.job ?? null;
  const live = auto?.jobLive ?? false;

  const set = (next: { enabled: boolean; trigger?: AutoSleepTrigger }) => {
    void save.save(() => setAuto.mutateAsync(next));
  };

  return (
    <SettingGroup title={t('settings.sleep.auto')} note={t('settings.sleep.auto_note')}>
      {auto?.consentStale && (
        <p className="settings-test-err" role="alert">
          ✗ {t('settings.sleep.auto_stale')}
        </p>
      )}

      <SettingRow
        title={t('settings.sleep.auto_toggle')}
        hint={t('settings.sleep.auto_toggle_hint')}
        more={t('settings.sleep.auto_more')}
        control={
          <Toggle
            checked={enabled}
            disabled={setAuto.isPending}
            onChange={(next) => set({ enabled: next, trigger })}
          />
        }
        status={<SaveMark state={save.state} />}
      />

      {enabled && (
        <SettingRow
          title={t('settings.sleep.auto_trigger')}
          hint={t('settings.sleep.auto_trigger_hint')}
          control={
            <select
              className="settings-text-input"
              aria-label={t('settings.sleep.auto_trigger')}
              value={trigger}
              onChange={(e) => set({ enabled: true, trigger: e.target.value as AutoSleepTrigger })}
            >
              <option value="must-sleep">{t('settings.sleep.trigger.must')}</option>
              <option value="sleepy">{t('settings.sleep.trigger.sleepy')}</option>
            </select>
          }
        />
      )}

      {job && (
        <div className={`sleep-job${live ? ' sleep-job--live' : ''}`}>
          <span className="sleep-job-text">
            {live
              ? t('settings.sleep.job_running').replace('{time}', new Date(job.startedAt).toLocaleTimeString())
              : t('settings.sleep.job_last').replace('{status}', job.status)}
          </span>
          {live && (
            <button
              type="button"
              className="settings-btn settings-btn--quiet"
              disabled={cancel.isPending}
              // The pid and start time are shown so the person confirming knows
              // exactly what they are stopping — the same bar the CLI holds.
              // `confirmAction`, never `window.confirm`: the latter is inert in
              // the desktop webview, so the button would silently do nothing.
              onClick={() => {
                void (async () => {
                  const ok = await confirmAction({
                    title: t('settings.sleep.job_cancel'),
                    body: t('settings.sleep.job_confirm')
                      .replace('{pid}', String(job.pid))
                      .replace('{time}', new Date(job.startedAt).toLocaleTimeString()),
                    confirmLabel: t('settings.sleep.job_cancel'),
                    destructive: true,
                  });
                  if (ok) cancel.mutate();
                })();
              }}
            >
              {t('settings.sleep.job_cancel')}
            </button>
          )}
          {job.summary && !live && <span className="dc-muted sleep-job-summary">{job.summary.slice(0, 200)}</span>}
          {job.error && <span className="settings-test-err sleep-job-summary">{job.error.slice(0, 200)}</span>}
        </div>
      )}
    </SettingGroup>
  );
}
