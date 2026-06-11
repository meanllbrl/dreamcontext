import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getTaskBackend, LocalTaskBackend } from '../../src/lib/task-backend/index.js';
import { readSetupConfig, updateSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { writeClickUpToken, resolveClickUpToken, maskToken } from '../../src/lib/task-backend/secrets.js';
import { clickupMemberMap, resolvePeople } from '../../src/lib/task-backend/identity.js';
import { ensureRemoteBackendGitignore } from '../../src/lib/task-backend/paths.js';
import { gitignoreCovers } from '../../src/lib/gitignore.js';
import { describeTaskBackendConformance } from './task-backend-conformance.js';

/**
 * SPEC — Pluggable task backend (local | clickup)
 * GitHub: https://github.com/meanllbrl/dreamcontext/issues/11
 * (Revised 2026-06-11: first remote backend is ClickUp via a generic REST
 * ApiAdapter; the original GitHub Projects design stays as a future backend.)
 *
 * Goal: a `TaskBackend` interface both the CLI command actions and the server
 * route handlers call, so tasks can live either on disk (`local`, default,
 * current behavior) or in ClickUp (`clickup`). The dashboard, CLI, recall,
 * SessionStart snapshot, and sleep must all keep working unchanged.
 *
 * Remaining `it.todo`s convert milestone-by-milestone (M2–M5). CI stays green.
 */

const SRC_ROOT = join(__dirname, '..', '..', 'src');

function makeTmpProject(): { projectRoot: string; contextRoot: string; stateDir: string } {
  const raw = join(tmpdir(), `dc-tb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const projectRoot = realpathSync(raw);
  const contextRoot = join(projectRoot, '_dream_context');
  const stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  return { projectRoot, contextRoot, stateDir };
}

const BASE_CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.0.0',
  disableNativeMemory: true,
};

describe('task backend', () => {
  describe('M1 — interface + local backend conformance', () => {
    it('getTaskBackend(config) returns the local backend when taskBackend is "local" or unset', () => {
      const { contextRoot, projectRoot } = makeTmpProject();
      try {
        expect(getTaskBackend(contextRoot, null).name).toBe('local');
        expect(getTaskBackend(contextRoot, { ...BASE_CONFIG }).name).toBe('local');
        expect(getTaskBackend(contextRoot, { ...BASE_CONFIG, taskBackend: 'local' }).name).toBe('local');
        // No .config.json on disk at all → local
        expect(getTaskBackend(contextRoot).name).toBe('local');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('local backend implements every TaskBackend method', () => {
      const { stateDir, projectRoot } = makeTmpProject();
      try {
        const backend = new LocalTaskBackend(stateDir);
        for (const method of [
          'list', 'get', 'create', 'updateFields', 'insertSection',
          'addChangelog', 'complete', 'resolveSlug', 'sync',
        ] as const) {
          expect(typeof backend[method], `missing method ${method}`).toBe('function');
        }
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('GOLDEN: list/create/updateFields/insert/changelog/complete produce byte-identical state/*.md vs the pre-refactor CLI', () => {
      // The byte-level proof lives in tests/unit/task-backend-golden.test.ts,
      // which replays every CLI verb + dashboard endpoint against fixtures
      // recorded on the PRE-refactor implementation. This test pins that the
      // recorded fixtures exist and cover all golden scenarios.
      const fixtureDir = join(__dirname, '..', 'fixtures', 'task-backend-golden');
      expect(existsSync(join(fixtureDir, 'MANIFEST.json'))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(fixtureDir, 'MANIFEST.json'), 'utf-8')) as string[];
      expect(manifest).toEqual(['dash-gamma.md', 'golden-alpha.md', 'golden-beta.md']);
      for (const f of manifest) expect(existsSync(join(fixtureDir, f))).toBe(true);
    });

    it('CLI verbs (list/create/rice/insert/status/complete/log) route through the backend, not direct fs', () => {
      const src = readFileSync(join(SRC_ROOT, 'cli', 'commands', 'tasks.ts'), 'utf-8');
      expect(src).toContain("from '../../lib/task-backend/index.js'");
      expect(src).toContain('getTaskBackend(');
      // No direct file I/O or frontmatter manipulation left in the command layer.
      expect(src).not.toMatch(/from 'node:fs'/);
      expect(src).not.toContain('writeFileSync');
      expect(src).not.toContain('readFrontmatter');
      expect(src).not.toContain('updateFrontmatterFields');
      expect(src).not.toContain('insertToSection(');
    });

    it('server route handlers (GET/POST /api/tasks, GET/PATCH /api/tasks/:slug, /:slug/changelog, /:slug/insert) route through the backend', () => {
      const src = readFileSync(join(SRC_ROOT, 'server', 'routes', 'tasks.ts'), 'utf-8');
      expect(src).toContain("from '../../lib/task-backend/index.js'");
      expect(src).toContain('getTaskBackend(');
      expect(src).not.toMatch(/from 'node:fs'/);
      expect(src).not.toContain('writeFileSync');
      expect(src).not.toContain('readFrontmatter');
      expect(src).not.toContain('updateFrontmatterFields');
      expect(src).not.toContain('insertToSection(');
      expect(src).not.toContain('fast-glob');
    });
  });

  // The conformance suite is THE backend contract: the exact same describe
  // block runs against the ClickUp backend (mocked HTTP) from M3 on.
  describeTaskBackendConformance('local', async () => {
    const { stateDir, projectRoot } = makeTmpProject();
    return {
      backend: new LocalTaskBackend(stateDir),
      cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
    };
  });

  describe('M2 — identity + config + ApiAdapter + token storage', () => {
    it('people roster maps person slugs to ClickUp member IDs (config peopleIdentity)', () => {
      const { contextRoot, projectRoot } = makeTmpProject();
      try {
        const config: SetupConfig = {
          ...BASE_CONFIG,
          people: ['Alice Smith', 'bob'],
          peopleIdentity: {
            'alice-smith': { clickupMemberId: '101', tokenEnv: 'ALICE_CLICKUP_TOKEN' },
            bob: { clickupMemberId: '202' },
          },
        };
        expect(clickupMemberMap(contextRoot, config)).toEqual({ 'alice-smith': '101', bob: '202' });
        const people = resolvePeople(contextRoot, config);
        expect(people.find((p) => p.slug === 'alice-smith')?.tokenEnv).toBe('ALICE_CLICKUP_TOKEN');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('identity roles are seedable from knowledge/team_owners.md when present', () => {
      const { contextRoot, projectRoot } = makeTmpProject();
      try {
        mkdirSync(join(contextRoot, 'knowledge'), { recursive: true });
        writeFileSync(
          join(contextRoot, 'knowledge', 'team_owners.md'),
          '# Team owners\n\n- Engineering: Alice Smith\n- Design: bob\n',
          'utf-8',
        );
        const config: SetupConfig = { ...BASE_CONFIG, people: ['Alice Smith', 'bob'] };
        const people = resolvePeople(contextRoot, config);
        expect(people.find((p) => p.slug === 'alice-smith')?.role).toBe('Engineering');
        expect(people.find((p) => p.slug === 'bob')?.role).toBe('Design');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('per-user token resolution order: per-person env → CLICKUP_TOKEN env → secrets file', () => {
      const { projectRoot } = makeTmpProject();
      const saved = { ...process.env };
      try {
        delete process.env.CLICKUP_TOKEN;
        delete process.env.CLICKUP_API_KEY;
        delete process.env.ALICE_TOKEN;

        // Secrets only → secrets file wins by default
        writeClickUpToken(projectRoot, 'pk_secrets_default');
        writeClickUpToken(projectRoot, 'pk_secrets_alice', 'alice');
        expect(resolveClickUpToken(projectRoot)).toMatchObject({ token: 'pk_secrets_default', source: 'secrets' });
        expect(resolveClickUpToken(projectRoot, { user: 'alice' })).toMatchObject({
          token: 'pk_secrets_alice',
          source: 'secrets',
          via: 'users.alice',
        });

        // Shared env beats secrets
        process.env.CLICKUP_TOKEN = 'pk_env_shared';
        expect(resolveClickUpToken(projectRoot, { user: 'alice' })).toMatchObject({
          token: 'pk_env_shared',
          source: 'env',
          via: 'CLICKUP_TOKEN',
        });

        // Per-person env beats everything
        process.env.ALICE_TOKEN = 'pk_env_alice';
        expect(resolveClickUpToken(projectRoot, { envVar: 'ALICE_TOKEN', user: 'alice' })).toMatchObject({
          token: 'pk_env_alice',
          source: 'env',
          via: 'ALICE_TOKEN',
        });
      } finally {
        process.env.CLICKUP_TOKEN = saved.CLICKUP_TOKEN;
        process.env.CLICKUP_API_KEY = saved.CLICKUP_API_KEY;
        delete process.env.ALICE_TOKEN;
        if (saved.CLICKUP_TOKEN === undefined) delete process.env.CLICKUP_TOKEN;
        if (saved.CLICKUP_API_KEY === undefined) delete process.env.CLICKUP_API_KEY;
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('config clickup-token writes the gitignored secrets file — .gitignore entry is written BEFORE the secrets file exists', () => {
      const { projectRoot } = makeTmpProject();
      try {
        expect(existsSync(join(projectRoot, '.gitignore'))).toBe(false);

        writeClickUpToken(projectRoot, 'pk_order_check');

        const gi = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
        expect(gi).toContain('_dream_context/state/.secrets.json');
        const secrets = join(projectRoot, '_dream_context', 'state', '.secrets.json');
        expect(existsSync(secrets)).toBe(true);
        expect(readFileSync(secrets, 'utf-8')).toContain('pk_order_check');
        // 0600 on POSIX
        if (process.platform !== 'win32') {
          const mode = statSync(secrets).mode & 0o777;
          expect(mode).toBe(0o600);
        }
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('clickup-token aborts (no secrets file) when .gitignore cannot be updated', () => {
      const { projectRoot } = makeTmpProject();
      try {
        // Make .gitignore unwritable-as-a-file: a DIRECTORY occupies the path.
        mkdirSync(join(projectRoot, '.gitignore'));
        expect(() => writeClickUpToken(projectRoot, 'pk_must_not_land')).toThrow(/\.gitignore/);
        // The ordering guarantee: nothing was written.
        expect(existsSync(join(projectRoot, '_dream_context', 'state', '.secrets.json'))).toBe(false);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('config show masks the token (present/absent, never echoed)', () => {
      expect(maskToken('pk_1234567890abcd')).toBe('••••••••abcd');
      expect(maskToken('short')).toBe('••••••••');
      expect(maskToken('pk_1234567890abcd')).not.toContain('pk_');
      // The `config show` line itself is exercised end-to-end in
      // tests/integration/clickup-config.test.ts (full CLI run via dist).
    });

    it('the token never lands in .config.json or any committable file', () => {
      const { projectRoot } = makeTmpProject();
      try {
        writeClickUpToken(projectRoot, 'pk_super_secret_value');
        updateSetupConfig(projectRoot, { taskBackend: 'clickup' });
        const cfg = readFileSync(join(projectRoot, '_dream_context', 'state', '.config.json'), 'utf-8');
        expect(cfg).not.toContain('pk_super_secret_value');
        // The only file holding the token is the secrets file, and it is covered.
        expect(gitignoreCovers(projectRoot, ['_dream_context/state/.secrets.json'])).toBe(true);
        // Full `git add -A` proof lives in tests/integration/clickup-config.test.ts.
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('config task-backend <local|clickup> writes config and gitignores the derived files', () => {
      const { projectRoot } = makeTmpProject();
      try {
        ensureRemoteBackendGitignore(projectRoot);
        updateSetupConfig(projectRoot, { taskBackend: 'clickup', cloudTaskManagement: true });
        const cfg = readSetupConfig(projectRoot);
        expect(cfg?.taskBackend).toBe('clickup');
        expect(cfg?.cloudTaskManagement).toBe(true);
        expect(gitignoreCovers(projectRoot, [
          '_dream_context/state/*.md',
          '_dream_context/state/.tasks-sync.json',
          '_dream_context/state/.tasks-queue.json',
          '_dream_context/state/.conflicts/',
          '_dream_context/state/.secrets.json',
        ])).toBe(true);
        // Re-running is idempotent (no duplicate lines).
        ensureRemoteBackendGitignore(projectRoot);
        const gi = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
        expect(gi.split('\n').filter((l) => l.trim() === '_dream_context/state/*.md')).toHaveLength(1);
        // The CLI command itself is exercised in tests/integration/clickup-config.test.ts.
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    // ApiAdapter contract (generic config, rate-limit queue, retry/backoff,
    // normalized errors) is pinned in tests/unit/api-adapter.test.ts.
  });

  describe('M3 — ClickUp PUSH (watermark-based, one-way)', () => {
    it.todo('clickup backend passes the SAME conformance suite with mocked HTTP transport');
    it.todo('PUSH creates unmapped local tasks remotely and records the id-map (state/.tasks-map.json)');
    it.todo('PUSH only sends tasks changed since last_synced_at (watermark, server time)');
    it.todo('PUSH uses ONE field-level PUT per task, queued under the rate limit');
    it.todo('changelog entries push as ClickUp comments');
    it.todo('PUSH re-run is idempotent: no duplicate tasks, no duplicate comments');
    it.todo('watermarks use ClickUp server time (date_updated), never the local clock');
    it.todo('no ClickUp types leak past the backend boundary (callers/sync engine import none)');
    it.todo('live smoke test against real ClickUp (skipped unless CLICKUP_API_KEY is set)');
  });

  describe('M4 — PULL + two-way merge + offline queue', () => {
    it.todo('PULL is a delta sync: only tasks with date_updated > watermark are re-mirrored');
    it.todo('PULL updates existing mirror files and creates new ones');
    it.todo('comment/changelog union merge is conflict-free (no duplicates, all entries kept)');
    it.todo('status/assignee resolve last-write-wins by server time; updated_by records the winner');
    it.todo('prose body sections 3-way merge using base_snapshot');
    it.todo('missing base_snapshot → ClickUp wins; local copy saved to state/.conflicts/ and surfaced (never silent loss)');
    it.todo('offline writes enqueue to state/.tasks-queue.json (op-id keyed) and replay idempotently');
    it.todo('pending-push tasks are visible (flagged in the mirror/sync state)');
    it.todo('local mirror keeps recall + snapshot working with taskBackend=clickup (no edits to recall.ts/snapshot.ts)');
    it.todo('ledger split: committed state/.tasks-map.json + gitignored state/.tasks-sync.json');
  });

  describe('M5 — triggers + surfaces', () => {
    it.todo('git commit/push hook triggers are non-blocking and can never fail the git operation (adapter forced to error/timeout)');
    it.todo('post-sleep sync routes tasks log/status/insert through the backend idempotently');
    it.todo('.config.json taskBackend + clickup block validated (strict-pick) on PATCH /api/config');
    it.todo('SettingsPage exposes the backend selector + connection test (Cloud Task Management)');
    it.todo('.gitignore updated for mirror/sync/queue/conflict files when clickup is enabled');
    it.todo('default is local; existing projects with no taskBackend field behave exactly as today');
  });
});
