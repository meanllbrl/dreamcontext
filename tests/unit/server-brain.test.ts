import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  handleBrainStatus,
  handleBrainDiscover,
  handleBrainCreate,
  handleBrainAttach,
  handleBrainDisconnect,
  handleBrainSync,
  handleBrainSettingsGet,
  handleBrainSettingsPost,
  handleBrainScope,
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

  it('separate mode reports the brain repo own origin as remote', async () => {
    const ctx = makeVault('cur', { mode: 'separate' });
    sh(ctx, ['init']);
    sh(ctx, ['remote', 'add', 'origin', 'https://github.com/acme/brain.git']);

    const { res, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(body().remote).toBe('https://github.com/acme/brain.git');
    expect(body().hasRemote).toBe(true);
  });

  it('separate mode falls back to the configured remote when the context is not its own repo yet', async () => {
    const ctx = makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git' });
    const { res, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(body().remote).toBe('https://github.com/acme/brain.git');
    expect(body().hasRemote).toBe(true);
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

describe('brain routes — scope (whole project vs brain-only)', () => {
  it('switching to full-repo requires a project origin — 400 no_origin without one', async () => {
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']); // repo but NO origin

    const { res, status, body } = makeRes();
    await handleBrainScope(makeReq('POST', { scope: 'full-repo' }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('no_origin');
    // Config is untouched — mode never flipped to full-repo.
    expect(readSetupConfig(projectRoot)?.brainRepo?.mode).not.toBe('full-repo');
  });

  it('switching to full-repo with an origin flips mode + enables sync + autoSync', async () => {
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/meanllbrl/dreamcontext.git']);

    const { res, status, body } = makeRes();
    await handleBrainScope(makeReq('POST', { scope: 'full-repo' }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().mode).toBe('full-repo');
    expect(body().enabled).toBe(true);
    const cfg = readSetupConfig(projectRoot)?.brainRepo;
    expect(cfg?.mode).toBe('full-repo');
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.autoSync).toBe(true);
  });

  it('switching back to brain reverts full-repo to in-tree when no dedicated brain remote is set', async () => {
    const ctx = makeVault('cur', { mode: 'full-repo', enabled: true, autoSync: true });
    const projectRoot = join(base, 'cur');
    const { res, status, body } = makeRes();
    await handleBrainScope(makeReq('POST', { scope: 'brain' }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().mode).toBe('in-tree');
    expect(readSetupConfig(projectRoot)?.brainRepo?.mode).toBe('in-tree');
  });

  it('rejects an unknown scope', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainScope(makeReq('POST', { scope: 'nonsense' }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
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
    const ctx = makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git', enabled: true });
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

  it('separate mode writes to the brain (_dream_context) .gitignore, not the project root', async () => {
    const ctx = makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git', enabled: true });
    const { res, status } = makeRes();
    await handleBrainScrubIgnore(makeReq('POST', { path: 'lab/credentials.json' }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(readFileSync(join(ctx, '.gitignore'), 'utf-8')).toContain('lab/credentials.json');
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

describe('brain routes — disconnect', () => {
  it('removes the separate brain repo origin + clears the configured remote, pins enabled:false', async () => {
    const ctx = makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git', autoSync: true });
    const projectRoot = join(base, 'cur');
    sh(ctx, ['init']);
    sh(ctx, ['remote', 'add', 'origin', 'https://github.com/acme/brain.git']);

    const { res, status, body } = makeRes();
    await handleBrainDisconnect(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
    expect(() => sh(ctx, ['remote', 'get-url', 'origin'])).toThrow();
    const config = readSetupConfig(projectRoot);
    expect(config?.brainRepo).toEqual({ mode: 'separate', enabled: false });

    const after = makeRes();
    await handleBrainStatus(makeReq('GET'), after.res, {}, ctx);
    expect(after.body().hasRemote).toBe(false);
    expect(after.body().enabled).toBe(false);
  });

  it('in-tree disconnect never touches the code repo remotes', async () => {
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/meanllbrl/vibe-cto.git']);

    const { res, status, body } = makeRes();
    await handleBrainDisconnect(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
    expect(sh(projectRoot, ['remote', 'get-url', 'origin'])).toBe('https://github.com/meanllbrl/vibe-cto.git');
    expect(readSetupConfig(projectRoot)?.brainRepo).toEqual({ mode: 'in-tree', enabled: false });
  });
});

describe('brain routes — create (B4 gate)', () => {
  it('400s when name is missing', async () => {
    const ctx = makeVault('cur');
    const { res, status } = makeRes();
    await handleBrainCreate(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(400);
  });

  it('400s confirmation_required for a PUBLIC create without confirmation (before any network)', async () => {
    const ctx = makeVault('cur');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { res, status, body } = makeRes();
    await handleBrainCreate(makeReq('POST', { name: 'brain', public: true }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('confirmation_required');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('brain routes — discover (B3 auth)', () => {
  it('400s auth_required when no token is available', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainDiscover(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('auth_required');
  });
});

describe('brain routes — attach (B5 trust gate)', () => {
  it('refuses (ok:false) without confirmation', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainAttach(makeReq('POST', { url: 'https://github.com/acme/brain.git', confirmed: false }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(false);
    expect(body().reason).toMatch(/confirmation/i);
  });

  it('attaching an EMPTY remote bootstraps the scrubbed first commit + push (bootstrap:"pushed")', async () => {
    const ctx = makeVault('cur');
    const bare = join(base, 'empty-remote.git');
    execFileSync('git', ['init', '--bare', bare]);
    writeFileSync(join(ctx, 'note.md'), '# a note\n', 'utf-8');

    const { res, status, body } = makeRes();
    await handleBrainAttach(makeReq('POST', { url: bare, confirmed: true }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
    expect(body().bootstrap).toBe('pushed');
    // main was born on the remote with the brain's initial import.
    expect(sh(bare, ['log', '-1', '--format=%s', 'main'])).toBe('chore(brain): initial import');
    expect(sh(bare, ['ls-tree', '--name-only', 'main'])).toContain('note.md');
  });

  it('attaching a remote that already has main does NOT bootstrap (first sync pulls instead)', async () => {
    const ctx = makeVault('cur');
    const bare = join(base, 'existing-remote.git');
    execFileSync('git', ['init', '--bare', bare]);
    // Seed the bare with one commit so refs/heads/main exists.
    const seed = join(base, 'seed');
    execFileSync('git', ['clone', bare, seed]);
    writeFileSync(join(seed, 'seeded.md'), 'existing brain content\n', 'utf-8');
    sh(seed, ['add', '-A']);
    sh(seed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed']);
    sh(seed, ['push', 'origin', 'HEAD:main']);

    const { res, status, body } = makeRes();
    await handleBrainAttach(makeReq('POST', { url: bare, confirmed: true }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
    expect(body().bootstrap).toBeUndefined();
    // The remote's history is untouched — attach never pushes over existing content.
    expect(sh(bare, ['log', '--format=%s', 'main']).trim()).toBe('seed');
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

describe('brain routes — settings (SW2 master switch)', () => {
  it('GET reports resolved state + source', async () => {
    const ctx = makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git' });
    const { res, status, body } = makeRes();
    await handleBrainSettingsGet(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(200);
    // A configured remote makes the derived default ON.
    expect(body().enabled).toBe(true);
    expect(body().source).toBe('derived-github-connected');
    expect(body().mode).toBe('separate');
  });

  it('POST persists via updateSetupConfig spread — mode/remote preserved, source flips to explicit', async () => {
    const projectRoot = join(base, 'cur');
    const ctx = makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git' });
    const { res, status, body } = makeRes();
    await handleBrainSettingsPost(makeReq('POST', { enabled: false }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().enabled).toBe(false);
    expect(body().source).toBe('explicit');
    // The spread preserved the pre-existing brainRepo fields (updateSetupConfig
    // replaces brainRepo wholesale, so a naive patch would have dropped them).
    const config = readSetupConfig(projectRoot);
    expect(config?.brainRepo?.mode).toBe('separate');
    expect(config?.brainRepo?.remote).toBe('https://github.com/acme/brain.git');
    expect(config?.brainRepo?.enabled).toBe(false);
  });
});

describe('brain routes — team/updates (B6 cache-only)', () => {
  it('reads pulledUpdates from brain-local with ZERO network calls', async () => {
    const projectRoot = join(base, 'cur');
    makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git' });
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
