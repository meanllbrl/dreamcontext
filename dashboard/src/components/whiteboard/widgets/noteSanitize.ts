import DOMPurify from 'dompurify';
// Arms `==highlight==` on the shared `marked` singleton, as every parse path must for itself.
import '../../../lib/markdownMark';
import { markdownBlocks, renderMarkdownBlock } from '../../../lib/markdownBlocks';

/**
 * The board-note sanitize profile: DOMPurify's defaults plus `style` and `form`.
 *
 * A note's markdown can come from a shared repo. DOMPurify's defaults already strip scripts,
 * handlers and `javascript:` URLs, but they keep `<style>` (which would restyle the whole app
 * from inside a note) and `<form>` (a fake login box drawn on a board). Neither belongs in a
 * note, so both are forbidden here.
 *
 * WHY THIS AND NOT `MarkdownPreview`: MarkdownPreview takes markdown and sanitizes with the
 * default profile, and it has no option to pass a profile in. Its file is not this lane's, so
 * the note renders the same markdown pipeline (`markdownBlocks` + `renderMarkdownBlock`) and
 * sanitizes with this profile before the HTML reaches the DOM.
 */
export const BOARD_NOTE_SANITIZE = {
  FORBID_TAGS: ['style', 'form'],
};

export function renderBoardNote(markdown: string): string {
  return markdownBlocks(markdown)
    .map((block) => DOMPurify.sanitize(renderMarkdownBlock(block), BOARD_NOTE_SANITIZE))
    .join('\n');
}
