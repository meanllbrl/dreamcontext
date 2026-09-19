import { useCallback, useState } from 'react';
import { useVault } from '../../../context/VaultContext';
import { isDesktop } from '../../../lib/desktop';
import { CardHeader } from './molecules';
import { InlineTerminal } from './InlineTerminal';
import { postToSession } from './postToSession';
import { buildRunReport, type RunOutcome } from './runReport';
import type { RunViewSpec } from '../../../lib/chatViewSpec';
import type { ChatSession } from '../chatSession';

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
 *  3. the turn CONTINUES — on exit the card posts the outcome back into the conversation
 *     itself, so the agent picks up without the user typing "done".
 *
 * The output switch is the honest part of (3). The default is to hand back the tail,
 * because that is what makes the agent useful on the next line; but a command that PRINTS a
 * credential (`firebase login:ci`, `gh auth token`) would put it in the transcript, and the
 * person who can tell is the one looking at the screen. So it is a switch they can flip
 * before pressing ▶ — never a judgement the agent makes for them.
 */

type Phase = 'idle' | 'running' | 'done';

export function RunCard({ spec, session }: { spec: RunViewSpec; session?: ChatSession }) {
  const { vault } = useVault();
  const desktop = isDesktop();
  const [phase, setPhase] = useState<Phase>('idle');
  const [includeOutput, setIncludeOutput] = useState(true);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [copied, setCopied] = useState(false);
  // Bumped on every run so the terminal REMOUNTS: a second run must be a new process with a
  // clean screen, and reusing the mount would show the first run's output under the second
  // run's prompt.
  const [runNo, setRunNo] = useState(0);

  const handleExit = useCallback((result: { code: number | null; tail: string }) => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const next = { ...result, seconds };
    setOutcome(next);
    setPhase('done');
    if (session) postToSession(session, buildRunReport(spec.command, next, { includeOutput }));
  }, [includeOutput, session, spec.command, startedAt]);

  const start = () => {
    setOutcome(null);
    setStartedAt(Date.now());
    setRunNo((n) => n + 1);
    setPhase('running');
  };

  const copy = () => {
    void navigator.clipboard?.writeText(spec.command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => { /* clipboard unavailable */ });
  };

  const blocked = !desktop
    ? 'Running a command in the chat needs the desktop app. Copy it and run it in your terminal.'
    : !vault
      ? 'No project is open — open one to run this here.'
      : null;

  const codeChip = outcome && (outcome.code === 0
    ? <span className="chat-runcard-exit is-ok">exit 0</span>
    : outcome.code === null
      ? <span className="chat-runcard-exit is-unknown">no exit code</span>
      : <span className="chat-runcard-exit is-bad">exit {outcome.code}</span>);

  return (
    <div className="chat-viewcard chat-runcard" data-phase={phase}>
      <CardHeader
        glyph={phase === 'running' ? '▸' : '>_'}
        title={phase === 'running' ? 'Running in chat' : phase === 'done' ? 'Ran in chat' : 'Run this yourself'}
        aside={phase === 'done' ? codeChip : spec.cwd ? <span className="chat-runcard-cwd">{spec.cwd}</span> : undefined}
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
          {session
            ? includeOutput
              ? 'Reported back to the agent with the output.'
              : 'Reported back to the agent — exit code only.'
            : 'Finished. Nothing was reported back: this transcript has no live session.'}
        </p>
      )}
    </div>
  );
}
