import { Command } from 'commander';
import chalk from 'chalk';
import { error, header, info, warn } from '../../../lib/format.js';
import { listCohorts } from '../../../lib/marketing/cohort.js';
import { getLatestSnapshot, getPriorSnapshot } from '../../../lib/marketing/insights-cache.js';

export function registerMarketingDiff(parent: Command): void {
  parent
    .command('diff')
    .description('Diff insights snapshots over a window (default 24h).')
    .option('--since <window>', 'comparison window (24h, 48h, 7d)', '24h')
    .option('--campaign <id>', 'restrict to one campaign')
    .action((opts: { since: string; campaign?: string }) => {
      console.log(header(`Diff — since ${opts.since}`));
      const beforeMs = parseSince(opts.since);
      if (beforeMs == null) {
        error(`Invalid --since "${opts.since}". Use 24h, 48h, 7d.`);
        process.exit(1);
      }

      const targets: string[] = [];
      if (opts.campaign) {
        targets.push(opts.campaign);
      } else {
        const active = listCohorts().filter((c) => c.status === 'launched' || c.status === 'monitoring');
        for (const c of active) targets.push(...c.campaign_ids);
      }
      if (targets.length === 0) {
        info('No campaigns to diff. Pass --campaign <id> to target one.');
        return;
      }

      let any = false;
      for (const id of targets) {
        const latest = getLatestSnapshot(id);
        const prior = getPriorSnapshot(id, beforeMs);
        if (!latest) {
          warn(`${id}: no current snapshot`);
          continue;
        }
        if (!prior) {
          warn(`${id}: no prior snapshot ≥${opts.since} ago`);
          continue;
        }
        any = true;
        console.log();
        console.log(`  ${chalk.cyan(id)}  ${chalk.dim(`(${prior.pulled_at.slice(0, 16)} → ${latest.pulled_at.slice(0, 16)})`)}`);
        const before = aggregate(prior.data);
        const after = aggregate(latest.data);
        printRow('spend',     before.spend,    after.spend);
        printRow('impressions', before.impressions, after.impressions);
        printRow('clicks',    before.clicks,   after.clicks);
        printRow('CTR',       before.ctr,      after.ctr);
        printRow('CPM',       before.cpm,      after.cpm);
        printRow('ROAS',      before.roas,     after.roas);
        printRow('frequency', before.frequency, after.frequency);
      }
      if (!any) {
        info('No comparable pairs found. Pull more snapshots first.');
      }
    });
}

function parseSince(s: string): number | null {
  const m = /^(\d+)\s*(h|d)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return m[2].toLowerCase() === 'h' ? n * 3_600_000 : n * 86_400_000;
}

interface Agg {
  spend: number; impressions: number; clicks: number;
  ctr: number; cpm: number; roas: number; frequency: number;
}

function aggregate(raw: unknown): Agg {
  const acc: Agg = { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, roas: 0, frequency: 0 };
  if (raw == null || typeof raw !== 'object') return acc;
  const rows = ((raw as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown>>;
  let n = 0;
  for (const r of rows) {
    acc.spend += Number(r.spend ?? 0);
    acc.impressions += Number(r.impressions ?? 0);
    acc.clicks += Number(r.clicks ?? 0);
    acc.ctr += Number(r.ctr ?? 0);
    acc.cpm += Number(r.cpm ?? 0);
    const roasArr = r.purchase_roas as Array<{ value?: string }> | undefined;
    if (roasArr?.[0]?.value) acc.roas += Number(roasArr[0].value);
    acc.frequency += Number(r.frequency ?? 0);
    n += 1;
  }
  if (n > 1) {
    acc.ctr /= n; acc.cpm /= n; acc.roas /= n; acc.frequency /= n;
  }
  return acc;
}

function printRow(label: string, before: number, after: number): void {
  const delta = after - before;
  const pct = before === 0 ? null : (delta / before) * 100;
  const arrow = delta > 0 ? chalk.green('▲') : delta < 0 ? chalk.red('▼') : chalk.dim('=');
  const pctStr = pct == null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
  console.log(
    `    ${label.padEnd(11)} ${before.toFixed(2).padStart(10)} → ${after.toFixed(2).padStart(10)}  ${arrow} ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}${pctStr}`,
  );
}
