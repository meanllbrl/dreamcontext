import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIGHT_LANE_MAX_LINES, guardedReason, isVisiblePath, laneFromGit, parseNumstat, pickLane } from '../../src/lib/run-lane.js';

describe('pickLane', () => {
  it('a small ordinary change takes the light lane', () => {
    const p = pickLane([{ path: 'src/lib/format-date.ts', lines: 120 }, { path: 'tests/unit/format-date.test.ts', lines: 60 }]);
    expect(p).toMatchObject({ lane: 'light', lines: 180, visible: false });
  });

  it('the threshold is exact: one line under is light, at it is full', () => {
    expect(pickLane([{ path: 'src/a.ts', lines: LIGHT_LANE_MAX_LINES - 1 }]).lane).toBe('light');
    expect(pickLane([{ path: 'src/a.ts', lines: LIGHT_LANE_MAX_LINES }]).lane).toBe('full');
  });

  it('a lockfile or generated manifest does not count as size', () => {
    expect(pickLane([{ path: 'src/a.ts', lines: 10 }, { path: 'package-lock.json', lines: 5000 }]).lane).toBe('light');
  });

  it.each([
    ['src/server/auth/login.ts', 'security'],
    ['src/lib/oauth-flow.ts', 'security'],
    ['.env.local', 'security'],
    ['src/lib/secrets.ts', 'security'],
    ['functions/stripe-charge.ts', 'money'],
    ['src/billing/invoice.ts', 'money'],
    ['src/lib/paywall-copy.ts', 'money'],
    ['migrations/0007-add.sql', 'data migration'],
    ['src/lib/migrate-store.ts', 'data migration'],
    ['src/server/permission-check.ts', 'permissions'],
    ['firestore.rules', 'permissions'],
    ['src/hooks/useAuth.ts', 'security'],
    ['web/requireAuth.ts', 'security'],
    ['src/AuthProvider.tsx', 'security'],
    ['src/LoginForm.tsx', 'security'],
    ['src/server/routes/owner-guard.ts', 'security'],
    ['src/server/owner-key.ts', 'security'],
    ['desktop/src-tauri/src/owner_key.rs', 'security'],
    ['src/server/phone-origin.ts', 'security'],
    ['src/lib/git-sync/askpass.cjs', 'security'],
    ['src/server/routes/tasks.ts', 'security'],
    ['config/prod.env', 'security'],
    ['src/PricingCard.tsx', 'money'],
    ['src/purchase.ts', 'money'],
    ['src/entitlements.ts', 'money'],
    ['src/userSchema.ts', 'data migration'],
    ['alembic/versions/a1b2_add.py', 'data migration'],
    ['src/cli/commands/upgrade.ts', 'data migration'],
    ['src/userRoles.ts', 'permissions'],
    ['.claude/settings.json', 'permissions'],
    ['.github/workflows/ci.yml', 'permissions'],
    ['src/JWTVerifier.ts', 'security'],
    ['src/server/CORSMiddleware.ts', 'security'],
    ['src/APIAuth.ts', 'security'],
    ['src/RBACPolicy.ts', 'security'],
    ['src/HMACSigner.ts', 'security'],
    ['src/lib/api-key.ts', 'security'],
    ['src/apiKeys.ts', 'security'],
    ['src/mfa.ts', 'security'],
    ['src/sso.ts', 'security'],
    ['src/oidc.ts', 'security'],
    ['app/api/users/route.ts', 'security'],
    ['src/private-key.pem', 'security'],
    ['.envrc', 'security'],
    ['.npmrc', 'security'],
    ['.claude/agents/reviewer.md', 'permissions'],
    ['skill/SKILL.md', 'permissions'],
    ['skill-packs/agents/reviewer.md', 'permissions'],
    ['agents/reviewer.md', 'permissions'],
    ['CLAUDE.md', 'permissions'],
    ['src/lib/run-lane.ts', 'permissions'],
    ['src/lib/run-budget.ts', 'permissions'],
    ['src/cli/commands/hook.ts', 'permissions'],
    ['.claude/hooks/pre.sh', 'permissions'],
    ['id_rsa', 'security'],
    ['src/OAuth2Client.ts', 'security'],
    ['src/SECRETs.ts', 'security'],
    ['src/auth0.ts', 'security'],
    ['src/signIn.ts', 'security'],
    ['src/allowList.ts', 'permissions'],
  ])('%s never takes the light lane, however small (%s)', (path, why) => {
    const p = pickLane([{ path, lines: 1 }]);
    expect(p.lane).toBe('full');
    expect(p.reason).toContain(why);
  });

  it.each(['src/lib/format-date.ts', 'src/lib/author-name.ts', 'dashboard/src/components/Payload.css', 'dashboard/src/styles/tokens.css', 'src/lib/tokenizer-notes.md'])(
    '%s is an ordinary path', (path) => expect(guardedReason(path)).toBeNull());

  it('an empty diff is no verdict: a reproduction still gets its browser', () => {
    expect(pickLane([]).visible).toBe(true);
  });

  it('says when a browser is due', () => {
    expect(isVisiblePath('dashboard/src/App.tsx')).toBe(true);
    expect(isVisiblePath('src/lib/a.ts')).toBe(false);
    expect(isVisiblePath('tests/unit/a.test.tsx')).toBe(false);
  });

  it('names a verify script the change added, not one it edited', () => {
    const p = pickLane([{ path: 'scripts/verify/new.mjs', lines: 40, added: true }, { path: 'scripts/verify/old.mjs', lines: 2 }]);
    expect(p.customScripts).toEqual(['scripts/verify/new.mjs']);
  });
});

describe('parseNumstat', () => {
  it('reads a binary as no lines', () => {
    expect(parseNumstat('3\t1\ta.ts\0-\t-\tb.png\0')).toEqual([{ path: 'a.ts', lines: 4 }, { path: 'b.png', lines: 0 }]);
  });
});

describe('laneFromGit', () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', ...a], { cwd: repo, stdio: 'ignore' });
  const write = (p: string, lines: number) => {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), 'x\n'.repeat(lines));
  };
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dc-lane-'));
    git('init', '-q', '-b', 'main'); write('src/a.ts', 5); git('add', '-A'); git('commit', '-q', '-m', 'i');
    git('checkout', '-q', '-b', 'work');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('a small real change on a branch is light, committed and untracked lines together', () => {
    write('src/b.ts', 40); git('add', '-A'); git('commit', '-q', '-m', 'b');
    write('src/c.ts', 30);
    expect(laneFromGit(repo)).toMatchObject({ lane: 'light' });
    expect(laneFromGit(repo).lines).toBeGreaterThanOrEqual(70);
  });

  it('a one-line security change in a real repo is full', () => {
    write('src/auth/session.ts', 1);
    const p = laneFromGit(repo);
    expect(p.lane).toBe('full');
    expect(p.reason).toContain('security');
  });

  it('a big change is full', () => {
    write('src/big.ts', 400);
    expect(laneFromGit(repo).lane).toBe('full');
  });

  it('reads the run\'s own trees when given them', () => {
    expect(laneFromGit(repo, 'HEAD', 'HEAD')).toMatchObject({ lane: 'light', lines: 0 });
  });

  it('an unreadable diff is the full lane, never the light one', () => {
    const p = laneFromGit(repo, 'no-such-ref', 'HEAD');
    expect(p.lane).toBe('full');
    expect(p.reason).toContain('could not be read');
  });
});
