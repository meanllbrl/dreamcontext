// The window chrome's Hands-free button wears the hands-free mark, never the retired cloud mode's
// cloud (owner, 2026-10-21). Checked against the source (root vitest runs under plain Node); the
// painted button, light and dark, off and on, is scripts/verify/handsfree-chrome-button.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../dashboard/src/components/handsfree/HandsfreeButton.tsx', import.meta.url), 'utf-8');

describe('the Hands-free chrome button', () => {
  it('draws the hands-free mark at 16px and no inline svg of its own', () => {
    expect(src).toMatch(/<HandsfreeMark height=\{16\} \/>/);
    expect(src).not.toMatch(/<svg/);
    expect(src).not.toContain('M4.5 12.5h7a3 3 0 0 0 .4-5.97');
  });
  it('marks Mac mode on with a dot only then', () => {
    expect(src).toMatch(/\{macOn && <span className="hf-chrome-dot"/);
  });
});
