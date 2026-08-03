/**
 * Unit tests for `knowledgeLinkTarget` / `isPdfHref` — where a link written inside a knowledge
 * note actually points.
 *
 * The resolver is the whole reason a note's `[the contract](assets/msa.pdf)` can open: the
 * href is relative to the NOTE, the server route wants a path relative to the VAULT, and
 * getting that translation wrong means the link opens the wrong file or nothing at all.
 */
import { describe, it, expect } from 'vitest';
import { knowledgeLinkTarget, isPdfHref } from '../../dashboard/src/lib/knowledgeLinks';

describe('knowledgeLinkTarget — resolving against the note', () => {
  it('resolves relative to the note’s FOLDER, not the note itself', () => {
    expect(knowledgeLinkTarget('legal/contracts', 'assets/msa.pdf'))
      .toBe('knowledge/legal/assets/msa.pdf');
  });

  it('resolves a sibling file for a note at the knowledge root', () => {
    expect(knowledgeLinkTarget('onboarding', 'handbook.pdf')).toBe('knowledge/handbook.pdf');
  });

  it('handles ./ and ../ the way a path resolver would', () => {
    expect(knowledgeLinkTarget('legal/contracts', './assets/msa.pdf'))
      .toBe('knowledge/legal/assets/msa.pdf');
    expect(knowledgeLinkTarget('legal/contracts', '../shared/policy.pdf'))
      .toBe('knowledge/shared/policy.pdf');
  });

  // An agent tends to write the path from the vault root. Re-anchoring that under the note's
  // folder would point at nothing, so it is taken as written.
  it('takes a `_dream_context/`-prefixed link as written', () => {
    expect(knowledgeLinkTarget('legal/contracts', '_dream_context/knowledge/other/spec.pdf'))
      .toBe('knowledge/other/spec.pdf');
  });

  it('drops a query or fragment before resolving — `msa.pdf#page=4` is the same file', () => {
    expect(knowledgeLinkTarget('legal/contracts', 'assets/msa.pdf#page=4'))
      .toBe('knowledge/legal/assets/msa.pdf');
  });

  // Containment does not rest on the endpoint's check alone: a climb that would escape the
  // vault resolves INSIDE it, so an escaping path is never even constructed.
  it('cannot climb out of the vault', () => {
    expect(knowledgeLinkTarget('legal/contracts', '../../../../etc/passwd'))
      .toBe('etc/passwd');
    expect(knowledgeLinkTarget('legal/contracts', '../../..')).toBe(null);
  });

  it('leaves hrefs that belong to someone else alone', () => {
    // Absolute URLs go to the OS browser; `/…` is an app route or a server endpoint; a
    // fragment is the browser's own business; an absolute filesystem path belongs to the chat
    // surface's file route, which knows about grants.
    for (const href of [
      'https://example.com/a.pdf', 'http://x/y.pdf', 'mailto:a@b.c', '#section',
      '/api/graph/content?path=x.pdf', '/Users/me/handbook.pdf', '', '   ',
    ]) {
      expect(knowledgeLinkTarget('legal/contracts', href)).toBe(null);
    }
  });
});

describe('isPdfHref', () => {
  it('is true for a .pdf, with or without a query or fragment', () => {
    expect(isPdfHref('assets/msa.pdf')).toBe(true);
    expect(isPdfHref('assets/MSA.PDF')).toBe(true);
    expect(isPdfHref('assets/msa.pdf#page=4')).toBe(true);
    expect(isPdfHref('assets/msa.pdf?v=2')).toBe(true);
  });

  it('is false for anything else', () => {
    for (const href of ['notes.md', 'shot.png', 'pdf', 'a.pdfx', '']) {
      expect(isPdfHref(href)).toBe(false);
    }
  });
});
