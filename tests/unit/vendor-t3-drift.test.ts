/**
 * The vendored T3 tree (src/vendor/t3) equals T3 at the recorded commit plus our listed stubs and
 * patches, nothing else (plan r5 §1-2, W1 criterion 2). Any hand edit of a vendored file fails
 * here: a behaviour change must be a `patches/*.patch` with a `# reason:` line, re-applied by
 * `node scripts/sync-t3.mjs <t3-checkout> <commit>`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const VENDOR = join(ROOT, 'src/vendor/t3');
const manifest = JSON.parse(readFileSync(join(VENDOR, 'vendor-manifest.json'), 'utf-8')) as {
  commit: string;
  files: Record<string, string>;
  stubs: Record<string, { reason: string; sha256: string }>;
  patches: Array<{ file: string; reason: string; touches: string[] }>;
};
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const OURS = new Set(['VENDORED.md', 'vendor-manifest.json', 'LICENSE', 'tsconfig.json']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('vendored T3 provider layer', () => {
  it('is pinned to T3 commit 36dac688', () => {
    expect(manifest.commit.startsWith('36dac688')).toBe(true);
  });

  it('every vendored file equals the recorded upstream file (+ MIT header, + listed patches)', () => {
    const drift = Object.entries(manifest.files).filter(([rel, hash]) => !existsSync(join(VENDOR, rel)) || sha(join(VENDOR, rel)) !== hash);
    expect(drift.map(([rel]) => rel)).toEqual([]);
  });

  it('every stub sits at its seam unchanged and carries its reason', () => {
    for (const [rel, stub] of Object.entries(manifest.stubs)) {
      expect(stub.reason.length, rel).toBeGreaterThan(20);
      expect(sha(join(VENDOR, rel)), rel).toBe(stub.sha256);
      expect(sha(join(VENDOR, '_stubs', rel)), `${rel} source`).toBe(stub.sha256);
    }
  });

  it('no file is in the tree that the manifest does not account for', () => {
    const known = new Set([...Object.keys(manifest.files), ...Object.keys(manifest.stubs)]);
    const extra = walk(VENDOR)
      .map((p) => relative(VENDOR, p))
      .filter((rel) => !rel.startsWith('_stubs/') && !rel.startsWith('patches/') && !OURS.has(rel) && !rel.endsWith('/package.json') && !known.has(rel));
    expect(extra).toEqual([]);
  });

  it('every T3 source file keeps the MIT notice, and at most 3 in-file patches exist, each with a reason', () => {
    for (const rel of Object.keys(manifest.files).filter((f) => f.endsWith('.ts'))) {
      expect(readFileSync(join(VENDOR, rel), 'utf-8').startsWith('/*! @license MIT'), rel).toBe(true);
    }
    expect(manifest.patches.length).toBeLessThanOrEqual(3);
    for (const p of manifest.patches) expect(p.reason.length).toBeGreaterThan(10);
    expect(readFileSync(join(VENDOR, 'LICENSE'), 'utf-8')).toContain('T3 Tools Inc.');
  });

  it('when the T3 checkout is on this machine, the manifest matches upstream byte for byte', async () => {
    const src = process.env.T3_CHECKOUT ?? '/tmp/t3code-src/repo';
    if (!existsSync(join(src, '.git'))) return; // CI has no checkout; the hashes above still hold
    const { vendoredText, STUBBED } = await import('../../scripts/sync-t3.mjs');
    for (const [rel, hash] of Object.entries(manifest.files)) {
      if (manifest.patches.some((p) => p.touches.includes(rel)) || STUBBED.includes(rel)) continue;
      const up = readFileSync(join(src, rel), rel.endsWith('.ts') || rel.endsWith('.mjs') ? 'utf-8' : undefined);
      const text = typeof up === 'string' ? vendoredText(rel, up) : up;
      expect(createHash('sha256').update(text).digest('hex'), rel).toBe(hash);
    }
  });
});
