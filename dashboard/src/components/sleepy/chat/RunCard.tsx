import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, useVaultId } from '../../../context/VaultContext';
import { isDesktop } from '../../../lib/desktop';
import { isMacPhoneSurface } from '../../../lib/phoneSurface';
import {
  FOLDER_CHANGED, OWNER_ONLY_LINE, canPressWith, cardFolderText, folderLine as folderLineOf, phoneFolderOf, pressRun, refreshCards, settleFolderCheck, ticketActionOf,
  useHostCard, useShownFolder, type CardActionResult, type CardHost, type FolderCheck,
} from '../../../lib/cardRecords';
import { commandUnsafe, escapeUnsafe } from '../../../lib/unsafeChars';
import { useOwnerCardT } from '../../../context/I18nContext';
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

export function RunCard({ spec, report, sessionId, host, folder, startRequest, onEnded, onStartRequest, onReread }: {
  spec: RunViewSpec;
  /** Where the exit report goes on a host without a chat (an agent thread's reply). */
  report?: (text: string) => void;
  /** The chat's session (pin) id: the card is the server's record, run and reported by it. */
  sessionId?: string;
  /** An owner item's record (the Super-chat slot, K7): the card is found by its handle, never by
   *  chat text. Wins over `sessionId`. */
  host?: CardHost;
  /** The folder it runs in (the card's working root, `GET /api/agent/cards/state`). */
  folder?: { name: string; path: string } | null;
  /** The bar's ▶ Run (K7): a new number starts the run here, when this card draws exactly the
   *  command the bar drew (`shown`). */
  startRequest?: { n: number; shown: string };
  /** A terminal of this card ended (the slot reads its state again). */
  onEnded?: () => void;
  /** The bar's request `n` was handled here (started, or told it did not): the slot forgets it. */
  onStartRequest?: (n: number) => void;
  /** The server said the folder changed: the slot reads the card's state again (never presses). */
  onReread?: () => void;
}) {
  const chatHost: CardHost | undefined = host ?? (sessionId ? { session: sessionId } : undefined);
  if (chatHost) return <ChatRunCard spec={spec} host={chatHost} folder={folder} startRequest={startRequest} onEnded={onEnded} onStartRequest={onStartRequest} onReread={onReread} />;
  return <ThreadRunCard spec={spec} report={report} />;
}

/**
 * The command as the card draws it: the WHOLE command, wrapped (K4 "what is shown is what runs").
 * A command with a character the Telegram path refuses, or a run of 8 spaces, is drawn with those
 * as visible escapes; the caller offers it no Run.
 */
function CommandText({ command }: { command: string }) {
  const unsafe = commandUnsafe(command);
  return (
    <code
      className="chat-runcard-cmd"
      data-testid="run-card-command"
      data-unsafe={unsafe ? 'true' : undefined}
      style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
    >{unsafe ? escapeUnsafe(command) : command}</code>
  );
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
function ChatRunCard({ spec, host, folder, startRequest, onEnded, onStartRequest, onReread }: {
  spec: RunViewSpec;
  host: CardHost;
  folder?: { name: string; path: string } | null;
  startRequest?: { n: number; shown: string };
  onEnded?: () => void;
  onStartRequest?: (n: number) => void;
  onReread?: () => void;
}) {
  const api = useApi();
  const t = useOwnerCardT();
  const { vault } = useVaultId();
  const fetchJson = useCallback((path: string) => api.get<unknown>(path), [api]);
  const { loaded, record, sessionId: hostSid } = useHostCard(host, spec, fetchJson);
  const sessionId = hostSid ?? '';
  const unsafe = commandUnsafe(spec.command);
  const recordHost = 'record' in host;
  const phone = isMacPhoneSurface();
  // THE FOLDER THIS CARD DRAWS IS THE FOLDER ITS PRESS NAMES (end review r2, r3), on the Mac and on
  // the phone alike: the slot hands it in; the card's own chat reads it (the Mac's card state, or
  // the phone's own card read). No folder drawn, no press offered.
  const phoneRead = useCallback((s: string, c: string) => refreshCards(s, fetchJson).then(() => phoneFolderOf(s, c)), [fetchJson]);
  const given = folder !== undefined ? folder : phone ? phoneFolderOf(sessionId, record?.cardRef) : undefined;
  const shownFolder = useShownFolder(vault, record ? { postingSession: sessionId, cardRef: record.cardRef } : undefined, given, onReread, phone ? phoneRead : undefined);
  const drawnRoot = shownFolder.folder?.path ?? null;
  const drawnRootRef = useRef(drawnRoot);
  drawnRootRef.current = drawnRoot;
  // A press refused because the folder moved: reading it again (always settles), then what it is
  // now, or that it cannot be confirmed here. Cleared when the owner presses again.
  const [check, setCheck] = useState<FolderCheck>(null);
  const checkRef = useRef(check);
  checkRef.current = check;
  const rereadRef = useRef(shownFolder.reread);
  rereadRef.current = shownFolder.reread;
  const folderChanged = useCallback((from: string | null) => {
    const named = from ?? '';
    setCheck({ from: named, state: 'reading' });
    void rereadRef.current().then((now) => setCheck(settleFolderCheck(named, now)));
  }, []);
  // Every Mac press carries a ticket minted for it, bound to the command AND the folder drawn here
  // (K4, end review r2). A refusal (no owner key: a plain browser) keeps its one line on the card;
  // a folder that changed shows its own line and reads the folder again, and is NEVER pressed again
  // by the card itself.
  const [refusal, setRefusal] = useState<string | null>(null);
  const mintTicket = useCallback(async (target: CardTarget): Promise<CardActionResult<string>> => {
    // No folder drawn, no press: never a mint with an empty root.
    const root = drawnRootRef.current;
    if (!root) return { ok: false, error: 'no_folder', message: t('ownerCard.cannotConfirm') };
    const r = await pressRun(api, {
      session: target.sessionId, card: target.cardRef, action: ticketActionOf(target), shown: spec.command, root,
    }, { folderChanged: (named) => { setRefusal(null); folderChanged(named); } });
    if (!r.ok && r.error === FOLDER_CHANGED) return r;
    setRefusal(r.ok ? null : r.message || OWNER_ONLY_LINE);
    return r;
  }, [api, spec.command, folderChanged, t]);
  const desktop = isDesktop();
  const pressable = canPressWith(drawnRoot, check);
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
    // Attaching on the Mac is a press too: it waits until the folder is drawn.
    if (!liveRunId || !cardRef || !pressable) return;
    setShown((cur) => {
      if (cur && !cur.ended) return cur.runId ? cur : { ...cur, runId: liveRunId };
      if (cur && cur.runId === liveRunId && (cur.exited || !cur.user)) return cur;
      return { key: `r${liveRunId}`, runId: liveRunId, target: { sessionId, cardRef, start: false, phone, ...(phone && drawnRootRef.current ? { root: drawnRootRef.current } : {}) }, user: false, ended: false, exited: false };
    });
  }, [liveRunId, cardRef, sessionId, phone, shownEnded, pressable]);

  const onEnd = (key: string, user: boolean, r: { code: number | null; exited: boolean; opened: boolean; reason?: string }) => {
    // The upgrade refused: the folder bound at the press is not the folder now. Say so, draw the
    // new one; nothing is pressed again.
    if (r.reason === FOLDER_CHANGED && !r.opened) {
      setShown((cur) => (cur?.key === key ? null : cur));
      if (!checkRef.current) folderChanged(drawnRootRef.current);
      return;
    }
    if (user && !r.opened && !r.exited) {
      // Refused before it opened (busy, too many starts, no terminal): nothing ran.
      setShown((cur) => (cur?.key === key ? null : cur));
      setOutcome({ kind: 'refused', key });
      return;
    }
    setShown((cur) => (cur?.key === key ? { ...cur, ended: true, exited: r.exited } : cur));
    if (r.exited) setOutcome({ kind: 'exited', code: r.code, key });
    onEnded?.();
  };

  // A command that could show something other than what runs is never offered a Run (K4, K7).
  const canStart = (desktop || phone) && !!vault && !unsafe;
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
    if (!record || unsafe || !pressable) return;
    setRefusal(null);
    setCheck(null);
    starts.current += 1;
    setOutcome(null);
    setShown({
      key: `l${starts.current}`,
      // The phone's press names the folder it drew in its URL; the Mac's in its ticket.
      target: { sessionId, cardRef: record.cardRef, start: true, withheld: !includeOutput, rerun: closed, phone, ...(phone && drawnRoot ? { root: drawnRoot } : {}) },
      user: true,
      ended: false,
      exited: false,
    });
  };

  // The bar's ▶ Run lands here (K7): only for the exact command this card draws. A request already
  // waiting when this card mounts (the bar pressed while the card was still loading) is handled
  // too, once the record is known: it starts when the card can start, and otherwise the card says
  // it did not, never a silent drop. Either way it is handed back (`onStartRequest`), so the store
  // forgets it and a remount never runs it twice.
  const startRef = useRef(start);
  startRef.current = start;
  const handledRequest = useRef(0);
  useEffect(() => {
    if (!startRequest || startRequest.n === handledRequest.current || !loaded) return;
    handledRequest.current = startRequest.n;
    if (startRequest.shown === spec.command && view.startable && pressable) startRef.current();
    // Said as the card stands: already running, its folder not known, the button it offers, or none.
    else if (view.phase === 'running') setRefusal(t('ownerCard.barRunning'));
    else if (!pressable) setRefusal(t('ownerCard.barNoFolder'));
    else if (view.runLabel && view.startable) setRefusal(t('ownerCard.notStarted').replace('{label}', view.runLabel === 'Run again' ? t('ownerCard.runAgainLabel') : t('ownerCard.bar.runVerb')));
    else setRefusal(t('ownerCard.barCannotRun'));
    onStartRequest?.(startRequest.n);
  }, [startRequest, spec.command, loaded, view.startable, view.phase, view.runLabel, pressable, t, onStartRequest]);

  // The one folder text every surface draws (cardFolderText); with no root read, the spec's cwd.
  const where = cardFolderText(shownFolder.folder, spec) ?? spec.cwd;
  // The slot's run executes on this Mac whoever pressed it: never "in chat" there.
  const title = recordHost && view.title === 'Ran in chat' ? t('ownerCard.ranOnMac')
    : recordHost && view.title === 'Running in chat' ? t('ownerCard.runningOnMac')
      : view.title;
  // The folder line: changed (and what it is now, once read again), or not known on the Mac.
  const folderLine = folderLineOf(t, {
    check, spec, unknown: !drawnRoot && loaded && view.phase !== 'running' && !unsafe,
  });

  return (
    <div className="chat-viewcard chat-runcard" data-phase={view.phase} data-closed-by={record?.closedBy} data-view-kind="run" data-view-id={spec.id} data-card-state={record?.state ?? (loaded ? 'none' : 'loading')} data-unsafe={unsafe ? 'true' : undefined}>
      <CardHeader
        glyph={view.phase === 'running' ? '▸' : '>_'}
        title={title}
        aside={view.chip !== undefined ? exitChip(view.chip) : where ? <span className="chat-runcard-cwd" data-testid="run-card-folder" title={shownFolder.folder?.path}>{where}</span> : undefined}
      />

      {spec.why && view.phase === 'idle' && <p className="chat-runcard-why">{spec.why}</p>}

      <div className="chat-runcard-cmdrow">
        <CommandText command={spec.command} />
        <button type="button" className="chat-runcard-copy" onClick={copy} aria-label="Copy the command">
          {copied ? 'Copied' : 'Copy'}
        </button>
        {view.runLabel && !unsafe && pressable && (
          <button
            type="button"
            className="chat-btn pill primary chat-runcard-play"
            data-testid="run-card-play"
            onClick={start}
            disabled={!view.startable}
          >
            <span aria-hidden>▶</span> {view.runLabel}
          </button>
        )}
      </div>

      {unsafe && <p className="chat-runcard-note" data-testid="run-card-unsafe">{t('ownerCard.unsafe')}</p>}

      {view.startable && pressable && (
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
          mintTicket={shown.target.phone ? undefined : mintTicket}
          onExit={(r) => onEnd(shown.key, shown.user, r)}
        />
      )}

      {refusal
        ? <p className="chat-runcard-note" data-testid="run-card-refused">{refusal}</p>
        : folderLine
          ? <p className="chat-runcard-note" data-testid="run-card-folder-line">{folderLine}</p>
          : view.note && <p className="chat-runcard-note">{view.note}</p>}
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
        <CommandText command={spec.command} />
        <button type="button" className="chat-runcard-copy" onClick={copy} aria-label="Copy the command">
          {copied ? 'Copied' : 'Copy'}
        </button>
        {phase !== 'running' && !commandUnsafe(spec.command) && (
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
