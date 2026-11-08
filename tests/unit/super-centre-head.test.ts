import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Super Agent chat card's head stays one row at every width (owner 2026-10-28: the name
 * wrapped to two lines and spilled under the head's border). The rendered proof is
 * scripts/verify/super-head.mjs; this pins the rules it rests on.
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'super', 'SuperSurface.css'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('the Super centre head never wraps or spills', () => {
  it('the name stays on one line and is cut with an ellipsis', () => {
    const name = rule('.super-centre-name');
    for (const decl of ['white-space: nowrap', 'text-overflow: ellipsis', 'overflow: hidden', 'min-width: 0']) expect(name).toContain(decl);
  });

  it('the head is a fixed-height row', () => {
    expect(rule('.super-card-large-head')).toContain('height: 40px');
  });

  it('narrow, the Agenda button keeps only its glyph', () => {
    const queries = [...CSS.matchAll(/@container super-centre \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)].map((m) => ({ px: Number(m[1]), body: m[2] }));
    expect(queries.some((q) => /^\s*\.super-fresh-btn \{[^}]*\}\s*\.super-fresh-btn-label \{ display: none; \}/.test(q.body))).toBe(true);
  });
});

/**
 * Less text in the head (owner 2026-11-05, 2026-11-07): no "you talk only to me" subtitle, no
 * worded button at all; Add a card, New session and Turn off behind a ⋯ menu. The rendered proof
 * is scripts/verify/super-head-menu.mjs.
 */
const SRC = (f: string) => readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', ...f.split('/')), 'utf-8');

describe('the Super head keeps Add a card, New session and Turn off in a ⋯ menu', () => {
  const surface = SRC('components/sleepy/super/SuperSurface.tsx');
  const head = surface.slice(surface.indexOf('export function SuperCentreHead'), surface.indexOf('/** How long "Added to Others" stays up. */'));
  const menu = SRC('components/sleepy/super/SuperHeadMenu.tsx');

  it('the head draws no subtitle and no worded New session or Turn off button', () => {
    expect(head).not.toContain('super-centre-sub');
    expect(head).not.toContain('super-turn-off-btn');
    expect(head).not.toContain('NewSessionButton');
    expect(head).toContain('<SuperHeadMenu');
    expect(SRC('context/I18nContext.tsx')).not.toContain("'super.centre.sub'");
  });

  it('the head draws no "+ Add" button: Add a card is the ⋯ menu\'s first row', () => {
    expect(surface).not.toContain('super-add-btn');
    expect(surface).not.toContain("t('super.add.button')");
    expect(surface).toMatch(/onAdd=\{canAdd && [^}]*\? openAddMenu : undefined\}/);
    expect(menu.indexOf('data-testid="super-head-add"')).toBeGreaterThan(-1);
    expect(menu.indexOf('data-testid="super-head-add"')).toBeLessThan(menu.indexOf('data-testid="super-head-fresh"'));
  });

  it('the menu holds New session, Telegram (plan U, owner 2026-11-08), then Turn off under a rule', () => {
    const fresh = menu.indexOf('data-testid="super-head-fresh"');
    const telegram = menu.indexOf('data-testid="super-head-telegram"');
    const rule = menu.indexOf('role="separator"');
    const off = menu.indexOf('data-testid="super-head-off"');
    expect(fresh).toBeGreaterThan(-1);
    expect(telegram).toBeGreaterThan(fresh);
    expect(rule).toBeGreaterThan(telegram);
    expect(off).toBeGreaterThan(rule);
    expect(menu).toContain('role="menu"');
    expect(menu.match(/role="menuitem"/g)?.length).toBe(4);
  });

  it('it asks nothing through a browser dialog (a silent no-op in the desktop app)', () => {
    const code = menu.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b(confirm|alert|prompt)\(/);
  });

  it('it is the stage menu: keyboard, Esc and an outside press close it, and the surface yields Esc to it', () => {
    expect(menu).toContain('useStageMenu(');
    expect(menu).toMatch(/className="super-size-menu super-head-menu"/);
    expect(CSS).toContain('.super-size-menu.super-head-menu {');
  });
});
