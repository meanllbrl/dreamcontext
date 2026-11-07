/**
 * The composer, made roomier (owner 2026-11-07):
 *   1 the checkout chip (`main`, a worktree) sits in the composer's bottom row right after the
 *     `+`, and the shelf leaves it out whenever that composer is the one drawn;
 *   2 while Claude works there are two discs, Stop and Send: the hollow queue disc is gone.
 * The geometry (390 and 1440 px) is proven in a real browser by scripts/verify/composer-sade.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutShelf, splitCheckoutTags, checkoutFact, type ShelfEntry } from '../../dashboard/src/lib/shelfModel.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const COMPOSER = 'dashboard/src/components/sleepy/chat/Composer.tsx';
const CHAT_PANE = 'dashboard/src/components/sleepy/ChatPane.tsx';
const COMPOSER_CSS = 'dashboard/src/components/sleepy/chat/composer.css';

describe('splitCheckoutTags: the checkout chip apart from the pins', () => {
  const branch = checkoutFact({ isRepo: true, branch: 'main', defaultBranch: 'main', worktree: false, worktreeName: null })!;
  const pins: ShelfEntry[] = [
    { kind: 'pin', id: 'dev', weight: 'tag', facts: [{ label: ':5173', url: 'http://localhost:5173' }], updatedAt: 1 },
  ];

  it('takes the server chip out and keeps every agent pin, in order', () => {
    const { checkout, rest } = splitCheckoutTags(layoutShelf(pins, [branch]).tags);
    expect(checkout.map((t) => t.label)).toEqual(['main']);
    expect(checkout[0].icon).toBe('branch');
    expect(rest.map((t) => t.label)).toEqual([':5173']);
  });

  it('a pin whose label looks like a branch stays a pin', () => {
    const own: ShelfEntry[] = [{ kind: 'pin', id: 'fact', weight: 'tag', facts: [{ label: 'release' }], updatedAt: 1 }];
    const { checkout, rest } = splitCheckoutTags(layoutShelf(own, []).tags);
    expect(checkout).toEqual([]);
    expect(rest.map((t) => t.label)).toEqual(['release']);
  });

  it('no checkout reported: nothing to move', () => {
    expect(splitCheckoutTags(layoutShelf(pins, []).tags).checkout).toEqual([]);
  });
});

describe('the chip rides in the composer row, right after the +', () => {
  const src = read(COMPOSER);
  it('the composer draws the pane-supplied chip immediately after the attach button', () => {
    const attach = src.indexOf('<AttachButton onPick={stablePick} />');
    const chip = src.indexOf('{checkoutChip}');
    const spacer = src.indexOf('<div className="chat-cmp-spacer" />');
    expect(attach).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(attach);
    expect(chip).toBeLessThan(spacer);
  });

  it('the pane hands the chip to the composer and tells the shelf to leave it out', () => {
    const pane = read(CHAT_PANE);
    expect(pane).toMatch(/checkoutChip=\{bare \? undefined : <CheckoutChips shelf=\{shelf\}/);
    expect(pane).toContain('checkoutInComposer={composerDrawn}');
  });
});

describe('two discs while Claude works', () => {
  it('no hollow queue disc in the composer, and no style left for one', () => {
    expect(read(COMPOSER)).not.toContain('is-queue');
    expect(read(COMPOSER_CSS)).not.toContain('is-queue');
  });

  it('the deliberate queue keeps a way in: ⌥⏎ while a turn runs', () => {
    expect(read(COMPOSER)).toMatch(/e\.key === 'Enter' && e\.altKey && busy[^\n]*\n\s*e\.preventDefault\(\); submit\('queue'\);/);
  });
});
