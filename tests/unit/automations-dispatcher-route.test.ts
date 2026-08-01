import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * `/api/automations/dispatcher*` + `/api/automations/:slug/enable|disable` —
 * the dashboard's half of the two switches that used to be CLI-only:
 * `automations install/uninstall` (the machine-local scheduler) and
 * `automations enable/disable` (one manifest's own flag).
 *
 * launchd is NEVER touched for real here (the whole launchd module is mocked,
 * matching `automations-launchd.test.ts`'s injected-ExecRunner discipline), and
 * neither is the notifier — building one shells out to osacompile/codesign.
 * `$HOME` is redirected per test so the machine-local registry a real user
 * depends on is never written by a test run: this feature ships disabled, and a
 * suite that quietly registers a project or bootstraps an agent would undo that.
 */

vi.mock('../../src/lib/automations/launchd.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/automations/launchd.js')>();
  return {
    ...actual,
    inspectDispatcher: vi.fn(),
    installDispatcher: vi.fn(),
    uninstallDispatcher: vi.fn(),
  };
});

vi.mock('../../src/lib/automations/notifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/automations/notifier.js')>();
  return {
    ...actual,
    buildNotifierApp: vi.fn(() => ({ built: true, path: '/tmp/fake.app', reason: null })),
    inspectNotifier: vi.fn(() => ({
      supported: true,
      bundlePresent: true,
      bundlePath: '/tmp/fake.app',
      iconPackaged: true,
      queuedPayloads: 0,
      scriptCurrent: true,
    })),
    notifyViaBundle: vi.fn(() => true),
    removeNotifierApp: vi.fn(() => ({ removedBundle: true, removedPayloads: 0 })),
  };
});

import {
  inspectDispatcher,
  installDispatcher,
  uninstallDispatcher,
  dispatcherPlistPath,
  type InstallCheck,
  type InstallResult,
} from '../../src/lib/automations/launchd.js';
import { buildNotifierApp, notifyViaBundle } from '../../src/lib/automations/notifier.js';
import { Router } from '../../src/server/router.js';
import { createAutomation, getAutomation } from '../../src/lib/automations/store.js';
import {
  approveAutomation,
  checkApproval,
  listRegisteredProjects,
  registerProject,
} from '../../src/lib/automations/registry.js';
import {
  handleAutomationsList,
  handleAutomationsRunStatus,
  handleAutomationsShow,
  handleAutomationsRunNow,
  handleAutomationsApprove,
  handleAutomationsSession,
  handleAutomationsEnable,
  handleAutomationsDisable,
  handleAutomationsDispatcherStatus,
  handleAutomationsDispatcherInstall,
  handleAutomationsDispatcherUninstall,
} from '../../src/server/routes/automations.js';

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
}

function makePostReq(body?: unknown): IncomingMessage {
  // Buffers, not strings: `parseJsonBody` concats with `Buffer.concat`, which
  // throws on string chunks and degrades to a null body — a string-chunk helper
  // would make every "the body was honoured" assertion pass vacuously.
  const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')]);
  return Object.assign(readable, { method: 'POST', headers: {} }) as unknown as IncomingMessage;
}

const getReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;

function fakeCheck(over: Partial<InstallCheck> = {}): InstallCheck {
  return {
    resolved: { bin: '/usr/local/bin/dreamcontext', path: '/usr/local/bin:/usr/bin:/bin', shell: '/bin/zsh' },
    runningBin: '/usr/local/bin/dreamcontext',
    mismatch: false,
    plistPresent: true,
    plistCurrent: true,
    wrapperPresent: true,
    wrapperCurrent: true,
    bootstrapped: true,
    logPath: '/tmp/automations.log',
    logSizeBytes: 0,
    ...over,
  } as InstallCheck;
}

function fakeInstallResult(over: Partial<InstallResult> = {}): InstallResult {
  return {
    check: fakeCheck(),
    wroteWrapper: true,
    wrotePlist: true,
    bootstrapped: true,
    method: 'bootstrap',
    warnings: [],
    ...over,
  };
}

let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
  vi.clearAllMocks();
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-dispatch-route-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });

  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-dispatch-home-'));
  process.env.HOME = fakeHome;

  vi.mocked(inspectDispatcher).mockResolvedValue(fakeCheck());
  vi.mocked(installDispatcher).mockResolvedValue(fakeInstallResult());
  vi.mocked(uninstallDispatcher).mockResolvedValue({ bootedOut: true, removedPlist: true, removedWrapper: true });
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

// ─── route order (the same load-bearing constraint `/runs` documents) ────────

describe('route registration order', () => {
  it('/api/automations/dispatcher resolves to the dispatcher handler, never captured as a :slug', () => {
    // Mirrors index.ts's exact registration order for this route family.
    const router = new Router();
    router.get('/api/automations', handleAutomationsList);
    router.get('/api/automations/runs', handleAutomationsRunStatus);
    router.get('/api/automations/dispatcher', handleAutomationsDispatcherStatus);
    router.post('/api/automations/dispatcher/install', handleAutomationsDispatcherInstall);
    router.post('/api/automations/dispatcher/uninstall', handleAutomationsDispatcherUninstall);
    router.get('/api/automations/:slug/session', handleAutomationsSession);
    router.get('/api/automations/:slug', handleAutomationsShow);
    router.post('/api/automations/:slug/run', handleAutomationsRunNow);
    router.post('/api/automations/:slug/approve', handleAutomationsApprove);
    router.post('/api/automations/:slug/enable', handleAutomationsEnable);
    router.post('/api/automations/:slug/disable', handleAutomationsDisable);

    expect(router.match('GET', '/api/automations/dispatcher')?.handler).toBe(handleAutomationsDispatcherStatus);
    expect(router.match('GET', '/api/automations/dispatcher')?.params).toEqual({});
    expect(router.match('POST', '/api/automations/dispatcher/install')?.handler).toBe(handleAutomationsDispatcherInstall);
    expect(router.match('POST', '/api/automations/dispatcher/uninstall')?.handler).toBe(handleAutomationsDispatcherUninstall);

    // …and the slug routes it sits in front of still resolve normally.
    expect(router.match('GET', '/api/automations/eod-digest')?.params).toEqual({ slug: 'eod-digest' });
    expect(router.match('POST', '/api/automations/eod-digest/enable')?.handler).toBe(handleAutomationsEnable);
    expect(router.match('POST', '/api/automations/eod-digest/disable')?.handler).toBe(handleAutomationsDisable);
  });

  it('WOULD misroute /dispatcher as a slug if registered after /:slug (proves the ordering is load-bearing)', () => {
    const router = new Router();
    router.get('/api/automations/:slug', handleAutomationsShow);
    router.get('/api/automations/dispatcher', handleAutomationsDispatcherStatus);
    const match = router.match('GET', '/api/automations/dispatcher');
    expect(match?.handler).toBe(handleAutomationsShow);
    expect(match?.params).toEqual({ slug: 'dispatcher' });
  });
});

// ─── GET dispatcher: read-only, and honest about the three "on but broken" shapes ─

describe('GET /api/automations/dispatcher', () => {
  it('reports a healthy install as installed + current, and never writes anything', async () => {
    registerProject(projectRoot);
    const { res, status, body } = makeRes();
    await handleAutomationsDispatcherStatus(getReq, res, {}, contextRoot);

    expect(status()).toBe(200);
    expect(body().dispatcher).toMatchObject({
      installed: true,
      current: true,
      mismatch: false,
      projectRegistered: true,
    });
    // The decisive assertion for a feature that ships disabled: READING the
    // switch must never flip it.
    expect(installDispatcher).not.toHaveBeenCalled();
    expect(existsSync(dispatcherPlistPath(fakeHome))).toBe(false);
  });

  it('a missing plist reads as not installed', async () => {
    vi.mocked(inspectDispatcher).mockResolvedValue(fakeCheck({ plistPresent: false, bootstrapped: false }));
    const { res, body } = makeRes();
    await handleAutomationsDispatcherStatus(getReq, res, {}, contextRoot);
    expect(body().dispatcher).toMatchObject({ installed: false, current: false });
  });

  /** Files on disk but never booted into launchd: it exists and never fires. */
  it('present-but-not-bootstrapped is NOT installed', async () => {
    vi.mocked(inspectDispatcher).mockResolvedValue(fakeCheck({ bootstrapped: false }));
    const { res, body } = makeRes();
    await handleAutomationsDispatcherStatus(getReq, res, {}, contextRoot);
    expect(body().dispatcher).toMatchObject({ installed: false });
  });

  /** Installed against a CLI that has since moved: wakes on time, then fails. */
  it('a stale wrapper reads installed but NOT current', async () => {
    vi.mocked(inspectDispatcher).mockResolvedValue(fakeCheck({ wrapperCurrent: false }));
    const { res, body } = makeRes();
    await handleAutomationsDispatcherStatus(getReq, res, {}, contextRoot);
    expect(body().dispatcher).toMatchObject({ installed: true, current: false });
  });

  /** The brain-sync shape: manifests are here, the scheduler is healthy, and it
   *  never looks at this project because nothing local ever registered it. */
  it('an unregistered project is reported as such even when the dispatcher is healthy', async () => {
    const { res, body } = makeRes();
    await handleAutomationsDispatcherStatus(getReq, res, {}, contextRoot);
    expect(body().dispatcher).toMatchObject({ installed: true, projectRegistered: false });
  });
});

// ─── POST install ────────────────────────────────────────────────────────────

describe('POST /api/automations/dispatcher/install', () => {
  it('installs, registers THIS project, and primes the notification permission', async () => {
    const { res, status, body } = makeRes();
    await handleAutomationsDispatcherInstall(makePostReq({}), res, {}, contextRoot);

    expect(status()).toBe(200);
    expect(body()).toMatchObject({ installed: true, method: 'bootstrap' });
    expect(installDispatcher).toHaveBeenCalledWith({ force: false });
    // The CLI registers at `create`; a dashboard user can be looking at
    // manifests that arrived over brain sync, where nothing ever did.
    expect(listRegisteredProjects()).toContain(projectRoot);
    expect(buildNotifierApp).toHaveBeenCalled();
    expect(notifyViaBundle).toHaveBeenCalled();
  });

  it('passes force through only when the body asks for it', async () => {
    const { res } = makeRes();
    await handleAutomationsDispatcherInstall(makePostReq({ force: true }), res, {}, contextRoot);
    expect(installDispatcher).toHaveBeenCalledWith({ force: true });
  });

  it('tolerates a completely absent body (force defaults off)', async () => {
    const { res, status } = makeRes();
    await handleAutomationsDispatcherInstall(makePostReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(installDispatcher).toHaveBeenCalledWith({ force: false });
  });

  /**
   * The soft refusal. `installDispatcher` returns (never throws) on a
   * resolution mismatch without --force, having written nothing — so the route
   * must report `installed: false` with the reason, and must NOT do the things
   * a real install does: no registration, no notifier build, no "done" that
   * points at a scheduler which does not exist.
   */
  it('a mismatch refusal reports installed:false and leaves no side effects', async () => {
    vi.mocked(installDispatcher).mockResolvedValue(
      fakeInstallResult({
        check: fakeCheck({ mismatch: true, plistPresent: false, wrapperPresent: false, bootstrapped: false }),
        wroteWrapper: false,
        wrotePlist: false,
        bootstrapped: false,
        method: 'none',
        warnings: ['Resolution mismatch: the dispatcher would run "/other/bin/dreamcontext"…'],
      }),
    );

    const { res, status, body } = makeRes();
    await handleAutomationsDispatcherInstall(makePostReq({}), res, {}, contextRoot);

    expect(status()).toBe(200);
    expect(body().installed).toBe(false);
    expect((body().warnings as string[])[0]).toMatch(/mismatch/i);
    expect(listRegisteredProjects()).not.toContain(projectRoot);
    expect(buildNotifierApp).not.toHaveBeenCalled();
    expect(notifyViaBundle).not.toHaveBeenCalled();
  });

  /**
   * The other way an install "succeeds" and still fires nothing: both files
   * land, then `launchctl bootstrap` AND the legacy `load -w` fallback both
   * fail. Reporting that as installed because bytes were written would be the
   * scheduler-lies failure this feature already refuses elsewhere (raw stdout
   * on a failed run) — `installed` must mean "this will actually fire".
   */
  it('files written but never bootstrapped is NOT installed', async () => {
    vi.mocked(installDispatcher).mockResolvedValue(
      fakeInstallResult({
        check: fakeCheck({ bootstrapped: false }),
        wroteWrapper: true,
        wrotePlist: true,
        bootstrapped: false,
        method: 'none',
        warnings: ['launchctl bootstrap and the legacy load -w fallback both failed: …'],
      }),
    );

    const { res, body } = makeRes();
    await handleAutomationsDispatcherInstall(makePostReq({}), res, {}, contextRoot);

    expect(body().installed).toBe(false);
    // …and the embedded view never contradicts the top-level flag.
    expect((body().dispatcher as Record<string, unknown>).installed).toBe(false);
    expect((body().warnings as string[])[0]).toMatch(/bootstrap/);
    expect(listRegisteredProjects()).not.toContain(projectRoot);
  });

  it('an unsupported platform is a 400 with the reason, not a 500', async () => {
    const { AutomationError } = await import('../../src/lib/automations/types.js');
    vi.mocked(installDispatcher).mockRejectedValue(new AutomationError('The launchd dispatcher is macOS-only'));
    const { res, status, body } = makeRes();
    await handleAutomationsDispatcherInstall(makePostReq({}), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('install_rejected');
    expect(body().message).toMatch(/macOS-only/);
  });
});

// ─── POST uninstall ──────────────────────────────────────────────────────────

describe('POST /api/automations/dispatcher/uninstall', () => {
  it('removes the scheduler and reports the fresh state', async () => {
    vi.mocked(inspectDispatcher).mockResolvedValue(
      fakeCheck({ plistPresent: false, wrapperPresent: false, bootstrapped: false }),
    );
    const { res, status, body } = makeRes();
    await handleAutomationsDispatcherUninstall(makePostReq(), res, {}, contextRoot);

    expect(status()).toBe(200);
    expect(body()).toMatchObject({ bootedOut: true, removedPlist: true, removedNotifier: true });
    expect((body().dispatcher as Record<string, unknown>).installed).toBe(false);
  });

  /** Uninstall removes the SCHEDULER, never the automations — approvals and
   *  manifests both survive, exactly as the CLI verb promises. */
  it('leaves manifests and their approvals untouched', async () => {
    const manifest = createAutomation(contextRoot, {
      slug: 'survivor', title: 'Survivor', days: 'daily', at: '18:00', prompt: 'do the thing',
    });
    approveAutomation(projectRoot, manifest, new Date('2026-08-01T12:00:00.000Z'));

    const { res } = makeRes();
    await handleAutomationsDispatcherUninstall(makePostReq(), res, {}, contextRoot);

    const after = getAutomation(contextRoot, 'survivor');
    expect(after).not.toBeNull();
    expect(checkApproval(projectRoot, after!).approved).toBe(true);
  });
});

// ─── per-automation enable / disable ─────────────────────────────────────────

describe('POST /api/automations/:slug/enable|disable', () => {
  it('404s for a missing slug', async () => {
    const { res, status, body } = makeRes();
    await handleAutomationsEnable(makePostReq(), res, { slug: 'nope' }, contextRoot);
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });

  it('flips the manifest flag and returns the fresh summary', async () => {
    createAutomation(contextRoot, {
      slug: 'toggle-me', title: 'Toggle me', days: 'daily', at: '18:00', prompt: 'do the thing',
    });

    const off = makeRes();
    await handleAutomationsDisable(makePostReq(), off.res, { slug: 'toggle-me' }, contextRoot);
    expect(off.status()).toBe(200);
    expect((off.body().automation as Record<string, unknown>).enabled).toBe(false);
    expect(getAutomation(contextRoot, 'toggle-me')?.enabled).toBe(false);

    const on = makeRes();
    await handleAutomationsEnable(makePostReq(), on.res, { slug: 'toggle-me' }, contextRoot);
    expect((on.body().automation as Record<string, unknown>).enabled).toBe(true);
    expect(getAutomation(contextRoot, 'toggle-me')?.enabled).toBe(true);
  });

  /**
   * REGRESSION LOCK. `enabled` is deliberately not one of the approval-hashed
   * fields, so toggling must never re-block an approved automation — the exact
   * failure `upsertSection`'s whole-file normalization caused for `## Prompt`
   * (a write that touched bytes it had no business touching, discovered only at
   * runtime because the blocked run notified nobody). Toggling both ways proves
   * the frontmatter round-trip is hash-stable, not just the first write.
   */
  it('a toggle NEVER invalidates an existing approval', async () => {
    const manifest = createAutomation(contextRoot, {
      slug: 'stays-approved', title: 'Stays approved', days: 'daily', at: '18:00',
      prompt: 'line one\n\n\nline two after blank lines',
      effort: 'high',
    });
    approveAutomation(projectRoot, manifest, new Date('2026-08-01T12:00:00.000Z'));
    expect(checkApproval(projectRoot, manifest).approved).toBe(true);

    for (const handler of [handleAutomationsDisable, handleAutomationsEnable, handleAutomationsDisable]) {
      const { res, body } = makeRes();
      await handler(makePostReq(), res, { slug: 'stays-approved' }, contextRoot);
      // The route re-summarizes through the same live `checkApproval` the list
      // route uses, so a hash-breaking write shows up right here.
      expect((body().automation as Record<string, unknown>).approved).toBe(true);
      expect(checkApproval(projectRoot, getAutomation(contextRoot, 'stays-approved')!).approved).toBe(true);
    }

    // …and the hashed body sections came back byte-identical, not merely equal
    // after normalization.
    expect(getAutomation(contextRoot, 'stays-approved')?.prompt).toBe('line one\n\n\nline two after blank lines');
  });

  it('enabling does not approve, and cannot make an unapproved automation runnable', async () => {
    createAutomation(contextRoot, {
      slug: 'still-blocked', title: 'Still blocked', days: 'daily', at: '18:00', prompt: 'do the thing',
    });

    const { res, body } = makeRes();
    await handleAutomationsEnable(makePostReq(), res, { slug: 'still-blocked' }, contextRoot);

    expect(body().automation).toMatchObject({ enabled: true, approved: false, approvalReason: 'never-approved' });
  });
});
