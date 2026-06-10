import { describe, it, expect } from 'vitest';

import {
  UPSTREAM_REPO,
  FEEDBACK_LABEL,
  FEEDBACK_MARKER,
  FEEDBACK_CATEGORIES,
  isFeedbackCategory,
  parseGhAccount,
  detectGitHubCli,
  buildIssueBody,
  labelsFor,
  normalizeTitle,
  titleSimilarity,
  findDuplicate,
  createIssue,
  type CommandRunner,
  type EnvironmentInfo,
  type IssueRef,
} from '../../src/lib/feedback.js';

const ENV: EnvironmentInfo = {
  dreamcontextVersion: '0.7.0',
  node: 'v20.0.0',
  os: 'darwin 25.3.0 (arm64)',
};

// ── category guard ────────────────────────────────────────────────────────────
describe('categories', () => {
  it('accepts known categories and rejects others', () => {
    expect(isFeedbackCategory('bug')).toBe(true);
    expect(isFeedbackCategory('missing-cli')).toBe(true);
    expect(isFeedbackCategory('nonsense')).toBe(false);
  });

  it('every category yields the marker label first', () => {
    for (const c of FEEDBACK_CATEGORIES) {
      expect(labelsFor(c)[0]).toBe(FEEDBACK_LABEL);
    }
  });

  it('maps a bug to the built-in bug label and a feature to enhancement', () => {
    expect(labelsFor('bug')).toContain('bug');
    expect(labelsFor('feature')).toContain('enhancement');
    expect(labelsFor('other')).toEqual([FEEDBACK_LABEL]);
  });
});

// ── gh detection ────────────────────────────────────────────────────────────
describe('detectGitHubCli', () => {
  it('reports not-installed when gh --version fails', () => {
    const run: CommandRunner = () => ({ ok: false, stdout: '', stderr: 'not found' });
    expect(detectGitHubCli(run)).toEqual({ installed: false, authenticated: false });
  });

  it('reports installed-but-unauthenticated', () => {
    const run: CommandRunner = (_cmd, args) => {
      if (args[0] === '--version') return { ok: true, stdout: 'gh version 2.0', stderr: '' };
      return { ok: false, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
    };
    const status = detectGitHubCli(run);
    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(false);
  });

  it('parses the account when authenticated', () => {
    const authText = '✓ Logged in to github.com account meanllbrl (keyring)';
    const run: CommandRunner = (_cmd, args) => {
      if (args[0] === '--version') return { ok: true, stdout: 'gh version 2.0', stderr: '' };
      return { ok: true, stdout: authText, stderr: '' };
    };
    const status = detectGitHubCli(run);
    expect(status.authenticated).toBe(true);
    expect(status.account).toBe('meanllbrl');
  });

  it('detects auth even when gh writes status to stderr with non-zero exit', () => {
    const run: CommandRunner = (_cmd, args) => {
      if (args[0] === '--version') return { ok: true, stdout: 'gh version 2.0', stderr: '' };
      return { ok: false, stdout: '', stderr: '✓ Logged in to github.com account octocat (oauth_token)' };
    };
    const status = detectGitHubCli(run);
    expect(status.authenticated).toBe(true);
    expect(status.account).toBe('octocat');
  });
});

describe('parseGhAccount', () => {
  it('returns undefined when no account line', () => {
    expect(parseGhAccount('not logged in')).toBeUndefined();
  });
});

// ── body template ─────────────────────────────────────────────────────────────
describe('buildIssueBody', () => {
  it('includes every section heading, the env block, and the marker', () => {
    const body = buildIssueBody(
      {
        category: 'missing-cli',
        title: 'Add tasks reopen',
        scenario: 'User asked to reopen a completed task.',
        proposal: 'Add `tasks reopen <id>`.',
      },
      ENV,
    );
    expect(body).toContain('### Scenario');
    expect(body).toContain('### Expected');
    expect(body).toContain('### Gap');
    expect(body).toContain('### Reproduction');
    expect(body).toContain('### Proposed improvement');
    expect(body).toContain('User asked to reopen a completed task.');
    expect(body).toContain('Add `tasks reopen <id>`.');
    expect(body).toContain('dreamcontext: `0.7.0`');
    expect(body).toContain('category: `missing-cli`');
    expect(body).toContain(FEEDBACK_MARKER);
  });

  it('fills omitted fields with a not-provided placeholder', () => {
    const body = buildIssueBody(
      { category: 'bug', title: 't', scenario: 's' },
      ENV,
    );
    expect(body).toContain('_(not provided)_');
  });
});

// ── dedup ─────────────────────────────────────────────────────────────────────
describe('title similarity + dedup', () => {
  it('normalizes conventional-commit prefixes and punctuation', () => {
    expect(normalizeTitle('feat(tasks): Add `reopen`!!')).toBe('add reopen');
  });

  it('scores identical titles at 1 and disjoint at 0', () => {
    expect(titleSimilarity('add reopen command', 'add reopen command')).toBe(1);
    expect(titleSimilarity('alpha beta', 'gamma delta')).toBe(0);
  });

  it('finds a near-duplicate above threshold', () => {
    const existing: IssueRef[] = [
      { number: 7, title: 'feat(tasks): add a reopen command', url: 'u7' },
      { number: 8, title: 'totally unrelated thing', url: 'u8' },
    ];
    const dup = findDuplicate('Add tasks reopen command', existing);
    expect(dup?.number).toBe(7);
  });

  it('returns undefined when nothing is similar enough', () => {
    const existing: IssueRef[] = [{ number: 1, title: 'fix the dashboard css', url: 'u1' }];
    expect(findDuplicate('Add a brand new export command', existing)).toBeUndefined();
  });
});

// ── createIssue ────────────────────────────────────────────────────────────────
describe('createIssue', () => {
  const input = { category: 'feature' as const, title: 'X', scenario: 's' };

  it('targets the upstream repo and returns the printed url', () => {
    let captured: string[] = [];
    const run: CommandRunner = (_cmd, args) => {
      captured = args;
      return { ok: true, stdout: 'https://github.com/meanllbrl/dreamcontext/issues/42\n', stderr: '' };
    };
    const res = createIssue(input, 'body', run);
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://github.com/meanllbrl/dreamcontext/issues/42');
    expect(captured).toContain('--repo');
    expect(captured[captured.indexOf('--repo') + 1]).toBe(UPSTREAM_REPO);
  });

  it('retries without labels when the first create fails', () => {
    let calls = 0;
    const run: CommandRunner = (_cmd, args) => {
      calls++;
      const hasLabel = args.includes('--label');
      if (hasLabel) return { ok: false, stdout: '', stderr: 'could not add label' };
      return { ok: true, stdout: 'https://github.com/meanllbrl/dreamcontext/issues/43', stderr: '' };
    };
    const res = createIssue(input, 'body', run);
    expect(calls).toBe(2);
    expect(res.ok).toBe(true);
    expect(res.url).toContain('/issues/43');
  });

  it('reports an error when both attempts fail', () => {
    const run: CommandRunner = () => ({ ok: false, stdout: '', stderr: 'boom' });
    const res = createIssue(input, 'body', run);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
  });
});
