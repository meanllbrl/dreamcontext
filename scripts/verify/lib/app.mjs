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
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, scratchDir, shotsDir } from './measure.mjs';

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
    if (proc.exitCode != null) throw new Error(`${label} exited with ${proc.exitCode}`);
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} did not answer ${url} in ${timeoutMs / 1000}s`);
}

const pathOf = (url) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };

/** Requests a dev server makes that are no finding about the app. */
const NOISE = /\/@vite\/|\/__vite_ping|favicon\.ico|\/api\/.*\/ws\b/;

export async function openApp({ suite = 'look', build = false } = {}) {
  const scratch = scratchDir(`dc-verify-${suite}`);
  rmSync(scratch, { recursive: true, force: true });
  const home = join(scratch, 'home');
  const proj = join(scratch, 'proj');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  mkdirSync(join(proj, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: proj });

  // npm's cache stays the real one: under the fake HOME, `npx tsx` would download tsx every run.
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
  const env = { ...clean, HOME: home, PATH: `${bin}:${process.env.PATH}`, npm_config_cache: join(process.env.HOME ?? home, '.npm'), DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0' };
  const apiPort = await freePort();
  const shots = shotsDir(REPO, suite);
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

    spawnSync(cli[0], [...cli[1], 'vaults', 'add', 'proj', proj], { cwd: proj, env, stdio: 'ignore' });

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
    browser = await chromium.launch();
  } catch (err) {
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
    async look(path, act = async () => {}, { name = 'page' } = {}) {
      for (const w of WIDTHS) {
        const context = await browser.newContext({ viewport: { width: w.width, height: w.height } });
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
