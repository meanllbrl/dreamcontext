import { describe, it, expect } from 'vitest';
import { evaluateChecks } from '../../src/lib/onboarding/checks.js';
import { planFixes, nextNeedingUser } from '../../src/lib/onboarding/plan.js';
import type { ExtraFacts } from '../../src/lib/onboarding/types.js';

const FRESH_EXTRA: ExtraFacts = {
  online: true, runningNodeVersion: '24.9.0', npmBesideExec: true, claudeBin: null, cliBinOffPath: null,
  claudeAuth: { loggedIn: false }, ghAuthed: null, github: { connected: false, needsReconnect: false, login: null },
  ptyPresent: false,
};

describe('planFixes', () => {
  it('starts git-install first, then required auto, recommended auto, recommended interactive; never optional', () => {
    const checks = evaluateChecks({ shell: '/bin/zsh', cltInstalled: false }, FRESH_EXTRA, { surface: 'desktop', platform: 'darwin' });
    const plan = planFixes(checks);
    expect(plan[0]).toBe('git-install');
    expect(plan).toEqual(['git-install', 'node-shell-path', 'cli-install', 'claude-install', 'gh-install', 'github-signin']);
    expect(plan).not.toContain('pty-install'); // optional: a row button only
  });

  it('places required interactive fixes after required auto ones', () => {
    const checks = evaluateChecks(
      { shell: '/bin/zsh', node: '/n', nodeVersion: 'v24.0.0', claude: '/c', git: '/g', gh: '/gh' },
      { ...FRESH_EXTRA, ghAuthed: false },
      { surface: 'desktop', platform: 'darwin' },
    );
    expect(planFixes(checks)).toEqual(['cli-install', 'claude-signin', 'github-signin', 'gh-signin']);
  });

  it('is stable: the same facts give the same order', () => {
    const run = () => planFixes(evaluateChecks({ shell: '/bin/zsh' }, FRESH_EXTRA, { surface: 'desktop', platform: 'darwin' }));
    expect(run()).toEqual(run());
  });

  it('plans nothing on the browser surface, and no manual fixes on Linux', () => {
    expect(planFixes(evaluateChecks({ shell: '/bin/zsh' }, FRESH_EXTRA, { surface: 'browser', platform: 'darwin' }))).toEqual([]);
    const linux = planFixes(evaluateChecks({ shell: '/bin/bash' }, FRESH_EXTRA, { surface: 'cli', platform: 'linux', linuxPm: 'apt' }));
    expect(linux).not.toContain('git-install');
    expect(linux).not.toContain('gh-install');
  });
});

describe('nextNeedingUser', () => {
  it('names the first check an automatic fix cannot finish', () => {
    const checks = evaluateChecks(
      { shell: '/bin/zsh', node: '/n', nodeVersion: 'v24.0.0', claude: '/c', dreamcontext: '/d', git: '/g', gh: '/gh' },
      { ...FRESH_EXTRA, ghAuthed: true, github: { connected: true, needsReconnect: false, login: 'a' } },
      { surface: 'desktop', platform: 'darwin' },
    );
    expect(nextNeedingUser(checks)).toBe('claude-auth');
  });
});
