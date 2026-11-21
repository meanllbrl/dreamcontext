import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from 'commander';
import { acquireBrowserSlot, acquireHeavy, heavySlotDir, HEAVY_LOCK_BUSY_EXIT } from '../../lib/builder-tools.js';
import { contentTree, gitToplevel } from '../../lib/check-receipt.js';
import { resolveContextRoot } from '../../lib/context-path.js';
import { laneHere, opsRootFromIntent } from '../../lib/lane-intent.js';
import { credentialOriginOk, readOpsCard, safeUrl, type OpsCard } from '../../lib/ops-card.js';
import {
  FAST_BROWSER_TARGET, HEAVY_OVER_BUDGET_EXIT, becauseSpent, budgetPath, currentScope, fastBrowserScope, intentScope, readBudget,
  recordRed, recordStart, refusal, validReason, type BudgetScope,
} from '../../lib/run-budget.js';

/**
 * `dreamcontext shots <url>`: one URL's screenshots at a phone and a desktop width, through the
 * same limit and slots as every browser run (plan sirket-yavaslik D8). Measured 2026-11-21 on the
 * company Mac: every child wrote its own Playwright script in /tmp and ran it 3+ times, 663
 * browser minutes a day, 519 of them repeats. This is the shared one; a project whose flow needs
 * steps keeps ONE script in its repo and names it on the ops card (`ops set shots_script`).
 *
 * Before any slot it asks the budget (fast: one browser run per run, none when nothing visible
 * changed). A basic-auth login goes only to the card's staging/preview origin, over https or to
 * this machine, through Playwright's `httpCredentials` with that origin; its values are never
 * printed, logged or put in a file name.
 */
export const SHOTS_USAGE_EXIT = 2;
const DEFAULT_WIDTHS = [390, 1440];
const SETTLE_MS = 500;

export interface ShotsOptions { width?: string; out?: string; waitFor?: string; script?: string; because?: string; maxWait?: string }

export interface ShotsDeps {
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  print: (l: string) => void;
  printErr: (l: string) => void;
  slotDir: () => string;
  /** Resolve the playwright package's entry, or null (project node_modules, then the global root). */
  findPlaywright: (cwd: string) => string | null;
}

function globalNodeRoot(): string | null {
  try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() || null; } catch { return null; }
}

export function findPlaywrightPackage(cwd: string): string | null {
  for (const base of [cwd, globalNodeRoot()]) {
    if (!base) continue;
    try { return createRequire(join(resolve(base), 'noop.js')).resolve('playwright'); } catch { /* next */ }
  }
  return null;
}

const DEFAULT_DEPS: ShotsDeps = {
  cwd: () => process.cwd(),
  env: process.env,
  print: (l) => process.stdout.write(`${l}\n`),
  printErr: (l) => process.stderr.write(`${l}\n`),
  slotDir: () => heavySlotDir(),
  findPlaywright: findPlaywrightPackage,
};

/** The login the card names for this URL, or null: only its own staging/preview origin, https or loopback. */
export function credentialsFor(url: URL, card: OpsCard | null, env: NodeJS.ProcessEnv): { username: string; password: string; origin: string } | null {
  if (!card?.auth_env || !credentialOriginOk(url)) return null;
  const origins = [card.staging_url, card.preview_url].filter((u): u is string => !!u).map((u) => new URL(u).origin);
  if (!origins.includes(url.origin)) return null;
  const user = card.auth_env.find((n) => /_(?:USER|USERNAME|LOGIN)$/.test(n));
  const pass = card.auth_env.find((n) => /_(?:PASS|PASSWORD)$/.test(n));
  const username = user ? env[user] : undefined;
  const password = pass ? env[pass] : undefined;
  return username && password ? { username, password, origin: url.origin } : null;
}

/** The env a card's script runs with: PATH, HOME, and the card's login names only for its own origin. */
export function scriptEnv(url: URL, card: OpsCard | null, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: env.HOME };
  if (credentialsFor(url, card, env)) for (const n of card!.auth_env!) if (env[n] !== undefined) out[n] = env[n];
  return out;
}

function parseWidths(raw: string | undefined): number[] | null {
  if (raw === undefined) return DEFAULT_WIDTHS;
  const ws = raw.split(',').map((w) => w.trim());
  if (ws.length === 0 || ws.length > 4 || !ws.every((w) => /^\d{3,4}$/.test(w))) return null;
  return ws.map(Number);
}

/** The built-in capture: each width, `load` + an optional selector + a short settle; console errors listed. */
async function capture(entry: string, url: URL, widths: number[], outDir: string, waitFor: string | undefined, creds: ReturnType<typeof credentialsFor>): Promise<{ files: string[]; errors: string[]; failed: string | null }> {
  const pw = await import(pathToFileURL(entry).href) as { chromium: { launch: (o: object) => Promise<{ newContext: (o: object) => Promise<{ newPage: () => Promise<PwPage>; close: () => Promise<void> }>; close: () => Promise<void> }> } };
  const browser = await pw.chromium.launch({ headless: true });
  const files: string[] = [];
  const errors: string[] = [];
  let failed: string | null = null;
  try {
    for (const width of widths) {
      const ctx = await browser.newContext({ viewport: { width, height: width < 800 ? 844 : 900 }, ...(creds ? { httpCredentials: creds } : {}) });
      const page = await ctx.newPage();
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${width}] console: ${m.text().slice(0, 300)}`); });
      page.on('pageerror', (e) => { errors.push(`[${width}] page error: ${String((e as Error).message ?? e).slice(0, 300)}`); });
      try {
        const res = await page.goto(url.toString(), { waitUntil: 'load', timeout: 45_000 });
        if (res && res.status() >= 400) failed = `HTTP ${res.status()} at ${width}px`;
        if (waitFor) await page.waitForSelector(waitFor, { timeout: 15_000 });
        await page.waitForTimeout(SETTLE_MS);
        const file = join(outDir, `${url.hostname.replace(/[^a-z0-9.-]/gi, '_')}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        files.push(file);
      } catch (err) {
        failed = `${width}px: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`;
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return { files, errors, failed };
}

interface PwPage {
  on: (ev: string, fn: (x: { type: () => string; text: () => string } & Error) => void) => void;
  goto: (u: string, o: object) => Promise<{ status: () => number } | null>;
  waitForSelector: (s: string, o: object) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  screenshot: (o: object) => Promise<unknown>;
}

export async function runShots(deps: ShotsDeps, rawUrl: string, opts: ShotsOptions): Promise<number> {
  const cwd = deps.cwd();
  const url = safeUrl(rawUrl);
  if (!url) {
    deps.printErr(`shots: "${rawUrl.slice(0, 80)}" is not a URL it opens: http(s) only, no login in it, no token in the query`);
    return SHOTS_USAGE_EXIT;
  }
  const widths = parseWidths(opts.width);
  if (!widths) { deps.printErr('shots: --width takes 1-4 widths in px, like 390,1440'); return SHOTS_USAGE_EXIT; }
  if (opts.because !== undefined && !validReason(opts.because)) { deps.printErr('shots: --because needs a reason a reader can use'); return SHOTS_USAGE_EXIT; }
  const card = readOpsCard(opsRootFromIntent(cwd) ?? resolveContextRoot(cwd), { worktree: cwd });
  if (opts.script !== undefined) {
    if (!card) { deps.printErr('shots: no ops card here, so no script runs; record it first: dreamcontext ops set shots_script <repo path>'); return SHOTS_USAGE_EXIT; }
    if (card.shots_script !== opts.script) {
      deps.printErr(`shots: --script runs only the card's checked shots_script${card.shots_script ? ` (${card.shots_script})` : ' (none passes its checks: a tracked .mjs/.js/.ts in this repo)'}`);
      return SHOTS_USAGE_EXIT;
    }
  }
  const entry = opts.script === undefined ? deps.findPlaywright(cwd) : 'script';
  if (!entry) {
    deps.printErr('shots: no playwright package here or in the global npm root; install it once: npm i -g playwright && npx playwright install chromium');
    return SHOTS_USAGE_EXIT;
  }

  // The same limit `builder heavy` applies to a browser run, asked before any slot.
  const { pick, intent } = laneHere(cwd);
  const top = gitToplevel(cwd);
  const tree = top ? contentTree(top) : null;
  const open = currentScope(cwd);
  const fast = pick.lane === 'fast' && intent?.base && top;
  const target = fast ? FAST_BROWSER_TARGET : `shots ${opts.script ?? url.origin}`;
  const scope: BudgetScope | null = fast ? fastBrowserScope(top!, intent!.base!)
    : open ? { ...open, tree } : intent?.base && top ? intentScope(top, intent.base, tree) : null;
  const budget = budgetPath(cwd);
  const over = scope ? refusal(readBudget(budget), scope, 'browser', target, Date.now(), pick) : null;
  if (over && opts.because === undefined) {
    deps.printErr(`shots: REFUSED, ${over}. NOTHING ran. Read the screenshot you have; a fix that changed the look truly needs one more? shots --because "<why>" ${rawUrl}`);
    return HEAVY_OVER_BUDGET_EXIT;
  }
  if (over && scope && becauseSpent(readBudget(budget), scope, target)) {
    deps.printErr(`shots: REFUSED, ${over}, and this run already spent its one --because. NOTHING ran: use the screenshots you have, or put it to the owner.`);
    return HEAVY_OVER_BUDGET_EXIT;
  }

  const waitMs = (opts.maxWait !== undefined && /^\d+$/.test(opts.maxWait) ? Number(opts.maxWait) : 300) * 1000;
  const heavy = await acquireHeavy(cwd, { waitMs, slotDir: deps.slotDir(), noRepoLock: true });
  if (!heavy) { deps.printErr('shots: every heavy slot of this machine stayed busy; NOTHING ran. Run the same command again.'); return HEAVY_LOCK_BUSY_EXIT; }
  const browserFree = await acquireBrowserSlot({ slotDir: deps.slotDir(), waitMs });
  if (!browserFree) { heavy.release(); deps.printErr('shots: both browser slots of this machine stayed busy; NOTHING ran. Run the same command again.'); return HEAVY_LOCK_BUSY_EXIT; }
  try {
    if (scope) recordStart(budget, scope, 'browser', target, Date.now(), over ? { command: `shots ${rawUrl}`, reason: opts.because! } : undefined);
    const outDir = resolve(cwd, opts.out ?? join(top ?? cwd, 'tmp', 'shots'));
    mkdirSync(outDir, { recursive: true });
    if (top) {
      try { execFileSync('git', ['check-ignore', '-q', join(outDir, 'x.png')], { cwd: top, stdio: 'ignore' }); } catch { deps.printErr(`shots: note: ${outDir} is not git-ignored here; keep screenshots out of commits`); }
    }
    let code: number;
    if (opts.script !== undefined) {
      code = await new Promise<number>((done) => {
        const child = spawn(process.execPath, [join(top ?? cwd, opts.script!), url.toString(), outDir], { cwd: top ?? cwd, env: scriptEnv(url, card, deps.env), stdio: 'inherit' });
        child.on('error', () => done(127));
        child.on('close', (c) => done(c ?? 1));
      });
      if (code === 0) deps.print(`shots: ${opts.script} wrote to ${outDir}`);
    } else {
      const r = await capture(entry, url, widths, outDir, opts.waitFor, credentialsFor(url, card, deps.env));
      for (const f of r.files) deps.print(`shot: ${f}`);
      for (const e of r.errors) deps.printErr(e);
      if (r.failed) deps.printErr(`shots: the page did not load: ${r.failed}`);
      deps.print(`console errors: ${r.errors.length}`);
      code = r.failed || r.errors.length > 0 ? 1 : 0;
    }
    if (code !== 0 && scope) recordRed(budget, scope, target, Date.now());
    return code;
  } finally {
    browserFree();
    heavy.release();
  }
}

export function registerShotsCommand(program: Command, deps: ShotsDeps = DEFAULT_DEPS): void {
  program
    .command('shots')
    .argument('<url>', 'The page (http or https; the local dev server or a preview)')
    .option('--width <px,...>', 'Widths to capture (default 390,1440)')
    .option('--out <dir>', 'Where the PNGs go (default the repo\'s tmp/shots/)')
    .option('--wait-for <selector>', 'Wait for this element before the shot')
    .option('--script <repo-path>', 'Run the ops card\'s shots_script instead: node <script> <url> <out>')
    .option('--because <reason>', 'One more screenshot past the limit, once per run (kept in builder budget)')
    .option('--max-wait <seconds>', 'How long to wait for a browser slot (default 300)')
    .description(`Screenshot one URL at a phone and a desktop width and list its console errors, through the browser limit and the machine's browser slots (exit 0 = shots and no console error, 1 = the page failed or logged errors, ${SHOTS_USAGE_EXIT} = bad input or no playwright, ${HEAVY_OVER_BUDGET_EXIT} = past the limit, NOTHING ran, ${HEAVY_LOCK_BUSY_EXIT} = no slot came free)`)
    .action(async (url: string, opts: ShotsOptions) => {
      process.exitCode = await runShots(deps, url, opts);
    });
}
