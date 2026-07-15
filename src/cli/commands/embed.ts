import { Command } from 'commander';
import { existsSync, statSync, readFileSync, readSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header, info, success, warn, error } from '../../lib/format.js';
import { buildCorpus, type CorpusType } from '../../lib/recall.js';
import { refreshEmbeddings, embeddingCacheExists } from '../../lib/embeddings/store.js';
import { EMBED_MODEL, embeddingsAvailable } from '../../lib/embeddings/embedder.js';
import { dedupCandidate, type DedupResult, type DedupCandidate } from '../../lib/embeddings/dedup.js';

const VALID_DEDUP_TYPES: readonly CorpusType[] = [
  'knowledge', 'feature', 'task', 'memory', 'changelog', 'objective', 'insight',
];

/** Read all of stdin synchronously (candidate body piped in). */
function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  try {
    for (;;) {
      const n = readSync(0, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch {
    // EOF on a non-pipe stdin surfaces as EAGAIN/EOF — return what we have.
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Append one dedup decision to the (gitignored) `.embeddings/dedup-log.jsonl`. */
function logDedupDecision(root: string, candidate: DedupCandidate, result: DedupResult): void {
  try {
    const dir = join(root, '.embeddings');
    mkdirSync(dir, { recursive: true });
    const ignorePath = join(dir, '.gitignore');
    if (!existsSync(ignorePath)) {
      // Match store.saveCache: the whole dir is credential-class / local-only.
      appendFileSync(ignorePath, '*\n');
    }
    const entry = {
      ts: new Date().toISOString(),
      title: candidate.title,
      verdict: result.verdict,
      topDocKey: result.top?.docKey ?? null,
      topSim: result.top ? Number(result.top.sim.toFixed(4)) : null,
      mergeThreshold: result.mergeThreshold,
      reviewThreshold: result.reviewThreshold,
      neighbors: result.neighbors.map((n) => ({ docKey: n.docKey, sim: Number(n.sim.toFixed(4)) })),
    };
    appendFileSync(join(dir, 'dedup-log.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    // Logging is best-effort — never fail a dedup check because the log is unwritable.
  }
}

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
    .command('dedup')
    .description('Semantic near-duplicate check for a candidate knowledge/feature doc (sleep dedup: merge instead of duplicate)')
    .requiredOption('--title <title>', 'Candidate document title (recall/identity anchor)')
    .option('-d, --description <desc>', 'Candidate description / summary')
    .option('-c, --content <content>', 'Candidate body content (inline)')
    .option('--file <path>', 'Read candidate body from a file')
    .option('--stdin', 'Read candidate body from stdin')
    .option('--types <types>', 'Corpus types to check against (comma-separated)', 'knowledge,feature')
    .option('--top <n>', 'Number of nearest neighbors to show', '5')
    .option('--merge-threshold <n>', 'Cosine ≥ this → MERGE verdict (0–1; overrides DREAMCONTEXT_DEDUP_MERGE)')
    .option('--review-threshold <n>', 'Cosine ≥ this and < merge → REVIEW verdict (0–1; overrides DREAMCONTEXT_DEDUP_REVIEW)')
    .option('--exclude <docKey>', 'Exclude a type/slug from neighbors (when re-checking an existing doc you are updating)')
    .option('--json', 'Machine-readable JSON output')
    .option('--no-log', 'Do not append the decision to .embeddings/dedup-log.jsonl')
    .option('--if-present', 'Exit quietly (verdict "unknown") unless an embedding cache already exists (safe for sleep: never triggers a first-time model download)')
    .action(async (opts: {
      title: string;
      description?: string;
      content?: string;
      file?: string;
      stdin?: boolean;
      types: string;
      top: string;
      mergeThreshold?: string;
      reviewThreshold?: string;
      exclude?: string;
      json?: boolean;
      log?: boolean;
      ifPresent?: boolean;
    }) => {
      const root = ensureContextRoot();

      if (opts.ifPresent && !embeddingCacheExists(root)) {
        if (opts.json) {
          console.log(JSON.stringify({ verdict: 'unknown', reason: 'no-embedding-cache' }));
        } else {
          info('No embedding cache in this vault — semantic dedup skipped (enable hybrid recall first). Fall back to keyword recall.');
        }
        return;
      }

      // Candidate body: --content wins, then --file, then --stdin, else empty.
      let body = opts.content ?? '';
      if (!opts.content && opts.file) {
        if (!existsSync(opts.file)) {
          error(`Candidate --file not found: ${opts.file}`);
          process.exitCode = 1;
          return;
        }
        body = readFileSync(opts.file, 'utf-8');
      } else if (!opts.content && opts.stdin) {
        body = readStdin();
      }

      const types = opts.types
        .split(',')
        .map((t) => t.trim())
        .filter((t): t is CorpusType => (VALID_DEDUP_TYPES as readonly string[]).includes(t));
      if (types.length === 0) {
        error(`No valid --types (got "${opts.types}"). Valid: ${VALID_DEDUP_TYPES.join(', ')}.`);
        process.exitCode = 1;
        return;
      }

      const parseThreshold = (v: string | undefined, label: string): number | undefined => {
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          warn(`Ignoring --${label} "${v}" (must be a number in 0–1).`);
          return undefined;
        }
        return n;
      };
      const topK = Math.max(1, Number.parseInt(opts.top, 10) || 5);

      if (!(await embeddingsAvailable())) {
        if (opts.json) {
          console.log(JSON.stringify({ verdict: 'unknown', reason: 'model-unavailable' }));
        } else {
          warn(`Embedding model unavailable (${EMBED_MODEL}) — semantic dedup skipped. Fall back to keyword recall.`);
        }
        process.exitCode = 1;
        return;
      }

      const candidate: DedupCandidate = {
        title: opts.title,
        description: opts.description,
        body,
      };
      const result = await dedupCandidate(root, candidate, {
        types,
        topK,
        mergeThreshold: parseThreshold(opts.mergeThreshold, 'merge-threshold'),
        reviewThreshold: parseThreshold(opts.reviewThreshold, 'review-threshold'),
        excludeDocKey: opts.exclude,
      });

      if (result === null) {
        if (opts.json) {
          console.log(JSON.stringify({ verdict: 'unknown', reason: 'model-unavailable' }));
        } else {
          warn('Semantic dedup unavailable (embedding model could not run) — fall back to keyword recall.');
        }
        process.exitCode = 1;
        return;
      }

      if (opts.log !== false) logDedupDecision(root, candidate, result);

      if (opts.json) {
        console.log(JSON.stringify(result, (_k, v) => (v instanceof Float32Array ? Array.from(v) : v)));
        return;
      }

      console.log(header(`Semantic dedup — "${opts.title}"`));
      if (result.neighbors.length === 0) {
        info(`No existing ${types.join('/')} docs to compare against — safe to CREATE.`);
      } else {
        console.log(chalk.dim(`  Nearest of ${result.corpusDocs} ${types.join('/')} doc(s), by cosine similarity:`));
        for (const n of result.neighbors) {
          const band =
            n.sim >= result.mergeThreshold ? chalk.red(' [≥merge]')
            : n.sim >= result.reviewThreshold ? chalk.yellow(' [≥review]')
            : '';
          console.log(`  ${chalk.cyan(n.sim.toFixed(3))}  ${chalk.magentaBright(n.docKey)}${band}`);
          console.log(`         ${chalk.dim(n.title)}`);
        }
      }
      console.log('');
      const t = result.top;
      const marginStr = result.margin === null ? 'only doc' : `+${result.margin.toFixed(3)} over #2`;
      if (result.verdict === 'merge' && t) {
        console.log(
          chalk.red.bold('  VERDICT: MERGE') +
          `  — fold into ${chalk.magentaBright(t.docKey)} ` +
          chalk.dim(`(cosine ${t.sim.toFixed(3)} ≥ ${result.mergeThreshold}, margin ${marginStr})`),
        );
        console.log(chalk.dim(`  Do NOT create a new file. Extend ${t.relPath} (or \`dreamcontext knowledge merge\`).`));
      } else if (result.verdict === 'review' && t) {
        console.log(
          chalk.yellow.bold('  VERDICT: REVIEW') +
          `  — closest is ${chalk.magentaBright(t.docKey)} ` +
          chalk.dim(`(cosine ${t.sim.toFixed(3)}; below ${result.mergeThreshold} merge, above ${result.reviewThreshold} review)`),
        );
        console.log(chalk.dim('  Judge create-vs-extend: same topic family → extend it; genuinely separate → create.'));
      } else {
        console.log(
          chalk.green.bold('  VERDICT: CREATE') +
          '  — no near-duplicate above the review threshold. Safe to create a new file.',
        );
      }
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
