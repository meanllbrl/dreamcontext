import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../context/I18nContext';
import { startHandsfreeJob } from './handsfreeActions';
import { useHandsfree } from './handsfreeStore';
import { fill, InlineConfirm } from './HandsfreeParts';
import type { Conflict, FilesReceipt, Receipt, RepoReceipt } from './handsfreeTypes';

/**
 * What a Return brought back (AC7, AC8, AC20): repos with their outcome, branches and written /
 * deleted / conflicting / refused paths and parked refs; non-git files (secret-class NAMES only,
 * never contents); sessions; every changed auto-executing config file with its diff as PLAIN
 * TEXT (a <pre>, never markup); where the conflicts and the backups are; what the cloud
 * finalization did. Resume / Roll back when the status offers them.
 */
export function HandsfreeReceipt({ receipt, onClose }: { receipt: Receipt; onClose: () => void }) {
  const { t } = useI18n();
  const { status } = useHandsfree();
  const ref = useRef<HTMLDivElement>(null);
  const offers = status?.phase === 'returning' && status.tripId === receipt.tripId ? status.offers : [];

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Portalled to <body>: the chrome bar is its own stacking context, and the banner must sit
  // under this modal's backdrop, not over it.
  return createPortal(
    <div className="hf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="hf-sheet hf-sheet--wide" role="dialog" aria-modal="true" aria-labelledby="hf-receipt-title" tabIndex={-1} data-testid="hf-receipt">
        <header className="hf-sheet-head">
          <h2 id="hf-receipt-title">{t('handsfree.receipt.title')}</h2>
          <button type="button" className="hf-icon-btn" onClick={onClose} aria-label={t('handsfree.close')}>✕</button>
        </header>
        <div className="hf-sheet-body">
          <p className="hf-quiet">
            {fill(t('handsfree.receipt.meta'), { trip: receipt.tripId, date: new Date(receipt.createdAt).toLocaleString(), pass: receipt.pass })}
          </p>
          {(offers.includes('resume') || offers.includes('rollback')) && (
            <div className="hf-actions">
              {offers.includes('resume') && (
                <button type="button" className="hf-btn hf-btn--primary" onClick={() => void startHandsfreeJob('resume')}>{t('handsfree.resume')}</button>
              )}
              {offers.includes('rollback') && (
                <InlineConfirm label={t('handsfree.rollback')} confirmLabel={t('handsfree.rollback.confirm')} body={<p>{t('handsfree.rollback.body')}</p>} onConfirm={() => void startHandsfreeJob('rollback')} danger testId="hf-receipt-rollback" />
              )}
            </div>
          )}
          <ReceiptBody receipt={receipt} />
          {(receipt.previousPasses ?? []).map((p) => (
            <details key={p.pass} className="hf-details">
              <summary>{fill(t('handsfree.receipt.previousPass'), { pass: p.pass })}</summary>
              <ReceiptBody receipt={p} />
            </details>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ReceiptBody({ receipt }: { receipt: Receipt }) {
  const { t } = useI18n();
  const f = receipt.finalization;
  return (
    <>
      <Section title={t('handsfree.receipt.repos')} count={receipt.repos.length}>
        {receipt.repos.map((r) => <RepoBlock key={r.rootId} repo={r} />)}
      </Section>

      <Section title={t('handsfree.receipt.files')} count={receipt.files.length}>
        {receipt.files.map((f) => <FilesBlock key={f.rootId} files={f} deletedReason={receipt.deletedInCloudReason} />)}
      </Section>

      <Section title={t('handsfree.receipt.sessions')} count={receipt.sessions.length}>
        {receipt.sessions.map((s) => (
          <div key={s.rootId} className="hf-block">
            {s.roster && (
              <>
                <PathList label={t('handsfree.receipt.openedOnPhone')} items={s.roster.openedOnPhone} />
                <PathList label={t('handsfree.receipt.closedOnPhone')} items={s.roster.closedOnPhone} />
                {s.roster.updated > 0 && <p className="hf-quiet">{fill(t('handsfree.receipt.sessionsUpdated'), { n: s.roster.updated })}</p>}
              </>
            )}
            <p className="hf-quiet">{fill(t('handsfree.receipt.titles'), { n: s.titlesChanged, m: s.mapFilesWritten })}</p>
          </div>
        ))}
      </Section>

      <Section title={t('handsfree.receipt.autoExec')} count={receipt.autoExec.length} testId="hf-autoexec">
        <p className="hf-quiet">{t('handsfree.receipt.autoExecNote')}</p>
        {receipt.autoExec.map((a) => (
          <div key={`${a.rootId}:${a.path}`} className="hf-block">
            <code className="hf-mono">{a.path}</code>
            {/* Plain text, always: React escapes it, and nothing here is ever parsed as markup. */}
            <pre className="hf-diff" data-testid="hf-autoexec-diff">{a.diff}</pre>
          </div>
        ))}
      </Section>

      {receipt.links.some((l) => l.undone.length || l.escaping.length) && (
        <Section title={t('handsfree.receipt.links')} count={receipt.links.length}>
          {receipt.links.map((l) => (
            <div key={l.rootId} className="hf-block">
              <PathList label={t('handsfree.receipt.linksUndone')} items={l.undone} />
              <PathList label={t('handsfree.receipt.linksEscaping')} items={l.escaping} />
            </div>
          ))}
        </Section>
      )}

      {!!receipt.ignoredRoots?.length && (
        <Section title={t('handsfree.receipt.ignoredRoots')} count={receipt.ignoredRoots.length}>
          <ul className="hf-paths">{receipt.ignoredRoots.map((r) => <li key={r.rootId}><code className="hf-mono">{r.rootId}</code> <span className="hf-quiet">{r.reason}</span></li>)}</ul>
        </Section>
      )}

      <dl className="hf-facts">
        <dt>{t('handsfree.receipt.conflictsDir')}</dt><dd><code className="hf-mono">{receipt.conflictsDir}</code></dd>
        <dt>{t('handsfree.receipt.backupDir')}</dt><dd><code className="hf-mono">{receipt.backupDir}</code></dd>
        <dt>{t('handsfree.receipt.finalization')}</dt>
        <dd data-testid="hf-finalization">
          {[
            f.secretsWiped ? t('handsfree.receipt.secretsWiped') : t('handsfree.receipt.secretsNotWiped'),
            f.sealed ? t('handsfree.receipt.sealed') : t('handsfree.receipt.notSealed'),
            f.stopped ? t('handsfree.receipt.stopped') : t('handsfree.receipt.notStopped'),
          ].join(' · ')}
          {f.queued.length > 0 && <span className="hf-quiet"> · {fill(t('handsfree.receipt.queued'), { steps: f.queued.join(', ') })}</span>}
        </dd>
      </dl>
    </>
  );
}

function Section({ title, count, testId, children }: { title: string; count: number; testId?: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="hf-section" data-testid={testId}>
      <h3>{title} <span className="hf-count">{count}</span></h3>
      {count === 0 ? <p className="hf-quiet">{t('handsfree.receipt.none')}</p> : children}
    </section>
  );
}

function PathList({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="hf-pathlist">
      <span className="hf-pathlist-label">{label} <span className="hf-count">{items.length}</span></span>
      <ul className="hf-paths">{items.map((p) => <li key={p}><code className="hf-mono">{p}</code></li>)}</ul>
    </div>
  );
}

function ConflictList({ label, items }: { label: string; items: Conflict[] }) {
  if (!items.length) return null;
  return (
    <div className="hf-pathlist">
      <span className="hf-pathlist-label">{label} <span className="hf-count">{items.length}</span></span>
      <ul className="hf-paths">{items.map((c) => <li key={c.path}><code className="hf-mono">{c.path}</code> <span className="hf-quiet">{c.reason}</span></li>)}</ul>
    </div>
  );
}

function RepoBlock({ repo }: { repo: RepoReceipt }) {
  const { t } = useI18n();
  const parked = Object.entries(repo.parkedRefs ?? {});
  return (
    <div className="hf-block" data-outcome={repo.outcome}>
      <div className="hf-block-head">
        <code className="hf-mono">{repo.path}</code>
        <span className="hf-chip" data-tone={repo.outcome === 'applied' ? 'good' : 'warn'}>{t(`handsfree.receipt.outcome.${repo.outcome}`)}</span>
      </div>
      {repo.parkReasons.length > 0 && <ul className="hf-paths">{repo.parkReasons.map((r) => <li key={r} className="hf-quiet">{r}</li>)}</ul>}
      {repo.branches.length > 0 && (
        <ul className="hf-paths">
          {repo.branches.map((b) => (
            <li key={b.ref}><code className="hf-mono">{b.ref}</code> <span className="hf-quiet hf-mono">{(b.from ?? '∅').slice(0, 8)} → {(b.to ?? '∅').slice(0, 8)}</span></li>
          ))}
        </ul>
      )}
      <PathList label={t('handsfree.receipt.written')} items={repo.written} />
      <PathList label={t('handsfree.receipt.deleted')} items={repo.deleted} />
      <ConflictList label={t('handsfree.receipt.conflicts')} items={repo.conflicts} />
      <ConflictList label={t('handsfree.receipt.refused')} items={repo.refused} />
      <PathList label={t('handsfree.receipt.worktreesAdded')} items={repo.worktreesAdded ?? []} />
      <PathList label={t('handsfree.receipt.worktreesRemoved')} items={repo.worktreesRemoved ?? []} />
      {parked.length > 0 && (
        <div className="hf-pathlist">
          <span className="hf-pathlist-label">{t('handsfree.receipt.parked')} <span className="hf-count">{parked.length}</span></span>
          <ul className="hf-paths">{parked.map(([ref, oid]) => <li key={ref}><code className="hf-mono">{ref}</code> <span className="hf-quiet hf-mono">{oid.slice(0, 8)}</span></li>)}</ul>
        </div>
      )}
    </div>
  );
}

function FilesBlock({ files, deletedReason }: { files: FilesReceipt; deletedReason?: string }) {
  const { t } = useI18n();
  return (
    <div className="hf-block">
      <code className="hf-mono">{files.path}</code>
      <PathList label={t('handsfree.receipt.written')} items={files.written} />
      <ConflictList label={t('handsfree.receipt.conflicts')} items={files.conflicts} />
      <ConflictList label={t('handsfree.receipt.refused')} items={files.refused} />
      <PathList label={t('handsfree.receipt.deletedInCloud')} items={files.deletedInCloud} />
      {files.deletedInCloud.length > 0 && deletedReason && <p className="hf-quiet">{deletedReason}</p>}
      <PathList label={t('handsfree.receipt.secrets')} items={files.secrets} />
      <PathList label={t('handsfree.receipt.notReturned')} items={files.notReturned} />
      <PathList label={t('handsfree.receipt.transcriptCopies')} items={files.transcriptCopies ?? []} />
    </div>
  );
}
