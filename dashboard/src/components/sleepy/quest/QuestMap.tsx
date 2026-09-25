import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AGENT_ROLES, roleOf } from '../../../lib/agentRoles';
import {
  VERDICT_LABELS, branchCaption, formatQuestElapsed, formatQuestTokens, questVictoryCopy,
  type QuestBranch, type QuestLineage as QuestLineageModel, type QuestLineageNode, type QuestMember,
  type QuestStage, type QuestView,
} from '../../../lib/quest';
import { AgentAvatar, QuestBadge, VerdictChip } from '../chat/atoms';
import './quest.css';

/**
 * The QUEST surfaces: a run drawn as a path of stages with its characters standing on them,
 * the one calm win beat at the end, and the "How this was built" receipt behind it.
 *
 * Everything here reads a `QuestView` / `QuestLineage` (lib/quest.ts) and nothing else, so a
 * Plan chat, a Develop chat and a goal-skill live file all draw the same map. Status stays on
 * its own channels (the node's tint and check, the round counter's ink); a character's hue is
 * identity only, and the cast never animates: the team log's avatar is the one that works.
 *
 * Three map sizes, one DOM:
 *  - `strip`, one row (≤ 32px): Terminal's composer strip.
 *  - `rail`, two rows (≤ 64px): the path, then a reserved-height beat line (or, while the
 *    builders work, the branch that seeded them).
 *  - `full`, the goal popup: bigger nodes, the beat, and the branch drawn as a fan.
 */

/** How long a win or a branch stays "news" before its one-shot motion settles. */
export const WIN_HOLD_MS = 1600;

/** Faces shown per node before the rest fold into "+N". */
const CAST_VISIBLE = 4;

// ─── One-shot moments ─────────────────────────────────────────────────────────────

/**
 * True for `holdMs` after `key` changes to a new non-null value. The key a component MOUNTS
 * with is history, not news: reopening a finished run must not replay its moment.
 * Derived during render (the "previous prop in state" pattern) so the flag is on in the very
 * frame the change lands, not one effect later.
 */
export function useJustHappened(key: string | null, holdMs: number = WIN_HOLD_MS): boolean {
  const [prevKey, setPrevKey] = useState(key);
  const [live, setLive] = useState<string | null>(null);
  if (key !== prevKey) {
    setPrevKey(key);
    setLive(key);
  }
  useEffect(() => {
    if (live == null) return undefined;
    const t = window.setTimeout(() => setLive(null), holdMs);
    return () => window.clearTimeout(t);
  }, [live, holdMs]);
  return live != null && live === key;
}

/** True for `holdMs` after `won` turns true while mounted. The seal stamps once. */
export function useJustWon(won: boolean, holdMs: number = WIN_HOLD_MS): boolean {
  return useJustHappened(won ? 'won' : null, holdMs);
}

// ─── Small pieces ─────────────────────────────────────────────────────────────────

function CheckMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} aria-hidden>
      <path d="M2.6 6.3 5 8.6 9.4 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "rounds 1-2", "rounds 1, 3", "round 2"; empty when the node never counted rounds. */
function roundsText(rounds: readonly number[]): string {
  if (rounds.length === 0) return '';
  if (rounds.length === 1) return `round ${rounds[0]}`;
  const contiguous = rounds.every((r, i) => i === 0 || r === rounds[i - 1] + 1);
  return contiguous ? `rounds ${rounds[0]}-${rounds[rounds.length - 1]}` : `rounds ${rounds.join(', ')}`;
}

function memberTitle(m: QuestMember): string {
  return m.verdict ? `${m.name} · ${VERDICT_LABELS[m.verdict]}` : m.name;
}

/** Still faces at 20px: identity only, so they never carry the working loop. */
function Cast({ members }: { members: readonly QuestMember[] }) {
  if (members.length === 0) return null;
  const shown = members.slice(0, CAST_VISIBLE);
  const more = members.length - shown.length;
  const names = members.map(memberTitle).join(', ');
  return (
    <span className="quest-node-cast" role="img" aria-label={names} title={names}>
      {shown.map((m) => (
        <AgentAvatar key={m.key} name={m.name} size={20} role={m.role} />
      ))}
      {more > 0 && <span className="quest-node-cast-more" aria-hidden>+{more}</span>}
    </span>
  );
}

function stageMeta(s: QuestStage): { text: string; title?: string } | null {
  const parts: string[] = [];
  if (s.wave) parts.push(s.wave.of != null ? `wave ${s.wave.at} of ${s.wave.of}` : `wave ${s.wave.at}`);
  if (s.meter) parts.push(`${s.meter.done} of ${s.meter.total}`);
  if (parts.length === 0) return null;
  return {
    text: parts.join(' · '),
    title: s.meter ? `${s.meter.done} of ${s.meter.total} criteria ticked` : undefined,
  };
}

const STATE_WORD: Readonly<Record<QuestStage['state'], string>> = { done: 'done', active: 'now', todo: 'next' };

function QuestNode({ stage, index, cast }: { stage: QuestStage; index: number; cast: readonly QuestMember[] }) {
  const meta = stageMeta(stage);
  const heat = stage.rounds >= 3 ? 3 : stage.rounds;
  return (
    <li
      className="quest-node"
      data-stage={stage.id}
      data-state={stage.state}
      data-rounds={stage.rounds}
      aria-current={stage.state === 'active' ? 'step' : undefined}
      title={`${stage.label}, ${STATE_WORD[stage.state]}${stage.rounds >= 2 ? `, round ${stage.rounds}` : ''}`}
      style={{ '--i': index } as CSSProperties}
    >
      <span className="quest-node-dot" aria-hidden>
        {stage.state === 'done' && <CheckMark size={10} />}
      </span>
      <span className="quest-node-label">{stage.label}</span>
      <span className="quest-sr">, {STATE_WORD[stage.state]}</span>
      {stage.rounds >= 2 && <span className="quest-node-round" data-heat={heat}>round {stage.rounds}</span>}
      {meta && <span className="quest-node-meta" title={meta.title}>{meta.text}</span>}
      <Cast members={cast} />
    </li>
  );
}

/**
 * One character's memory fanning out into the builders it seeded. `compact` is the rail's
 * single 20px row; otherwise each builder gets its own line under the fan.
 */
function QuestBranchView({ branch, cast, just, compact }: {
  branch: QuestBranch;
  cast: readonly QuestMember[];
  just: boolean;
  compact: boolean;
}) {
  const from = roleOf(branch.fromRole);
  const nameOf = (key: string) => cast.find((m) => m.key === key)?.name ?? key;
  const shown = compact ? branch.toKeys.slice(0, CAST_VISIBLE) : branch.toKeys;
  return (
    <div className="quest-branch" data-just-branched={just || undefined} data-compact={compact || undefined}>
      <span className="quest-branch-fan" aria-hidden>
        <AgentAvatar name={from.label} size={20} role={from.id} />
        <svg className="quest-branch-lines" viewBox="0 0 16 20" width="16" height="20">
          <path d="M1 10 H6 M6 10 C10 10 10 3 15 3 M6 10 H15 M6 10 C10 10 10 17 15 17" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        {compact ? (
          <span className="quest-branch-to">
            {shown.map((k) => <AgentAvatar key={k} name={nameOf(k)} size={20} role="implementer" />)}
          </span>
        ) : null}
      </span>
      {!compact && (
        <ul className="quest-branch-to" aria-label={`${AGENT_ROLES.implementer.noun.many} started from the ${from.label}`}>
          {shown.map((k, i) => (
            <li key={k} style={{ '--i': i } as CSSProperties}>
              <AgentAvatar name={nameOf(k)} size={20} role="implementer" />
              <span className="quest-branch-name">{nameOf(k)}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="quest-branch-caption">{branchCaption(branch, from.label)}</span>
    </div>
  );
}

// ─── The map ──────────────────────────────────────────────────────────────────────

/**
 * A run as a path: sentence-case stages (done, the one active, the rest to come), each
 * active character standing still on its stage, a round counter that warms from round 3,
 * and the latest beat under it. Renders the win too: every stage done and `[data-won]`,
 * with `[data-just-won]` held for {@link WIN_HOLD_MS} so the path lights up once.
 */
export function QuestMap({ quest, variant }: { quest: QuestView; variant: 'rail' | 'strip' | 'full' }) {
  const outcome = quest.outcome;
  // A run left for your sign-off has not won yet: no stamp, no lit path.
  const justWon = useJustWon(outcome != null && outcome.kind !== 'awaiting-signoff');
  const branch = quest.branch;
  const justBranched = useJustHappened(branch ? `${branch.fromKey}>${branch.toKeys.join(',')}` : null);

  const activeStage = quest.stages[quest.activeIndex]?.id ?? null;
  const castFor = (stage: QuestStage) =>
    quest.cast.filter((m) => (m.stage ?? activeStage) === stage.id);

  const elapsedMs = outcome?.elapsedMs ?? (quest.startedAt != null ? Date.now() - quest.startedAt : null);

  // The branch earns the rail's second row only while its builders are at work; in the full
  // view it always has its own block. Once shown there, a beat that only repeats it is dropped.
  const showBranch = !!branch && (variant === 'full' || (variant === 'rail' && activeStage === 'build'));
  const caption = branch && showBranch ? branchCaption(branch, roleOf(branch.fromRole).label) : null;
  const beat = quest.beat && !(caption && caption.startsWith(quest.beat.text)) ? quest.beat : null;

  return (
    <div
      className="quest-map"
      role="group"
      aria-label="Quest map"
      data-kind={quest.kind}
      data-variant={variant}
      data-won={outcome ? outcome.kind : undefined}
      data-just-won={justWon || undefined}
    >
      <ol className="quest-map-path">
        {quest.stages.map((s, i) => (
          <QuestNode key={s.id} stage={s} index={i} cast={castFor(s)} />
        ))}
      </ol>
      {elapsedMs != null && (
        <span className="quest-map-elapsed" title="Time on this quest">{formatQuestElapsed(elapsedMs)}</span>
      )}
      {variant === 'rail' && showBranch && branch ? (
        <QuestBranchView branch={branch} cast={quest.cast} just={justBranched} compact />
      ) : (
        <p className="quest-beat" data-stale={beat?.stale || undefined} aria-live="polite">{beat?.text ?? ''}</p>
      )}
      {variant === 'full' && showBranch && branch && (
        <QuestBranchView branch={branch} cast={quest.cast} just={justBranched} compact={false} />
      )}
    </div>
  );
}

// ─── The win beat ─────────────────────────────────────────────────────────────────

/** A stamp: scalloped rim, check inside. Hollow is the unsigned version, drawn but not pressed. */
const SEAL_BEADS = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return { cx: +(16 + Math.cos(a) * 13.2).toFixed(2), cy: +(16 + Math.sin(a) * 13.2).toFixed(2) };
});

function QuestSeal({ hollow }: { hollow: boolean }) {
  return (
    <svg className="quest-seal" data-hollow={hollow || undefined} viewBox="0 0 32 32" width="32" height="32" aria-hidden>
      <circle className="quest-seal-rim" cx="16" cy="16" r="13.5" />
      {!hollow && SEAL_BEADS.map((b, i) => (
        // eslint-disable-next-line react/no-array-index-key -- a fixed ring of 12
        <circle key={i} className="quest-seal-bead" cx={b.cx} cy={b.cy} r="1.1" />
      ))}
      <circle className="quest-seal-face" cx="16" cy="16" r="10" />
      <path className="quest-seal-check" d="M11.4 16.4 14.6 19.4 20.8 12.8" />
    </svg>
  );
}

/**
 * The one calm win beat: "Plan sealed" or "Quest cleared" stamp their seal once (while
 * `justWon`); "Ready for your sign-off" draws it hollow and never stamps. Develop and goal
 * runs offer the receipt; a plan has nothing built to account for.
 */
export function QuestVictory({ quest, justWon, onReceipt }: {
  quest: QuestView;
  justWon: boolean;
  onReceipt?: () => void;
}) {
  const copy = questVictoryCopy(quest);
  const outcome = quest.outcome;
  if (!copy || !outcome) return null;
  const hollow = outcome.kind === 'awaiting-signoff';
  const receipt = onReceipt && (quest.kind === 'develop' || quest.kind === 'goal');
  return (
    <div className="quest-victory" data-outcome={outcome.kind} data-just-won={(justWon && !hollow) || undefined}>
      <QuestSeal hollow={hollow} />
      <span className="quest-victory-body">
        <span className="quest-victory-text">{copy.headline}</span>
        {copy.stats && <span className="quest-victory-stats">{copy.stats}</span>}
      </span>
      {receipt && (
        <button type="button" className="quest-receipt-toggle" onClick={onReceipt}>
          How this was built
        </button>
      )}
    </div>
  );
}

// ─── The receipt ──────────────────────────────────────────────────────────────────

function LineageItem({ node }: { node: QuestLineageNode }) {
  const rounds = roundsText(node.rounds);
  return (
    <li className="quest-lineage-node" data-role={node.role} data-kind={node.kind} data-state={node.state}>
      <span className="quest-lineage-row">
        <AgentAvatar name={node.label} size={20} role={node.role} />
        <span className="quest-lineage-name">{node.label}</span>
        {node.carries && <QuestBadge carries={node.carries} />}
        {node.verdict && <VerdictChip verdict={node.verdict} />}
        {rounds && <span className="quest-lineage-rounds">{rounds}</span>}
      </span>
      <span className="quest-lineage-note">{node.note}</span>
      {node.children.length > 0 && (
        <ul className="quest-lineage-children">
          {node.children.map((c) => <LineageItem key={c.key} node={c} />)}
        </ul>
      )}
    </li>
  );
}

/** The run's family tree: the lead at the root, copied memories under whoever they came from. */
export function QuestLineage({ lineage }: { lineage: QuestLineageModel }) {
  return (
    <ul className="quest-lineage" aria-label="Who worked on it">
      <LineageItem node={lineage.root} />
    </ul>
  );
}

function lineageStats(l: QuestLineageModel): string {
  const parts: string[] = [];
  if (l.copies > 0) parts.push(`${l.copies} ${l.copies === 1 ? 'memory copy' : 'memory copies'}`);
  if (l.returns > 0) parts.push(`${l.returns} picked up where they left off`);
  if (l.fresh > 0) parts.push(`${l.fresh} ${l.fresh === 1 ? 'fresh look' : 'fresh looks'}`);
  if (l.reusedTokens != null) parts.push(`${formatQuestTokens(l.reusedTokens)} tokens not rebuilt (measured)`);
  return parts.join(' · ');
}

/**
 * "How this was built", as a dialog over the whole window. Portalled to `document.body`: the
 * agent surface's `contain: layout paint` would clip a fixed overlay (the AgentDock trap).
 * Esc or the scrim closes it; focus moves to Close on open and back to the opener on close.
 * `title` names what was built (the goal or task), under the fixed "How this was built" kicker.
 */
export function QuestReceipt({ lineage, title, onClose }: {
  lineage: QuestLineageModel;
  title: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Held in a ref so a caller's inline arrow doesn't re-run the effect (and bounce focus).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // The receipt is the topmost layer: swallow Esc and Tab so the pane underneath (whose
      // Esc means something) gets no say while it is on screen. Close is its one control.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus();
    };
  }, []);

  const stats = lineageStats(lineage);
  return createPortal(
    <div className="quest-receipt-scrim" onClick={onClose}>
      <div
        className="quest-receipt"
        role="dialog"
        aria-modal="true"
        aria-label={`How this was built: ${title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="quest-receipt-head">
          <span className="quest-receipt-heading">
            <span className="quest-receipt-kicker">How this was built</span>
            <h3 className="quest-receipt-title">{title}</h3>
          </span>
          <button ref={closeRef} type="button" className="quest-receipt-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
              <path d="M3 3 9 9 M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="quest-receipt-body">
          <QuestLineage lineage={lineage} />
        </div>
        {stats && <footer className="quest-receipt-stats">{stats}</footer>}
      </div>
    </div>,
    document.body,
  );
}
