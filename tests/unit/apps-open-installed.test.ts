/**
 * Open on an installed app (2026-11-09). The owner pressed Open on "Yük İzleme" under "From
 * others": "Opening..." and back to "Open", no window, no word. An installed app's registered
 * hash carries its installId, but the bundle was built under `appHash(projectRoot, slug)`, so
 * `open` was pointed at a bundle that never existed and its failure was thrown away.
 *
 * Here: Open looks for, and opens, the bundle of the record's own hash; every way it fails comes
 * back as an error the card shows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { focusApp, setAppsHomeForTests } from '../../src/server/routes/apps.js';
import { appBundlePath, appHash, ensureAppBundle } from '../../src/lib/apps/bundle.js';
import type { AppRecord } from '../../src/lib/apps/registry.js';

let home: string;
let project: string;
let runner: string;
const saved = process.env.DREAMCONTEXT_APP_RUNNER;

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-open-')));
  project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  runner = join(home, 'app-runner');
  writeFileSync(runner, 'runner');
  setAppsHomeForTests(home);
});
afterAll(() => {
  if (saved === undefined) delete process.env.DREAMCONTEXT_APP_RUNNER; else process.env.DREAMCONTEXT_APP_RUNNER = saved;
  rmSync(home, { recursive: true, force: true });
});

function installed(): AppRecord {
  const root = join(home, 'proj-apps', 'installed', 'yuk-izleme');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'yuk-izleme', name: 'Yuk Izleme' }));
  return { slug: 'yuk-izleme', vault: 'v', projectRoot: project, root, name: 'Yuk Izleme', origin: 'installed', installId: 'abc123', hash: appHash(project, 'yuk-izleme', 'abc123'), createdAt: '2026-11-09T00:00:00Z' } as AppRecord;
}

const stubExec = (cmd: string, args: string[]) => {
  if (cmd.endsWith('iconutil')) writeFileSync(args[args.indexOf('-o') + 1], 'icns');
};

describe('Open on an installed app', () => {
  it('opens the bundle of the record\'s own hash', async () => {
    if (process.platform !== 'darwin') return;
    const rec = installed();
    const built = ensureAppBundle({ home, hash: rec.hash, projectRoot: project, vault: 'v', slug: rec.slug, name: rec.name, runnerPath: runner, appBundleId: 'com.dreamcontext.beta' }, { exec: stubExec, platform: 'darwin' });
    expect(built.ok).toBe(true);
    const opened: string[] = [];
    const r = await focusApp(rec, { runnerAlive: true }, async (p) => { opened.push(p); return null; });
    expect(r).toEqual({ ok: true, path: appBundlePath(home, rec.slug, rec.hash) });
    expect(opened).toEqual([appBundlePath(home, rec.slug, rec.hash)]);
    rmSync(appBundlePath(home, rec.slug, rec.hash), { recursive: true, force: true });
  });

  it('a failed `open` is said, never swallowed', async () => {
    if (process.platform !== 'darwin') return;
    const rec = installed();
    ensureAppBundle({ home, hash: rec.hash, projectRoot: project, vault: 'v', slug: rec.slug, name: rec.name, runnerPath: runner, appBundleId: 'com.dreamcontext.beta' }, { exec: stubExec, platform: 'darwin' });
    const r = await focusApp(rec, { runnerAlive: true }, async () => new Error('LSOpenURLsWithRole() failed with error -10810'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('open_failed');
    expect(r.message).toMatch(/macOS did not open the app's window: LSOpenURLsWithRole/);
    rmSync(appBundlePath(home, rec.slug, rec.hash), { recursive: true, force: true });
  });

  it('a bundle that sits only under the old, wrong name is not taken for this app', async () => {
    if (process.platform !== 'darwin') return;
    const rec = installed();
    const stray = appHash(project, 'yuk-izleme');
    ensureAppBundle({ home, hash: stray, projectRoot: project, vault: 'v', slug: rec.slug, name: rec.name, runnerPath: runner, appBundleId: 'com.dreamcontext.beta' }, { exec: stubExec, platform: 'darwin' });
    delete process.env.DREAMCONTEXT_APP_RUNNER;
    let called = false;
    const r = await focusApp(rec, { runnerAlive: true }, async () => { called = true; return null; });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('runner_missing');
  });
});
