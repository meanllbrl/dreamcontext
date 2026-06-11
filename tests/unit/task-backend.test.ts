import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getTaskBackend, LocalTaskBackend, ClickUpTaskBackend } from '../../src/lib/task-backend/index.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { makeFakeClickUp } from './clickup-fake.js';
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
    // PUSH behavior (create+id-map, delta-by-watermark, 1 PUT/task,
    // changelog→comments, idempotent re-run, server-time watermarks, offline
    // WAL replay) is pinned in tests/unit/clickup-push.test.ts against the
    // mocked transport. The live smoke test (gated on CLICKUP_API_KEY) lives
    // in tests/integration/clickup-live.test.ts.

    it('no ClickUp types leak past the backend boundary (callers/sync engine import none)', () => {
      // Callers and the generic layers must be provider-free; only
      // clickup.ts + clickup-map.ts may know ClickUp shapes.
      for (const rel of [
        ['cli', 'commands', 'tasks.ts'],
        ['server', 'routes', 'tasks.ts'],
        ['lib', 'task-backend', 'types.ts'],
        ['lib', 'task-backend', 'local.ts'],
        ['lib', 'task-backend', 'api-adapter.ts'],
        ['lib', 'task-backend', 'sync-state.ts'],
      ]) {
        const src = readFileSync(join(SRC_ROOT, ...rel), 'utf-8');
        expect(src.toLowerCase(), `${rel.join('/')} must not mention clickup`).not.toContain('clickup');
      }
    });

    it('no MCP dependency: the ClickUp backend imports no MCP client (headless by construction)', () => {
      for (const rel of [
        ['lib', 'task-backend', 'clickup.ts'],
        ['lib', 'task-backend', 'clickup-map.ts'],
        ['lib', 'task-backend', 'api-adapter.ts'],
        ['lib', 'task-backend', 'identity.ts'],
        ['lib', 'task-backend', 'secrets.ts'],
        ['lib', 'task-backend', 'index.ts'],
        ['lib', 'task-backend', 'local.ts'],
      ]) {
        const src = readFileSync(join(SRC_ROOT, ...rel), 'utf-8');
        const imports = src.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l));
        for (const line of imports) {
          expect(line.toLowerCase(), `${rel.join('/')} imports MCP: ${line}`).not.toContain('mcp');
        }
        // And no runtime require/dynamic import of an MCP client either.
        expect(src.toLowerCase()).not.toMatch(/require\(['"][^'"]*mcp/);
        expect(src.toLowerCase()).not.toMatch(/import\(['"][^'"]*mcp/);
      }
    });
  });

  // THE SAME conformance suite, against the ClickUp backend with mocked HTTP —
  // the acceptance test that the remote backend is indistinguishable to callers.
  describeTaskBackendConformance('clickup (mocked HTTP transport)', async () => {
    const { contextRoot, projectRoot } = makeTmpProject();
    const fake = makeFakeClickUp();
    let clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    const adapter = new ApiAdapter({
      baseUrl: 'https://api.clickup.com/api/v2',
      authHeaders: () => ({ Authorization: 'pk_test' }),
      fetchImpl: fake.fetchImpl,
      now,
      sleep,
    });
    const config: SetupConfig = {
      ...BASE_CONFIG,
      taskBackend: 'clickup',
      cloudTaskManagement: true,
      clickup: { teamId: 't1', spaceId: 's1', listId: 'l1', changelogTarget: 'comments' },
    };
    return {
      backend: new ClickUpTaskBackend(contextRoot, config, { adapter, now, sleep }),
      cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
    };
  });

  // M4 — PULL + two-way merge + offline queue: converted in
  // tests/unit/clickup-pull.test.ts (delta pull by date_updated > watermark,
  // mirror create/update, comment-union merge, status/assignee LWW by server
  // time with updated_by winner, prose 3-way with base_snapshot, missing base
  // → ClickUp wins + state/.conflicts/ copy surfaced, pending-push
  // visibility, recall-over-mirror, ledger split) and
  // tests/unit/clickup-push.test.ts (offline WAL enqueue + idempotent replay).

  describe('M5 — triggers + surfaces', () => {
    // git hook never-fails-git (CLI forced to error + to hang) and the
    // post-sleep best-effort sync are exercised at the git/CLI level in
    // tests/integration/clickup-hooks.test.ts. PATCH /api/config strict-pick
    // validation lives in tests/unit/config-route-taskbackend.test.ts.

    it('post-sleep sync routes tasks log/status/insert through the backend idempotently', async () => {
      // The sleep-tasks agent mutates tasks via the CLI verbs, which route
      // through getTaskBackend (M1 source-grep test) — so a re-run produces
      // no duplicate remote ops. Direct proof on the backend:
      const { contextRoot, projectRoot } = makeTmpProject();
      const fake = makeFakeClickUp();
      let clock = 1000;
      const adapter = new ApiAdapter({
        baseUrl: 'https://api.clickup.com/api/v2',
        authHeaders: () => ({ Authorization: 'pk_test' }),
        fetchImpl: fake.fetchImpl,
        now: () => (clock += 7),
        sleep: async () => { clock += 1; },
      });
      const backend = new ClickUpTaskBackend(contextRoot, {
        ...BASE_CONFIG,
        taskBackend: 'clickup',
        clickup: { teamId: 't', spaceId: 's', listId: 'l' },
      }, { adapter, now: () => (clock += 7) });
      try {
        await backend.create({ name: 'Sleep Routed', variant: 'cli' });
        await backend.addChangelog('sleep-routed', '### 2026-06-11 - Session Update\n- consolidated');
        await backend.updateFields('sleep-routed', { status: 'in_progress', updated_at: '2026-06-11' });
        await backend.sync('both');
        const commentCount = [...fake.comments.values()].flat().length;
        // Idempotent re-run of the SAME post-sleep flow: no duplicates.
        await backend.sync('both');
        expect(fake.tasks.size).toBe(1);
        expect([...fake.comments.values()].flat()).toHaveLength(commentCount);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('SettingsPage exposes the backend selector + connection test (Cloud Task Management)', () => {
      const src = readFileSync(
        join(SRC_ROOT, '..', 'dashboard', 'src', 'pages', 'SettingsPage.tsx'),
        'utf-8',
      );
      expect(src).toContain("t('settings.cloud_tasks.label')");
      expect(src).toContain('/tasks/sync-test');
      expect(src).toContain('taskBackend');
      // Token is CLI-managed — the page must NOT collect or display it.
      expect(src.toLowerCase()).not.toContain('token_input');
      expect(src).toContain("t('settings.cloud_tasks.token_hint')");
    });

    it('default is local; existing projects with no taskBackend field behave exactly as today', () => {
      const { contextRoot, projectRoot } = makeTmpProject();
      try {
        // Legacy config without the field → local backend, no remote code.
        updateSetupConfig(projectRoot, {});
        const backend = getTaskBackend(contextRoot);
        expect(backend.name).toBe('local');
        expect(readSetupConfig(projectRoot)?.taskBackend).toBeUndefined();
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
