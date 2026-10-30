/**
 * D11's stated exception (task codex-tarzi-yeni-kabuk W1, AC 5c): the chat cards' full-screen
 * views are portaled to `document.body`, outside every `.project-instance`, so the new shell's
 * `.project-instance[data-shell="new"] .fullscreen-overlay` rule can never reach them; they keep
 * today's `top: var(--header-height)` under the (same-height) title bar. Knowledge's view is the
 * one in place, and the one the rule bounds.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'dashboard', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf-8');

describe("portaled full-screen views keep today's coverage", () => {
  for (const f of ['components/sleepy/chat/HtmlView.tsx', 'components/sleepy/chat/SurveyCard.tsx', 'components/sleepy/chat/BoardEmbed.tsx']) {
    it(`${f} portals its FullscreenOverlay to document.body`, () => {
      const src = read(f);
      const at = src.indexOf('<FullscreenOverlay');
      expect(at).toBeGreaterThan(-1);
      const portal = src.lastIndexOf('createPortal(', at);
      expect(portal).toBeGreaterThan(-1);
      expect(src.slice(at, src.indexOf('document.body', at) + 13)).toContain('document.body');
    });
  }
  it('Knowledge renders its FullscreenOverlay in place (no portal)', () => {
    const src = read('pages/KnowledgePage.tsx');
    expect(src).toContain('<FullscreenOverlay');
    expect(src).not.toContain('createPortal');
  });
  it("the new-shell rule is scoped under the instance; the overlay's own rule still places it under the bar", () => {
    expect(read('components/layout/newshell/NewShell.css')).toMatch(/\.project-instance\[data-shell="new"\] \.fullscreen-overlay \{/);
    expect(read('components/layout/FullscreenOverlay.css')).toMatch(/top: var\(--header-height\)/);
    expect(read('styles/tokens.css')).toMatch(/--titlebar-height: 42px/);
  });
});
