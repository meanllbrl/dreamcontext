import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { customScriptAdapter, scriptFilePath } from '../../src/lib/lab/adapters/custom-script.js';
import { LabError, type AdapterContext, type InsightManifest, type RawPayloadEnvelope, type RawSeries } from '../../src/lib/lab/types.js';

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

// ── app/v1 + dataset/v1 gatekeeping (T2) ────────────────────────────────────
//
// custom-script.ts is the ONLY place that hands a script's raw return value
// to the engine — without these checks `fetched.app` is always undefined for
// script-authored insights (the envelope was rebuilt by hand, dropping any
// field it didn't name) and the app/v1 bridge is dead on arrival.
describe('custom-script adapter — app/v1 + dataset/v1 gatekeeping (T2)', () => {
  it('rejects a bare { kind: "app/v1" } return before the generic array error can steal it', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'bare-app.mjs'),
      'export default async () => ({ kind: "app/v1", entry: "a", pages: [{ id: "a", title: "A", html: "<div>x</div>" }] });\n',
      'utf-8',
    );
    const err = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/bare-app.mjs'))).catch((e) => e);
    expect(err).toBeInstanceOf(LabError);
    expect((err as Error).message).toMatch(/data is mandatory/);
    expect((err as Error).message).toContain('{ data, app }');
  });

  it('passes a bare dataset/v1 payload through unchanged, beside funnel/matrix', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'bare-dataset.mjs'),
      'export default async () => ({ kind: "dataset/v1", datasets: [{ key: "a", dims: [{ key: "x" }], rows: [{ d: { x: "1" }, v: 1 }] }] });\n',
      'utf-8',
    );
    const result = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/bare-dataset.mjs')));
    expect(result).toEqual({
      kind: 'dataset/v1',
      datasets: [{ key: 'a', dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 1 }] }],
    });
  });

  it('copies the envelope `app` field through after a shape check — this is the fix', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'envelope-app.mjs'),
      'export default async () => ({'
      + ' data: [{ name: "m", points: [{ t: "2026-01-01", v: 1 }] }],'
      + ' app: { kind: "app/v1", entry: "overview", pages: [{ id: "overview", title: "Overview", html: "<div>x</div>" }] },'
      + ' });\n',
      'utf-8',
    );
    const result = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/envelope-app.mjs'))) as RawPayloadEnvelope;
    expect(result.data).toEqual([{ name: 'm', points: [{ t: '2026-01-01', v: 1 }] }]);
    expect(result.app).toEqual({
      kind: 'app/v1',
      entry: 'overview',
      pages: [{ id: 'overview', title: 'Overview', html: '<div>x</div>' }],
    });
  });

  it('accepts a dataset/v1 `data` half in the envelope without coercing it to series', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'envelope-dataset-data.mjs'),
      'export default async () => ({'
      + ' data: { kind: "dataset/v1", datasets: [{ key: "a", dims: [{ key: "x" }], rows: [{ d: { x: "1" }, v: 1 }] }] },'
      + ' });\n',
      'utf-8',
    );
    const result = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/envelope-dataset-data.mjs'))) as RawPayloadEnvelope;
    expect(result.data).toEqual({
      kind: 'dataset/v1',
      datasets: [{ key: 'a', dims: [{ key: 'x' }], rows: [{ d: { x: '1' }, v: 1 }] }],
    });
  });

  it('rejects a non-app-shaped envelope `app` field', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'bad-app-shape.mjs'),
      'export default async () => ({ data: [{ name: "m", points: [] }], app: { foo: 1 } });\n',
      'utf-8',
    );
    const err = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/bad-app-shape.mjs'))).catch((e) => e);
    expect(err).toBeInstanceOf(LabError);
    expect((err as Error).message).toContain('`app` must be a { kind: "app/v1", … } object');
  });

  it('coerceSeries names dataset/v1 and { data, app? } in its error message', async () => {
    writeFileSync(
      join(root, 'lab', 'scripts', 'not-a-series.mjs'),
      'export default async () => ({ foo: 1 });\n',
      'utf-8',
    );
    const err = await customScriptAdapter.fetch(ctx(scriptManifest('scripts/not-a-series.mjs'))).catch((e) => e);
    expect(err).toBeInstanceOf(LabError);
    expect((err as Error).message).toContain('dataset/v1');
    expect((err as Error).message).toContain('{ data, app? }');
  });
});
