import { Command } from 'commander';
import chalk from 'chalk';
import { header, info, warn } from '../../../lib/format.js';
import { listCohorts } from '../../../lib/marketing/cohort.js';
import { getLatestSnapshot } from '../../../lib/marketing/insights-cache.js';

export function registerMarketingToday(parent: Command): void {
  parent
    .command('today')
    .description('Active cohorts + today\'s spend by campaign + freshness in <2s.')
    .action(() => {
      console.log(header('Today'));

      const cohorts = listCohorts().filter((c) => c.status === 'launched' || c.status === 'monitoring');
      if (cohorts.length === 0) {
        info('No active cohorts.');
        return;
      }

      let totalSpendMinor = 0;
      let staleCount = 0;

      for (const c of cohorts) {
        console.log(`  ${chalk.cyan(c.id)}  ${chalk.bold(c.name)}  ${chalk.dim('· ' + c.status)}`);
        if (c.campaign_ids.length === 0) {
          console.log(chalk.dim('    (no campaigns yet)'));
          continue;
        }
        for (const id of c.campaign_ids) {
          const snap = getLatestSnapshot(id);
          if (!snap) {
            console.log(`    ${chalk.dim(id.padEnd(22))}  ${chalk.dim('no snapshot')}`);
            staleCount += 1;
            continue;
          }
          const ageMs = Date.now() - new Date(snap.pulled_at).getTime();
          const isStale = ageMs > 24 * 60 * 60 * 1000;
          if (isStale) staleCount += 1;
          const rows = extractRows(snap.data);
          const spend = rows.reduce((acc, r) => acc + Number(r.spend ?? 0), 0);
          totalSpendMinor += Math.round(spend * 100);
          const freshness = isStale ? chalk.red('STALE >24h') : chalk.green(ageStr(snap.pulled_at));
          console.log(`    ${chalk.dim(id.padEnd(22))}  spend=${chalk.yellow(spend.toFixed(2).padStart(8))}  ${freshness}`);
        }
      }

      console.log();
      console.log(chalk.bold(`  total spend (window): ${chalk.yellow((totalSpendMinor / 100).toFixed(2))}`));
      if (staleCount > 0) {
        warn(`${staleCount} entit${staleCount === 1 ? 'y has' : 'ies have'} stale data — run \`dreamcontext marketing insights pull\`.`);
      }
    });
}

function ageStr(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

interface InsightRow { spend?: string | number; [k: string]: unknown; }
function extractRows(raw: unknown): InsightRow[] {
  if (raw == null || typeof raw !== 'object') return [];
  const data = (raw as { data?: unknown[] }).data;
  return Array.isArray(data) ? (data as InsightRow[]) : [];
}
