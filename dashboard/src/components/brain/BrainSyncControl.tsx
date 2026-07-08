import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { GitHubMark } from './GitHubLogin';
import {
  useBrainStatus,
  useRunBrainSync,
  useAddScrubIgnore,
  type BrainSyncResult,
  type SyncFailure,
  type ScrubBlock,
} from '../../hooks/useBrainStatus';
import { useAgentCapabilities, isSleepAgentReady } from '../../hooks/useAgentCapabilities';
import { readAgentSettings } from '../../lib/agentSettings';
import { requestBrainResolveAgent, DREAM_SYNC_COMMAND } from '../../lib/brainResolveAgent';
import { readAutoCheckpointOnOpen } from '../../lib/brainSyncPrefs';
import './BrainSyncControl.css';

/**
 * The connected brain cloud-sync control (github-cloud-collaboration-brain-repo-sync
 * hardening). Owns the sync row + every failure/handoff surface: the one-click
 * "Resolve with AI" launch (item 1), specific network/auth/permission recovery
 * (items 5 & 8), the scrub-block gitignore panel (item 6), auto-checkpoint transparency
 * (item 7), the full-repo code-conflict banner (item 4 UI), and the user's-own-merge
 * notice (item 3 UI). Mounted only when GitHub is connected AND a remote is configured.
 */

const SYNC_FEEDBACK_MS = 4000;
const COPIED_MS = 1600;

interface SyncFeedback { kind: 'ok' | 'warn'; message: string }

function RefreshIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.7 2.2v2.9h-2.9" />
    </svg>
  );
}

function GearIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" strokeLinecap="round" />
    </svg>
  );
}

interface BrainSyncControlProps {
  /** Open Settings → Brain (gear, reconnect, "check permissions"). */
  onOpenSettings: () => void;
}

export function BrainSyncControl({ onOpenSettings }: BrainSyncControlProps) {
  const { t } = useI18n();
  const { data: brainStatus } = useBrainStatus();
  const { data: caps } = useAgentCapabilities();
  const runSync = useRunBrainSync();
  const addIgnore = useAddScrubIgnore();

  // The in-app agent can drive `/dream-sync` only in the desktop app with the agent
  // prerequisites met AND the agent surface enabled. Otherwise we fall back to a copyable command.
  const canRunAgent = isSleepAgentReady(caps) && readAgentSettings().enabled;

  const mergeKind = brainStatus?.mergeKind ?? null;
  const codeConflicts = brainStatus?.codeConflicts ?? [];

  // Transient UI from the last sync result — persists until the next sync run.
  const [feedback, setFeedback] = useState<SyncFeedback | null>(null);
  const [failure, setFailure] = useState<SyncFailure | null>(null);
  const [scrubBlocks, setScrubBlocks] = useState<ScrubBlock[]>([]);
  // A blocked outcome with no panel of its own (detached HEAD, or a non-token
  // no-remote) — held so the resting label reflects it instead of decaying to "synced".
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  const [checkpointSha, setCheckpointSha] = useState<string | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const feedbackTimer = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const autoSyncedRef = useRef(false);
  useEffect(() => () => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  const showFeedback = (fb: SyncFeedback) => {
    setFeedback(fb);
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), SYNC_FEEDBACK_MS);
  };

  const runSyncWithFeedback = (mode: 'auto' | 'pull-only', opts: { silentNoop?: boolean; noCheckpoint?: boolean } = {}) => {
    if (runSync.isPending) return;
    // A fresh run supersedes any stale failure/scrub panel.
    setFeedback(null);
    setFailure(null);
    setScrubBlocks([]);
    setBlockedNote(null);
    setCheckpointSha(null);
    runSync.mutate({ mode, noCheckpoint: opts.noCheckpoint }, {
      onSettled: (result?: BrainSyncResult, error?: unknown) => {
        if (error || !result) { showFeedback({ kind: 'warn', message: t('brain.sidebar.refreshFailed') }); return; }
        if (result.checkpointed && result.checkpointSha) setCheckpointSha(result.checkpointSha);
        switch (result.action) {
          case 'error':
            setFailure(result.failure ?? { kind: 'unknown', recovery: 'retry', message: result.note ?? t('brain.sidebar.refreshFailed') });
            showFeedback({ kind: 'warn', message: t('brain.sync.failed') });
            break;
          case 'no-remote':
            if (result.failure) setFailure(result.failure);
            else setBlockedNote(result.note ?? t('brain.sidebar.refreshFailed'));
            showFeedback({ kind: 'warn', message: result.note ?? t('brain.sidebar.refreshFailed') });
            break;
          case 'blocked-scrub':
            setScrubBlocks(result.scrub?.blocks ?? []);
            showFeedback({ kind: 'warn', message: t('brain.sidebar.refreshBlocked') });
            break;
          case 'awaiting-agent':
          case 'already-awaiting-agent':
            showFeedback({ kind: 'warn', message: t('brain.sidebar.refreshAwaitingAgent') });
            break;
          case 'code-conflict':
            showFeedback({ kind: 'warn', message: t('brain.sync.codeConflictShort') });
            break;
          case 'user-merge-in-progress':
            showFeedback({ kind: 'warn', message: t('brain.sync.userMergeShort') });
            break;
          case 'detached-head':
            setBlockedNote(t('brain.sync.detachedShort'));
            showFeedback({ kind: 'warn', message: t('brain.sync.detachedShort') });
            break;
          case 'pulled':
            showFeedback({ kind: 'ok', message: t('brain.sidebar.refreshPulled').replace('{n}', String(result.pulledUpdates ?? 0)) });
            break;
          case 'pushed':
            showFeedback({ kind: 'ok', message: t('brain.sidebar.refreshPushed') });
            break;
          case 'noop':
            if (!opts.silentNoop) showFeedback({ kind: 'ok', message: t('brain.sidebar.refreshUpToDate') });
            break;
          default:
            showFeedback({ kind: 'warn', message: result.note ?? t('brain.sidebar.refreshFailed') });
        }
      },
    });
  };

  // Auto pull+merge ONCE on mount (dashboard open). Never pushes; a dirty tree is
  // auto-checkpointed first UNLESS the user disabled auto-checkpoint-on-open, in
  // which case a dirty tree is left untouched (noCheckpoint). Silent on noop.
  useEffect(() => {
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    runSyncWithFeedback('pull-only', { silentNoop: true, noCheckpoint: !readAutoCheckpointOnOpen() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleResolveClick = () => {
    if (canRunAgent) {
      requestBrainResolveAgent();
      showFeedback({ kind: 'ok', message: t('brain.resolve.launching') });
      setFallbackOpen(false);
    } else {
      // No in-app agent surface (plain browser dashboard) — reveal the exact command.
      setFallbackOpen((v) => !v);
    }
  };

  const copyCommand = () => {
    try {
      void navigator.clipboard?.writeText(DREAM_SYNC_COMMAND);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch { /* clipboard blocked */ }
  };

  const recoveryAction = (f: SyncFailure) => {
    switch (f.recovery) {
      case 'reconnect-github': return { label: t('brain.recovery.reconnect'), onClick: onOpenSettings };
      case 'check-permissions': return { label: t('brain.recovery.checkPerms'), onClick: onOpenSettings };
      case 'retry': return { label: t('brain.recovery.retry'), onClick: () => runSyncWithFeedback('auto') };
      case 'manual': return { label: t('brain.recovery.openSettings'), onClick: onOpenSettings };
      case 'wait-online': return null; // passive — retries on next sync/open
      default: return { label: t('brain.recovery.retry'), onClick: () => runSyncWithFeedback('auto') };
    }
  };

  // The resting label must reflect the last known sync state. Any persistent, unresolved
  // condition — a classified failure, a scrub block, a merge awaiting resolution, or a
  // panel-less block (detached HEAD / non-token no-remote) — means the sync did NOT succeed,
  // so the row must never decay back to the cheerful "Project synced" once the transient
  // feedback clears (that decay is what left an "expired sign-in" banner sitting above a
  // green "Project synced" footer). Mirror the active panel's short label where there is one.
  const blockedLabel: string | null =
    failure ? t('brain.sidebar.refreshFailed')
    : scrubBlocks.length > 0 ? t('brain.sidebar.refreshBlocked')
    : mergeKind === 'code' ? t('brain.sync.codeConflictShort')
    : mergeKind === 'user' ? t('brain.sync.userMergeShort')
    : mergeKind === 'agent' ? t('brain.sidebar.refreshAwaitingAgent')
    : blockedNote;

  const mainSyncLabel = feedback?.message
    ?? (runSync.isPending ? t('brain.sidebar.syncing') : (blockedLabel ?? t('brain.sidebar.syncedProject')));
  const labelKind: SyncFeedback['kind'] | null = feedback?.kind ?? (blockedLabel ? 'warn' : null);
  const recovery = failure ? recoveryAction(failure) : null;

  return (
    <div className="sidebar-brain-sync sidebar-brain-sync--connected">
      {/* ── item 1: teammate prose overlap → one-click Resolve with AI ── */}
      {mergeKind === 'agent' && (
        <button className="sidebar-sync-resolve" onClick={handleResolveClick} title={t('brain.sidebar.resolveTip')}>
          <span className="sidebar-sync-resolve-icon" aria-hidden="true">⚠</span>
          <span className="sidebar-sync-resolve-label">{t('brain.sidebar.resolveLabel')}</span>
          <span className="sidebar-sync-resolve-cta" aria-hidden="true">▸</span>
        </button>
      )}

      {/* Browser fallback (no agent surface): the exact command + copy. */}
      {mergeKind === 'agent' && fallbackOpen && (
        <div className="brain-sync-panel brain-sync-panel--info">
          <p className="brain-sync-panel-title">{t('brain.resolve.fallbackTitle')}</p>
          <code className="brain-sync-cmd">{DREAM_SYNC_COMMAND}</code>
          <button className="brain-sync-panel-btn" onClick={copyCommand}>
            {copied ? t('brain.resolve.copied') : t('brain.resolve.copy')}
          </button>
        </div>
      )}

      {/* ── item 4 UI: full-repo code conflict → the human's editor ── */}
      {mergeKind === 'code' && (
        <div className="brain-sync-panel brain-sync-panel--warn">
          <p className="brain-sync-panel-title">{t('brain.code.title')}</p>
          {codeConflicts.length > 0 && (
            <ul className="brain-sync-files">
              {codeConflicts.slice(0, 4).map((f) => <li key={f}><code>{f}</code></li>)}
              {codeConflicts.length > 4 && <li>{t('brain.code.more').replace('{n}', String(codeConflicts.length - 4))}</li>}
            </ul>
          )}
          <p className="brain-sync-panel-hint">{t('brain.code.hint')}</p>
          <button className="brain-sync-panel-btn" onClick={() => runSyncWithFeedback('auto')}>{t('brain.recovery.retry')}</button>
        </div>
      )}

      {/* ── item 3 UI: the user's OWN in-progress git merge ── */}
      {mergeKind === 'user' && (
        <div className="brain-sync-panel brain-sync-panel--warn">
          <p className="brain-sync-panel-title">{t('brain.userMerge.title')}</p>
          <p className="brain-sync-panel-hint">{t('brain.userMerge.hint')}</p>
        </div>
      )}

      {/* ── items 5 & 8: a classified failure with a concrete recovery ── */}
      {failure && (
        <div className={`brain-sync-panel brain-sync-panel--${failure.kind === 'network' ? 'info' : 'error'}`}>
          <p className="brain-sync-panel-title">{failure.message}</p>
          {failure.kind === 'auth' && (
            <span className="brain-sync-panel-mark" aria-hidden="true"><GitHubMark size={13} /></span>
          )}
          {recovery && (
            <button className="brain-sync-panel-btn" onClick={recovery.onClick}>{recovery.label}</button>
          )}
        </div>
      )}

      {/* ── item 6: scrub-block guidance + one-click add-to-.gitignore ── */}
      {scrubBlocks.length > 0 && (
        <div className="brain-sync-panel brain-sync-panel--error">
          <p className="brain-sync-panel-title">{t('brain.scrub.title')}</p>
          <ul className="brain-sync-files">
            {scrubBlocks.slice(0, 4).map((b, i) => (
              <li key={`${b.file}:${b.line}:${i}`}>
                <code>{b.file}:{b.line}</code> <span className="brain-sync-rule">{b.rule}</span>
                {isSafeToGitignoreClient(b.file) && (
                  <button
                    className="brain-sync-inline-btn"
                    disabled={addIgnore.isPending}
                    onClick={() => addIgnore.mutate(b.file, { onSuccess: () => runSyncWithFeedback('auto') })}
                  >
                    {t('brain.scrub.ignore')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="brain-sync-panel-hint">{t('brain.scrub.hint')}</p>
        </div>
      )}

      {/* ── item 7: auto-checkpoint transparency (identifiable + undoable) ── */}
      {checkpointSha && (
        <div className="brain-sync-note" title={t('brain.checkpoint.undo').replace('{sha}', checkpointSha.slice(0, 7))}>
          <span aria-hidden="true">✓</span> {t('brain.checkpoint.note')}
        </div>
      )}

      {/* The sync row — the big button SYNCS; the gear opens Settings. */}
      <div className="sidebar-brain-sync-row">
        <button
          className={`sidebar-item sidebar-item--synced${runSync.isPending ? ' sidebar-item--syncing' : ''}`}
          onClick={() => runSyncWithFeedback('auto')}
          disabled={runSync.isPending}
          title={t('brain.sidebar.syncNowTip')}
        >
          <span className={`sidebar-icon${runSync.isPending ? ' sidebar-icon--spin' : ''}`}>
            {runSync.isPending ? <RefreshIcon size={14} /> : <GitHubMark size={14} />}
          </span>
          <span
            className={`sidebar-label${labelKind ? ` sidebar-label--sync-${labelKind}` : ''}`}
            role="status"
            aria-live="polite"
          >
            {mainSyncLabel}
          </span>
        </button>
        <button className="sidebar-sync-settings" onClick={onOpenSettings} title={t('brain.sidebar.settingsTip')} aria-label={t('brain.sidebar.settingsTip')}>
          <GearIcon />
        </button>
      </div>
    </div>
  );
}

/**
 * Client mirror of the server's `isSafeToGitignore` gate — only offer the one-click
 * ignore for local secret/config files, never a real source file (whose secret must
 * be removed instead). The server re-validates; this just hides the button when unsafe.
 */
const SAFE_TO_GITIGNORE = /(^|\/)([^/]*\.env(\.[^/]+)?|[^/]*\.local\.[^/]+|[^/]*secrets?[^/]*\.(json|ya?ml|toml|env)|credentials?[^/]*\.(json|ya?ml|toml|env)|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_rsa[^/]*|id_ed25519[^/]*)$/i;
function isSafeToGitignoreClient(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').trim();
  if (!p) return false;
  // Reject gitignore metacharacters / control chars (a `!` negation could un-ignore a
  // secret) — mirrors the server's authoritative guard; this only gates button visibility.
  if (/[!#*?[\]\r\n\0]/.test(p)) return false;
  if (p.startsWith('/') || p.split('/').includes('..')) return false;
  return SAFE_TO_GITIGNORE.test(p);
}
