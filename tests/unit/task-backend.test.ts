import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getTaskBackend, LocalTaskBackend } from '../../src/lib/task-backend/index.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
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
    it.todo('people roster maps person slugs to ClickUp member IDs (config peopleIdentity)');
    it.todo('per-user token resolution order: per-person env → CLICKUP_TOKEN env → secrets file');
    it.todo('config clickup-token writes the gitignored secrets file — .gitignore entry is written BEFORE the secrets file exists');
    it.todo('clickup-token aborts (no secrets file) when .gitignore cannot be updated');
    it.todo('config show masks the token (present/absent, never echoed)');
    it.todo('the token never lands in .config.json or any committable file');
    it.todo('ApiAdapter is backend-generic: auth header + base URL config, no ClickUp types');
    it.todo('ApiAdapter rate-limit queue keeps under ~100 req/min and retries 429/5xx with backoff');
    it.todo('ApiAdapter normalizes HTTP failures into typed errors (auth/rate_limited/not_found/server/network)');
    it.todo('config task-backend <local|clickup> CLI writes config; config show reports the backend');
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
