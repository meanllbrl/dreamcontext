import type { BrainSyncResult } from '../../hooks/useBrainStatus';

/** One sentence of the outcome: an i18n key and the values its `{placeholders}` take. */
export interface OutcomeLine {
  key: string;
  vars?: Record<string, string | number>;
}

/**
 * What the board's Sync button says after a press. `tone` colours it: `ok` quiet, `warn` the
 * sync ran but something waits, `bad` nothing went. `settings` adds the way to fix it there.
 */
export interface SyncOutcome {
  tone: 'ok' | 'warn' | 'bad';
  lines: OutcomeLine[];
  settings?: boolean;
}

/** The sync's outcome in the board's words (pure; the button renders it). */
export function syncOutcome(result: BrainSyncResult | null | undefined): SyncOutcome {
  if (!result) return { tone: 'bad', lines: [{ key: 'whiteboard.sync.failedGeneric' }] };
  switch (result.action) {
    case 'noop':
      return { tone: 'ok', lines: [{ key: 'whiteboard.sync.upToDate' }] };
    case 'pushed':
    case 'pulled':
    case 'merged': {
      const n = result.pulledUpdates ?? 0;
      return { tone: 'ok', lines: [n > 0 ? { key: 'whiteboard.sync.syncedIn', vars: { n } } : { key: 'whiteboard.sync.synced' }] };
    }
    case 'awaiting-agent':
    case 'already-awaiting-agent':
    case 'code-conflict':
      return waitingOutcome(result);
    case 'error':
      if (result.failure && (result.failure.kind === 'auth' || result.failure.kind === 'no-token')) {
        return { tone: 'bad', lines: [{ key: 'whiteboard.sync.signIn' }], settings: true };
      }
      return { tone: 'bad', lines: [{ key: 'whiteboard.sync.failed', vars: { reason: result.failure?.message ?? result.note ?? '' } }] };
    case 'no-remote':
      return result.failure
        ? { tone: 'bad', lines: [{ key: 'whiteboard.sync.signIn' }], settings: true }
        : { tone: 'bad', lines: [{ key: 'whiteboard.sync.noRemote' }], settings: true };
    case 'disabled':
      return { tone: 'bad', lines: [{ key: 'whiteboard.sync.off' }], settings: true };
    case 'skipped-in-tree':
      return { tone: 'warn', lines: [{ key: 'whiteboard.sync.inTree' }] };
    case 'locked':
      return { tone: 'warn', lines: [{ key: 'whiteboard.sync.locked' }] };
    case 'blocked-scrub':
      return { tone: 'bad', lines: [{ key: 'whiteboard.sync.secret', vars: { file: result.scrub?.blocks?.[0]?.file ?? '' } }] };
    case 'user-merge-in-progress':
      return { tone: 'warn', lines: [{ key: 'whiteboard.sync.userMerge' }] };
    case 'detached-head':
      return { tone: 'warn', lines: [{ key: 'whiteboard.sync.detached' }] };
    default:
      return result.note
        ? { tone: 'warn', lines: [{ key: 'whiteboard.sync.note', vars: { note: result.note } }] }
        : { tone: 'warn', lines: [{ key: 'whiteboard.sync.failedGeneric' }] };
  }
}

/** The team merge waits for sleep (or a code file for its owner); the boards went anyway. */
function waitingOutcome(result: BrainSyncResult): SyncOutcome {
  const lines: OutcomeLine[] = [];
  const b = result.boards;
  // Up to date only when the exchange ran to the end and found nothing to move (review r1).
  let tone: SyncOutcome['tone'] = 'warn';
  let settings = false;
  if (!b) {
    lines.push({ key: 'whiteboard.sync.boardsNotSent' });
  } else if (b.error) {
    tone = 'bad';
    lines.push({ key: 'whiteboard.sync.boardsFailed', vars: { reason: b.error } });
  } else if (b.stopped === 'no-session') {
    tone = 'bad';
    settings = true;
    lines.push({ key: 'whiteboard.sync.boardsSignIn' });
  } else if (b.stopped === 'secret') {
    tone = 'bad';
    lines.push({ key: 'whiteboard.sync.boardsSecret' });
  } else if (b.stopped) {
    tone = 'bad';
    lines.push({ key: 'whiteboard.sync.boardsNotSent' });
  } else if (b.sent > 0 || b.received > 0) {
    lines.push({ key: 'whiteboard.sync.boardsSynced' });
  } else {
    lines.push({ key: 'whiteboard.sync.boardsUpToDate' });
  }
  if (b?.trashed) lines.push(b.trashed === 1 ? { key: 'whiteboard.sync.boardsTrashedOne' } : { key: 'whiteboard.sync.boardsTrashed', vars: { n: b.trashed } });
  if (b && b.waiting > 0) lines.push({ key: 'whiteboard.sync.boardsWait', vars: { n: b.waiting } });
  const sleeping = result.awaitingSleep ?? 0;
  if (sleeping > 0) lines.push({ key: sleeping === 1 ? 'whiteboard.sync.sleepOne' : 'whiteboard.sync.sleepMany', vars: { n: sleeping } });
  const code = result.codeConflicts?.length ?? 0;
  if (result.action === 'code-conflict' && code > 0) lines.push({ key: 'whiteboard.sync.codeWait', vars: { n: code } });
  return settings ? { tone, lines, settings } : { tone, lines };
}

/** Fill `{name}` placeholders; a function replacement keeps a `$` in a value as text. */
export function fillOutcome(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
