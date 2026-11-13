/**
 * The board composer's pictures and files (owner 12 Nov: drop and paste into the quick edit
 * field, and the file must reach the prompt). Staged in the Chat composer's own store
 * (composerScratch: `stageUpload`, the same upload channel and chips), under the board's own
 * conversation id, and sent two ways:
 *
 * - quick edit: the uploaded paths go with the request; the server reads them into the turn;
 * - Ask Super: the message carries them exactly as a Chat message does (`[Picture N: <path>]`,
 *   a quoted path for a file), composed by the Chat's own `composeOutgoing`.
 */
import { composeOutgoing, removeAttachment, type Attachment } from '../sleepy/chat/composerScratch';
import { refToken } from '../sleepy/chat/composerRefs';
import { quotePath } from '../../lib/agentComposer';

/** At most this many ride one request (the server's QUICK_ATTACH_MAX). */
export const BOARD_ATTACH_MAX = 6;

/** The conversation id the board field stages its attachments under (one per board). */
export const boardAttachConv = (board: string): string => `board-field:${board}`;

/** The attachments the field shows and sends: pictures and files, in the order staged. */
export const fieldAttachments = (staged: readonly Attachment[]): Attachment[] =>
  staged.filter((a) => a.kind === 'image' || a.kind === 'file');

/** Sendable: uploaded, not refused. */
const sendable = (a: Attachment): boolean => !a.failed && !a.uploading && !!a.path;

/**
 * After a send, take off exactly the chips that went (review r1): a picture dropped while the send
 * was on its way stays for the next request, never wiped as if it had been sent.
 */
export function dropCarried(conv: string, carried: readonly Attachment[]): void {
  for (const a of carried) if (sendable(a)) removeAttachment(conv, a.id);
}

/** The uploaded paths a quick edit sends (a refused upload is left out, its chip says so). */
export function quickAttachmentPaths(atts: readonly Attachment[]): string[] {
  return atts.filter(sendable).map((a) => a.path!).slice(0, BOARD_ATTACH_MAX);
}

/**
 * The Super message: the field's text, then each attachment as the Chat writes it. Each one is
 * put in as its chip token at the end, so the Chat's composer places `[Picture N: <path>]` lines
 * after the words, the way a Chat message with its pictures after the text reads.
 */
export function superMessageWith(text: string, atts: readonly Attachment[]): string {
  const going = atts.filter(sendable).map((a) => ({ ...a, inline: true, pending: false }));
  if (!going.length) return text;
  const draft = `${text}\n${going.map((a) => refToken(a)).join(' ')}`;
  return composeOutgoing(draft, going, null, quotePath).message;
}
