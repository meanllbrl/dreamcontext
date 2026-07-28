import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { customScriptAdapter, scriptFilePath } from '../../src/lib/lab/adapters/custom-script.js';
import { LabError, type AdapterContext, type InsightManifest, type RawSeries } from '../../src/lib/lab/types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-script-'));
  mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
  mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function scriptManifest(file: string): InsightManifest {
  return {
    slug: 'x',
    title: 'X',
    description: null,
    group: null,
    render: 'number',
    source: { adapter: 'script', file },
    refresh: { ttl_minutes: 1440 },
    tweaks: [],
    binding: null,
    credentials_used: [],
    unit: null,
    path: join(root, 'lab', 'insights', 'x.md'),
    body: '',
  };
}

function ctx(manifest: InsightManifest, extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    manifest,
    resolvedTweaks: { values: {}, range: { fromISO: '2026-01-01', toISO: '2026-02-01' }, spanDays: 30 },
    credentials: {},
    ...extra,
  };
}

describe('custom-script adapter', () => {
  it('loads a fixture .mjs (default async fn) and returns its series', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'ok.mjs'),
      'export default async function (ctx) { return [{ name: "default", points: [{ t: "2026-01-01", v: 42 }] }]; }\n',
      'utf-8',
    );
    const series = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/ok.mjs')));
    expect(series).toEqual([{ name: 'default', points: [{ t: '2026-01-01', v: 42 }] }]);
  });

  it('passes credentials + resolvedTweaks through as the ctx argument', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'echo.mjs'),
      'export default async function (ctx) { return [{ name: "n", points: [{ t: "2026-01-01", v: ctx.credentials.apiKey === "secret" ? 1 : 0 }] }]; }\n',
      'utf-8',
    );
    const series = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/echo.mjs'), { credentials: { apiKey: 'secret' } }));
    expect(series[0].points[0].v).toBe(1);
  });

  it('throws a redacted LabError when the script throws', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'boom.mjs'),
      'export default async function () { throw new Error("leaked-secret-value failed"); }\n',
      'utf-8',
    );
    const err = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/boom.mjs'), { credentials: { key: 'leaked-secret-value' } })).catch((e) => e);
    expect(err).toBeInstanceOf(LabError);
    expect((err as Error).message).not.toContain('leaked-secret-value');
    expect((err as Error).message).toContain('***');
  });

  it('throws when the module has no default export function', async () => {
    writeFileSync(join(root, 'lab', 'scripts', 'nodefault.mjs'), 'export const notDefault = 1;\n', 'utf-8');
    await expect(customScriptAdapter.fetch(ctx(scriptManifest('scripts/nodefault.mjs')))).rejects.toThrow(LabError);
  });

  it('scriptFilePath rejects a path that escapes lab/', () => {
    expect(() => scriptFilePath(scriptManifest('../../etc/passwd'))).toThrow(LabError);
  });

  it('passes a funnel-set payload through unchanged across the process boundary', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'funnel.mjs'),
      'export default async () => ({ kind: "funnel-set/v1", dimensions: [], funnels: ['
      + '{ id: "f1", name: "Signup", meta: { product: "x" }, metrics: { cr: { v: 0.5, format: "pct" } },'
      + ' steps: [{ key: "view", label: "View", users: 100 }, { key: "signup", label: "Signup", users: 50 }] }] })\n',
      'utf-8',
    );
    const result = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/funnel.mjs')));
    expect(result).toEqual({
      kind: 'funnel-set/v1',
      dimensions: [],
      funnels: [{
        id: 'f1',
        name: 'Signup',
        meta: { product: 'x' },
        metrics: { cr: { v: 0.5, format: 'pct' } },
        steps: [{ key: 'view', label: 'View', users: 100 }, { key: 'signup', label: 'Signup', users: 50 }],
      }],
    });
  });
});

// ── GitHub #242 ────────────────────────────────────────────────────────────────
// A query-string cache-bust only ever freshens the ENTRY module; the entry's own
// `import './lib-*.mjs'` resolves to an unqueried URL and is pinned in Node's ESM
// registry for the life of the process. These pin the child-process runner that
// makes the whole graph fresh on every run — they FAIL against an in-process
// `await import(url + '?t=…')` implementation.
describe('custom-script adapter — module freshness (#242)', () => {
  function writeGraph(libValue: string): void {
    writeFileSync(join(root, 'lab', 'scripts', 'lib-shared.mjs'), `export const V = ${libValue};\n`, 'utf-8');
    writeFileSync(
      join(root, 'lab', 'scripts', 'entry.mjs'),
      'import { V } from "./lib-shared.mjs";\n'
      + 'export default async () => [{ name: "n", points: [{ t: "2026-01-01", v: V }] }];\n',
      'utf-8',
    );
  }

  it('picks up an edit to a TRANSITIVELY imported lib within one host process', async () => {
    writeGraph('1');
    const first = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/entry.mjs'))) as RawSeries[];
    expect(first[0].points[0].v).toBe(1);

    // Only the lib changes — the entry file is byte-identical.
    writeFileSync(join(root, 'lab', 'scripts', 'lib-shared.mjs'), 'export const V = 2;\n', 'utf-8');

    const second = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/entry.mjs'))) as RawSeries[];
    expect(second[0].points[0].v).toBe(2);
  });

  it('picks up an edit to the entry script itself within one host process', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'solo.mjs'),
      'export default async () => [{ name: "n", points: [{ t: "2026-01-01", v: 1 }] }];\n',
      'utf-8',
    );
    const first = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/solo.mjs'))) as RawSeries[];
    expect(first[0].points[0].v).toBe(1);

    writeFileSync(
      join(root, 'lab', 'scripts', 'solo.mjs'),
      'export default async () => [{ name: "n", points: [{ t: "2026-01-01", v: 2 }] }];\n',
      'utf-8',
    );
    const second = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/solo.mjs'))) as RawSeries[];
    expect(second[0].points[0].v).toBe(2);
  });
});

describe('custom-script adapter — host isolation (#242)', () => {
  it('survives a script that exits the process, reporting a loud failure', async () => {
    writeFileSync(join(root, 'lab', 'scripts', 'exit.mjs'), 'process.exit(7);\n', 'utf-8');
    const err = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/exit.mjs'))).catch((e) => e);
    expect(err).toBeInstanceOf(LabError);
    expect((err as Error).message).toContain('without returning a result');
  });

  it('kills a hung script at the timeout ceiling instead of wedging the sync', async () => {
    const prior = process.env.DREAMCONTEXT_LAB_SCRIPT_TIMEOUT_MS;
    process.env.DREAMCONTEXT_LAB_SCRIPT_TIMEOUT_MS = '400';
    try {
      // A real hang holds the event loop open (a pending timer/socket). A bare
      // `new Promise(() => {})` does not — Node detects the unsettled top-level
      // await and exits 13, which the "no result" branch already reports loudly.
      writeFileSync(
        join(root, 'lab', 'scripts', 'hang.mjs'),
        'export default async () => new Promise((r) => setTimeout(r, 60_000));\n',
        'utf-8',
      );
      const err = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/hang.mjs'))).catch((e) => e);
      expect(err).toBeInstanceOf(LabError);
      expect((err as Error).message).toContain('timed out after 400ms');
    } finally {
      if (prior === undefined) delete process.env.DREAMCONTEXT_LAB_SCRIPT_TIMEOUT_MS;
      else process.env.DREAMCONTEXT_LAB_SCRIPT_TIMEOUT_MS = prior;
    }
  });

  it('fails loudly when the script returns something that cannot cross the boundary', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'bigint.mjs'),
      'export default async () => [{ name: "n", points: [{ t: "2026-01-01", v: 1n }] }];\n',
      'utf-8',
    );
    const err = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/bigint.mjs'))).catch((e) => e);
    expect(err).toBeInstanceOf(LabError);
    expect((err as Error).message).toContain('not JSON-serializable');
  });
});
