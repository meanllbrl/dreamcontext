import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { EMBED_PROFILE, embedCacheModelKey } from '../../src/lib/embeddings/profiles.js';
import { embeddingCacheUsable } from '../../src/lib/embeddings/store.js';

/**
 * Hybrid is the DEFAULT recall mode, so a fresh machine — no model, no index — is the common
 * case, not an edge. This is the end-to-end proof that such a machine is safe (criterion 6):
 *   1. the per-prompt hook falls back to BM25 and never downloads or indexes inline, even with
 *      provisioning enabled — it only ever READS `hybridReady`;
 *   2. SessionStart provisioning is suppressed by DREAMCONTEXT_EMBED_AUTO=0 and, when enabled,
 *      is a detached process the hook does not wait for;
 *   3. `sleep done` embeds nothing under the opt-out.
 *
 * Each test runs the shipped CLI (dist/) with HOME pointed at an EMPTY temp dir, so the real
 * ~/.dreamcontext/models is never read or written.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const PACKAGE_INSTALLED = (() => {
  try { createRequire(import.meta.url).resolve('@huggingface/transformers'); return true; } catch { return false; }
})();

let tmpRoot: string;
let project: string;
let ctx: string;
let fakeHome: string;

function run(cmd: string, env: Record<string, string>, stdin?: string, timeout = 30_000): string {
  const pipe = stdin === undefined ? '' : `printf '%s' '${stdin.replace(/'/g, "'\\''")}' | `;
  try {
    return execSync(`${pipe}node ${CLI} ${cmd} 2>&1`, {
      cwd: project, encoding: 'utf-8', timeout, shell: '/bin/bash',
      env: { ...process.env, ...env },
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

/** Env for every run: empty HOME, hybrid mode, every unrelated hook gate off. */
function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: fakeHome,
    DREAMCONTEXT_RECALL_MODE: 'hybrid',
    DREAMCONTEXT_VERSION_CHECK: '0',
    DREAMCONTEXT_AUTO_UPGRADE: '0',
    DREAMCONTEXT_SKILLS_HOOK: '0',
    DREAMCONTEXT_INITIALIZER_HOOK: '0',
    DREAMCONTEXT_BRAIN_SYNC: '0',
    ...over,
  };
}

/**
 * Lay down every file the active model needs — graph, metadata AND ONNX weights — so
 * `isEmbedModelComplete` is satisfied. The content is garbage; presence is the point. The file
 * lists come from the active profile, so a model switch needs no change here.
 */
function fakeModelOnDisk(home: string): void {
  const dir = join(home, '.dreamcontext', 'models', EMBED_PROFILE.model);
  for (const f of [...EMBED_PROFILE.files, ...EMBED_PROFILE.dataFiles]) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), f.endsWith('.json') ? '{}' : 'not a real model');
  }
}

/** A cache the store accepts as usable for the active model (so the index is "already built"). */
function writeUsableIndex(): void {
  mkdirSync(join(ctx, '.embeddings'), { recursive: true });
  writeFileSync(join(ctx, '.embeddings', 'cache.json'), JSON.stringify({
    version: 1, model: embedCacheModelKey(), docs: {}, vectors: { aa: 'AAAA' },
  }));
}

/** The embedder's own completeness probe, evaluated against `home` — so a model switch breaks THIS, loudly. */
async function modelProbeSaysComplete(home: string): Promise<boolean> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  vi.resetModules();
  try {
    const embedder = await import('../../src/lib/embeddings/embedder.js');
    return embedder.isEmbedModelComplete();
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    vi.resetModules();
  }
}

/** Wait for a detached `embed ensure` child to be done: it leaves .embeddings behind and drops its lock. */
async function waitForEnsureChild(timeoutMs = 60_000): Promise<boolean> {
  const dir = join(ctx, '.embeddings');
  const finished = () => existsSync(join(dir, '.gitignore')) && !existsSync(join(dir, 'ensure.lock'));
  const deadline = Date.now() + timeoutMs;
  while (!finished() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  return finished();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ac-hybrid-fallback-'));
  project = join(tmpRoot, 'project');
  fakeHome = join(tmpRoot, 'home');
  mkdirSync(fakeHome, { recursive: true });
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(join(ctx, 'knowledge', 'features'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: test\n---\nTest soul.');
  // One strongly matching doc among fillers, so the hook's raw-score gate (>= 2.0) opens deterministically.
  writeFileSync(join(ctx, 'knowledge', 'zebra-quokka-protocol.md'), [
    '---', 'name: zebra-quokka-protocol', 'description: The zebra quokka protocol and its handshake', 'tags: [zebra, quokka, protocol]', '---',
    '# Zebra quokka protocol', 'Zebra quokka protocol handshake. Zebra quokka protocol handshake. Zebra quokka protocol handshake.',
  ].join('\n'));
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(ctx, 'knowledge', `filler-${i}.md`), `---\nname: filler-${i}\ndescription: unrelated note ${i}\n---\nBody about topic number ${i}, nothing to do with the rest.\n`);
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('hybrid mode on a machine with no model and no index', () => {
  it('the prompt hook answers from BM25 and provisions nothing inline, even with provisioning enabled', () => {
    const input = JSON.stringify({ session_id: 'sess-1', prompt: 'explain the zebra quokka protocol handshake' });
    const t0 = Date.now();
    const output = run('hook user-prompt-submit', baseEnv({ DREAMCONTEXT_EMBED_AUTO: '1' }), input);
    const ms = Date.now() - t0;

    expect(output).toContain('— Memory recall (BM25');
    expect(output).not.toContain('(Hybrid');
    expect(output).toContain('zebra-quokka-protocol.md');
    expect(ms).toBeLessThan(5000); // a model download or an index build would blow far past this
    expect(existsSync(join(fakeHome, '.dreamcontext', 'models'))).toBe(false);
    expect(existsSync(join(ctx, '.embeddings'))).toBe(false);
  });

  it('SessionStart under DREAMCONTEXT_EMBED_AUTO=0 starts nothing: no notice, no marker, no index dir, no model dir', () => {
    const input = JSON.stringify({ session_id: 'sess-1', source: 'startup', transcript_path: '/tmp/t.jsonl' });
    const output = run('hook session-start', baseEnv({ DREAMCONTEXT_EMBED_AUTO: '0' }), input);

    expect(output).not.toContain('Hybrid recall: preparing');
    expect(existsSync(join(ctx, '.embeddings'))).toBe(false);
    expect(existsSync(join(fakeHome, '.dreamcontext', 'models'))).toBe(false);
  });

  it.skipIf(!PACKAGE_INSTALLED)('SessionStart with provisioning enabled hands off to a DETACHED process and does not wait for it', async () => {
    // Model "on disk" but unusable, so the child gets as far as the index step and fails fast and
    // OFFLINE (a present model never fetches). What matters here is who runs it and when.
    fakeModelOnDisk(fakeHome);
    expect(await modelProbeSaysComplete(fakeHome)).toBe(true); // update fakeModelOnDisk if the probe's files change

    const input = JSON.stringify({ session_id: 'sess-1', source: 'startup', transcript_path: '/tmp/t.jsonl' });
    const t0 = Date.now();
    const output = run('hook session-start', baseEnv({ DREAMCONTEXT_EMBED_AUTO: '1' }), input);
    const hookMs = Date.now() - t0;

    expect(output).toContain('Hybrid recall: preparing the local embedding model and index in the background');
    expect(output.split('\n').filter((l) => l.includes('Hybrid recall: preparing'))).toHaveLength(1); // ONE line
    expect(hookMs).toBeLessThan(15_000);

    // The child ran: it creates .embeddings (with its self-ignore) at start, and removes its lock at the end.
    expect(await waitForEnsureChild()).toBe(true);
    expect(readFileSync(join(ctx, '.embeddings', '.gitignore'), 'utf-8')).toBe('*\n');
  }, 120_000);
});

describe('`sleep done` and the embedding index', () => {
  it('does nothing under DREAMCONTEXT_EMBED_AUTO=0, even with the model on disk and no index', async () => {
    fakeModelOnDisk(fakeHome);
    expect(await modelProbeSaysComplete(fakeHome)).toBe(true);

    const output = run('sleep done Consolidated the opt-out check', baseEnv({ DREAMCONTEXT_EMBED_AUTO: '0' }));
    expect(output).not.toContain('Embedding refresh');
    expect(output).not.toContain('building it in the background');
    expect(existsSync(join(ctx, '.embeddings'))).toBe(false);
  });

  it.skipIf(!PACKAGE_INSTALLED)('with the model on disk but NO usable index it hands the build to a detached ensure — it never builds inline', async () => {
    fakeModelOnDisk(fakeHome);
    expect(await modelProbeSaysComplete(fakeHome)).toBe(true);
    expect(embeddingCacheUsable(ctx)).toBe(false);

    const t0 = Date.now();
    const output = run('sleep done Consolidated the no-index check', baseEnv({ DREAMCONTEXT_EMBED_AUTO: '1' }), undefined, 90_000);
    const ms = Date.now() - t0;

    expect(output).toContain('the embedding index is not ready — building it in the background');
    expect(output).not.toContain('Embedding refresh');          // the inline refresh did not run
    expect(output).not.toContain('Embedding index refreshed');
    expect(ms).toBeLessThan(20_000);                            // a full build would not return this fast
    expect(existsSync(join(ctx, '.embeddings', 'cache.json'))).toBe(false); // nothing was indexed inline

    // The request really went to a detached `embed ensure`: it ran and finished on its own.
    expect(await waitForEnsureChild()).toBe(true);
  }, 120_000);

  it.skipIf(!PACKAGE_INSTALLED)('control: with a USABLE index the same run refreshes it inline (incrementally) and starts no ensure', async () => {
    fakeModelOnDisk(fakeHome);
    writeUsableIndex();
    expect(await modelProbeSaysComplete(fakeHome)).toBe(true);
    expect(embeddingCacheUsable(ctx)).toBe(true);

    // The fake model cannot load, so the refresh reports it — proof the inline path ran.
    const output = run('sleep done Consolidated the control check', baseEnv({ DREAMCONTEXT_EMBED_AUTO: '1' }), undefined, 90_000);
    expect(output).toContain('Embedding refresh: skipped');
    expect(output).not.toContain('building it in the background');
    expect(existsSync(join(ctx, '.embeddings', 'ensure.lock'))).toBe(false);
    expect(existsSync(join(ctx, '.embeddings', 'ensure.json'))).toBe(false);
  }, 120_000);

  it('does not refresh or provision a vault that is not in hybrid mode', async () => {
    fakeModelOnDisk(fakeHome);
    const output = run('sleep done Consolidated the raw-mode check', baseEnv({ DREAMCONTEXT_EMBED_AUTO: '1', DREAMCONTEXT_RECALL_MODE: 'raw' }));
    expect(output).not.toContain('Embedding refresh');
    expect(output).not.toContain('building it in the background');
    expect(existsSync(join(ctx, '.embeddings'))).toBe(false);
  });
});
