/**
 * The render list has ONE owner: `RENDERS` in src/lib/lab/types.ts. The CLI
 * `--render` enum, doctor's validation and the lenient manifest read all derive
 * from it at runtime, so they cannot drift.
 *
 * The dashboard cannot import from `src/` (separate tsconfig, separate bundle),
 * so its chart registry MIRRORS the list — and a mirror rots silently. These
 * tests parse the registry textually and fail the moment the two disagree, the
 * same guard RangeControl's presets carry (lab-wellknown-tweaks.test.ts).
 *
 * Also covered: the engine accepting the new render values on the write path,
 * and the `size` board-footprint override end to end (read → validate → API).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createInsight, getInsight, validateManifestForWrite } from '../../src/lib/lab/store.js';
import { INSIGHT_SIZES, LabError, RENDERS } from '../../src/lib/lab/types.js';
import { checkLab } from '../../src/cli/commands/doctor.js';
import { handleLabList, handleLabShow } from '../../src/server/routes/lab.js';

const REGISTRY_PATH = join(import.meta.dirname, '../../dashboard/src/components/lab/chartRegistry.ts');

let projectRoot: string;
let root: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-lab-registry-'));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Hand-write a manifest — createInsight is strict, and some cases need the
 *  values a hand-edited (or newer-build) manifest would carry. */
function writeManifest(slug: string, frontmatter: string): void {
  mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
  writeFileSync(
    join(root, 'lab', 'insights', `${slug}.md`),
    `---\ntitle: ${slug}\n${frontmatter}---\n## Meaning\n`,
    'utf-8',
  );
}

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

function makeReq(): IncomingMessage {
  const readable = Readable.from([]);
  return Object.assign(readable, { method: 'GET', headers: {} }) as unknown as IncomingMessage;
}

describe('chart registry ↔ engine render list', () => {
  const source = readFileSync(REGISTRY_PATH, 'utf-8');

  it('mirrors RENDERS exactly, in the same order', () => {
    const block = /RENDERS\s*=\s*\[([^\]]*)\]/.exec(source);
    expect(block, 'chartRegistry.ts must export a RENDERS array literal').toBeTruthy();
    const mirrored = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(mirrored).toEqual([...RENDERS]);
  });

  it('gives every render its own registry entry', () => {
    const literal = /CHART_REGISTRY: Record<Render, ChartRegistryEntry> = \{([\s\S]*?)\n\};/.exec(source);
    expect(literal, 'chartRegistry.ts must export a CHART_REGISTRY object literal').toBeTruthy();
    // Entries are the object's top-level (2-space indented) keys.
    const keys = [...literal![1].matchAll(/^ {2}([a-z_]+): \{$/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...RENDERS].sort());
  });

  it('declares a CardBody for every entry', () => {
    const bodies = [...source.matchAll(/^ {4}CardBody: (\w+),$/gm)].map((m) => m[1]);
    expect(bodies).toHaveLength(RENDERS.length);
    // A registry entry pointing at an unimported component would not compile,
    // but an entry pointing at the WRONG shared body would — so each render
    // must name a body that is actually imported into the module.
    for (const body of bodies) {
      expect(source, `${body} must be imported`).toMatch(new RegExp(`import \\{[^}]*\\b${body}\\b`));
    }
  });
});

describe('engine — the new render values', () => {
  const newRenders = ['bar', 'bar_compare', 'stacked', 'table', 'heatmap'] as const;

  it('lists the pre-Phase-3 renders first, so existing manifests are untouched', () => {
    expect(RENDERS.slice(0, 5)).toEqual(['number', 'line', 'pie', 'raw', 'funnel']);
  });

  it.each(newRenders)('validateManifestForWrite accepts render "%s"', (render) => {
    expect(() => validateManifestForWrite({ slug: 'metric', title: 'Metric', render })).not.toThrow();
  });

  it.each(newRenders)('createInsight round-trips render "%s" through the lenient read', (render) => {
    createInsight(root, { slug: `m-${render.replace('_', '-')}`, title: 'Metric', render });
    expect(getInsight(root, `m-${render.replace('_', '-')}`)!.render).toBe(render);
  });

  it('still rejects a render nobody declared', () => {
    expect(() => validateManifestForWrite({ slug: 'metric', title: 'Metric', render: 'gantt' as never }))
      .toThrow(LabError);
  });

  it('reads an UNKNOWN render as `number` instead of throwing (leniency is unchanged)', () => {
    writeManifest('legacy', 'render: quadrant\n');
    expect(getInsight(root, 'legacy')!.render).toBe('number');
  });

  it('doctor does not warn about a manifest using a new render', () => {
    for (const render of newRenders) {
      createInsight(root, { slug: `d-${render.replace('_', '-')}`, title: 'Metric', render });
    }
    const renderWarnings = checkLab(root).filter((r) => r.message.includes('render "'));
    expect(renderWarnings).toEqual([]);
  });
});

describe('manifest `size` — the board-footprint override', () => {
  it.each(INSIGHT_SIZES)('reads size "%s" back off the manifest', (size) => {
    createInsight(root, { slug: 'wau', title: 'WAU', size });
    expect(getInsight(root, 'wau')!.size).toBe(size);
  });

  it('defaults to null so the render keeps deciding its own span', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    expect(getInsight(root, 'wau')!.size).toBeNull();
  });

  it('reads an unrecognised size as null (lenient, like `category`)', () => {
    writeManifest('wau', 'render: number\nsize: enormous\n');
    expect(getInsight(root, 'wau')!.size).toBeNull();
  });

  it('rejects an unrecognised size on the WRITE path (strict)', () => {
    expect(() => validateManifestForWrite({ slug: 'wau', title: 'WAU', size: 'xl' as never }))
      .toThrow(LabError);
  });

  it('is exposed on the board summary (GET /api/lab)', async () => {
    createInsight(root, { slug: 'wide', title: 'Wide', render: 'table', size: 'l' });
    createInsight(root, { slug: 'plain', title: 'Plain' });
    const { res, status, body } = makeRes();

    await handleLabList(makeReq(), res, {}, root);

    expect(status()).toBe(200);
    const rows: { slug: string; size: string | null }[] = body().insights;
    expect(rows.find((r) => r.slug === 'wide')!.size).toBe('l');
    expect(rows.find((r) => r.slug === 'plain')!.size).toBeNull();
  });

  it('is exposed on the detail manifest (GET /api/lab/:slug)', async () => {
    createInsight(root, { slug: 'wide', title: 'Wide', render: 'heatmap', size: 's' });
    const { res, status, body } = makeRes();

    await handleLabShow(makeReq(), res, { slug: 'wide' }, root);

    expect(status()).toBe(200);
    expect(body().insight.size).toBe('s');
    expect(body().insight.render).toBe('heatmap');
  });
});
