import { Command } from 'commander';
import chalk from 'chalk';
import { error, success, header, info, warn } from '../../../lib/format.js';
import { getInsights } from '../../../lib/marketing/meta-client.js';
import { TokenExpiredError, MetaApiError } from '../../../lib/marketing/meta-fetch.js';
import {
  saveInsightsSnapshot,
  getCachedInsights,
  getLatestSnapshot,
  INSIGHTS_TTL_MS,
} from '../../../lib/marketing/insights-cache.js';
import { listCohorts } from '../../../lib/marketing/cohort.js';
import { beginRun } from '../../../lib/marketing/store.js';
import { buildReadCtx } from './_ctx.js';

const ALLOWED_PRESETS = new Set([
  'today', 'yesterday', 'last_3d', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month',
]);

const V0_MAX_PRESET = 'last_7d';   // hard cap per task; >7d goes through v1 async
const V0_MAX_PRESET_LIST = ['today', 'yesterday', 'last_3d', 'last_7d'];

export function registerMarketingInsights(parent: Command): void {
  const cmd = parent
    .command('insights')
    .description('Pull and inspect Meta /insights snapshots.');

  cmd
    .command('pull')
    .description('Pull insights for active cohorts (sync, v0 caps window at 7d).')
    .option('--since <preset>', 'date_preset (today|yesterday|last_3d|last_7d)', 'last_7d')
    .option('--campaign <id>', 'pull a single campaign')
    .option('--force', 'ignore the 15-min TTL cache and pull live anyway', false)
    .action(async (opts: { since: string; campaign?: string; force?: boolean }) => {
      console.log(header('Insights pull'));

      if (!ALLOWED_PRESETS.has(opts.since)) {
        error(`Invalid --since "${opts.since}". Allowed: ${[...ALLOWED_PRESETS].join(', ')}`);
        process.exit(1);
      }
      if (!V0_MAX_PRESET_LIST.includes(opts.since)) {
        warn(`v0 hard-caps sync windows at ${V0_MAX_PRESET}. Use a smaller --since or wait for v1 async insights.`);
        process.exit(1);
      }

      const ctx = buildReadCtx();

      // Decide what to pull
      const targets: string[] = [];
      if (opts.campaign) {
        targets.push(opts.campaign);
      } else {
        const active = listCohorts().filter((c) => c.status === 'launched' || c.status === 'monitoring');
        for (const c of active) targets.push(...c.campaign_ids);
      }

      if (targets.length === 0) {
        info('No active campaigns to pull. Pass --campaign <id> to target one explicitly.');
        return;
      }

      const run = beginRun('insights-pull', { since: opts.since, targets });
      let pulled = 0;
      let cached = 0;
      let failed = 0;

      try {
        for (const id of targets) {
          if (!opts.force) {
            const cachedSnap = getCachedInsights(id);
            if (cachedSnap) {
              cached += 1;
              info(`${chalk.dim(id)} cache hit (age=${ageStr(cachedSnap.pulled_at)})`);
              continue;
            }
          }
          try {
            const data = await getInsights(ctx, {
              entityId: id,
              date_preset: opts.since as 'last_7d',
              level: 'ad',
            });
            saveInsightsSnapshot({
              entity_id: id,
              level: 'ad',
              pulled_at: new Date().toISOString(),
              since: opts.since,
              data,
            });
            pulled += 1;
            success(`${chalk.cyan(id)} pulled`);
            run.appendEvent({ id, status: 'pulled' });
          } catch (e) {
            failed += 1;
            if (e instanceof TokenExpiredError) {
              error('Token expired. Regenerate and retry.');
              run.fail('token expired');
              process.exit(1);
            }
            const msg = e instanceof MetaApiError ? `status=${e.status} code=${e.metaErrorCode}` : (e as Error).message;
            error(`${id} failed: ${msg}`);
            run.appendEvent({ id, status: 'failed', error: msg });
          }
        }
        run.succeed({ pulled, cached, failed });
      } catch (e) {
        run.fail((e as Error).message);
        throw e;
      }

      console.log();
      info(`pulled=${pulled} cached=${cached} failed=${failed}`);
    });

  cmd
    .command('show')
    .description('Show the latest cached snapshot for a campaign / adset / ad.')
    .requiredOption('--id <id>', 'Meta entity id (campaign / adset / ad)')
    .action((opts: { id: string }) => {
      const snap = getLatestSnapshot(opts.id);
      if (!snap) {
        error(`No snapshot for ${opts.id}. Run \`dreamcontext marketing insights pull --campaign ${opts.id}\` first.`);
        process.exit(1);
      }
      console.log(header(`Insights — ${opts.id}`));
      console.log(`  pulled_at: ${snap.pulled_at} (${ageStr(snap.pulled_at)})`);
      console.log(`  window:    ${snap.since}`);
      console.log(`  level:     ${snap.level}`);
      console.log();
      const rows = extractRows(snap.data);
      if (rows.length === 0) {
        warn('Snapshot has no insight rows (no spend in window?).');
        return;
      }
      for (const r of rows.slice(0, 25)) {
        const id = r.ad_id ?? r.adset_id ?? r.campaign_id ?? '?';
        const name = r.ad_name ?? r.adset_name ?? r.campaign_name ?? '';
        console.log(
          `  ${chalk.cyan(String(id).padEnd(20))}  spend=${chalk.yellow(String(r.spend ?? '0').padEnd(8))}  ROAS=${chalk.green(String(r.purchase_roas?.[0]?.value ?? '-').padEnd(6))}  freq=${String(r.frequency ?? '-').slice(0, 5)}  ${chalk.dim(name)}`,
        );
      }
      if (rows.length > 25) info(`(${rows.length - 25} more rows)`);
    });
}

function ageStr(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

interface InsightRow {
  spend?: string | number;
  purchase_roas?: Array<{ value: string }>;
  frequency?: string | number;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  campaign_name?: string;
  adset_name?: string;
  ad_name?: string;
  [k: string]: unknown;
}

function extractRows(raw: unknown): InsightRow[] {
  if (raw == null || typeof raw !== 'object') return [];
  const data = (raw as { data?: unknown[] }).data;
  if (!Array.isArray(data)) return [];
  return data as InsightRow[];
}
