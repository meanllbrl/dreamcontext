import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Network-free coverage for the embedding-model *status* surface (the Settings
 * "Hybrid" card): disk-based download detection and the state-derivation logic.
 * We point HOME at a temp dir BEFORE importing the module so EMBED_MODEL_CACHE_DIR
 * (captured at import time from homedir()) resolves under our scratch tree — no real
 * model, no download, no @huggingface/transformers load.
 */

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tmpHome = mkdtempSync(join(tmpdir(), 'dc-embhome-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  EMBED_MODEL,
  EMBED_MODEL_CACHE_DIR,
  EMBED_PROFILE,
  isEmbedModelDownloaded,
  getEmbedModelStatus,
  isEmbedPackageInstalled,
} = await import('../../src/lib/embeddings/embedder.js');

const modelRoot = join(EMBED_MODEL_CACHE_DIR, EMBED_MODEL);

function writeModelFiles(opts: { onnx?: boolean; config?: boolean; tokenizer?: boolean; weights?: boolean }): void {
  mkdirSync(join(modelRoot, 'onnx'), { recursive: true });
  // The profile's external-data weights (empty for e5): part of "downloaded" now — see isEmbedModelComplete.
  if (opts.weights) for (const f of EMBED_PROFILE.dataFiles) writeFileSync(join(modelRoot, f), 'x');
  if (opts.onnx) writeFileSync(join(modelRoot, 'onnx', 'model_quantized.onnx'), 'x');
  if (opts.config) writeFileSync(join(modelRoot, 'config.json'), '{}');
  if (opts.tokenizer) writeFileSync(join(modelRoot, 'tokenizer.json'), '{}');
}

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
});

describe('embedding model status', () => {
  it('caches under ~/.dreamcontext/models', () => {
    expect(EMBED_MODEL_CACHE_DIR).toBe(join(tmpHome, '.dreamcontext', 'models'));
  });

  it('reports not_downloaded when no model files exist', () => {
    expect(isEmbedModelDownloaded()).toBe(false);
    const s = getEmbedModelStatus();
    expect(s.state).toBe('not_downloaded');
    expect(s.downloaded).toBe(false);
    expect(s.progress).toBe(0);
    expect(s.files).toEqual([]);
    expect(s.model).toBe(EMBED_MODEL);
    expect(typeof s.packageInstalled).toBe('boolean');
    expect(s.error).toBeNull();
    expect(s.errorCode).toBeNull();
  });

  it('treats a partial cache (onnx only, missing metadata) as NOT downloaded', () => {
    writeModelFiles({ onnx: true });
    expect(isEmbedModelDownloaded()).toBe(false);
    expect(getEmbedModelStatus().state).toBe('not_downloaded');
  });

  it('a graph + metadata WITHOUT the weights is not ready: the status agrees with the load gate', () => {
    writeModelFiles({ onnx: true, config: true, tokenizer: true });
    expect(isEmbedModelDownloaded()).toBe(true);
    if (EMBED_PROFILE.dataFiles.length === 0) return; // e5: nothing more to wait for
    const s = getEmbedModelStatus();
    expect(s.downloaded).toBe(false);
    expect(s.state).toBe('not_downloaded');
  });

  it('reports ready once all model files are present on disk', () => {
    writeModelFiles({ onnx: true, config: true, tokenizer: true, weights: true });
    expect(isEmbedModelDownloaded()).toBe(true);
    const s = getEmbedModelStatus();
    expect(s.state).toBe('ready');
    expect(s.downloaded).toBe(true);
    expect(s.progress).toBe(100);
  });

  it('package-installed probe returns a stable boolean (cached)', () => {
    const first = isEmbedPackageInstalled();
    expect(typeof first).toBe('boolean');
    expect(isEmbedPackageInstalled()).toBe(first);
  });
});
