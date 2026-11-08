import type { ChatAction, ChatActionKind } from './chatActions';
import { OpenInMainApp, useEmbed } from '../../embed/embedMode';
import type { AppLinkPage } from '../../../lib/appLink';

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
  // An app to install: opens the Apps page, which asks before anything is installed.
  'app-install': '⊕',
};

/** These open a page of the main app, or hand a task to a new session: links, in an app's frame. */
const LEAVES_THE_FRAME: Partial<Record<ChatActionKind, AppLinkPage>> = { develop: 'tasks', task: 'tasks', knowledge: 'knowledge', core: 'core' };

export function ActionRow({
  actions, onAction,
}: {
  actions: ChatAction[];
  onAction: (action: ChatAction) => void;
}) {
  const embed = useEmbed();
  if (!actions.length) return null;
  return (
    <div className="chat-action-row">
      {actions.map((a, i) => (embed && LEAVES_THE_FRAME[a.action] ? (
        <OpenInMainApp key={`${a.action}-${a.id ?? i}`} grant={embed} page={LEAVES_THE_FRAME[a.action] as AppLinkPage} id={a.action === 'develop' ? a.id ?? null : a.id ?? null}>{a.label}</OpenInMainApp>
      ) : (
        <button
          key={`${a.action}-${a.id ?? a.path ?? i}`}
          type="button"
          className="chat-action-btn"
          data-action={a.action}
          // The target, verbatim — so a button that turns out to point somewhere wrong is
          // diagnosable by hovering it rather than by reading the transcript's source.
          title={a.id ?? a.path ?? a.repo ?? a.text ?? a.label}
          onClick={() => onAction(a)}
        >
          <span className="chat-action-glyph" aria-hidden>{ACTION_GLYPH[a.action]}</span>
          <span className="chat-action-label">{a.label}</span>
        </button>
      )))}
    </div>
  );
}
