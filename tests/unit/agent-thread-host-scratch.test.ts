/**
 * A thread host with ITS OWN scratch bucket — what a whiteboard's agent card gets.
 *
 * The card lives on a board, not on the Agents page, so its staged chips and its unsent draft
 * cannot ride the page's per-slug bucket: leaving the Agents page would empty a field on a
 * board, and two cards for the same agent would share one draft. `useAgentThreadHost(…, {
 * scratchId })` gives the card a bucket keyed by an id it owns, kept off the page's revoke list
 * and released only through `dropThreadBucket(id)`.
 *
 * The hook is driven through `renderToStaticMarkup`, the same way the lab tests mount
 * dashboard components under root vitest's plain Node: every hook it calls runs on the server
 * renderer, and the host it returns is a stable object the test can then call directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import {
  __resetScratchForTests, addAttachments, dropSentAttachments, readScratch, nextAttachmentId,
  type Attachment,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { useAgentThreadHost, dropThreadScratch, dropThreadBucket } = await import(
  '../../dashboard/src/components/agents/agentsChannelHost.js'
);
type Composer = ReturnType<typeof useAgentThreadHost>;

const TARGET = { slug: 'board-helper', title: 'Board helper', runId: 'run-1' };
const CARD = 'wb-agent:q3-plan:card-1';
const OTHER_CARD = 'wb-agent:q3-plan:card-2';

/** Mount the hook once and hand back what it returned. */
function mount(opts?: { scratchId?: string }, send: (text: string) => void = () => {}): Composer {
  let out: Composer | null = null;
  function Probe() {
    out = useAgentThreadHost(TARGET, send, [], opts);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!out) throw new Error('the hook did not run');
  return out;
}

function chip(path: string): Attachment {
  return { id: nextAttachmentId(), kind: 'ref', name: 'Note · Q3 plan', path };
}

beforeEach(() => {
  dropThreadScratch();
  dropThreadBucket(CARD);
  dropThreadBucket(OTHER_CARD);
  __resetScratchForTests();
});

describe('a host given its own scratchId', () => {
  it('uses that id as the scratch bucket', () => {
    expect(mount({ scratchId: CARD }).host.scratchId).toBe(CARD);
  });

  it('without one, keeps the per-slug page bucket', () => {
    expect(mount().host.scratchId).toBe(`agents-thread-${TARGET.slug}`);
  });

  it('keys the draft by that id: a remount on the same card gets it back, another card does not', () => {
    mount({ scratchId: CARD }).host.syncDraft('what moved this week?');
    expect(mount({ scratchId: CARD }).host.getModel().draft).toBe('what moved this week?');
    expect(mount({ scratchId: OTHER_CARD }).host.getModel().draft).toBe('');
    // …and the same agent on the Agents page has its own field, untouched by the card's.
    expect(mount().host.getModel().draft).toBe('');
  });

  it('a page draft for the same agent does not leak onto the card', () => {
    mount().host.syncDraft('from the Agents page');
    expect(mount({ scratchId: CARD }).host.getModel().draft).toBe('');
  });

  it('is not on the Agents page\'s revoke list: leaving that page keeps the card\'s chips and draft', () => {
    const card = mount({ scratchId: CARD });
    card.host.syncDraft('half a question');
    addAttachments(CARD, [chip('dcref:wb/q3-plan/note-1')]);
    const page = mount();
    addAttachments(page.host.scratchId, [chip('dcref:wb/q3-plan/note-2')]);

    dropThreadScratch();

    expect(readScratch(page.host.scratchId).attachments).toHaveLength(0);
    expect(readScratch(CARD).attachments).toHaveLength(1);
    expect(mount({ scratchId: CARD }).host.getModel().draft).toBe('half a question');
  });

  it('dropThreadBucket(id) releases that bucket\'s chips and draft, and only that bucket', () => {
    mount({ scratchId: CARD }).host.syncDraft('one');
    mount({ scratchId: OTHER_CARD }).host.syncDraft('two');
    addAttachments(CARD, [chip('dcref:wb/q3-plan/a')]);
    addAttachments(OTHER_CARD, [chip('dcref:wb/q3-plan/b')]);

    dropThreadBucket(CARD);

    expect(readScratch(CARD).attachments).toHaveLength(0);
    expect(mount({ scratchId: CARD }).host.getModel().draft).toBe('');
    expect(readScratch(OTHER_CARD).attachments).toHaveLength(1);
    expect(mount({ scratchId: OTHER_CARD }).host.getModel().draft).toBe('two');
    // Idempotent.
    expect(() => dropThreadBucket(CARD)).not.toThrow();
  });

  it('a delivered send clears that bucket\'s draft; a refused one keeps it', () => {
    const sent: string[] = [];
    const card = mount({ scratchId: CARD }, (t) => sent.push(t));
    card.host.syncDraft('   ');
    expect(card.host.send('   ')).toBe(false);
    expect(sent).toEqual([]);

    card.host.syncDraft('summarise the board');
    expect(card.host.send('summarise the board')).toBeUndefined();
    expect(sent).toEqual(['summarise the board']);
    expect(mount({ scratchId: CARD }).host.getModel().draft).toBe('');
  });
});

describe('a ref chip', () => {
  it('is sendable as staged and leaves with the send it went out in', () => {
    addAttachments(CARD, [chip('dcref:wb/q3-plan/note-1')]);
    expect(readScratch(CARD).attachments[0]).toMatchObject({ kind: 'ref', path: 'dcref:wb/q3-plan/note-1' });
    dropSentAttachments(CARD);
    expect(readScratch(CARD).attachments).toHaveLength(0);
  });

  it('goes out as its raw token, never shell-quoted, and draws its own glyph', () => {
    // A source scan: the Composer is a React module with CSS imports behind it. The token is
    // what the server's `expandBoardRefs` matches, so quoting it would hide it from the server.
    const src = readFileSync(
      join(import.meta.dirname, '../../dashboard/src/components/sleepy/chat/Composer.tsx'), 'utf8',
    );
    expect(src).toMatch(/a\.kind === 'ref' \? a\.path \?\? '' : quotePath\(/);
    expect(src).toMatch(/a\.kind === 'ref' \? '📌'/);
    // The chip's class is `chat-cmp-attachment-${kind}`, so `chat-cmp-attachment-ref` follows.
    expect(src).toMatch(/chat-cmp-attachment chat-cmp-attachment-\$\{a\.kind\}/);
  });
});
