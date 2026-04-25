/**
 * mk kill --bottom <N> --by <metric>
 *
 * Ranks active campaigns by a metric (ROAS / CPA / spend / clicks) and pauses
 * the worst N. Default dry-run; --no-dry-run for live.
 *
 * Important per account-ops.md §4: kill-by-spend (Meta stopped spending ≥3d)
 * is the corpus rule, NOT kill-by-ROAS. This verb honors operator override but
 * warns when the chosen metric isn't `spend`.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info, warn } from '../../../lib/format.js';
import { pauseEntity } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import { listCohorts } from '../../../lib/marketing/cohort.js';
import { getLatestSnapshot } from '../../../lib/marketing/insights-cache.js';
import { withLock, beginRun } from '../../../lib/marketing/store.js';
import { buildCtx } from './_ctx.js';

const ALLOWED_METRICS = ['ROAS', 'roas', 'CPA', 'cpa', 'spend', 'clicks', 'CTR', 'ctr', 'frequency'];

export function registerMarketingKill(parent: Command): void {
  parent
    .command('kill')
    .description('Pause the worst N active campaigns by a metric. Default dry-run.')
    .requiredOption('--bottom <n>', 'how many campaigns to pause', '1')
    .requiredOption('--by <metric>', `ranking metric (one of ${ALLOWED_METRICS.join(', ')})`, 'spend')
    .option('--no-dry-run', 'Actually pause the campaigns')
    .action(async (opts: { bottom: string; by: string; dryRun?: boolean }) => {
      console.log(header(`Kill — bottom ${opts.bottom} by ${opts.by}`));
      const n = Number.parseInt(opts.bottom, 10);
      if (!Number.isInteger(n) || n < 1) {
        error(`--bottom must be a positive integer (got "${opts.bottom}")`);
        process.exit(1);
      }
      if (!ALLOWED_METRICS.includes(opts.by)) {
        error(`--by "${opts.by}" not allowed. Use one of: ${ALLOWED_METRICS.join(', ')}`);
        process.exit(1);
      }
      const metric = opts.by.toLowerCase();
      if (metric !== 'spend') {
        warn(
          `account-ops.md §4 corpus rule: kill by spend=0 (Meta de-prioritized), NOT by relative ${opts.by}. ` +
          `Killing low-${opts.by} ads while Meta is still spending on them breaks Meta's funnel sequence. ` +
          `Override accepted — but confirm with operator before live run.`,
        );
      }

      // Collect ranked candidates from active cohorts
      const active = listCohorts().filter((c) => c.status === 'launched' || c.status === 'monitoring');
      const candidates: Array<{ id: string; metric: number }> = [];
      for (const c of active) {
        for (const cid of c.campaign_ids) {
          const snap = getLatestSnapshot(cid);
          if (!snap) continue;
          const value = aggregateMetric(snap.data, metric);
          if (value == null) continue;
          candidates.push({ id: cid, metric: value });
        }
      }
      if (candidates.length === 0) {
        info('No active campaigns with snapshots to rank. Pull insights first.');
        return;
      }
      // Ascending sort = lowest first = bottom N
      candidates.sort((a, b) => a.metric - b.metric);
      const targets = candidates.slice(0, Math.min(n, candidates.length));
      console.log();
      console.log(chalk.bold('Targets:'));
      for (const t of targets) {
        console.log(`  ${chalk.red('✗')} ${chalk.cyan(t.id)}  ${opts.by}=${t.metric.toFixed(3)}`);
      }
      console.log();

      const ctx = buildCtx({ noDryRun: opts.dryRun === false });
      if (ctx.dryRun) info(chalk.yellow('[DRY-RUN] no live changes — pass --no-dry-run to pause'));

      try {
        await withLock(async () => {
          const run = beginRun('kill-bottom', { metric, n, targets: targets.map((t) => t.id), dry_run: ctx.dryRun });
          for (const t of targets) {
            try {
              await pauseEntity(ctx, t.id);
              run.appendEvent({ id: t.id, status: 'paused', metric_value: t.metric });
              success(`paused ${t.id}${ctx.dryRun ? ' (dry-run)' : ''}`);
            } catch (e) {
              run.appendEvent({ id: t.id, status: 'failed', error: (e as Error).message });
              error(`failed ${t.id}: ${(e as Error).message}`);
            }
          }
          run.succeed({ paused: targets.length });
        });
      } catch (e) {
        if (e instanceof TokenExpiredError) {
          error('Token expired. Regenerate and retry.');
          process.exit(1);
        }
        if (e instanceof MetaApiError) {
          error(`Graph API error: status=${e.status} code=${e.metaErrorCode ?? '-'}`);
          process.exit(1);
        }
        error(`kill failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}

function aggregateMetric(raw: unknown, metric: string): number | null {
  if (raw == null || typeof raw !== 'object') return null;
  const rows = ((raw as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  let total = 0;
  let n = 0;
  for (const r of rows) {
    let v: number | null = null;
    switch (metric) {
      case 'spend': v = Number(r.spend ?? 0); break;
      case 'clicks': v = Number(r.clicks ?? 0); break;
      case 'ctr': v = Number(r.ctr ?? 0); break;
      case 'frequency': v = Number(r.frequency ?? 0); break;
      case 'roas': {
        const arr = r.purchase_roas as Array<{ value?: string }> | undefined;
        if (arr?.[0]?.value) v = Number(arr[0].value);
        break;
      }
      case 'cpa': {
        const arr = r.cost_per_action_type as Array<{ action_type?: string; value?: string }> | undefined;
        const purchase = arr?.find((x) => x.action_type === 'purchase' || x.action_type === 'offsite_conversion.fb_pixel_purchase');
        if (purchase?.value) v = Number(purchase.value);
        break;
      }
    }
    if (v != null && Number.isFinite(v)) {
      total += v;
      n += 1;
    }
  }
  if (n === 0) return null;
  // For "spend" / "clicks" (cumulative), sum is right; for rates, average.
  return ['spend', 'clicks'].includes(metric) ? total : total / n;
}
