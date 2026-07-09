import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  handleBrainStatus,
  handleBrainSync,
  handleBrainSettingsGet,
  handleBrainSettingsPost,
  handleBrainOriginCreate,
  handleBrainOriginPreview,
  handleBrainOriginAttach,
  handleBrainOriginUpdate,
  handleBrainOriginDetach,
  handleBrainScrubIgnore,
  handleBrainTeamUpdates,
} from '../../src/server/routes/brain.js';
import { addVault } from '../../src/lib/vaults.js';
import { readSetupConfig, writeBrainLocal } from '../../src/lib/setup-config.js';
import { writeConflictReport } from '../../src/lib/git-sync/conflict-report.js';
import { readFileSync, existsSync } from 'node:fs';

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makeReq(method: string, bodyObj?: unknown): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  const readable = Readable.from(chunks);
  return Object.assign(readable, { method, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
}

let tmpHome: string;
let base: string;
let originalHome: string | undefined;

/** Register a vault with an optional brainRepo config; returns its _dream_context path. */
function makeVault(name: string, brainRepo?: Record<string, unknown>): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  const config: Record<string, unknown> = { platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true };
  if (brainRepo) config.brainRepo = brainRepo;
  writeFileSync(join(projectRoot, '_dream_context', 'state', '.config.json'), JSON.stringify(config), 'utf-8');
  addVault(name, projectRoot);
  return join(projectRoot, '_dream_context');
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `dc-brainroute-home-${stamp}`);
  base = join(tmpdir(), `dc-brainroute-base-${stamp}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(base, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe('brain routes — desktop gate', () => {
  it('403s when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const ctx = makeVault('cur');
    const { res, status } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(403);
  });
});

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('brain routes — status', () => {
  it('reports resolved enabled/source/mode and hasRemote:false for a fresh vault', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().mode).toBe('in-tree');
    expect(body().hasRemote).toBe(false);
    expect(body().source).toBe('derived-unconnected');
    expect(body().enabled).toBe(false);
  });

  it('NEVER reports the code repo origin as the connected brain repo (in-tree)', async () => {
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/meanllbrl/vibe-cto.git']);

    const { res, status, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().mode).toBe('in-tree');
    // The bug this pins: in-tree used to surface the CODE repo origin as `remote`.
    expect(body().remote).toBeNull();
    expect(body().hasRemote).toBe(false);
    expect(body().codeOrigin).toBe('https://github.com/meanllbrl/vibe-cto.git');
    // The github origin still derives cloud sync ON — only the connection claim changes.
    expect(body().enabled).toBe(true);
  });

  it('full-repo mode reports the PROJECT origin as the sync remote (whole folder syncs there)', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/meanllbrl/dreamcontext.git']);

    const { res, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(body().mode).toBe('full-repo');
    expect(body().remote).toBe('https://github.com/meanllbrl/dreamcontext.git');
    expect(body().hasRemote).toBe(true);
    expect(body().codeOrigin).toBe('https://github.com/meanllbrl/dreamcontext.git');
  });
});

// ── item 3: in-progress merge kind (agent vs code vs user) ──
describe('brain routes — status mergeKind', () => {
  function fullRepoWithMerge(): { ctx: string; projectRoot: string } {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/acme/proj.git']);
    // Simulate an in-progress merge (git writes .git/MERGE_HEAD).
    writeFileSync(join(projectRoot, '.git', 'MERGE_HEAD'), 'deadbeef\n', 'utf-8');
    return { ctx, projectRoot };
  }

  it("MERGE_HEAD with NO conflict report → mergeKind 'user' (the user's own git merge, not a team handoff)", async () => {
    const { ctx } = fullRepoWithMerge();
    const { res, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(body().mergeInProgress).toBe(true);
    expect(body().mergeKind).toBe('user');
  });

  it("MERGE_HEAD + a code-conflict report → mergeKind 'code' (human's editor, not the agent)", async () => {
    const { ctx } = fullRepoWithMerge();
    writeConflictReport(ctx, { remoteRef: 'origin/main', resolvedByCli: [], deferred: [], codeConflicts: ['src/app.ts'] });
    const { res, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(body().mergeKind).toBe('code');
  });

  it("MERGE_HEAD + an agent (prose) report → mergeKind 'agent'", async () => {
    const { ctx } = fullRepoWithMerge();
    writeConflictReport(ctx, {
      remoteRef: 'origin/main', resolvedByCli: [],
      deferred: [{ path: 'knowledge/x.md', class: 'knowledge-md', reason: 'r', base: 'b', ours: 'o', theirs: 't' }],
    });
    const { res, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(body().mergeKind).toBe('agent');
  });

  it("a pull-only deferred handoff (pendingAgentMerge, no MERGE_HEAD) is still 'agent'", async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const projectRoot = join(base, 'cur');
    writeBrainLocal(projectRoot, { pendingAgentMerge: true });
    const { res, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(body().mergeKind).toBe('agent');
  });
});

// ── item 6: one-click add-to-.gitignore for scrub-blocked local secret files ──
describe('brain routes — scrub/ignore', () => {
  it('adds a safe local secret file (full-repo → project-root .gitignore) and reports it', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const projectRoot = join(base, 'cur');
    const { res, status, body } = makeRes();
    await handleBrainScrubIgnore(makeReq('POST', { path: 'config/app.env' }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('config/app.env');
  });

  it('in-tree also writes to the project-root .gitignore (the whole project is the staged unit)', async () => {
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    const { res, status } = makeRes();
    await handleBrainScrubIgnore(makeReq('POST', { path: 'lab/credentials.json' }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('lab/credentials.json');
  });

  it('REFUSES a real source file (a secret must be removed, not un-tracked)', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const projectRoot = join(base, 'cur');
    const { res, status, body } = makeRes();
    await handleBrainScrubIgnore(makeReq('POST', { path: 'src/config.ts' }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('unsafe_path');
    expect(existsSync(join(projectRoot, '.gitignore'))).toBe(false);
  });

  it('REFUSES a path traversal attempt', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const { res, status, body } = makeRes();
    await handleBrainScrubIgnore(makeReq('POST', { path: '../../etc/passwd' }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_path');
  });

  it('REFUSES a gitignore NEGATION that would un-ignore a secret (!-prefix injection)', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const projectRoot = join(base, 'cur');
    for (const evil of ['!.env', '!_dream_context/state/.secrets.json']) {
      const { res, status, body } = makeRes();
      await handleBrainScrubIgnore(makeReq('POST', { path: evil }), res, {}, ctx);
      expect(status()).toBe(400);
      expect(body().error).toBe('unsafe_path');
    }
    // Nothing was written — the negation never reached .gitignore.
    expect(existsSync(join(projectRoot, '.gitignore'))).toBe(false);
  });

  it('REFUSES a multi-line payload that would inject arbitrary .gitignore rules', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const { res, status, body } = makeRes();
    await handleBrainScrubIgnore(makeReq('POST', { path: 'pwned.env\n!/.gitignore\ncore.important' }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('unsafe_path');
  });

  it('400s on a missing path', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const { res, status, body } = makeRes();
    await handleBrainScrubIgnore(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
  });
});

describe('brain routes — sync', () => {
  it('returns action:disabled for an unconnected vault (no push, no network)', async () => {
    const ctx = makeVault('cur');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { res, status, body } = makeRes();
    await handleBrainSync(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().action).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('brain routes — settings (master switch = whole-project sync)', () => {
  it('GET reports resolved state + source (github origin derives ON, in-tree by default)', async () => {
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/acme/proj.git']);
    const { res, status, body } = makeRes();
    await handleBrainSettingsGet(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(200);
    // A github origin makes the derived default ON.
    expect(body().enabled).toBe(true);
    expect(body().source).toBe('derived-github-connected');
    expect(body().mode).toBe('in-tree');
  });

  it('enabling requires a project origin — 400 no_origin without one, config untouched', async () => {
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']); // repo but NO origin
    const { res, status, body } = makeRes();
    await handleBrainSettingsPost(makeReq('POST', { enabled: true }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('no_origin');
    expect(readSetupConfig(projectRoot)?.brainRepo?.mode).not.toBe('full-repo');
  });

  it('enabling with an origin flips mode to full-repo + enables sync + autoSync', async () => {
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/meanllbrl/dreamcontext.git']);
    const { res, status, body } = makeRes();
    await handleBrainSettingsPost(makeReq('POST', { enabled: true }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().mode).toBe('full-repo');
    expect(body().enabled).toBe(true);
    expect(body().source).toBe('explicit');
    const cfg = readSetupConfig(projectRoot)?.brainRepo;
    expect(cfg?.mode).toBe('full-repo');
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.autoSync).toBe(true);
  });

  it('disabling reverts to in-tree + pins enabled:false (source flips to explicit)', async () => {
    const projectRoot = join(base, 'cur');
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true, autoSync: true });
    const { res, status, body } = makeRes();
    await handleBrainSettingsPost(makeReq('POST', { enabled: false }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().enabled).toBe(false);
    expect(body().source).toBe('explicit');
    expect(body().mode).toBe('in-tree');
    const config = readSetupConfig(projectRoot);
    expect(config?.brainRepo?.mode).toBe('in-tree');
    expect(config?.brainRepo?.enabled).toBe(false);
  });
});

describe('brain routes — origin setup (create/attach guards)', () => {
  it('create 401s without a GitHub token (before any network call)', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainOriginCreate(makeReq('POST', { name: 'x' }), res, {}, ctx);
    expect(status()).toBe(401);
    expect(body().error).toBe('no_token');
  });

  it('create 409s when the project already has an origin', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/acme/proj.git']);
    const { res, status, body } = makeRes();
    await handleBrainOriginCreate(makeReq('POST', { name: 'x' }), res, {}, ctx);
    expect(status()).toBe(409);
    expect(body().error).toBe('origin_exists');
  });

  it('attach 400s when url is missing', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainOriginAttach(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
  });

  it('attach 401s without a token (url present)', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainOriginAttach(makeReq('POST', { url: 'https://github.com/acme/proj' }), res, {}, ctx);
    expect(status()).toBe(401);
    expect(body().error).toBe('no_token');
  });

  it('attach 409s when the project already has an origin', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/acme/proj.git']);
    const { res, status, body } = makeRes();
    await handleBrainOriginAttach(makeReq('POST', { url: 'https://github.com/acme/other' }), res, {}, ctx);
    expect(status()).toBe(409);
    expect(body().error).toBe('origin_exists');
  });

  it('preview 400s when url is missing', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainOriginPreview(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
  });

  it('all origin routes 403 outside the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const ctx = makeVault('cur');
    for (const handler of [handleBrainOriginCreate, handleBrainOriginPreview, handleBrainOriginAttach, handleBrainOriginUpdate, handleBrainOriginDetach]) {
      const { res, status } = makeRes();
      await handler(makeReq('POST', { url: 'a/b', name: 'x' }), res, {}, ctx);
      expect(status()).toBe(403);
    }
  });
});

describe('brain routes — origin update (re-point) guards', () => {
  it('400s when url is missing', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainOriginUpdate(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
  });

  it('401s without a token (url present)', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainOriginUpdate(makeReq('POST', { url: 'https://github.com/acme/other' }), res, {}, ctx);
    expect(status()).toBe(401);
    expect(body().error).toBe('no_token');
  });

  it('409 no_origin when the project has no origin yet (use Connect instead)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']); // repo but NO origin
    const { res, status, body } = makeRes();
    await handleBrainOriginUpdate(makeReq('POST', { url: 'https://github.com/acme/other' }), res, {}, ctx);
    expect(status()).toBe(409);
    expect(body().error).toBe('no_origin');
  });

  it('re-points the origin to the canonical URL AND turns cloud sync off (in-tree)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true, autoSync: true });
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/acme/old.git']);
    // Mock the GitHub reachability preview (previewOrigin → GET /repos/acme/new).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ full_name: 'acme/new', private: true, default_branch: 'main' }),
    } as unknown as Response);

    const { res, status, body } = makeRes();
    await handleBrainOriginUpdate(makeReq('POST', { url: 'acme/new' }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
    expect(body().remote).toBe('https://github.com/acme/new.git');
    expect(body().syncDisabled).toBe(true);
    // origin actually re-pointed on disk
    expect(sh(projectRoot, ['remote', 'get-url', 'origin'])).toBe('https://github.com/acme/new.git');
    // sync reverted to in-tree so no background pull races the new remote (unrelated histories)
    const cfg = readSetupConfig(projectRoot)?.brainRepo;
    expect(cfg?.mode).toBe('in-tree');
    expect(cfg?.enabled).toBe(false);
    fetchSpy.mockRestore();
  });
});

describe('brain routes — origin detach (disconnect)', () => {
  it('removes the origin and reverts cloud sync to in-tree (disabled)', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true, autoSync: true });
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/acme/proj.git']);

    const { res, status, body } = makeRes();
    await handleBrainOriginDetach(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
    expect(body().remote).toBeNull();
    // origin is gone
    expect(() => sh(projectRoot, ['remote', 'get-url', 'origin'])).toThrow();
    // config reverted to in-tree + disabled (full-repo sync needs an origin)
    const cfg = readSetupConfig(projectRoot)?.brainRepo;
    expect(cfg?.mode).toBe('in-tree');
    expect(cfg?.enabled).toBe(false);
  });

  it('is idempotent when there is no origin (still 200 + reverts to in-tree)', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']); // repo, no origin
    const { res, status, body } = makeRes();
    await handleBrainOriginDetach(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
    expect(readSetupConfig(projectRoot)?.brainRepo?.mode).toBe('in-tree');
  });

  it('REFUSES (409) while a merge is in progress — origin + config left untouched', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true });
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/acme/proj.git']);
    // Simulate an in-progress merge (git writes .git/MERGE_HEAD).
    writeFileSync(join(projectRoot, '.git', 'MERGE_HEAD'), 'deadbeef\n', 'utf-8');

    const { res, status, body } = makeRes();
    await handleBrainOriginDetach(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(409);
    expect(body().error).toBe('merge_in_progress');
    // nothing mutated: origin still there, config still full-repo (merge stays visible)
    expect(sh(projectRoot, ['remote', 'get-url', 'origin'])).toBe('https://github.com/acme/proj.git');
    expect(readSetupConfig(projectRoot)?.brainRepo?.mode).toBe('full-repo');
  });
});

describe('brain routes — team/updates (B6 cache-only)', () => {
  it('reads pulledUpdates from brain-local with ZERO network calls', async () => {
    const projectRoot = join(base, 'cur');
    makeVault('cur', { mode: 'full-repo', enabled: true });
    writeBrainLocal(projectRoot, { pulledUpdates: 3, pendingAgentMerge: true });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { res, status, body } = makeRes();
    await handleBrainTeamUpdates(makeReq('GET'), res);
    expect(status()).toBe(200);
    const cur = body().vaults.find((v: any) => v.name === 'cur');
    expect(cur.updates).toBe(3);
    expect(cur.pendingAgentMerge).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
