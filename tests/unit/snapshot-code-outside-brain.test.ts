import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateSnapshot, renderCodeOutsideBrainRule } from '../../src/cli/commands/snapshot.js';

/**
 * The code-outside-the-brain rule (owner, 2026-10-17) is a must-not-miss rule, so its text is
 * pinned here word for word (knowledge/patterns/hook-delivered-must-not-miss-rules): a reworded
 * rule that drops "push back" or the link recipe would still render and still look compliant.
 * Its PLACEMENT in the snapshot (the never-evict linked-repos group, ahead of the soul) is
 * pinned by the byte-identity goldens, whose fixture links a repo; the no-linked-repos render
 * is driven below on a copy of that fixture with its link removed.
 */
describe('renderCodeOutsideBrainRule', () => {
  const TAIL =
    'A NEW project gets its own folder beside the brain, never inside it: `git init` it, then ' +
    '`dreamcontext link add <name> <path> --url <owner>/<repo>`. Asked to write code in the ' +
    "brain's repo? Push back once (every worktree of it forks `_dream_context/`) and do it only " +
    'if the user explicitly insists.\n';

  it('with linked repos: code goes to the linked repo', () => {
    expect(renderCodeOutsideBrainRule(true)).toEqual([
      '## Code lives outside the brain\n',
      "The brain's folder and repo hold NO project code. Code lives in a linked repo above, edited there. " + TAIL,
    ]);
  });

  it('without linked repos: code already beside the brain is flagged once and the split is offered', () => {
    expect(renderCodeOutsideBrainRule(false)).toEqual([
      '## Code lives outside the brain\n',
      "The brain's folder and repo hold NO project code. No code repo is linked yet: if code already " +
        'lives next to the brain, say so once and offer to move it into its own repo and link it. ' + TAIL,
    ]);
  });
});

describe('the rule in a real snapshot of a vault with NO linked repos', () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'snapshot-golden', 'vault');
  const saved = { home: process.env.HOME, cwd: process.cwd(), drift: process.env.DREAMCONTEXT_DRIFT_CHECK };
  let scratch: string;

  afterEach(() => {
    process.chdir(saved.cwd);
    process.env.HOME = saved.home;
    if (saved.drift === undefined) delete process.env.DREAMCONTEXT_DRIFT_CHECK;
    else process.env.DREAMCONTEXT_DRIFT_CHECK = saved.drift;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('renders the no-linked variant ahead of the soul, with no Linked repos block', () => {
    scratch = mkdtempSync(join(tmpdir(), 'dc-cob-'));
    const vault = join(scratch, 'vault');
    cpSync(FIXTURE, vault, { recursive: true });
    const cfgPath = join(vault, '_dream_context', 'state', '.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    delete cfg.linkedRepos;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    process.env.HOME = mkdtempSync(join(scratch, 'home-'));
    process.env.DREAMCONTEXT_DRIFT_CHECK = '0';
    process.chdir(vault);

    const text = generateSnapshot(join(vault, '_dream_context'));
    expect(text).not.toContain('## Linked repos');
    const rule = text.indexOf('## Code lives outside the brain');
    expect(rule).toBeGreaterThan(-1);
    expect(text).toContain('No code repo is linked yet: if code already lives next to the brain, say so once');
    expect(rule).toBeLessThan(text.indexOf('## Soul'));
  });
});
