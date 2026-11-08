import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, useVaultId } from '../../../context/VaultContext';
import { isDesktop } from '../../../lib/desktop';
import { isMacPhoneSurface } from '../../../lib/phoneSurface';
import { useCardRecord } from '../../../lib/cardRecords';
import { CardHeader } from './molecules';
import { InlineTerminal, type CardTarget } from './InlineTerminal';
import { buildRunReport, type RunOutcome } from './runReport';
import { runCardView, type RunOutcome as CardOutcome } from './runCardView';
import type { RunViewSpec } from '../../../lib/chatViewSpec';

/**
 * ORGANISM — the `dream-view` RUN card: a command, a ▶, and a real terminal that opens
 * where the card is.
 *
 * The gap it closes, in the owner's words (2026-09-19): "firebase auth login yapacağım,
 * yine chat'ten çıkmadan inline bir terminal açtırsın, ben onu çalıştırıp interact
 * olabileyim… çalışma bitince de agent otomatik devam ediyor". Three things have to be true
 * at once for that to work, and each is a different piece of this file:
 *
 *  1. the process is INTERACTIVE — `InlineTerminal` is a PTY, not a log pane;
 *  2. the user is never surprised — the command is shown in full, nothing runs until ▶;
 *  3. the turn CONTINUES — on exit the outcome goes back into the conversation itself, so
 *     the agent picks up without the user typing "done".
 *
 * TWO HOSTS (plan H4, I1, J2, K1, 2026-11-08):
 *  - A CHAT (a session is given): the card is the server's RECORD. The terminal names the
 *    record (`{sessionId, cardRef}`), never the command; the server runs it, and REPORTS it
 *    (this card posts nothing). The same run can be started here, on the hands-free phone page
 *    or from a Telegram button, and is watched from all three; a run going for this card is
 *    shown attached, never with a second ▶. Until the records have loaded the ▶ is disabled; a
 *    card the server has no record of (older than the chat's newest 16) gets Copy only. A
 *    finished card offers "Run again" on the Mac only.
 *  - An AGENT THREAD (no session, a `report` sink): as before, the card runs its own command
 *    and posts the report itself.
 *
 * The output switch is the honest part of (3). The default is to hand back the tail,
 * because that is what makes the agent useful on the next line; but a command that PRINTS a
 * credential (`firebase login:ci`, `gh auth token`) would put it in the transcript, and the
 * person who can tell is the one looking at the screen. So it is a switch they can flip
 * before pressing ▶ — never a judgement the agent makes for them.
 */

type Phase = 'idle' | 'running' | 'done';

export function RunCard({ spec, report, sessionId }: {
  spec: RunViewSpec;
  /** Where the exit report goes on a host without a chat (an agent thread's reply). */
  report?: (text: string) => void;
  /** The chat's session (pin) id: the card is the server's record, run and reported by it. */
  sessionId?: string;
}) {
  if (sessionId) return <ChatRunCard spec={spec} sessionId={sessionId} />;
  return <ThreadRunCard spec={spec} report={report} />;
}

function exitChip(code: number | null | undefined) {
  if (code === undefined) return undefined;
  return code === 0
    ? <span className="chat-runcard-exit is-ok">exit 0</span>
    : code === null
      ? <span className="chat-runcard-exit is-unknown">no exit code</span>
      : <span className="chat-runcard-exit is-bad">exit {code}</span>;
}

function useCopy(command: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => { /* clipboard unavailable */ });
  };
  return [copied, copy];
}

/** A terminal shown in a chat card: one this card started (`user`), or one watching a run that
 *  was started elsewhere. `runId` is the server run it shows, once known. */
interface Shown {
  key: string;
  target: CardTarget;
  user: boolean;
  runId?: string;
  /** Its socket ended. */
  ended: boolean;
  /** It ended with the server's exit frame: the process really finished. */
  exited: boolean;
}

/** The chat host: the server's record decides what can be done here; `runCardView` what it says. */
function ChatRunCard({ spec, sessionId }: { spec: RunViewSpec; sessionId: string }) {
  const api = useApi();
  const { vault } = useVaultId();
  const fetchJson = useCallback((path: string) => api.get<unknown>(path), [api]);
  const { loaded, record } = useCardRecord(sessionId, spec, fetchJson);
  const phone = isMacPhoneSurface();
  const desktop = isDesktop();
  const [includeOutput, setIncludeOutput] = useState(true);
  const [copied, copy] = useCopy(spec.command);
  // The terminal in this card. It STAYS mounted after its process ends (read-only), so the last
  // output stays on screen until a newer run replaces it.
  const [shown, setShown] = useState<Shown | null>(null);
  // What this card's own last terminal led to, tied to that terminal's key (a newer one voids it).
  const [outcome, setOutcome] = useState<(CardOutcome & { key: string }) | null>(null);
  const starts = useRef(0);

  const live = record?.run ?? null;
  const liveRunId = live?.runId;
  const cardRef = record?.cardRef;
  const closed = record?.state === 'closed';
  const shownEnded = shown?.ended;

  // Watch a run going for this card (started on the phone, from Telegram, or before a reload).
  // A connected terminal is only tagged with its run; one whose run already ended here, or whose
  // watch already dropped once, is kept (no reconnect loop); otherwise the new run is attached.
  useEffect(() => {
    if (!liveRunId || !cardRef) return;
    setShown((cur) => {
      if (cur && !cur.ended) return cur.runId ? cur : { ...cur, runId: liveRunId };
      if (cur && cur.runId === liveRunId && (cur.exited || !cur.user)) return cur;
      return { key: `r${liveRunId}`, runId: liveRunId, target: { sessionId, cardRef, start: false, phone }, user: false, ended: false, exited: false };
    });
  }, [liveRunId, cardRef, sessionId, phone, shownEnded]);

  const onEnd = (key: string, user: boolean, r: { code: number | null; exited: boolean; opened: boolean }) => {
    if (user && !r.opened && !r.exited) {
      // Refused before it opened (busy, too many starts, no terminal): nothing ran.
      setShown((cur) => (cur?.key === key ? null : cur));
      setOutcome({ kind: 'refused', key });
      return;
    }
    setShown((cur) => (cur?.key === key ? { ...cur, ended: true, exited: r.exited } : cur));
    if (r.exited) setOutcome({ kind: 'exited', code: r.code, key });
  };

  const canStart = (desktop || phone) && !!vault;
  const view = runCardView({
    loaded,
    hasRecord: !!record,
    canStart,
    phone,
    desktop,
    state: record?.state,
    closedBy: record?.closedBy,
    recordExit: record?.exit,
    liveOwner: live?.owner ?? null,
    connected: !!shown && !shown.ended,
    connectedIsOwn: !!shown?.user,
    outcome: outcome && (!shown || shown.key === outcome.key) ? outcome : null,
  });

  const start = () => {
    if (!record) return;
    starts.current += 1;
    setOutcome(null);
    setShown({
      key: `l${starts.current}`,
      target: { sessionId, cardRef: record.cardRef, start: true, withheld: !includeOutput, rerun: closed, phone },
      user: true,
      ended: false,
      exited: false,
    });
  };

  return (
    <div className="chat-viewcard chat-runcard" data-phase={view.phase} data-closed-by={record?.closedBy} data-view-kind="run" data-view-id={spec.id} data-card-state={record?.state ?? (loaded ? 'none' : 'loading')}>
      <CardHeader
        glyph={view.phase === 'running' ? '▸' : '>_'}
        title={view.title}
        aside={view.chip !== undefined ? exitChip(view.chip) : spec.cwd ? <span className="chat-runcard-cwd">{spec.cwd}</span> : undefined}
      />

      {spec.why && view.phase === 'idle' && <p className="chat-runcard-why">{spec.why}</p>}

      <div className="chat-runcard-cmdrow">
        <code className="chat-runcard-cmd">{spec.command}</code>
        <button type="button" className="chat-runcard-copy" onClick={copy} aria-label="Copy the command">
          {copied ? 'Copied' : 'Copy'}
        </button>
        {view.runLabel && (
          <button
            type="button"
            className="chat-btn pill primary chat-runcard-play"
            onClick={start}
            disabled={!view.startable}
          >
            <span aria-hidden>▶</span> {view.runLabel}
          </button>
        )}
      </div>

      {view.startable && (
        <label className="chat-runcard-share">
          <input type="checkbox" checked={includeOutput} onChange={(e) => setIncludeOutput(e.target.checked)} />
          Send the output back to the agent when it finishes
        </label>
      )}

      {shown && vault && (
        <InlineTerminal
          key={shown.key}
          vault={vault}
          command={spec.command}
          card={shown.target}
          onExit={(r) => onEnd(shown.key, shown.user, r)}
        />
      )}

      {view.note && <p className="chat-runcard-note">{view.note}</p>}
    </div>
  );
}

/** The agent-thread host: the card runs its own command and posts its own report. */
function ThreadRunCard({ spec, report }: { spec: RunViewSpec; report?: (text: string) => void }) {
  const { vault } = useVaultId();
  const desktop = isDesktop();
  const [phase, setPhase] = useState<Phase>('idle');
  const [includeOutput, setIncludeOutput] = useState(true);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [copied, copy] = useCopy(spec.command);
  // Bumped on every run so the terminal REMOUNTS: a second run must be a new process with a
  // clean screen, and reusing the mount would show the first run's output under the second
  // run's prompt.
  const [runNo, setRunNo] = useState(0);

  const handleExit = useCallback((result: { code: number | null; tail: string }) => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const next = { ...result, seconds };
    setOutcome(next);
    setPhase('done');
    report?.(buildRunReport(spec.command, next, { includeOutput }));
  }, [includeOutput, report, spec.command, startedAt]);

  const start = () => {
    setOutcome(null);
    setStartedAt(Date.now());
    setRunNo((n) => n + 1);
    setPhase('running');
  };

  const blocked = !desktop
    ? 'Running a command in the chat needs the desktop app. Copy it and run it in your terminal.'
    : !vault
      ? 'No project is open — open one to run this here.'
      : null;

  return (
    <div className="chat-viewcard chat-runcard" data-phase={phase} data-view-kind="run" data-view-id={spec.id}>
      <CardHeader
        glyph={phase === 'running' ? '▸' : '>_'}
        title={phase === 'running' ? 'Running in chat' : phase === 'done' ? 'Ran in chat' : 'Run this yourself'}
        aside={phase === 'done' && outcome ? exitChip(outcome.code) : spec.cwd ? <span className="chat-runcard-cwd">{spec.cwd}</span> : undefined}
      />

      {spec.why && phase === 'idle' && <p className="chat-runcard-why">{spec.why}</p>}

      <div className="chat-runcard-cmdrow">
        <code className="chat-runcard-cmd">{spec.command}</code>
        <button type="button" className="chat-runcard-copy" onClick={copy} aria-label="Copy the command">
          {copied ? 'Copied' : 'Copy'}
        </button>
        {phase !== 'running' && (
          <button
            type="button"
            className="chat-btn pill primary chat-runcard-play"
            onClick={start}
            disabled={!!blocked}
          >
            <span aria-hidden>▶</span> {phase === 'done' ? 'Run again' : 'Run'}
          </button>
        )}
      </div>

      {/* Asked BEFORE the run, while the user can still see what is about to print, and
          hidden WHILE it runs — flipping the switch mid-run, or after the report has gone,
          would change nothing and imply it had. On a finished card it is offered again
          because it configures the NEXT run, which is the only thing it still can. */}
      {phase !== 'running' && !blocked && (
        <label className="chat-runcard-share">
          <input
            type="checkbox"
            checked={includeOutput}
            onChange={(e) => setIncludeOutput(e.target.checked)}
          />
          Send the output back to the agent when it finishes
        </label>
      )}

      {blocked && <p className="chat-runcard-note">{blocked}</p>}

      {phase !== 'idle' && vault && (
        <InlineTerminal
          key={runNo}
          vault={vault}
          command={spec.command}
          cwd={spec.cwd}
          onExit={handleExit}
        />
      )}

      {phase === 'running' && (
        <p className="chat-runcard-note">
          Type here as you would in your own terminal. Closing the chat stops the command.
        </p>
      )}

      {phase === 'done' && outcome && (
        <p className="chat-runcard-note">
          {report
            ? includeOutput
              ? 'Reported back to the agent with the output.'
              : 'Reported back to the agent — exit code only.'
            : 'Finished. Nothing was reported back: this transcript has no live session.'}
        </p>
      )}
    </div>
  );
}
