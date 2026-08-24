import type { ChatAction, ChatActionKind } from './chatActions';

/**
 * MOLECULE — the row of buttons an answer asked for (`dream-actions`), rendered under the
 * message it belongs to.
 *
 * These are the answer's "and now?": open the thing it just made, jump to the entity it
 * just changed, send the follow-up it just proposed. Nothing here decides what an action
 * DOES — `ChatPane` owns that, so a button can only ever reach a surface the pane already
 * has (its slide-over, its lightbox, the app's navigation, the composer).
 *
 * Mono glyphs, not emoji, per the agent surface's glyph set (`◆`/`◇`/`>_`).
 */

const ACTION_GLYPH: Record<ChatActionKind, string> = {
  task: '☰',
  knowledge: '◈',
  core: '◉',
  file: '▤',
  board: '▦',
  reveal: '↗',
  ask: '▸',
  url: '⇗',
  // Plan → Develop: a tab stop, because the click hands the work on to a NEW session rather
  // than opening something in this one.
  develop: '⇥',
};

export function ActionRow({
  actions, onAction,
}: {
  actions: ChatAction[];
  onAction: (action: ChatAction) => void;
}) {
  if (!actions.length) return null;
  return (
    <div className="chat-action-row">
      {actions.map((a, i) => (
        <button
          key={`${a.action}-${a.id ?? a.path ?? i}`}
          type="button"
          className="chat-action-btn"
          data-action={a.action}
          // The target, verbatim — so a button that turns out to point somewhere wrong is
          // diagnosable by hovering it rather than by reading the transcript's source.
          title={a.id ?? a.path ?? a.text ?? a.label}
          onClick={() => onAction(a)}
        >
          <span className="chat-action-glyph" aria-hidden>{ACTION_GLYPH[a.action]}</span>
          <span className="chat-action-label">{a.label}</span>
        </button>
      ))}
    </div>
  );
}
