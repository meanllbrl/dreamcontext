import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { isPhoneSurface } from '../../lib/phoneSurface';
import { useCloudRecallStatus, useDisableCloudRecall, type CloudTier } from '../../hooks/useCloudRecall';
import {
  useRecallOptions,
  type LanguageMix,
  type RecallMeasurement,
  type RecallMeasurements,
  type RecallOptionId,
  type RecallOptions,
} from '../../hooks/useRecallOptions';
import type { RecallMode } from '../../hooks/useSleep';
import { MaturityTag } from '../common/MaturityTag';
import { BrandMark } from '../brand/BrandMark';
import { SettingChoice } from './SettingRow';
import { EmbeddingModelCard } from './EmbeddingModelCard';
import { CloudRecallCard } from './CloudRecallCard';
import './RecallModeCards.css';

/**
 * Settings → Recall: every way of fetching memory back, side by side, with the same facts for each
 * (accuracy for English-only and multi-language brains as two bars, then extra time, cost and what
 * leaves this computer as chips), under a "dreamcontext Memory" card that names what runs now and
 * offers the advised engine as one button. The numbers are the server's (`GET /api/recall/options`); the words are i18n.
 *
 * Choosing keeps the existing mechanisms: `recall_mode` through the sleep settings, and the two cloud
 * tiers through the cloud-recall card (key, disclosure, consent, index) — which this reuses, not
 * reimplements. The default (Smart picker) does not change here.
 */

const MAIN_OPTIONS: readonly RecallOptionId[] = ['haiku', 'cloud', 'cloud-index', 'raw', 'off'];
const DEFAULT_MODE: RecallMode = 'haiku';

/** The two audiences the page speaks to. The held-out set's Turkish and mixed questions are one: multi-language. */
type Audience = 'english' | 'multi';
const AUDIENCES: readonly Audience[] = ['english', 'multi'];

/** When each option is the advice: the rule the recommendation follows, shown as a small table. */
const RULES: ReadonlyArray<{ id: string; option: RecallOptionId }> = [
  { id: 'english', option: 'raw' },
  { id: 'multi', option: 'cloud' },
  { id: 'multi-private', option: 'cloud-index' },
];

function isCloudTier(id: RecallOptionId): id is CloudTier {
  return id === 'cloud' || id === 'cloud-index';
}

/** The ids that are a `recall_mode` of their own (the rest ride on `hybrid`). */
function isPlainMode(id: RecallOptionId): id is 'haiku' | 'raw' | 'off' {
  return id === 'haiku' || id === 'raw' || id === 'off';
}

function numberLocale(locale: string): string {
  return locale === 'tr' ? 'tr-TR' : 'en-US';
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), template);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function audienceOf(mix: LanguageMix): Audience | null {
  if (mix === 'english') return 'english';
  if (mix === 'turkish' || mix === 'mixed') return 'multi';
  return null;
}

/** Accuracy for one audience: English as measured; multi-language = Turkish and mixed, weighted by their question counts. */
function accuracyFor(m: RecallMeasurement, audience: Audience, q: RecallMeasurements['queries']): number | null {
  const acc = m.accuracyR5Pct;
  if (!acc) return null;
  if (audience === 'english') return acc.en;
  const n = q.tr + q.mixed;
  return n > 0 ? (acc.tr * q.tr + acc.mixed * q.mixed) / n : (acc.tr + acc.mixed) / 2;
}

function AccuracyBars({ m, queries, mine }: { m: RecallMeasurement; queries: RecallMeasurements['queries']; mine: Audience | null }) {
  const { t, locale } = useI18n();
  if (m.accuracyR5Pct === null) return null;
  // Turkish writes the sign first (%52), English after (52%).
  const percent = new Intl.NumberFormat(numberLocale(locale), { style: 'percent', maximumFractionDigits: 0 });
  return (
    <span className="recall-bars">
      {AUDIENCES.map((a) => {
        const pct = Math.round(accuracyFor(m, a, queries) ?? 0);
        const label = t(`settings.recall.aud.${a}`);
        const shown = percent.format(pct / 100);
        // The bar that answers for this brain is drawn; the other one recedes.
        const dim = mine !== null && mine !== a;
        return (
          <span key={a} className={`recall-bar-row${dim ? ' recall-bar-row--dim' : ''}`}>
            <span className="recall-bar-label">{label}</span>
            <span className="recall-bar" role="meter" aria-label={`${label} ${shown}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span className="recall-bar-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="recall-bar-pct">{shown}</span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * This vault's own index: what building it would cost now (`null` = unknown, use the measured figure),
 * whether it is built, and whether the estimate is still on its way (then no figure at all: a stand-in
 * that flips to a very different number a second later is worse than a blank).
 */
interface VaultIndex { estUsd: number | null; built: boolean; loading: boolean }

/** Time, cost and what leaves, as three short chips. */
function Facts({ m, index }: { m: RecallMeasurement; index: VaultIndex }) {
  const { t, locale } = useI18n();
  const fmt = (ms: number): string => (ms / 1000).toLocaleString(numberLocale(locale), { maximumFractionDigits: 1 });
  const sec = t('settings.recall.m.sec');
  const { min, max } = m.overheadP90Ms;
  let latency: string;
  if (max === 0) latency = t('settings.recall.chip.no-delay');
  else if (min === max) latency = `+${fmt(max)} ${sec}`;
  else latency = `+${fmt(min)}–${fmt(max)} ${sec}`;

  const { per1000QueriesUsd } = m.cost;
  // The index cost is THIS vault's (its own chunk count); the measured figure is only the fallback.
  const indexOnceUsd = m.cost.indexOnceUsd > 0 && index.estUsd !== null ? index.estUsd : m.cost.indexOnceUsd;
  const indexBuilt = m.cost.indexOnceUsd > 0 && index.built;
  const indexPending = m.cost.indexOnceUsd > 0 && per1000QueriesUsd === 0 && index.loading;
  let cost = t('settings.recall.m.cost.free');
  if (per1000QueriesUsd > 0) cost = fill(t('settings.recall.chip.per1000'), { per1000: usd(per1000QueriesUsd) });
  else if (indexBuilt) cost = t('settings.recall.chip.index-built');
  else if (indexOnceUsd > 0) cost = fill(t('settings.recall.chip.once'), { index: usd(indexOnceUsd) });

  const costTitle = per1000QueriesUsd > 0 || indexOnceUsd > 0
    ? fill(t(per1000QueriesUsd > 0 ? 'settings.recall.m.cost.cloud' : 'settings.recall.m.cost.index'), { per1000: usd(per1000QueriesUsd), index: usd(indexOnceUsd) })
    : undefined;

  return (
    <span className="recall-facts">
      <span className="recall-fact" title={`${t('settings.recall.m.latency')}${m.overheadIsEstimate ? ` (${t('settings.recall.m.latency.estimate')})` : ''}`}>{latency}</span>
      {!indexPending && <span className="recall-fact" title={costTitle}>{cost}</span>}
      <span
        className={`recall-fact${m.egress === 'nothing' ? ' recall-fact--local' : ''}`}
        title={t(`settings.recall.m.egress.${m.egress}`)}
      >
        {t(`settings.recall.chip.egress.${m.egress}`)}
      </span>
    </span>
  );
}

/** Accuracy for this brain's audience, as the page writes it (Turkish puts the sign first). */
function usePercent(): (pct: number) => string {
  const { locale } = useI18n();
  const percent = new Intl.NumberFormat(numberLocale(locale), { style: 'percent', maximumFractionDigits: 0 });
  return (pct) => percent.format(Math.round(pct) / 100);
}

/** Why the advice is what it is: the two readings and the rule they hit. Folded away by default. */
function RecommendationWhy({ options }: { options: RecallOptions }) {
  const { t } = useI18n();
  const { recommendation: r } = options;
  const name = (id: RecallOptionId): string => t(`settings.recall.opt.${id}.label`);
  const mixLabel = (mix: LanguageMix): string => t(`settings.recall.mix.${audienceOf(mix) ?? 'unknown'}`);
  const known = r.reason !== 'no-language-signal';
  const keyLine = r.option === 'cloud' ? t(r.keyPresent ? 'settings.recall.rec.key_ready' : 'settings.recall.rec.key_needed') : '';

  return (
    <details className="memory-why">
      <summary>{t('settings.recall.hero.why')}</summary>
      <div className="memory-why-body">
        <div className="recall-rec-signals">
          <span className="recall-signal"><span className="recall-signal-k">{t('settings.recall.sig.prompts')}</span>{mixLabel(r.promptsMix)}</span>
          <span className="recall-signal"><span className="recall-signal-k">{t('settings.recall.sig.docs')}</span>{mixLabel(r.docsMix)}</span>
        </div>
        {known ? (
          <ul className="recall-rules">
            {RULES.map((rule) => (
              <li key={rule.id} className={`recall-rule${rule.option === r.option ? ' recall-rule--on' : ''}`}>
                <span className="recall-rule-when">{t(`settings.recall.rule.${rule.id}`)}</span>
                <span className="recall-rule-arrow" aria-hidden="true">→</span>
                <span className="recall-rule-then">{name(rule.option)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="recall-rec-text">{fill(t('settings.recall.rec.no-language-signal'), { option: name(r.option) })}</p>
        )}
        {(keyLine || r.note === 'light-machine') && (
          <p className="recall-rec-note">
            {[keyLine, r.note === 'light-machine' ? fill(t('settings.recall.rec.note.light-machine'), { option: name('cloud-index') }) : '']
              .filter(Boolean).join(' ')}
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * The top of the page: what is running now, how well it finds things for THIS brain, and — when a
 * better engine is advised — one button that switches to it (or opens its setup, for a cloud tier).
 */
function MemoryHero({ options, active, onUpgrade }: {
  options: RecallOptions | undefined;
  active: RecallOptionId | null;
  onUpgrade: (id: RecallOptionId) => void;
}) {
  const { t } = useI18n();
  const pct = usePercent();
  const name = (id: RecallOptionId): string => t(`settings.recall.opt.${id}.label`);
  const r = options?.recommendation;
  const audience = options ? audienceOf(options.recommendation.languageMix) : null;
  const accuracy = (id: RecallOptionId | null): number | null => {
    if (!options || !audience || !id) return null;
    const m = options.measurements.options.find((o) => o.id === id);
    return m ? accuracyFor(m, audience, options.measurements.queries) : null;
  };
  const nowAcc = accuracy(active);
  const recAcc = r ? accuracy(r.option) : null;
  const upgrade = r && active !== null && r.option !== active ? r.option : null;

  return (
    // It is also the section's head: one name, one sentence, as every Settings section has.
    <section className="memory-hero" aria-label={t('settings.nav.recall')}>
      <div className="memory-hero-head">
        <BrandMark size={36} glow />
        <div className="memory-hero-id">
          <h2 className="memory-hero-name">{t('settings.nav.recall')}</h2>
          <span className="memory-hero-tag">{t('settings.desc.recall')}</span>
        </div>
      </div>

      <div className="memory-hero-stats">
        <div className="memory-stat">
          <span className="memory-stat-k">{t('settings.recall.hero.now')}</span>
          <span className="memory-stat-v">{active ? name(active) : '…'}</span>
          {nowAcc !== null && (
            <span className="memory-stat-n">{pct(nowAcc)} <span className="memory-stat-u">{t('settings.recall.hero.accuracy')}</span></span>
          )}
        </div>
        {upgrade && (
          <>
            <span className="memory-hero-arrow" aria-hidden="true">→</span>
            <div className="memory-stat memory-stat--rec">
              <span className="memory-stat-k">{t('settings.recall.rec.title')}</span>
              <span className="memory-stat-v">{name(upgrade)}</span>
              {recAcc !== null && (
                <span className="memory-stat-n">{pct(recAcc)} <span className="memory-stat-u">{t('settings.recall.hero.accuracy')}</span></span>
              )}
            </div>
          </>
        )}
      </div>

      {upgrade ? (
        <button type="button" className="memory-hero-cta" onClick={() => onUpgrade(upgrade)}>
          {fill(t(isCloudTier(upgrade) ? 'settings.recall.hero.cta.setup' : 'settings.recall.hero.cta.switch'), { option: name(upgrade) })}
        </button>
      ) : r && active !== null ? (
        <p className="memory-hero-ok">✓ {t('settings.recall.hero.on-best')}</p>
      ) : null}

      {options && <RecommendationWhy options={options} />}
    </section>
  );
}

function Footnote({ options }: { options: RecallOptions }) {
  const { t, locale } = useI18n();
  const { queries, measuredOn } = options.measurements;
  const date = new Date(`${measuredOn}T00:00:00Z`).toLocaleDateString(numberLocale(locale), {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  return (
    <p className="recall-foot">
      {fill(t('settings.recall.m.foot'), { total: queries.total, en: queries.en, multi: queries.tr + queries.mixed, date })}
    </p>
  );
}

export interface RecallModeCardsProps {
  recallMode: RecallMode;
  /** True while a recall-mode change is being saved. */
  saving: boolean;
  onSelectMode: (mode: RecallMode) => void;
}

export function RecallModeCards({ recallMode, saving, onSelectMode }: RecallModeCardsProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const cloudSurface = isPhoneSurface();
  const { data: options, isError: optionsFailed } = useRecallOptions();
  const { data: cloud, isPending: cloudPending } = useCloudRecallStatus();
  const disable = useDisableCloudRecall();
  /** A cloud tier whose setup is open, before it has consent. Shown as the pick while it is open. */
  const [openTier, setOpenTier] = useState<CloudTier | null>(null);
  /** A pick that waits on a step before the mode is written (local hybrid turns cloud off first). */
  const [pendingPick, setPendingPick] = useState<RecallOptionId | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const cardRefs = useRef(new Map<RecallOptionId, HTMLDivElement>());
  const [scrollTo, setScrollTo] = useState<RecallOptionId | null>(null);

  const consentTier = cloud?.consent === 'valid' && cloud.tier !== 'local' ? cloud.tier : null;
  // Hybrid is the mode behind three cards: which one depends on the consent in force, so until the
  // cloud status is known there is no answer (guessing "local hybrid" flashes the wrong card).
  const active: RecallOptionId | null = recallMode === 'hybrid'
    ? (cloudPending ? null : (consentTier ?? 'hybrid'))
    : recallMode;
  // What the radio shows: an open setup, then a pick on its way, then what is in force.
  const shown: RecallOptionId | null = openTier ?? pendingPick ?? active;

  useEffect(() => {
    if (active === 'hybrid') setAdvancedOpen(true);
  }, [active]);

  useEffect(() => {
    if (!scrollTo) return;
    cardRefs.current.get(scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setScrollTo(null);
  }, [scrollTo]);

  const select = (id: RecallOptionId): void => {
    if (isCloudTier(id)) {
      if (consentTier === id) { setOpenTier(null); onSelectMode('hybrid'); } else setOpenTier(id);
      return;
    }
    setOpenTier(null);
    if (id === 'hybrid') {
      // Local hybrid means no cloud: turn a cloud tier off first, then pick the mode.
      if (consentTier) {
        setPendingPick('hybrid');
        disable.mutate(undefined, {
          onSuccess: () => onSelectMode('hybrid'),
          onSettled: () => setPendingPick(null),
        });
      } else onSelectMode('hybrid');
      return;
    }
    if (isPlainMode(id)) onSelectMode(id);
  };

  const upgrade = (id: RecallOptionId): void => {
    if (id === 'hybrid') setAdvancedOpen(true);
    select(id);
    setScrollTo(id);
  };

  const mine = options ? audienceOf(options.recommendation.languageMix) : null;
  const vaultIndex: VaultIndex = {
    estUsd: cloud?.plan ? cloud.plan.estUsd : null,
    built: Boolean(cloud?.indexReady) && (cloud?.plan?.toEmbed ?? 1) === 0,
    loading: cloudPending,
  };

  /** The server changed the mode itself; the open setup stays the pick until the fresh mode is read. */
  const refreshAfterCloud = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['recall-options'] });
    void queryClient.invalidateQueries({ queryKey: ['sleep'] }).finally(() => setOpenTier(null));
  };

  const card = (id: RecallOptionId): ReactNode => {
    const m = options?.measurements.options.find((o) => o.id === id);
    const recommended = options?.recommendation.option === id;
    const isShown = shown === id;
    // The card in force keeps a mark while another one is being looked at.
    const isActiveElsewhere = active === id && shown !== id;
    const savingThis = isShown && saving;
    const setup = isCloudTier(id) && isShown
      ? (
        <CloudRecallCard
          tier={id}
          onEnabled={refreshAfterCloud}
          onDisabled={() => { setOpenTier(null); onSelectMode(DEFAULT_MODE); }}
          onCancel={() => setOpenTier(null)}
        />
      )
      : id === 'hybrid' && isShown ? <EmbeddingModelCard /> : null;
    return (
      <div
        key={id}
        className="recall-card"
        ref={(el) => { if (el) cardRefs.current.set(id, el); else cardRefs.current.delete(id); }}
      >
        <SettingChoice
          name="recall-mode"
          value={id}
          checked={isShown}
          disabled={disable.isPending}
          onSelect={() => select(id)}
          title={t(`settings.recall.opt.${id}.label`)}
          hint={t(`settings.recall.opt.${id}.hint`)}
          badge={(
            <>
              {id === DEFAULT_MODE && <MaturityTag label={t('settings.recall.opt.default')} />}
              {id === 'hybrid' && <MaturityTag label={t('settings.recall.experimental')} />}
              {recommended && <span className="recall-badge">{t('settings.recall.rec.badge')}</span>}
              {isActiveElsewhere && <span className="recall-badge recall-badge--current">{t('settings.recall.current')}</span>}
              {savingThis && <span className="recall-saving">{t('settings.recall.saving')}</span>}
            </>
          )}
        >
          {m && options && (
            <span className="recall-option-body">
              <AccuracyBars m={m} queries={options.measurements.queries} mine={mine} />
              <Facts m={m} index={vaultIndex} />
            </span>
          )}
        </SettingChoice>
        {/* Outside the radio's label: a click inside a setup form must never re-pick the card. */}
        {setup && <div className="recall-setup">{setup}</div>}
      </div>
    );
  };

  // The cloud tiers cannot be set from the phone (the routes refuse it).
  const mainOptions = MAIN_OPTIONS.filter((id) => !(cloudSurface && isCloudTier(id)));
  const heroOptions = options && cloudSurface && isCloudTier(options.recommendation.option) ? undefined : options;

  return (
    <div className="recall-cards">
      <MemoryHero options={heroOptions} active={active} onUpgrade={upgrade} />
      {optionsFailed && <p className="settings-field-hint">{t('settings.recall.m.unavailable')}</p>}
      <div className="setting-choices" role="radiogroup" aria-label={t('settings.nav.recall')}>
        {mainOptions.map(card)}
      </div>
      <details className="recall-advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary>{t('settings.recall.advanced')}</summary>
        <div className="setting-choices">{card('hybrid')}</div>
      </details>
      {options && <Footnote options={options} />}
    </div>
  );
}
