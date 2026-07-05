import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { customScriptAdapter, scriptFilePath } from '../../src/lib/lab/adapters/custom-script.js';
import { LabError, type AdapterContext, type InsightManifest } from '../../src/lib/lab/types.js';

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
});
