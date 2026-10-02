import { useI18n } from '../../../context/I18nContext';
import { LabShowcase } from '../LabShowcase';

/**
 * Insights with no board at all: what the page is for (the animated pipeline
 * showcase), then the one thing to do about it. "Create your first board"
 * makes an empty board and opens it; insights and blocks are added from there.
 * The CLI line is for the insight itself, which the dashboard does not author.
 */
export function BoardEmptyState({ onCreate, creating, failed }: {
  onCreate: () => void;
  creating: boolean;
  failed: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className="board-empty" aria-labelledby="board-empty-title">
      <p className="board-empty-kicker">{t('lab.board.emptyState.kicker')}</p>
      <h2 id="board-empty-title" className="board-empty-title">{t('lab.board.emptyState.title')}</h2>
      <p className="board-empty-lead">{t('lab.board.emptyState.lead')}</p>
      <LabShowcase />
      <button
        type="button"
        className="board-btn board-btn--primary"
        data-lab-create-first-board
        disabled={creating}
        onClick={onCreate}
      >
        {creating ? t('lab.board.emptyState.creating') : t('lab.board.emptyState.create')}
      </button>
      {failed && <p className="board-note board-note--error" role="alert">{t('lab.board.emptyState.failed')}</p>}
      <p className="board-empty-foot">{t('lab.board.emptyState.cli')}</p>
      <code className="board-empty-cmd">dreamcontext lab create &lt;slug&gt; --title &quot;Weekly Active Users&quot; --adapter http</code>
    </section>
  );
}
