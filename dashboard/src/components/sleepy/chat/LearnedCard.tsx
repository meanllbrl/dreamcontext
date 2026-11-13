import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { useI18n } from '../../../context/I18nContext';
import { RequestError } from '../../../api/client';
import { phoneAllows } from '../../../lib/phoneSurface';
import { CardHeader } from './molecules';
import type { LearnedViewSpec } from '../../../lib/chatViewSpec';
import type { ChatSession } from '../chatSession';

/** MIRROR of `LearnedCardFacts` (src/server/routes/learned.ts): the dashboard bundle cannot import
 *  the server. `learned-routes.test.ts` pins the key set. */
export interface LearnedCardFacts {
  id: string;
  scope: 'me' | 'project';
  status: 'active' | 'proposed' | 'superseded' | 'undone' | 'invalid';
  headline: string;
  text: string;
  quote: { text: string; at: string } | null;
  replaced: string | null;
  restored: string | null;
  by: string;
  hot: boolean;
}

type Tap = 'undo' | 'keep' | 'drop';
type Phase = 'idle' | 'busy' | 'failed' | 'refused';

/** One glyph per state: a check only where the rule is in force. */
const GLYPH: Record<LearnedCardFacts['status'], string> = { active: '✓', proposed: '?', undone: '↺', superseded: '⇄', invalid: '!' };

const SLOT = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

/** The line the agent reads after his tap (English, like every receipt a card posts). */
export function tapReport(f: LearnedCardFacts, tap: Tap): string {
  if (tap === 'undo') return `[learned rule undone · ${f.id}] The owner undid "${f.headline}" on its card.${f.restored ? ` The rule it replaced is back: "${f.restored}".` : ''} Do not learn it again from the same words.`;
  if (tap === 'keep') return `[learned rule kept · ${f.id}] The owner kept "${f.headline}" on its card: it is in force now.`;
  return `[learned rule dropped · ${f.id}] The owner dropped "${f.headline}" on its card: it is not in force.`;
}

/**
 * ORGANISM — the `dream-view` LEARNED card: the receipt of a rule `dreamcontext learn` stored
 * (learning loop C9). DERIVED, NEVER AUTHORED: the block names an id, and every line here comes
 * from `GET /api/learned/:id`, read from the rules store. One action row: Undo ("Geri al") for an
 * active rule, Keep and Drop for one that waits for his word. His page only: an agent's call is
 * refused by the route.
 */
export function LearnedCard({ spec, session, report }: {
  spec: LearnedViewSpec;
  session?: ChatSession;
  report?: (text: string) => void;
}) {
  const api = useApi();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const key = ['learned', spec.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ card: LearnedCardFacts }>(`/learned/${encodeURIComponent(spec.id)}`),
    retry: false,
  });
  const [phase, setPhase] = useState<Phase>('idle');

  const tap = useCallback(async (op: Tap) => {
    if (phase === 'busy' || !q.data) return;
    setPhase('busy');
    try {
      const res = await api.post<{ card: LearnedCardFacts }>(`/learned/${encodeURIComponent(spec.id)}/${op}`, { sessionId: session?.claudeId });
      queryClient.setQueryData(key, res);
      setPhase('idle');
      report?.(tapReport(res.card, op));
    } catch (err) {
      setPhase(err instanceof RequestError && err.code === 'owner_page_only' ? 'refused' : 'failed');
      // The rule may have moved under the card (undone in another window): show its real state,
      // and drop the "try again" line once there is nothing left to retry.
      const before = q.data.card.status;
      await queryClient.invalidateQueries({ queryKey: key });
      const now = queryClient.getQueryData<{ card: LearnedCardFacts }>(key)?.card.status;
      if (now && now !== before) setPhase('idle');
    }
    // `key` is rebuilt every render from the id; the id is what it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, phase, q.data, queryClient, report, session, spec.id]);

  if (q.isLoading) {
    return <div className="chat-viewcard chat-learnedcard" data-view-kind="learned"><CardHeader glyph="✓" title={t('chat.learned.loading')} /></div>;
  }
  if (!q.data) {
    const gone = q.error instanceof RequestError && q.error.status === 404;
    return (
      <div className="chat-viewcard chat-learnedcard" data-view-kind="learned" data-state="missing">
        <CardHeader glyph="✓" title={t('chat.learned.title')} />
        <p className="chat-learnedcard-note">{t(gone ? 'chat.learned.gone' : 'chat.learned.unreadable')}</p>
      </div>
    );
  }

  const f = q.data.card;
  // Keep and Drop are laptop-only routes: on the phone they are never drawn, the card says where.
  const decideHere = phoneAllows('POST', `/api/learned/${encodeURIComponent(f.id)}/keep`);
  const when = f.quote ? new Date(f.quote.at) : null;
  const date = when && !Number.isNaN(when.getTime())
    ? when.toLocaleDateString(locale === 'tr' ? 'tr-TR' : undefined, { day: 'numeric', month: 'short' })
    : '';
  return (
    <div className="chat-viewcard chat-learnedcard" data-view-kind="learned" data-state={f.status}>
      <CardHeader
        glyph={GLYPH[f.status] ?? '✓'}
        title={f.headline || t('chat.learned.title')}
        aside={<span className="chat-learnedcard-state" data-state={f.status}>{t(`chat.learned.state.${f.status}`)}</span>}
      />
      <p className="chat-learnedcard-scope">{t(f.scope === 'me' ? 'chat.learned.scope.me' : 'chat.learned.scope.project')}</p>
      {f.quote && (
        <blockquote className="chat-learnedcard-quote">
          <span>“{f.quote.text}”</span>
          {date && <span className="chat-learnedcard-date">{date}</span>}
        </blockquote>
      )}
      {f.replaced && <p className="chat-learnedcard-note">{SLOT(t('chat.learned.replaced'), { old: f.replaced })}</p>}
      {f.restored && <p className="chat-learnedcard-note">{SLOT(t('chat.learned.restored'), { old: f.restored })}</p>}
      {phase === 'refused' && <p className="chat-learnedcard-error">{t('chat.learned.refused')}</p>}
      {phase === 'failed' && <p className="chat-learnedcard-error">{t('chat.learned.failed')}</p>}
      {(f.status === 'active' || f.status === 'proposed') && (
        <div className="chat-learnedcard-foot">
          {f.status === 'active' && (
            <button type="button" className="chat-btn pill" disabled={phase === 'busy'} onClick={() => { void tap('undo'); }}>
              {t('chat.learned.undo')}
            </button>
          )}
          {f.status === 'proposed' && !decideHere && (
            <span className="chat-learnedcard-note">{t('chat.learned.onMac')}</span>
          )}
          {f.status === 'proposed' && decideHere && (
            <>
              <button type="button" className="chat-btn pill" disabled={phase === 'busy'} onClick={() => { void tap('drop'); }}>
                {t('chat.learned.drop')}
              </button>
              <button type="button" className="chat-btn pill primary" disabled={phase === 'busy'} onClick={() => { void tap('keep'); }}>
                {t('chat.learned.keep')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
