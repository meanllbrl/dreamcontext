/**
 * WS3 evidence script (issue #9): measure feature-doc upkeep health to decide
 * whether the sleep roster needs a dedicated `sleep-features` specialist.
 *
 * Loads this project's feature PRDs + task `related_feature` back-refs, runs the
 * existing `analyzeFeatures()` core, and prints {total, stale, orphaned,
 * dangling, freshPct}. Also computes a 90-day git churn ratio: feature-doc
 * commits vs src commits, a proxy for "do feature docs actually get maintained?"
 *
 * Run: `npx tsx scripts/feature-upkeep-evidence.ts`
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import { analyzeFeatures, type FeatureRef, type TaskRef } from '../src/lib/feature-freshness.js';

const ROOT = process.cwd();
const FEATURES_DIR = join(ROOT, '_dream_context', 'knowledge', 'features');
const STATE_DIR = join(ROOT, '_dream_context', 'state');

function loadFeatures(): FeatureRef[] {
  if (!existsSync(FEATURES_DIR)) return [];
  const out: FeatureRef[] = [];
  for (const file of readdirSync(FEATURES_DIR)) {
    if (!file.endsWith('.md')) continue;
    const { data } = matter(readFileSync(join(FEATURES_DIR, file), 'utf-8'));
    out.push({
      slug: basename(file, '.md'),
      id: typeof data.id === 'string' ? data.id : undefined,
      created: typeof data.created === 'string' ? data.created : undefined,
      updated: typeof data.updated === 'string' ? data.updated : undefined,
      related_tasks: Array.isArray(data.related_tasks)
        ? data.related_tasks.map(String)
        : undefined,
    });
  }
  return out;
}

function loadTaskRefs(): TaskRef[] {
  if (!existsSync(STATE_DIR)) return [];
  const out: TaskRef[] = [];
  for (const file of readdirSync(STATE_DIR)) {
    if (!file.endsWith('.md')) continue;
    const { data } = matter(readFileSync(join(STATE_DIR, file), 'utf-8'));
    out.push({
      task: basename(file, '.md'),
      related_feature:
        typeof data.related_feature === 'string' ? data.related_feature : null,
    });
  }
  return out;
}

/** Count commits in the last 90 days that touched any path under `prefix`. */
function commitsTouching(prefix: string): number {
  try {
    const out = execFileSync(
      'git',
      ['log', '--since=90 days ago', '--oneline', '--', prefix],
      { cwd: ROOT, encoding: 'utf-8' },
    );
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function main(): void {
  const features = loadFeatures();
  const taskRefs = loadTaskRefs();
  const result = analyzeFeatures(features, taskRefs);

  const total = features.length;
  const stale = result.stale.length;
  const orphaned = result.orphaned.length;
  const dangling = result.danglingTaskRefs.length;
  const freshPct = total === 0 ? 100 : Math.round(((total - stale) / total) * 100);
  const stalePct = total === 0 ? 0 : Math.round((stale / total) * 100);

  const featureDocCommits = commitsTouching('_dream_context/knowledge/features');
  const srcCommits = commitsTouching('src');
  const churnRatio =
    srcCommits === 0 ? 0 : Number((featureDocCommits / srcCommits).toFixed(3));

  console.log(
    JSON.stringify(
      {
        total,
        stale,
        stalePct,
        orphaned,
        dangling,
        freshPct,
        git90d: { featureDocCommits, srcCommits, churnRatio },
      },
      null,
      2,
    ),
  );
}

main();
