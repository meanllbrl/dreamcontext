import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { startTitleBarDrag } from '../../lib/desktop';
import { routeAppLink } from '../../lib/appLink';
import { normalizeNotifications, relativeTime, type InboxNotification } from './inboxModel';
import './ViewerWindow.css';

const INBOX_LIMIT = 50;
const INBOX_POLL_MS = 15_000;

async function fetchNotifications(): Promise<InboxNotification[]> {
  const res = await fetch(`/api/notifications?limit=${INBOX_LIMIT}`);
  if (!res.ok) throw new Error(`GET /api/notifications answered ${res.status}`);
  return normalizeNotifications(await res.json());
}

/**
 * The small Notifications window (`?inbox=1`): where a banner with no in-app place of its own
 * lands (`dreamcontext://inbox`), listing the recent banners newest first. A row that carried a
 * link routes exactly as its banner would have — the same router, so it reaches the window that
 * already holds the project rather than a new one. A row without a link just opens up to show
 * all of its text.
 */
export function InboxWindow() {
  const { t } = useI18n();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['notifications', INBOX_LIMIT],
    queryFn: fetchNotifications,
    refetchInterval: INBOX_POLL_MS,
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    document.title = t('inbox.title');
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, [t]);

  const openRow = (row: InboxNotification) => {
    if (!row.link) {
      setExpanded((cur) => (cur === row.id ? null : row.id));
      return;
    }
    void routeAppLink(row.link).then((route) => {
      // A link this build cannot read (a newer writer, a hand-made one) still shows its words.
      if (route.to === 'dropped') setExpanded(row.id);
    }).catch((err: unknown) => {
      console.warn('[inbox] could not open', row.link, err);
      setExpanded(row.id);
    });
  };

  const rows = data ?? [];
  return (
    <div className="inbox-window">
      <div className="viewer-bar" onMouseDown={startTitleBarDrag}>
        <div className="viewer-bar-inset" aria-hidden="true" />
        <span className="viewer-bar-title">{t('inbox.title')}</span>
        <button type="button" className="inbox-refresh" onClick={() => void refetch()} disabled={isFetching}>
          {t('inbox.refresh')}
        </button>
      </div>
      <div className="inbox-list">
        {isLoading && <p className="viewer-status">{t('viewer.loading')}</p>}
        {error && <p className="viewer-status viewer-status--error">{t('inbox.failed')}</p>}
        {!isLoading && !error && rows.length === 0 && <p className="viewer-status">{t('inbox.empty')}</p>}
        {rows.map((row) => (
          <button
            type="button"
            key={row.id}
            className="inbox-row"
            aria-expanded={expanded === row.id}
            title={row.link ? t('inbox.open') : undefined}
            onClick={() => openRow(row)}
          >
            <span className="inbox-row-head">
              <span className="inbox-row-title">{row.title}</span>
              <span className="inbox-row-time">{relativeTime(row.at, now)}</span>
            </span>
            {row.body && <span className="inbox-row-body">{row.body}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
