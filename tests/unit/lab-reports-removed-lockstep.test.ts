/**
 * Lockstep guard for the Reports removal (Insights v2, D8 / AC10).
 *
 * Boards replace categories, groups AND Reports, so Reports and their AI
 * commentary are deleted outright: the UI, the routes, the commentary job, the
 * `lab report` CLI, the stores, their tests and verify scripts. This file fails
 * loudly if any of it comes back: a report file reappearing, a report route
 * answering, `lab report` in the generated CLI manifest, or a report identifier
 * surviving in `src/` or `dashboard/src/`.
 *
 * The routes are asserted against the REAL router (`buildRouter`), dispatched
 * the way `startDashboardServer` does it: no match = 404 `No route`, a match
 * runs the handler. User-vault `lab/reports/**` files are left untouched by the
 * removal, so a report manifest is planted in the scratch vault to prove it is
 * no longer served.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildRouter } from '../../src/server/index.js';

const ROOT = join(import.meta.dirname, '../..');

const DELETED = [
  'dashboard/src/components/lab/reports',
  'dashboard/src/components/lab/reports/ReportPage.tsx',
  'dashboard/src/components/lab/reports/ReportPage.css',
  'dashboard/src/components/lab/reports/reportModel.ts',
  'src/lib/lab/reports-store.ts',
  'src/lib/lab/report-commentary.ts',
  'src/server/lab-commentary-job.ts',
  'tests/unit/lab-reports.test.ts',
  'tests/unit/lab-reports-ui.test.ts',
  'tests/unit/lab-report-commentary.test.ts',
  'scripts/verify/lab-breakdown-reports.mjs',
  'scripts/verify/lab-report-template.mjs',
];

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

function makeReq(method: string, url: string, bodyObj?: unknown): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  const readable = Readable.from(chunks);
  return Object.assign(readable, { method, url, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
}

/** The server's own dispatch: match → handler, no match → 404 `No route`. */
async function dispatch(method: string, path: string, root: string, bodyObj?: unknown) {
  const out = makeRes();
  const match = buildRouter().match(method, path);
  if (match) {
    await match.handler(makeReq(method, path, bodyObj), out.res, match.params, root);
  } else {
    out.res.writeHead(404);
    out.res.end(JSON.stringify({ error: 'not_found' }));
  }
  return out;
}

/** Every file under `dir` (source trees only: no node_modules, no build output). */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('Reports are gone: the files', () => {
  it.each(DELETED)('%s is absent', (rel) => {
    expect(existsSync(join(ROOT, rel))).toBe(false);
  });

  it('package.json carries no report verify script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const scripts = Object.keys(pkg.scripts ?? {});
    expect(scripts).not.toContain('verify:lab-breakdown-reports');
    expect(scripts).not.toContain('verify:lab-report-template');
  });
});

describe('Reports are gone: the routes answer 404 from the real router', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lab-reports-removed-'));
    mkdirSync(join(root, 'core'), { recursive: true });
    // A leftover user report: the removal leaves vault files alone, the server must not serve them.
    mkdirSync(join(root, 'lab', 'reports'), { recursive: true });
    writeFileSync(join(root, 'lab', 'reports', 'daily.md'), '---\ntitle: Daily\nsections: []\n---\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['GET', '/api/lab/reports'],
    ['GET', '/api/lab/reports/daily'],
    ['GET', '/api/lab/reports/daily/commentary'],
    ['POST', '/api/lab/reports/daily/commentary'],
  ])('%s %s → 404', async (method, path) => {
    const { status } = await dispatch(method, path, root, method === 'POST' ? {} : undefined);
    expect(status()).toBe(404);
  });
});

describe('Reports are gone: the CLI', () => {
  it('`lab report` and its subcommands are absent from cli-manifest.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'dashboard/src/generated/cli-manifest.json'), 'utf-8'),
    ) as { endpoints: { path: string }[] };
    expect(manifest.endpoints.length).toBeGreaterThan(0);
    const paths = manifest.endpoints.map((e) => e.path);
    expect(paths).toContain('lab sync'); // the manifest is the real one, not an empty stub
    expect(paths.filter((p) => p === 'lab report' || p.startsWith('lab report '))).toEqual([]);
  });
});

describe('Reports are gone: no identifier survives in src/ or dashboard/src/', () => {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'dashboard/src'))];
  // Read once, shared by every identifier (the trees are a few thousand files).
  let sources: Map<string, string> | null = null;

  function holders(identifier: string): string[] {
    sources ??= new Map(files.map((f) => [relative(ROOT, f), readFileSync(f, 'utf-8')]));
    const re = new RegExp(`\\b${identifier}\\b`);
    return [...sources].filter(([, text]) => re.test(text)).map(([rel]) => rel);
  }

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  // WindowRange went with the transient window override (`window-cache.ts`,
  // `SyncOptions.window`, the sync job's `windows`, the sync-jobs windows parse).
  it.each(['ReportPage', 'reportSlugs', 'WindowRange'])('%s appears nowhere', (identifier) => {
    expect(holders(identifier)).toEqual([]);
  }, 60_000);

  it('the window cache module is gone', () => {
    expect(existsSync(join(ROOT, 'src/lib/lab/window-cache.ts'))).toBe(false);
  });
});
