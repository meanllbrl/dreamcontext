/**
 * REAL-path containment on the chat surface's file routes.
 *
 * `resolveChatReference` decides "inside the project?" LEXICALLY — it compares resolved
 * strings — so a symlink that lives inside the project and points out of it is inside by
 * that test and outside in fact. That gap is reachable rather than theoretical: an agent's
 * thread `files[]` paths are read back off disk, and for a SHARED agent those files are
 * written by whoever syncs the brain.
 *
 * The fix re-takes the decision over real paths, and the failure direction is the one that
 * ASKS: a symlinked-out target becomes `needs_grant` — the existing consent card — never a
 * silent serve. Driven through the real route rather than the private helper, because what
 * matters is what the endpoint answers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAgentFile } from '../../src/server/routes/agent-chat.js';

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; return res; },
    setHeader() {},
    end(data?: string) { if (data) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } } },
    on() { return res; },
    once() { return res; },
    emit() { return false; },
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
}

function makeReq(path: string): IncomingMessage {
  return { url: `/api/agent/file?path=${encodeURIComponent(path)}`, headers: { host: 'localhost' } } as unknown as IncomingMessage;
}

let projectRoot: string;
let contextRoot: string;
let outsideDir: string;
let realDesktop: string | undefined;

beforeEach(() => {
  realDesktop = process.env.DREAMCONTEXT_DESKTOP;
  // The route is desktop-gated and that gate STAYS — set it so the test reaches the
  // containment decision instead of stopping at a 403 that proves nothing.
  process.env.DREAMCONTEXT_DESKTOP = '1';
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-agentfile-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  writeFileSync(join(contextRoot, 'automations', 'real.md'), '# real\n', 'utf-8');

  outsideDir = mkdtempSync(join(tmpdir(), 'dc-agentfile-outside-'));
  writeFileSync(join(outsideDir, 'secret.md'), 'ssh keys\n', 'utf-8');
});

afterEach(() => {
  if (realDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
  else process.env.DREAMCONTEXT_DESKTOP = realDesktop;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('GET /api/agent/file — realpath containment', () => {
  it('answers needs_grant for a symlink inside the project pointing outside it', async () => {
    symlinkSync(join(outsideDir, 'secret.md'), join(contextRoot, 'automations', 'link.md'));
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('_dream_context/automations/link.md'), res, {}, contextRoot);
    // Not the bytes, and not a flat 400 either: this is exactly the case the consent card
    // exists for, so the user gets asked rather than silently refused.
    expect(status()).toBe(403);
    expect(body().error).toBe('needs_grant');
  });

  it('answers needs_grant for a real file under a symlinked DIRECTORY', async () => {
    // The case `lstat` on the leaf misses entirely — the leaf is a perfectly ordinary file.
    symlinkSync(outsideDir, join(contextRoot, 'automations', 'linked'));
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('_dream_context/automations/linked/secret.md'), res, {}, contextRoot);
    expect(status()).toBe(403);
    expect(body().error).toBe('needs_grant');
  });

  it('404s a MISSING in-project path — a file that is not there is not a containment answer', async () => {
    // `realpathSync` throws ENOENT for a path that does not exist. Treating that like any
    // other failure turned every not-found into a needs_grant card offering access to a
    // file nobody has — which is both wrong and a worse answer than the truth.
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('_dream_context/automations/gone.md'), res, {}, contextRoot);
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });

  it('404s a DANGLING symlink — it resolves to nothing, so there is nothing to disclose', async () => {
    symlinkSync(join(outsideDir, 'never-existed.md'), join(contextRoot, 'automations', 'dangling.md'));
    const { res, status } = makeRes();
    await handleAgentFile(makeReq('_dream_context/automations/dangling.md'), res, {}, contextRoot);
    expect(status()).toBe(404);
  });

  it('FAILS CLOSED on a realpath error that is not ENOENT — unverified must ask, not serve', async () => {
    // Resolving THROUGH a regular file gives ENOTDIR, which is the cheapest stand-in for
    // the class this arm exists for: a permission error, a symlink loop, a race. ENOENT is
    // the one benign case and it is handled above; everything else must still land on the
    // consent card rather than being waved through.
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('_dream_context/automations/real.md/child.md'), res, {}, contextRoot);
    expect(status()).toBe(403);
    expect(body().error).toBe('needs_grant');
  });

  it('still serves an ordinary in-project file — the harder check did not break the normal path', async () => {
    const { res, status } = makeRes();
    await handleAgentFile(makeReq('_dream_context/automations/real.md'), res, {}, contextRoot);
    expect(status()).toBe(200);
  });

  it('keeps the desktop gate — no env, no route, whatever the path resolves to', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('_dream_context/automations/real.md'), res, {}, contextRoot);
    expect(status()).toBe(403);
    expect(body().error).toBe('desktop_only');
  });
});
