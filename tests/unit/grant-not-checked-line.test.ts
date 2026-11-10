/**
 * The always-sizes' "not checked" line (owner, 11 Nov): ONE short line naming the folder relative
 * to the root the script lives in, never an absolute path a person cannot read.
 */
import { describe, expect, it } from 'vitest';
import { notCheckedLine } from '../../src/lib/super/inbox.js';

const PROJECT = '/Users/someone/projects/acme-storefront';
const WT = '/Users/someone/.claude-worktrees/acme-storefront-weekly';

describe('notCheckedLine', () => {
  it('names the folder relative to its root, in the project or a worktree', () => {
    expect(notCheckedLine(`${PROJECT}/tools/weekly-total.mjs`, [PROJECT, WT])).toBe('What it loads from tools/ is not checked.');
    expect(notCheckedLine(`${WT}/scripts/verify/look.mjs`, [PROJECT, WT])).toBe('What it loads from scripts/verify/ is not checked.');
  });
  it('a script at a root reads as the project; never an absolute path', () => {
    expect(notCheckedLine(`${PROJECT}/run.mjs`, [PROJECT])).toBe('What it loads from the project is not checked.');
    const line = notCheckedLine('/private/var/folders/8h/T/x/acme/tools/a.mjs', ['/private/var/folders/8h/T/x/acme']);
    expect(line).toBe('What it loads from tools/ is not checked.');
    expect(line).not.toContain('/private');
  });
  it('the most specific root wins (a worktree under a project path)', () => {
    expect(notCheckedLine(`${PROJECT}/.wt/a/tools/x.mjs`, [PROJECT, `${PROJECT}/.wt/a`])).toBe('What it loads from tools/ is not checked.');
  });
});
