/**
 * GET /api/launcher/detect and GET /api/launcher/defaults, the folder facts the onboarding
 * Project step reads. Detect is filesystem-only (probeFolder): it must never spawn git, so a
 * Mac without the developer tools never sees Apple's install dialog because of it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import * as childProcess from 'node:child_process';
import { handleLauncherDetect, handleLauncherDefaults } from '../../src/server/routes/launcher.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function mkTmp(prefix = 'dc-detect'): string {
  const raw = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const real = realpathSync(raw);
  dirs.push(real);
  return real;
}

interface Captured { status: number; body: any }

function fakeRes(): { res: any; out: Captured } {
  const out: Captured = { status: 0, body: null };
  const res: any = {
    writeHead(code: number) { out.status = code; },
    setHeader() {},
    end(data: string) { try { out.body = JSON.parse(data); } catch { out.body = data; } },
  };
  return { res, out };
}

async function detect(path: string): Promise<Captured> {
  const { res, out } = fakeRes();
  const req: any = { url: `/api/launcher/detect?path=${encodeURIComponent(path)}`, headers: { host: '127.0.0.1:1' } };
  await handleLauncherDetect(req, res, {}, null);
  return out;
}

function spawnCallCount(): number {
  const cp = childProcess as unknown as Record<string, { mock?: { calls: unknown[] } }>;
  return ['spawn', 'spawnSync', 'execFile', 'execFileSync'].reduce((n, k) => n + (cp[k]?.mock?.calls.length ?? 0), 0);
}

describe('handleLauncherDetect', () => {
  it('reports documents, git, brain and writability without spawning anything', async () => {
    const dir = mkTmp();
    mkdirSync(join(dir, 'notes'));
    for (let i = 0; i < 6; i++) writeFileSync(join(dir, 'notes', `n${i}.md`), `# note ${i}\n`);
    mkdirSync(join(dir, '.git'));
    const before = spawnCallCount();
    const out = await detect(dir);
    expect(spawnCallCount()).toBe(before);
    expect(out.status).toBe(200);
    expect(out.body.isGitRepo).toBe(true);
    expect(out.body.docs.count).toBe(6);
    expect(out.body.brain).toBe('missing');
    expect(out.body.hasContext).toBe(false);
    expect(out.body.writable).toBe(true);
    expect(typeof out.body.stack).toBe('string');
  });

  it('reports a plain folder as not a repository', async () => {
    const dir = mkTmp();
    const out = await detect(dir);
    expect(out.status).toBe(200);
    expect(out.body.isGitRepo).toBe(false);
    expect(out.body.docs.count).toBe(0);
  });

  it('refuses a symlinked folder with symlink_refused', async () => {
    const real = mkTmp();
    const holder = mkTmp('dc-link');
    const link = join(holder, 'link');
    symlinkSync(real, link);
    const out = await detect(link);
    expect(out.status).toBe(400);
    expect(out.body.error).toBe('symlink_refused');
  });

  it('answers a missing folder with "does not exist" (the clone-destination probe relies on it)', async () => {
    const out = await detect(join(mkTmp(), 'nope'));
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/does not exist/i);
  });

  it('rejects a relative path', async () => {
    const out = await detect('relative/path');
    expect(out.status).toBe(400);
  });
});

describe('handleLauncherDefaults', () => {
  it('reports whether the default parent folder exists', async () => {
    const { res, out } = fakeRes();
    await handleLauncherDefaults({} as any, res, {}, null);
    expect(out.status).toBe(200);
    expect(typeof out.body.defaultParentExists).toBe('boolean');
    expect(out.body.defaultParent).toMatch(/projects$/);
  });
});
