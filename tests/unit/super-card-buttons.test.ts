import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardPlaceKey } from '../../dashboard/src/components/sleepy/super/cardMenuModel';

/**
 * Super stage card buttons (owner 2026-11-07, lights 2026-11-08): Mac window controls top left, a
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

describe('the Mac window controls: red close, yellow minimise, green full screen (owner 2026-11-08)', () => {
  it('every card draws the three lights in that order, top left, with no word sliding out', () => {
    expect(CONTAINER).toContain("{one('close', close)}\n      {/* Yellow only where it works: an inert grey dot is not drawn (owner 2026-11-08). */}\n      {minimize.onClick && one('minimize', minimize)}\n      {one('zoom', zoom)}");
    expect(CONTAINER).not.toContain('super-icon-btn-caption');
    expect(CSS).not.toContain('super-icon-btn--caption');
    expect(CSS).toMatch(/\.super-card-lights \{[^}]*position: absolute;[^}]*top: 6px;[^}]*left: 8px;/);
  });
  it('a large card minimises on yellow and opens full screen on green; a floating card has yellow off and green brings it back', () => {
    expect(CONTAINER).toContain("minimize={floating ? { label: t('super.card.minimize') } : { label: t('super.card.minimize'), onClick: () => props.onMinimize(c.id), testId: 'super-card-minimize' }}");
    expect(CONTAINER).toContain("? { label: t('super.card.sideBySide'), onClick: () => props.onSideBySide(c.id), testId: 'super-card-restore' }");
    expect(CONTAINER).toContain(": { label: t('super.card.fullscreen'), onClick: openFull, testId: 'super-card-fullscreen' }}");
  });
  it('minimise is not drawn where it has no action; another control that does not apply stays off and disabled', () => {
    expect(CONTAINER).toContain('disabled={off}');
    expect(CSS).toMatch(/\.super-light:disabled \.super-light-dot \{ background: var\(--color-bg-tertiary\);/);
  });
  it('the colours are always on; the glyphs come on hover and on keyboard focus', () => {
    expect(CSS).toMatch(/\.super-light-dot > svg \{ opacity: 0;/);
    expect(CSS).toMatch(/\.super-card-lights:hover \.super-light-dot > svg,\s*\.super-card-lights:has\(:focus-visible\) \.super-light-dot > svg \{ opacity: 1; \}/);
  });
  it('each light is a 24 px target with a name, a tooltip and a focus ring', () => {
    expect(CSS).toMatch(/\.super-light \{[^}]*width: 24px;[^}]*height: 24px;/);
    expect(CSS).toContain('.super-light:focus-visible { outline: 2px solid var(--color-accent);');
    expect(CONTAINER).toMatch(/className=\{`super-light super-light--\$\{tone\}`\}[\s\S]*?aria-label=\{l\.label\}[\s\S]*?title=\{l\.label\}/);
    expect(CONTAINER).toContain("role=\"group\" aria-label={t('super.card.controls')}");
  });
  it('a large card head starts after the lights and stops before the ask button', () => {
    expect(CSS).toContain(":is(.super-card-head, .super-card-large-head) { padding-left: 88px; padding-right: 44px; }");
  });
  it('the group tile wears the same lights: red closes its cards, green opens them all', () => {
    expect(GROUP).toContain('<CardLights');
    expect(GROUP).toContain("testId: 'super-group-close'");
    expect(GROUP).toContain("testId: 'super-group-open-all'");
  });
  it('a 160 px tile fits the lights and two buttons: To Others moves into its ⋯ menu, Ungroup into the group panel', () => {
    expect(CONTAINER).toContain("{!props.remote && !small && <IconButton icon=\"others\"");
    expect(CONTAINER).toContain("onToOthers={menu === 'more' && !props.remote ? () => { setMenu(null); props.onToOthers(c.id); } : undefined}");
    expect(CONTAINER).toContain('data-testid="super-card-to-others"');
    expect(GROUP).not.toContain('icon="ungroup"');
  });
  it('ask about this sits on the trailing side, larger and in the accent colour', () => {
    expect(CONTAINER).toContain("<AskButton label={t('super.card.askAbout')} onClick={() => props.onAskAbout(c.id)} />");
    expect(CSS).toContain('.super-ask-btn { width: 28px; height: 28px; color: var(--color-accent); }');
  });
  it("a card's close question opens under the red light; the group panel's stays at the right", () => {
    expect(CSS).toContain('.super-card-frame > .super-close-choice { top: 42px; left: 6px; right: auto; }');
    expect(CSS).toMatch(/\.super-close-choice \{\s*position: absolute;\s*top: 38px;\s*right: 6px;/);
  });
  it('no lights on a mini or thumb tile, and none left behind while a closed card fades', () => {
    expect(CONTAINER).toMatch(/\{!thumb && !plan\.mini && \(\s*<CardLights/);
    expect(CSS).toContain(".super-card-frame[data-cue='close'] .super-card-actions,\n.super-card-frame[data-cue='close'] .super-card-lights { display: none; }");
  });
  it('an off light carries no test id, so nothing finds a dead control by name', () => {
    expect(CONTAINER).toContain('data-testid={off ? undefined : l.testId}');
  });
  it('the ⋯ of a small tile names everything it holds', () => {
    expect(CONTAINER).toContain("label={props.remote ? t('super.card.more') : t('super.card.moreWithOthers')}");
  });
  it('Turkish reads Küçült, Kart düğmeleri and Kart ekle', () => {
    const i18n = SRC('context/I18nContext.tsx');
    expect(i18n).toContain("'super.card.minimize': 'Küçült'");
    expect(i18n).toContain("'super.card.controls': 'Kart düğmeleri'");
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
    expect(SURF).toContain("{chat !== 'bar' && (column || onAdd || telegramMember) && (");
  });
  it('the add menu opened under the ⋯ closes on the fold, and focus goes back only to a ⋯ on screen', () => {
    expect(SURF).toContain("useEffect(() => { if (plan.chat === 'bar' && addByButton.current) setAddMenu(null); }, [plan.chat]);");
    expect(SURF).toContain('if (addByButton.current && back?.isConnected && back.offsetParent) back.focus();');
  });
});
