import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { phoneAllows } from '../../lib/phoneSurface';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { createDeckSubmitter, type DeckSubmitter } from './sleepEvalSubmit';
import './SleepEvalDeck.css';

/**
 * The sleep-eval labelling deck. A banner on the Tasks board says how many cards wait; the
 * deck shows one card at a time and asks ONE question the score is built from: "what should
 * sleep have done with this?" — open a new task, put it into an existing task, or nothing
 * (with a reason). A repeated correction is a yes/no card: should it become a written rule?
 * Owner 2026-10-16: the first version asked whether a model's label was right ("is this a
 * detail of the task below?" under a bare slug); that taught nothing and read as noise.
 * Swipe right = the first answer, left = "nothing"; keys 1/2/3 and ←/→ do the same.
 */

type Category = 'opened' | 'explicit-ask' | 'sub-detail' | 'abandoned' | 'other-project' | 'style-correction';
type Outcome = 'new-task' | 'add-to-task' | 'nothing';

interface LabelCard {
  id: string;
  round: string;
  category: Category;
  name: string;
  why: string;
  quote: string;
  parent?: string | null;
  parentName?: string | null;
  slug?: string | null;
  source?: string | null;
}

interface Progress {
  total: number;
  labelled: number;
  required: { total: number; labelled: number };
}

interface LabelsResponse {
  active: boolean;
  total: number;
  labelled: number;
  required: { total: number; labelled: number };
  pending: LabelCard[];
  reasons: string[];
}

interface LabelInput {
  id: string;
  outcome?: Outcome;
  verdict?: 'keep' | 'reject';
  reason?: string | null;
  note?: string;
}

interface Answer {
  key: string;
  label: string;
  input: Omit<LabelInput, 'id' | 'reason' | 'note'>;
  /** Asks for a reason before it is saved. */
  needsReason?: boolean;
  tone: 'keep' | 'neutral' | 'reject';
}

const SWIPE_COMMIT_PX = 96;

export function useSleepEvalLabels() {
  const api = useApi();
  return useQuery({
    queryKey: ['sleep-eval-labels'],
    queryFn: () => api.get<LabelsResponse>('/sleep-eval/labels'),
    // The test set stays on the Mac (route-policy deny): the phone does not ask for it.
    enabled: phoneAllows('GET', '/api/sleep-eval/labels'),
    staleTime: 30_000,
  });
}

/** `r-20261014-2121` / `tilki-r-20261014-2121` → `14.10`. */
function roundDate(round: string): string {
  const m = round.match(/r-(\d{4})(\d{2})(\d{2})-/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : round;
}

/** The banner under the board toolbar; renders nothing when no card waits. */
export function SleepEvalBanner() {
  const { t } = useI18n();
  const { data } = useSleepEvalLabels();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (!data?.active || hidden) return null;
  const requiredLeft = data.required.total - data.required.labelled;
  const left = data.total - data.labelled;
  if (left <= 0 && !open) return null;
  return (
    <>
      <div className="se-banner" role="status">
        <span className="se-banner-dot" aria-hidden="true" />
        <span className="se-banner-title">{t('sleepEval.banner.title')}</span>
        <span className="se-banner-sub">
          {requiredLeft > 0
            ? t('sleepEval.banner.required').replace('{n}', String(requiredLeft))
            : t('sleepEval.banner.optional').replace('{n}', String(data.labelled - data.required.labelled))}
        </span>
        <div className="se-flex" />
        <button type="button" className="se-btn se-btn-primary" onClick={() => setOpen(true)}>{t('sleepEval.banner.open')}</button>
        <button type="button" className="se-icon-btn" aria-label={t('sleepEval.banner.hide')} title={t('sleepEval.banner.hide')} onClick={() => setHidden(true)}>✕</button>
      </div>
      {open && <SleepEvalDeck data={data} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The answers a card offers, in order. The first is "swipe right", the "nothing" one is "swipe left". */
function answersFor(card: LabelCard, t: (k: string) => string): Answer[] {
  if (card.category === 'style-correction') {
    return [
      { key: 'rule', label: t('sleepEval.a.rule'), input: { verdict: 'keep' }, tone: 'keep' },
      { key: 'once', label: t('sleepEval.a.once'), input: { verdict: 'reject' }, tone: 'reject' },
    ];
  }
  const into = card.parentName
    ? t('sleepEval.a.addTo').replace('{task}', card.parentName)
    : t('sleepEval.a.addToExisting');
  if (card.category === 'opened') {
    return [
      { key: 'right', label: t('sleepEval.a.openedRight'), input: { outcome: 'new-task' }, tone: 'keep' },
      { key: 'into', label: t('sleepEval.a.addToExisting'), input: { outcome: 'add-to-task' }, tone: 'neutral' },
      { key: 'nothing', label: t('sleepEval.a.openedNothing'), input: { outcome: 'nothing' }, needsReason: true, tone: 'reject' },
    ];
  }
  return [
    { key: 'new', label: t('sleepEval.a.newTask'), input: { outcome: 'new-task' }, tone: 'keep' },
    { key: 'into', label: into, input: { outcome: 'add-to-task' }, tone: 'neutral' },
    { key: 'nothing', label: t('sleepEval.a.nothing'), input: { outcome: 'nothing' }, needsReason: true, tone: 'reject' },
  ];
}

function SleepEvalDeck({ data, onClose }: { data: LabelsResponse; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  // The queue is fixed when the deck opens, so a refetch never reshuffles the card in hand.
  const [queue] = useState<LabelCard[]>(() => data.pending);
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState<Progress>({ total: data.total, labelled: data.labelled, required: data.required });
  const [rejecting, setRejecting] = useState<Answer | null>(null);
  const [note, setNote] = useState('');
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const drag = useRef<{ x: number; id: number } | null>(null);
  const card = queue[index];
  const answers = card ? answersFor(card, t) : [];

  const save = useMutation({
    mutationFn: (input: LabelInput) => api.post<Progress>('/sleep-eval/labels', input),
    onSuccess: (r) => {
      setProgress({ total: r.total, labelled: r.labelled, required: r.required });
      qc.invalidateQueries({ queryKey: ['sleep-eval-labels'] });
    },
  });

  // One answer per card: taken before the save, given back once the next card is on screen
  // (see sleepEvalSubmit.ts). React state is a render late; a held key or a fast second tap is not.
  const submitter = useRef<DeckSubmitter<LabelInput> | null>(null);
  const saveRef = useRef(save.mutateAsync);
  saveRef.current = save.mutateAsync;
  const tRef = useRef(t);
  tRef.current = t;

  if (!submitter.current) {
    submitter.current = createDeckSubmitter<LabelInput>({
      save: (input) => saveRef.current(input),
      leave: (dir) => setLeaving(dir),
      // The exit is over: this only QUEUES the next card. The gate stays shut until it commits.
      next: () => {
        setIndex((i) => i + 1);
        setLeaving(null);
        setDx(0);
        setRejecting(null);
        setNote('');
        setWhyOpen(false);
      },
      exitMs: 180,
      onError: (e) => {
        setDx(0);
        setError((e as Error).message || tRef.current('sleepEval.error'));
      },
    });
  }

  // The gate opens once the next card has COMMITTED. Opened in the exit timer, right after
  // setIndex, a tap landing before React rendered the next card answered the old one again
  // and advanced a second time, skipping a card unseen.
  const cardId = card?.id ?? null;
  useLayoutEffect(() => {
    submitter.current?.shown(cardId);
  }, [index, cardId]);

  const submit = useCallback((input: LabelInput, dir: 'left' | 'right') => {
    if (!submitter.current?.accepts(input.id)) return;
    setError(null);
    void submitter.current.submit(input, dir);
  }, []);

  const choose = useCallback((a: Answer | undefined) => {
    if (!card || !a || save.isPending || !submitter.current?.accepts(card.id)) return;
    if (a.needsReason) {
      setDx(0);
      setRejecting(a);
      return;
    }
    submit({ id: card.id, ...a.input }, a.tone === 'reject' ? 'left' : 'right');
  }, [card, save.isPending, submit]);

  const first = answers[0];
  const last = answers[answers.length - 1];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (rejecting) setRejecting(null); else onClose(); return; }
      // A held key repeats: one press is one answer.
      if (e.repeat || rejecting || (e.target instanceof HTMLElement && e.target.closest('textarea, input'))) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); choose(first); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); choose(last); }
      const n = Number(e.key);
      if (n >= 1 && n <= answers.length) { e.preventDefault(); choose(answers[n - 1]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choose, first, last, answers, rejecting, onClose]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (rejecting || leaving || save.isPending || submitter.current?.busy || (e.target as HTMLElement).closest('button, textarea')) return;
    drag.current = { x: e.clientX, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!leaving && drag.current?.id === e.pointerId) setDx(e.clientX - drag.current.x);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (leaving) return;
    if (dx > SWIPE_COMMIT_PX) choose(first);
    else if (dx < -SWIPE_COMMIT_PX) choose(last);
    else setDx(0);
  };

  const requiredDone = progress.required.labelled >= progress.required.total;
  const extra = progress.labelled - progress.required.labelled;
  const offset = leaving === 'right' ? 480 : leaving === 'left' ? -480 : dx;
  const hint = dx > 24 ? 'keep' : dx < -24 ? 'reject' : null;
  const isOpened = card?.category === 'opened';
  const isRule = card?.category === 'style-correction';

  return (
    <div className="se-overlay" role="dialog" aria-modal="true" aria-label={t('sleepEval.deck.title')} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="se-deck">
        <div className="se-deck-head">
          <div>
            <div className="se-deck-title">{t('sleepEval.deck.title')}</div>
            <div className="se-deck-sub">{t('sleepEval.deck.sub')}</div>
          </div>
          <button type="button" className="se-icon-btn" aria-label={t('sleepEval.deck.close')} onClick={onClose}>✕</button>
        </div>
        {requiredDone ? (
          <div className="se-optional">
            <div className="se-optional-title">{t('sleepEval.deck.requiredDone')}</div>
            <div className="se-optional-sub">{t('sleepEval.deck.optionalCount').replace('{n}', String(extra))}</div>
            <button type="button" className="se-btn" onClick={onClose}>{t('sleepEval.deck.stopHere')}</button>
          </div>
        ) : (
          <>
            <div className="se-progress" aria-label={`${progress.required.labelled} / ${progress.required.total}`}>
              <div className="se-progress-fill" style={{ width: `${progress.required.total > 0 ? Math.round((progress.required.labelled / progress.required.total) * 100) : 0}%` }} />
            </div>
            <div className="se-progress-text">
              {t('sleepEval.deck.requiredCount').replace('{n}', String(progress.required.labelled)).replace('{total}', String(progress.required.total))}
            </div>
          </>
        )}

        {card ? (
          <>
            <div
              className={`se-card${leaving ? ' se-card-leaving' : ''}${dx === 0 && !leaving ? ' se-card-rest' : ''}`}
              // While the answered card slides out, it takes no input at all.
              style={{ transform: `translateX(${offset}px) rotate(${offset / 24}deg)`, pointerEvents: leaving ? 'none' : undefined }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => { drag.current = null; setDx(0); }}
            >
              {hint && <span className={`se-stamp se-stamp-${hint}`}>{hint === 'keep' ? first?.label : last?.label}</span>}
              <div className="se-card-meta">
                <span className={`se-chip se-chip-${isOpened ? 'opened' : isRule ? 'style-correction' : 'explicit-ask'}`}>
                  {isOpened ? t('sleepEval.head.opened') : isRule ? t('sleepEval.head.rule') : t('sleepEval.head.message')}
                </span>
                <span className="se-card-round">{card.source ? `${card.source} · ` : ''}{roundDate(card.round)}</span>
              </div>

              {isOpened ? (
                <>
                  <div className="se-card-name">{card.name}</div>
                  {card.why && (
                    <>
                      <p className={`se-card-why${whyOpen ? '' : ' se-card-why-clamped'}`}>{card.why}</p>
                      {card.why.length > 240 && (
                        <button type="button" className="se-link" onClick={() => setWhyOpen((v) => !v)}>
                          {whyOpen ? t('sleepEval.deck.less') : t('sleepEval.deck.more')}
                        </button>
                      )}
                    </>
                  )}
                </>
              ) : (
                <>
                  {card.quote ? (
                    <blockquote className="se-card-quote se-card-quote-lead">“{card.quote}”</blockquote>
                  ) : (
                    <div className="se-card-name">{card.name}</div>
                  )}
                  {card.quote && (
                    <div className="se-card-reading">
                      <span className="se-card-reading-label">{isRule ? t('sleepEval.deck.ruleReading') : t('sleepEval.deck.reading')}</span>
                      <span className="se-card-reading-text">{card.name}</span>
                    </div>
                  )}
                </>
              )}

              <div className="se-question">
                {isOpened ? t('sleepEval.q.opened') : isRule ? t('sleepEval.q.rule') : t('sleepEval.q.message')}
              </div>

              {rejecting ? (
                <div className="se-reasons">
                  <div className="se-reasons-title">{t('sleepEval.deck.why')}</div>
                  <div className="se-reason-row">
                    {data.reasons.filter((r) => r !== 'badly-written' || isOpened).map((r) => (
                      <button
                        key={r}
                        type="button"
                        className="se-reason"
                        disabled={save.isPending || !!leaving}
                        onClick={() => card && submit({ id: card.id, ...rejecting.input, reason: r, note: note.trim() || undefined }, 'left')}
                      >
                        {t(`sleepEval.reason.${r}`)}
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="se-note"
                    rows={2}
                    placeholder={t('sleepEval.deck.note')}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <button type="button" className="se-link" onClick={() => setRejecting(null)}>{t('sleepEval.deck.back')}</button>
                </div>
              ) : (
                <div className="se-answers">
                  {answers.map((a, i) => (
                    <button
                      key={a.key}
                      type="button"
                      className={`se-answer se-answer-${a.tone}`}
                      disabled={save.isPending || !!leaving}
                      onClick={() => choose(a)}
                    >
                      <span className="se-answer-key" aria-hidden="true">{i + 1}</span>
                      <span className="se-answer-label">{a.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {error && <div className="se-error" role="alert">{error}</div>}
          </>
        ) : (
          <div className="se-done">
            <div className="se-done-check" aria-hidden="true">✓</div>
            <div className="se-done-title">{t('sleepEval.done.title')}</div>
            <p className="se-done-sub">{t('sleepEval.done.sub')}</p>
            <button type="button" className="se-btn se-btn-primary" onClick={onClose}>{t('sleepEval.deck.close')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
