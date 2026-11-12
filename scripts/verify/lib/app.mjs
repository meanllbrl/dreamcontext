/**
 * The shared skeleton of a browser check, so a job does not write its own script: 15% of all
 * changed lines were such scripts when measured (2026-10-31), and each ran a full build first.
 *
 *   import { openApp } from './lib/app.mjs';
 *   const app = await openApp({ suite: 'my-check' });        // scratch HOME + vault, API, Vite
 *   await app.look('/?vault=proj', async (page) => { ... }); // 390 and 1440 px, shots, errors
 *   process.exit(await app.finish());                        // prints the report, 0 = clean
 *
 * No build: the API runs from source through tsx and the UI from the Vite dev server, which
 * proxies /api to it. WebSockets are not proxied (vite.config.ts), so a check of live chat
 * streaming still needs the built app: `build: true` serves dist/ instead.
 *
 * Nothing touches your machine: a fake HOME, a scratch project, a stand-in `claude` first on its
 * PATH, and no session variables of the agent that runs it.
 *
 * Preflight (audit OR-5): before the check's own steps, openApp proves the harness reaches the
 * product: `build: true` refuses a `dist/` older than the code, the servers answer, and the app
 * shell draws at `target`. Any of those failing ends the process with HARNESS_EXIT (78) and a
 * HARNESS line (./preflight.mjs), which `builder heavy` does not count against the repeat limit.
 * `onHarness: 'throw'` hands the HarnessError to the caller instead.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { distIndex, markAnnouncementsSeen, scratchDir, shotsDir } from './measure.mjs';
import { HarnessError, OLD_BUILD_ON_PURPOSE, reportHarness, staleDist } from './preflight.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const WIDTHS = [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }];

const freePort = () => new Promise((done, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

async function waitFor(url, label, proc, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (proc.exitCode != null) throw new HarnessError('start', `${label} exited with ${proc.exitCode} before it answered`);
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new HarnessError('start', `${label} did not answer ${url} in ${timeoutMs / 1000}s`);
}

/** The app shell drew at `path`: React mounted something into #root, and no Vite error overlay. */
async function preflightShell(browser, base, path, shots, timeoutMs) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await markAnnouncementsSeen(context, base);
    const page = await context.newPage();
    let crash = null;
    page.on('pageerror', (e) => { crash = crash ?? String(e.message).slice(0, 200); });
    try {
      await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (err) {
      throw new HarnessError('shell', `could not open ${path}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
    const drew = await page.waitForSelector('#root > *', { state: 'attached', timeout: timeoutMs }).then(() => true, () => false);
    const overlay = await page.locator('vite-error-overlay').count().catch(() => 0);
    if (!drew || overlay) {
      const shot = join(shots, 'preflight.png');
      await page.screenshot({ path: shot }).catch(() => {});
      const why = overlay ? 'the Vite error overlay is up (the dashboard does not compile)' : `the app shell did not draw in ${timeoutMs / 1000}s`;
      throw new HarnessError('shell', `${why} at ${path}${crash ? `; page error: ${crash}` : ''} (screenshot: ${shot})`);
    }
  } finally {
    await context.close().catch(() => {});
  }
}

const pathOf = (url) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };

/** Requests a dev server makes that are no finding about the app. */
const NOISE = /\/@vite\/|\/__vite_ping|favicon\.ico|\/api\/.*\/ws\b/;

/**
 * `claude`: what answers as `claude` in the fake HOME. Default a stand-in that exits 0; a path:
 * that script (a deterministic fake); 'real': the machine's own `claude`, signed in through the
 * login keychain (linked into the fake HOME), for a check that must measure the real model.
 */
export async function openApp(opts = {}) {
  try {
    return await openAppInner(opts);
  } catch (err) {
    if (!(err instanceof HarnessError) || opts.onHarness === 'throw') throw err;
    process.exit(reportHarness(err));
  }
}

async function openAppInner({ suite = 'look', build = false, desktop = false, claude = null, target = '/?vault=proj', preflight = true } = {}) {
  // DC_VERIFY_DIST points at another build on purpose (a before run): its age is the point.
  if (build && !process.env.DC_VERIFY_DIST) {
    const stale = staleDist(REPO);
    if (stale) throw new HarnessError('stale build', `${stale.why}. Build first: dreamcontext builder heavy -- ${stale.build}. An older build on purpose: put ${OLD_BUILD_ON_PURPOSE} in front of the command`);
  }
  const scratch = scratchDir(`dc-verify-${suite}-${process.pid}`); // two runs can overlap in the fast line
  rmSync(scratch, { recursive: true, force: true });
  const home = join(scratch, 'home');
  const proj = join(scratch, 'proj');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  mkdirSync(join(proj, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: proj });

  // npm's cache stays the real one: under the fake HOME, `npx tsx` would download tsx every run.
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  if (claude === 'real') {
    const realHome = process.env.HOME ?? '';
    const found = spawnSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf-8' }).stdout.trim();
    if (!found) throw new Error('claude: real asked, but no claude on this Mac');
    symlinkSync(found, join(bin, 'claude'));
    mkdirSync(join(home, 'Library'), { recursive: true });
    symlinkSync(join(realHome, 'Library', 'Keychains'), join(home, 'Library', 'Keychains'));
  } else if (claude) {
    symlinkSync(claude, join(bin, 'claude'));
  } else {
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'claude'), 0o755);
  }
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
  const env = { ...clean, HOME: home, PATH: `${bin}:${process.env.PATH}`, npm_config_cache: join(process.env.HOME ?? home, '.npm'), DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0' };
  // `desktop` (needs `build`: the server must be this process's direct child): the server acts as
  // the Mac app's own, with its loopback-only desktop routes and `desktop-server.json`, in the fake HOME.
  if (desktop) Object.assign(env, { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: String(process.pid) });
  const apiPort = await freePort();
  const shots = join(shotsDir(REPO, suite), String(process.pid));
  mkdirSync(shots, { recursive: true });
  const procs = [];
  const killAll = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
  // A killed check must not leave its detached servers behind.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { killAll(); process.exit(1); });
  const start = (cmd, args, opts) => {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts });
    // A failed spawn sets exitCode, which waitFor turns into a throw; unhandled, it would skip killAll.
    p.on('error', () => {});
    procs.push(p);
    return p;
  };
  const cli = build
    ? ['node', [distIndex(REPO)]]
    : ['npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts')]];

  const added = spawnSync(cli[0], [...cli[1], 'vaults', 'add', 'proj', proj], { cwd: proj, env, encoding: 'utf-8' });
  if (added.status !== 0) {
    const said = `${added.stderr ?? ''}${added.stdout ?? ''}`.trim().split('\n').slice(-2).join(' ');
    throw new HarnessError('start', `the CLI could not register the scratch vault (exit ${added.status ?? added.error?.message}): ${said.slice(0, 300)}`);
  }

  let base = `http://127.0.0.1:${apiPort}`;
  let browser;
  try {
    const api = start(cli[0], [...cli[1], 'dashboard', '--no-open', '-p', String(apiPort)], { cwd: proj, env });
    await waitFor(`${base}/api/health`, 'the API server', api);
    if (!build) {
      const vitePort = await freePort();
      // The dashboard's own Vite: the root's is another major, pulled in by vitest.
      const vite = start(join(REPO, 'dashboard', 'node_modules', '.bin', 'vite'), ['--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], {
        cwd: join(REPO, 'dashboard'), env: { ...clean, DC_API_TARGET: `http://localhost:${apiPort}` },
      });
      base = `http://127.0.0.1:${vitePort}`;
      await waitFor(base, 'the Vite dev server', vite);
    }
    // DC_VERIFY_ENGINE=webkit: the engine the Mac app runner draws with.
    browser = await (process.env.DC_VERIFY_ENGINE === 'webkit' ? webkit : chromium).launch()
      .catch((err) => { throw new HarnessError('start', `the browser did not launch: ${err instanceof Error ? err.message.split('\n')[0] : err}`); });
    if (preflight) await preflightShell(browser, base, target, shots, build ? 20_000 : 60_000);
  } catch (err) {
    await browser?.close().catch(() => {});
    killAll();
    throw err;
  }
  const findings = [];
  const taken = [];

  const stop = async () => {
    await browser.close().catch(() => {});
    killAll();
  };

  return {
    base, home, proj, shots, findings, taken,
    /** Open `path` at each width, run `act`, screenshot, and collect errors and overflow. */
    async look(path, act = async () => {}, { name = 'page', init } = {}) {
      for (const w of WIDTHS) {
        const context = await browser.newContext({ viewport: { width: w.width, height: w.height } });
        // `init(w)` may answer a script to run before the page's own (e.g. playing the Mac app's shell).
        const script = init?.(w);
        if (script) await context.addInitScript(script);
        await markAnnouncementsSeen(context, base);
        const page = await context.newPage();
        const where = `${name}@${w.name}`;
        page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) findings.push(`${where} console: ${m.text().slice(0, 200)}`); });
        page.on('pageerror', (e) => findings.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
        page.on('requestfailed', (r) => { if (!NOISE.test(r.url())) findings.push(`${where} failed request: ${pathOf(r.url())}`); });
        page.on('response', (r) => { if (r.status() >= 400 && !NOISE.test(r.url())) findings.push(`${where} ${r.status()}: ${pathOf(r.url())}`); });
        await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await act(page, w);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 1) findings.push(`${where} overflows sideways by ${over}px`);
        const file = join(shots, `${name}-${w.name}.png`);
        await page.screenshot({ path: file });
        taken.push(file);
        await context.close();
      }
    },
    /** Print the report, stop everything, and answer the exit code. */
    async finish() {
      await stop();
      const report = join(shots, 'report.json');
      writeFileSync(report, `${JSON.stringify({ base, findings, screenshots: taken }, null, 1)}\n`);
      for (const f of taken) process.stdout.write(`screenshot: ${f}\n`);
      for (const f of findings) process.stdout.write(`FINDING: ${f}\n`);
      process.stdout.write(`${findings.length === 0 ? 'CLEAN' : `${findings.length} finding(s)`}: read the screenshots yourself (${report})\n`);
      return findings.length === 0 ? 0 : 1;
    },
    stop,
  };
}
