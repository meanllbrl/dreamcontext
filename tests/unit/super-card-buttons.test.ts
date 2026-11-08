import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardPlaceKey } from '../../dashboard/src/components/sleepy/super/cardMenuModel';

/**
 * Super stage card buttons (owner 2026-11-07): the minimise glyph shows its word on hover, a
 * card's close menu ("This chat?") belongs to the card where it opened, and that menu offers
 * Minimise. The rendered proof is the screenshots in the task log.
 */
const SRC = (f: string) => readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', ...f.split('/')), 'utf-8');
const CSS = SRC('components/sleepy/super/SuperSurface.css').replace(/\/\*[\s\S]*?\*\//g, '');
const CONTAINER = SRC('components/sleepy/super/SuperContainer.tsx');
const GROUP = SRC('components/sleepy/super/SuperGroupCard.tsx');

const half = { where: 'half', rect: { x: 400, y: 20, width: 620, height: 700 } };

describe('the close menu closes when its card stops being where it opened', () => {
  it('minimised (half → float, smaller) is a new place', () => {
    expect(cardPlaceKey({ where: 'float', rect: { width: 160, height: 213 } }, false)).not.toBe(cardPlaceKey(half, false));
  });
  it('resized in place is a new place', () => {
    expect(cardPlaceKey({ ...half, rect: { ...half.rect, width: 500 } }, false)).not.toBe(cardPlaceKey(half, false));
  });
  it('sent to Others, parked or scrolled out of the strip: off the stage', () => {
    expect(cardPlaceKey({ where: 'others', rect: half.rect }, false)).not.toBe(cardPlaceKey(half, false));
    expect(cardPlaceKey(half, true)).toBe('off');
    expect(cardPlaceKey({ ...half, hidden: true }, false)).toBe('off');
  });
  it('a move alone keeps it: the menu is drawn inside the card and follows it', () => {
    expect(cardPlaceKey({ ...half, rect: { ...half.rect, x: 10, y: 300 } }, false)).toBe(cardPlaceKey(half, false));
  });
  it('the card and the group card both close their menu on a new place', () => {
    for (const src of [CONTAINER, GROUP]) {
      expect(src).toContain('cardPlaceKey(');
      expect(src).toMatch(/if \(openedAt\.current === placeKey\) return;\s*openedAt\.current = placeKey;\s*setCloseAsk\(false\);/);
    }
  });
});

describe('the close menu offers Minimise where the card can be minimised', () => {
  it('a Minimise row, only for a card that is not floating, that minimises and closes the menu', () => {
    expect(CONTAINER).toMatch(/\{!floating && \(\s*<button[^>]*data-testid="super-close-minimize"\s*onClick=\{\(\) => \{ setCloseAsk\(false\); props\.onMinimize\(c\.id\); \}\}>\s*\{t\('super\.card\.minimize'\)\}/);
  });
});

describe('the minimise glyph shows its word on hover and focus', () => {
  it('the minimise button is a captioned IconButton', () => {
    expect(CONTAINER).toContain(`<IconButton icon="minimize" label={t('super.card.minimize')} onClick={() => props.onMinimize(c.id)} testId="super-card-minimize" caption />`);
    expect(CONTAINER).toContain('{caption && <span className="super-icon-btn-caption" aria-hidden>{label}</span>}');
  });
  it('the caption is hidden at rest and slides out on hover and focus-visible', () => {
    expect(CSS).toMatch(/\.super-icon-btn-caption \{[^}]*max-width: 0;[^}]*opacity: 0;/);
    expect(CSS).toMatch(/\.super-icon-btn--caption:hover > \.super-icon-btn-caption,\s*\.super-icon-btn--caption:focus-visible > \.super-icon-btn-caption \{ max-width: 120px; opacity: 1; \}/);
  });
  it('reduced motion drops the slide', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.super-icon-btn--caption,\s*\.super-icon-btn-caption \{ transition: none; \}/);
  });
  it('Turkish reads Küçült and Kart ekle', () => {
    const i18n = SRC('context/I18nContext.tsx');
    expect(i18n).toContain("'super.card.minimize': 'Küçült'");
    expect(i18n).toContain("'super.add.menuItem': 'Kart ekle'");
    expect(i18n).toContain("'super.add.menuItem': 'Add a card'");
    expect(i18n).not.toContain("'super.add.button'");
  });
});

describe('a rail mini tile is one button, with no toolbar on hover', () => {
  it('no hover buttons and no resize handle on a mini tile', () => {
    expect(CONTAINER).toContain('{!thumb && !plan.mini && <div className="super-card-actions">');
    expect(CONTAINER).toContain('{floating && !plan.mini && props.onPressResize && (');
  });
  it('the tile shows it is clickable and carries its name as the tooltip', () => {
    expect(CSS).toContain(".super-card-frame[data-mini='true'] { cursor: pointer; }");
    expect(CONTAINER).toContain("title={plan.mini ? props.title : undefined}");
  });
});

describe('a chat folded to the bar takes its menus with it', () => {
  const SURF = SRC('components/sleepy/super/SuperSurface.tsx');
  it('the ⋯ unmounts with the hidden head, so no menu stays open out of sight', () => {
    expect(SURF).toContain("{chat !== 'bar' && (column || onAdd) && (");
  });
  it('the add menu opened under the ⋯ closes on the fold, and focus goes back only to a ⋯ on screen', () => {
    expect(SURF).toContain("useEffect(() => { if (plan.chat === 'bar' && addByButton.current) setAddMenu(null); }, [plan.chat]);");
    expect(SURF).toContain('if (addByButton.current && back?.isConnected && back.offsetParent) back.focus();');
  });
});
