import { Command } from 'commander';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header, info, success, warn } from '../../lib/format.js';
import { buildCorpus } from '../../lib/recall.js';
import { refreshEmbeddings, embeddingCacheExists } from '../../lib/embeddings/store.js';
import { EMBED_MODEL, embeddingsAvailable } from '../../lib/embeddings/embedder.js';

/**
 * `dreamcontext embed` — manage the EXPERIMENTAL local embedding index that
 * backs hybrid recall (DREAMCONTEXT_RECALL_MODE=hybrid / `dreamcontext recall
 * hybrid`). Off by default; recall itself also refreshes lazily per query, so
 * these commands exist for eager/periodic freshness (cron, sleep, prewarm) and
 * visibility — not correctness.
 */
export function registerEmbedCommand(program: Command): void {
  const embed = program
    .command('embed')
    .description('EXPERIMENTAL: manage the local embedding index used by hybrid recall');

  embed
    .command('refresh')
    .description('Bring the embedding index up to date with the corpus (embeds only changed chunks)')
    .option('--force', 'Re-chunk every doc (content hash fully authoritative; catches same-mtime+size edits)')
    .option('--if-present', 'Exit quietly unless an embedding cache already exists (safe for cron/sleep: never triggers a first-time model download)')
    .action(async (opts: { force?: boolean; ifPresent?: boolean }) => {
      const root = ensureContextRoot();
      if (opts.ifPresent && !embeddingCacheExists(root)) {
        info('No embedding cache in this vault — nothing to refresh (enable hybrid recall first).');
        return;
      }
      if (!(await embeddingsAvailable())) {
        warn(`Embedding model unavailable (${EMBED_MODEL}) — install optional deps / check network for the first download.`);
        process.exitCode = 1;
        return;
      }
      const t0 = performance.now();
      const corpus = buildCorpus(root);
      const res = await refreshEmbeddings(root, corpus, undefined, { force: opts.force ?? false });
      if (res === null) {
        warn('Refresh failed: embedding model unavailable.');
        process.exitCode = 1;
        return;
      }
      const ms = Math.round(performance.now() - t0);
      success(
        `Embedding index fresh: ${res.index.chunks.length} chunks over ${corpus.length} docs ` +
        `(embedded ${res.stats.embedded}, reused ${res.stats.reused}, evicted ${res.stats.evicted}) in ${ms}ms` +
        (opts.force ? ' [force]' : ''),
      );
    });

  embed
    .command('status')
    .description('Show embedding cache presence, size, and model')
    .action(() => {
      const root = ensureContextRoot();
      console.log(header('Embedding Index'));
      const path = join(root, '.embeddings', 'cache.json');
      if (!existsSync(path)) {
        info('No embedding cache — hybrid recall has not been used in this vault.');
        info(`Enable: ${chalk.cyan('dreamcontext recall hybrid')} (or DREAMCONTEXT_RECALL_MODE=hybrid), then run ${chalk.cyan('dreamcontext embed refresh')} to prewarm.`);
        return;
      }
      try {
        const raw = statSync(path);
        // Cheap structural read: count docs/vectors without keeping the blob.
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
          model?: string;
          docs?: Record<string, unknown>;
          vectors?: Record<string, unknown>;
        };
        console.log(`  Model:   ${parsed.model ?? 'unknown'}`);
        console.log(`  Docs:    ${Object.keys(parsed.docs ?? {}).length}`);
        console.log(`  Vectors: ${Object.keys(parsed.vectors ?? {}).length}`);
        console.log(`  Size:    ${(raw.size / 1024 / 1024).toFixed(1)} MB`);
        console.log(`  Updated: ${new Date(raw.mtimeMs).toISOString()}`);
      } catch {
        warn('Cache file exists but could not be read — it will be rebuilt on the next refresh.');
      }
    });
}
