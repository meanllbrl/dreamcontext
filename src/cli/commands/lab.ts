import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { success, error, header, warn } from '../../lib/format.js';
import { createInsight, getInsight, listInsights, readCache, writeInsightTweaks } from '../../lib/lab/store.js';
import { bindInsight, syncInsight, syncAll } from '../../lib/lab/sync.js';
import { ProgressBar } from '../../lib/progress.js';
import { writeCredential, listCredentialNames } from '../../lib/lab/credentials.js';
import { gitignoreCovers } from '../../lib/gitignore.js';
import { computeFunnelPrev, computeStepRows, worstDropIndex } from '../../lib/lab/funnel.js';
import { dimLabel, dimValues, pivotCell, MATRIX_LOW_SAMPLE_THRESHOLD, MATRIX_SET_KIND } from '../../lib/lab/matrix.js';
import { createReport, getReport, listReports, reportWindowPlan, resolveReport, DATE_NAVS, type DateNav } from '../../lib/lab/reports-store.js';
import { generateReportCommentary } from '../../lib/lab/report-commentary.js';
import { findAppPage } from '../../lib/lab/app.js';
import { queryDataset, resolveDatasetAsOf, type DatasetQuery } from '../../lib/lab/datasetQuery.js';
import { htmlToText } from '../../lib/lab/htmlText.js';
import {
  INSIGHT_SIZES,
  LabError,
  RENDERS,
  type DatasetCacheEntry,
  type FunnelCacheEntry,
  type InsightCache,
  type InsightSize,
  type MatrixCacheEntry,
  type MatrixSet,
  type Render,
} from '../../lib/lab/types.js';

/**
 * `dreamcontext lab` — the analytics-insights subsystem CLI. Mirrors `roadmap`:
 * a thin renderer over the same store/sync engine the dashboard's `/api/lab*`
 * routes call, so behaviour never drifts between CLI and UI.
 */

/** Resolve the project root that holds `_dream_context/` (secrets file location). */
function projectRootFor(contextRoot: string): string {
  return dirname(contextRoot);
}

/** Render `n` as a fixed-width table cell. */
function cell(v: string, width: number): string {
  return v.length >= width ? v : v + ' '.repeat(width - v.length);
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

/** `lab show` funnel view: per-funnel step table with the worst drop highlighted. */
function printFunnelSet(funnel: FunnelCacheEntry, history: InsightCache['funnelHistory']): void {
  const { set, notices, range } = funnel;
  const prev = computeFunnelPrev(funnel, history);
  console.log(`  range: ${range.fromISO} → ${range.toISO}`);
  if (prev.source) console.log(chalk.dim(`  Δ vs snapshot ${prev.source.range.fromISO} → ${prev.source.range.toISO}`));
  for (const notice of notices) warn(notice);

  for (const f of set.funnels) {
    console.log();
    console.log(`  ${chalk.magentaBright(f.id)} — ${f.name}`);
    const metricBits = Object.entries(f.metrics).map(([key, m]) => {
      const v = m.v === null ? '—' : m.format === 'pct' ? `${m.v}%` : m.format === 'usd' ? `$${m.v}` : String(m.v);
      return `${m.label ?? key}=${v}`;
    });
    if (metricBits.length > 0) console.log(chalk.dim(`    ${metricBits.join(' · ')}`));

    const rows = computeStepRows(f.steps);
    const worst = worstDropIndex(rows);
    const labelWidth = Math.min(36, Math.max(8, ...rows.map((r) => r.label.length)));
    console.log(chalk.dim(`    ${cell('step', labelWidth)}  ${cell('users', 8)}  ${cell('of top', 8)}  ${cell('of prev', 8)}  drop`));
    rows.forEach((row, i) => {
      const drop = row.drop === null ? '—' : row.drop < 0 ? `↑${-row.drop}` : `−${row.drop}`;
      const line = `    ${cell(row.label.slice(0, labelWidth), labelWidth)}  ${cell(String(row.users), 8)}  ${cell(fmtPct(row.ofTop), 8)}  ${cell(fmtPct(row.ofPrev), 8)}  ${drop}`;
      console.log(i === worst ? chalk.red(`${line}  ◄ worst drop`) : line);
    });
  }
}

function fmtV(v: number | null, unit?: string): string {
  if (v === null) return '—';
  const s = Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(v);
  return unit ? `${s} ${unit}` : s;
}

/** The pivot table itself (rows/cols from dims, n chips, low-sample marks,
 *  total) — the ONE table style every dimensional render shares: `lab show`
 *  on a matrix/v1 insight (printMatrixSet), an app/v1 insight's datasets
 *  (printDatasetBundle) and `lab query`'s result all call this rather than
 *  inventing their own layout. 1 dim → a value list; 2 dims → rows=dim1 ×
 *  cols=dim2; a 3rd dim → one pivot per value. Low-sample cells (n < 30) are
 *  marked, mirroring the F4 idiom. */
function printMatrixPivot(set: MatrixSet): void {
  const unit = set.unit ?? undefined;

  const [dim1, dim2, dim3] = set.dims;
  const printPivot = (coords: Record<string, string>): void => {
    const rowValues = dimValues(set, dim1.key);
    if (!dim2) {
      const width = Math.min(28, Math.max(8, ...rowValues.map((v) => v.length)));
      console.log(chalk.dim(`    ${cell(dimLabel(dim1), width)}  value`));
      for (const value of rowValues) {
        const c = pivotCell(set, { ...coords, [dim1.key]: value });
        const low = c.n !== null && c.n < MATRIX_LOW_SAMPLE_THRESHOLD ? chalk.dim(' (low sample)') : '';
        console.log(`    ${cell(value.slice(0, width), width)}  ${fmtV(c.v, unit)}${c.n !== null ? chalk.dim(` n=${c.n}`) : ''}${low}`);
      }
      return;
    }
    const colValues = dimValues(set, dim2.key);
    const rowWidth = Math.min(28, Math.max(dimLabel(dim1).length, ...rowValues.map((v) => v.length)));
    const colWidth = Math.max(10, ...colValues.map((v) => v.length + 2));
    console.log(chalk.dim(`    ${cell(dimLabel(dim1), rowWidth)}  ${colValues.map((v) => cell(v, colWidth)).join('')}`));
    for (const rowValue of rowValues) {
      const cells = colValues.map((colValue) => {
        const c = pivotCell(set, { ...coords, [dim1.key]: rowValue, [dim2.key]: colValue });
        const text = fmtV(c.v);
        const low = c.n !== null && c.n < MATRIX_LOW_SAMPLE_THRESHOLD;
        return cell(low ? `${text}*` : text, colWidth);
      });
      console.log(`    ${cell(rowValue.slice(0, rowWidth), rowWidth)}  ${cells.join('')}`);
    }
    console.log(chalk.dim('    (* = low sample, n < ' + MATRIX_LOW_SAMPLE_THRESHOLD + ')'));
  };

  if (dim3) {
    for (const value of dimValues(set, dim3.key)) {
      console.log();
      console.log(`  ${chalk.magentaBright(dimLabel(dim3))}: ${value}`);
      printPivot({ [dim3.key]: value });
    }
  } else {
    console.log();
    printPivot({});
  }
  if (set.total) {
    console.log();
    console.log(`  total: ${fmtV(set.total.v, unit)}${set.total.n !== null && set.total.n !== undefined ? chalk.dim(` n=${set.total.n}`) : ''}`);
  }
}

/** `lab show` breakdown view: the pivot the dashboard draws, in text. */
function printMatrixSet(matrix: MatrixCacheEntry): void {
  const { set, notices, range } = matrix;
  console.log(`  range: ${range.fromISO} → ${range.toISO}`);
  for (const notice of notices) warn(notice);
  printMatrixPivot(set);
}

/** `lab show` app view: one pivot per named dataset in the bundle, reusing
 *  the SAME table style `printMatrixSet` draws (a dataset carries the exact
 *  matrix/v1 grammar — dataset.ts delegates its validation to
 *  `parseMatrixSet`, so there is no second table style to invent here). */
function printDatasetBundle(entry: DatasetCacheEntry): void {
  const { bundle, notices, range } = entry;
  console.log(`  range: ${range.fromISO} → ${range.toISO}`);
  for (const notice of notices) warn(notice);
  for (const dataset of bundle.datasets) {
    console.log();
    const primaryTag = dataset.key === bundle.primary ? chalk.dim(' (primary)') : '';
    console.log(`  ${chalk.magentaBright(dataset.key)}${dataset.label ? ` — ${dataset.label}` : ''}${primaryTag}`);
    printMatrixPivot({ kind: MATRIX_SET_KIND, dims: dataset.dims, rows: dataset.rows, total: dataset.total, unit: dataset.unit });
  }
}

/** Repeatable-option accumulator (commander's pattern for `--where a=1 --where b=2`). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function handleLabError(err: unknown): void {
  if (err instanceof LabError) {
    error(err.message);
    process.exitCode = 1;
    return;
  }
  error((err as Error).message ?? String(err));
  process.exitCode = 1;
}

export function registerLabCommand(program: Command): void {
  const lab = program
    .command('lab')
    .description('Analytics insights: curated metrics from HTTP APIs or scripts, synced into the brain');

  lab
    .command('sync')
    .argument('[slug]', 'Insight slug to sync (omit with --all)')
    .description('Sync one insight, or every insight with --all')
    .option('--all', 'Sync every insight')
    .option('--force', 'Refetch even if the cached snapshot is still within its TTL')
    .action(async (slug: string | undefined, opts: { all?: boolean; force?: boolean }) => {
      const root = ensureContextRoot();
      if (!opts.all && !slug) {
        error('Provide an insight slug, or pass --all to sync every insight.');
        process.exitCode = 1;
        return;
      }
      try {
        if (opts.all) {
          // A full board runs for minutes across concurrent workers — without a
          // live bar the terminal looks hung until the very last insight lands.
          const bar = new ProgressBar();
          const { results, failed } = await syncAll(root, {
            force: opts.force,
            onProgress: (ev) => bar.update('insights', ev.done, ev.total),
          });
          bar.done();
          for (const r of results) {
            if (r.status === 'ok') success(`${r.slug}: synced (latest=${r.latest ?? 'n/a'}, ${r.granularity})`);
            else if (r.status === 'fresh') console.log(chalk.dim(`  ${r.slug}: fresh (skipped)`));
            else error(`${r.slug}: ${r.error}`);
          }
          console.log();
          if (failed.length > 0) {
            error(`${failed.length} of ${results.length} insight(s) failed to sync.`);
            process.exitCode = 1;
          } else {
            success(`Synced ${results.length} insight(s).`);
          }
          return;
        }
        const result = await syncInsight(root, slug!, { force: opts.force });
        if (result.status === 'ok') success(`${result.slug}: synced (latest=${result.latest ?? 'n/a'}, ${result.granularity})`);
        else if (result.status === 'fresh') console.log(chalk.dim(`  ${result.slug}: fresh (skipped) — use --force to refetch.`));
        else {
          error(`${result.slug}: ${result.error}`);
          process.exitCode = 1;
        }
      } catch (err) {
        handleLabError(err);
      }
    });

  lab
    .command('list')
    .description('List insights with their latest value and staleness')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const insights = listInsights(root);
      if (opts.json) {
        console.log(JSON.stringify(insights.map((m) => ({ ...m, source: m.source })), null, 2));
        return;
      }
      console.log(header('Lab Insights'));
      if (insights.length === 0) {
        console.log(chalk.dim('  (none yet — dreamcontext lab create <slug> --title "..." --render number --adapter http)'));
        return;
      }
      for (const m of insights) {
        const cache = readCache(root, m.slug);
        const latest = cache?.latest !== null && cache?.latest !== undefined ? String(cache.latest) : '—';
        const staleness = cache?.fetchedAt
          ? `fetched ${cache.fetchedAt}`
          : 'never synced';
        const errBadge = cache?.error ? chalk.red(' ⚠ error') : '';
        console.log(`  ${chalk.magentaBright(m.slug)} — ${m.title} · ${latest}${m.unit ? ` ${m.unit}` : ''} · ${chalk.dim(staleness)}${errBadge}`);
      }
    });

  lab
    .command('show')
    .argument('<slug>', 'Insight slug')
    .description('Show the cached snapshot for one insight (no fetch)')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = getInsight(root, slug);
      if (!manifest) {
        error(`Insight not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const cache = readCache(root, slug);
      if (opts.json) {
        console.log(JSON.stringify({ manifest, cache }, null, 2));
        return;
      }
      console.log(header(`Insight: ${slug}`));
      console.log(`  title: ${manifest.title}`);
      console.log(`  render: ${manifest.render}${manifest.size ? ` (size ${manifest.size})` : ''}`);
      console.log(`  category: ${manifest.category ?? '(none)'}`);
      console.log(`  group: ${manifest.group ?? '(none)'}`);
      if (cache) {
        console.log(`  latest: ${cache.latest ?? '—'}${manifest.unit ? ` ${manifest.unit}` : ''}`);
        console.log(`  granularity: ${cache.granularity}`);
        console.log(`  fetchedAt: ${cache.fetchedAt || '(never)'}`);
        if (cache.error) console.log(chalk.red(`  error: ${cache.error}`));
        if (cache.funnel) printFunnelSet(cache.funnel, cache.funnelHistory);
        if (cache.matrix) printMatrixSet(cache.matrix);
        if (cache.app) {
          console.log();
          const pageList = cache.app.spec.pages
            .map((p) => (p.id === cache.app!.spec.entry ? `${p.id} (entry)` : p.id))
            .join(' · ');
          console.log(`  app: ${cache.app.spec.pages.length} page(s) — ${pageList}`);
          for (const notice of cache.app.notices) warn(notice);
          console.log(chalk.dim(`  → dreamcontext lab body ${slug} [--page <id>] for the html/text/markdown source.`));
        }
        if (cache.datasets) {
          console.log();
          console.log('  datasets:');
          printDatasetBundle(cache.datasets);
        }
      } else {
        console.log(chalk.dim('  (no cache yet — run `dreamcontext lab sync ' + slug + '`)'));
      }
    });

  lab
    .command('body')
    .argument('<slug>', 'Insight slug')
    .description('Read a script-authored card/app body from the cache (never fetches)')
    .option('--page <id>', 'Page id (app/v1 insights only; default: the entry page)')
    .option('--format <format>', 'text|md|html (default text)')
    .option('--json', 'Emit as JSON: { pages, page, html, text }')
    .action((slug: string, opts: { page?: string; format?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = getInsight(root, slug);
      if (!manifest) {
        error(`Insight not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const format = opts.format ?? 'text';
      if (format !== 'text' && format !== 'md' && format !== 'html') {
        error(`--format must be text|md|html (got "${format}").`);
        process.exitCode = 1;
        return;
      }
      const cache = readCache(root, slug);
      if (!cache || (!cache.app && !cache.html)) {
        error(`${slug}: no script-authored body cached yet — run \`dreamcontext lab sync ${slug}\`.`);
        process.exitCode = 1;
        return;
      }

      let pages: { id: string; title: string }[] = [];
      let pageId: string | null = null;
      let html: string;

      if (cache.app) {
        const page = findAppPage(cache.app.spec, opts.page ?? null);
        // findAppPage always falls back to the entry page — parseAppSpec
        // guarantees `entry` names a declared page, so this is unreachable
        // except via a hand-corrupted cache; treated as a hard miss.
        if (!page) {
          error(`${slug}: app cache has no pages (corrupt cache — re-run \`dreamcontext lab sync ${slug} --force\`).`);
          process.exitCode = 1;
          return;
        }
        if (opts.page && page.id !== opts.page) {
          warn(`page "${opts.page}" not found — showing the entry page "${page.id}".`);
        }
        pages = cache.app.spec.pages.map((p) => ({ id: p.id, title: p.title }));
        pageId = page.id;
        html = page.html;
      } else {
        if (opts.page) warn(`${slug} is a single-body (html/v1) insight — --page is ignored.`);
        html = cache.html!;
      }

      const text = htmlToText(html, { format: format === 'md' ? 'md' : 'text' });

      if (opts.json) {
        console.log(JSON.stringify({ pages, page: pageId, html, text }, null, 2));
        return;
      }
      console.log(format === 'html' ? html : text);
    });

  lab
    .command('query')
    .argument('<slug>', 'Insight slug')
    .description('Query a cached dataset (dimensional slice/aggregate) — never fetches')
    .option('--dataset <key>', "Dataset key (default: the bundle's primary, else the first)")
    .option('--where <kv>', 'Exact-match filter key=value (repeatable)', collect, [] as string[])
    .option('--group-by <dim>', 'Aggregate rows by one dimension key')
    .option('--top <n>', 'Keep only the top N rows by value')
    .option('--date <date>', 'Resolve to the dataset snapshot at/before this YYYY-MM-DD date (default: live)')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { dataset?: string; where: string[]; groupBy?: string; top?: string; date?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = getInsight(root, slug);
      if (!manifest) {
        error(`Insight not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const date = opts.date ?? null;
      if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
        error(`--date must be a valid YYYY-MM-DD date (got "${date}").`);
        process.exitCode = 1;
        return;
      }
      const where: Record<string, string> = {};
      for (const kv of opts.where) {
        const i = kv.indexOf('=');
        if (i <= 0) {
          error(`--where must be key=value (got "${kv}").`);
          process.exitCode = 1;
          return;
        }
        where[kv.slice(0, i)] = kv.slice(i + 1);
      }

      const cache = readCache(root, slug);
      if (!cache) {
        error(`${slug}: no cache yet — run \`dreamcontext lab sync ${slug}\`.`);
        process.exitCode = 1;
        return;
      }
      const resolved = resolveDatasetAsOf(cache, date);
      if (!resolved) {
        if (opts.json) {
          console.log(JSON.stringify({ slug, date, asOf: null, result: null }, null, 2));
          return;
        }
        console.log(header(`Query: ${slug}`));
        console.log(date
          ? `  No dataset snapshot at or before ${date} — nothing to show (no interpolation).`
          : '  No cached data yet.');
        return;
      }

      const query: DatasetQuery = {
        dataset: opts.dataset ?? null,
        where,
        groupBy: opts.groupBy ?? null,
        top: opts.top !== undefined ? Number(opts.top) : null,
      };
      const result = queryDataset(resolved.bundle, query);

      if (opts.json) {
        console.log(JSON.stringify({ slug, date, asOf: resolved.at, result }, null, 2));
        return;
      }
      console.log(header(`Query: ${slug}${manifest.title ? ` — ${manifest.title}` : ''}`));
      console.log(`  dataset: ${result.dataset}${result.label ? ` — ${result.label}` : ''}`);
      console.log(`  as of: ${resolved.at}`);
      for (const notice of result.notices) warn(notice);
      if (result.rows.length === 0) {
        console.log(chalk.dim('  (no rows matched)'));
        return;
      }
      printMatrixPivot({
        kind: MATRIX_SET_KIND,
        dims: result.dims.map((key) => ({ key })),
        rows: result.rows,
        total: result.total ?? undefined,
        unit: result.unit ?? undefined,
      });
    });

  lab
    .command('create')
    .argument('<slug>', 'Kebab-case insight slug (e.g. weekly-active-users)')
    .description('Scaffold a new insight manifest in lab/insights/<slug>.md')
    .requiredOption('--title <title>', 'Insight title')
    .option('--category <category>', 'Top-level dashboard category (side-menu tab, e.g. "Marketing")')
    .option('--group <group>', 'Dashboard section this insight groups under')
    // Enum text derives from RENDERS so a new render never needs a CLI edit.
    .option('--render <render>', `${RENDERS.join('|')} (default number)`)
    .option('--size <size>', `${INSIGHT_SIZES.join('|')} — board footprint (default: the render's own)`)
    .option('--adapter <adapter>', 'http|script (default http)')
    .option('--unit <unit>', 'Display unit (e.g. "users")')
    .option('--ttl <minutes>', 'Cache TTL in minutes (default 1440)')
    .action((slug: string, opts: { title: string; category?: string; group?: string; render?: string; size?: string; adapter?: string; unit?: string; ttl?: string }) => {
      const root = ensureContextRoot();
      try {
        const m = createInsight(root, {
          slug,
          title: opts.title,
          category: opts.category ?? null,
          group: opts.group ?? null,
          render: (opts.render as Render) ?? 'number',
          size: opts.size as InsightSize | undefined,
          adapter: (opts.adapter as 'http' | 'script') ?? 'http',
          unit: opts.unit ?? null,
          ttl_minutes: opts.ttl ? Number(opts.ttl) : undefined,
        });
        success(`Insight created: lab/insights/${m.slug}.md`);
        console.log(chalk.dim('  Edit the manifest to set the real endpoint/extract config, then `dreamcontext lab sync ' + m.slug + '`.'));
      } catch (err) {
        handleLabError(err);
      }
    });

  lab
    .command('tweak')
    .argument('<slug>', 'Insight slug')
    .argument('<key>', 'Tweak key (a declared one, or the well-known range/from/to)')
    .argument('<value>', 'New value')
    .description('Set one tweak value on an insight')
    .action((slug: string, key: string, value: string) => {
      const root = ensureContextRoot();
      try {
        writeInsightTweaks(root, slug, { [key]: value });
        success(`${slug}: tweak "${key}" set to "${value}".`);
      } catch (err) {
        handleLabError(err);
      }
    });

  lab
    .command('bind')
    .argument('<slug>', 'Insight slug')
    .argument('[objective]', 'Objective slug whose Key Result this insight feeds (omit with --clear)')
    .description('Connect an insight to an objective Key Result (metric.current updates on every sync)')
    .option('--value <value>', 'Bound value: "latest" (default) or "series:<name>"')
    .option('--clear', 'Disconnect the insight from its objective')
    .action((slug: string, objective: string | undefined, opts: { value?: string; clear?: boolean }) => {
      const root = ensureContextRoot();
      if (!opts.clear && !objective) {
        error('Provide an objective slug, or pass --clear to disconnect.');
        process.exitCode = 1;
        return;
      }
      try {
        if (opts.clear) {
          bindInsight(root, slug, null);
          success(`${slug}: binding cleared.`);
          return;
        }
        const { unbound, seededCurrent } = bindInsight(root, slug, { objective: objective!, value: opts.value ?? 'latest' });
        success(`${slug}: now feeds objective "${objective}".`);
        if (seededCurrent !== null) console.log(chalk.dim(`  metric.current seeded to ${seededCurrent} from the cached snapshot.`));
        for (const u of unbound) warn(`${u}: unbound from "${objective}" — an objective's Key Result has one feeder.`);
      } catch (err) {
        handleLabError(err);
      }
    });

  const report = lab
    .command('report')
    .description('My Reports: composed, date-navigable views over existing insight caches');

  report
    .command('create')
    .argument('<slug>', 'Kebab-case report slug (e.g. daily-product-report)')
    .description('Scaffold a new report in lab/reports/<slug>.md')
    .requiredOption('--title <title>', 'Report title')
    .option('--description <description>', 'One-line description')
    .option('--date-nav <nav>', `${DATE_NAVS.join('|')} (default daily)`)
    .option('--insights <slugs>', 'Comma-separated insight slugs to seed the first section')
    .action((slug: string, opts: { title: string; description?: string; dateNav?: string; insights?: string }) => {
      const root = ensureContextRoot();
      try {
        const r = createReport(root, {
          slug,
          title: opts.title,
          description: opts.description ?? null,
          date_nav: opts.dateNav as DateNav | undefined,
          insights: opts.insights ? opts.insights.split(',').map((s) => s.trim()).filter(Boolean) : [],
        });
        success(`Report created: lab/reports/${r.slug}.md`);
        console.log(chalk.dim('  Edit the manifest to add sections/items, then `dreamcontext lab report show ' + r.slug + '`.'));
      } catch (err) {
        handleLabError(err);
      }
    });

  report
    .command('list')
    .description('List reports')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const reports = listReports(root);
      if (opts.json) {
        console.log(JSON.stringify(reports, null, 2));
        return;
      }
      console.log(header('Lab Reports'));
      if (reports.length === 0) {
        console.log(chalk.dim('  (none yet — dreamcontext lab report create <slug> --title "...")'));
        return;
      }
      for (const r of reports) {
        const items = r.sections.reduce((a, s) => a + s.items.length, 0);
        console.log(`  ${chalk.magentaBright(r.slug)} — ${r.title} · ${r.sections.length} section(s), ${items} item(s) · ${chalk.dim(r.date_nav)}`);
      }
    });

  report
    .command('show')
    .argument('<slug>', 'Report slug')
    .description('Show a report with every item resolved (optionally as of a date / over a custom from→to window)')
    .option('--date <date>', 'The window END (YYYY-MM-DD; default today for live)')
    .option('--from <date>', 'Free-range window START — with --date (or today) it overrides the default window for every non-pinned item')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { date?: string; from?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = getReport(root, slug);
      if (!manifest) {
        error(`Report not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const date = opts.date ?? null;
      if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
        error(`--date must be a valid YYYY-MM-DD date (got "${date}").`);
        process.exitCode = 1;
        return;
      }
      const from = opts.from ?? null;
      if (from !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)))) {
        error(`--from must be a valid YYYY-MM-DD date (got "${from}").`);
        process.exitCode = 1;
        return;
      }
      const sections = resolveReport(root, manifest, date, from);
      if (opts.json) {
        console.log(JSON.stringify({ report: manifest, date, from, sections }, null, 2));
        return;
      }
      console.log(header(`Report: ${manifest.title}`));
      if (manifest.description) console.log(chalk.dim(`  ${manifest.description}`));
      console.log(`  date: ${date ?? '(live)'}${date ? ' — latest snapshot at/before end of day' : ''}`);
      for (const section of sections) {
        console.log();
        console.log(`  ${chalk.magentaBright(section.title)}`);
        if (section.prose) console.log(chalk.dim(`  ${section.prose}`));
        for (const item of section.items) {
          if (item.missing) {
            warn(`${item.insight}: insight no longer exists — remove it from the report.`);
            continue;
          }
          if (item.asOf === null) {
            if (item.targetWindow && (item.windowStatus === 'missing' || item.windowStatus === 'stale')) {
              console.log(chalk.dim(`    ${item.insight}: window ${item.targetWindow.fromISO}→${item.targetWindow.toISO} not measured yet — dreamcontext lab report sync ${slug}${date ? ` --date ${date}` : ''}`));
            } else {
              console.log(chalk.dim(`    ${item.insight}: no snapshot at/before this date — nothing to show (no interpolation).`));
            }
            continue;
          }
          const latest = item.latest !== null ? ` · ${item.latest}${item.unit ? ` ${item.unit}` : ''}` : '';
          // Window honesty: name the measurement window — or say plainly that
          // there is none ("no declared window") / that history recorded none.
          const window = item.window
            ? `window ${item.window.fromISO}→${item.window.toISO}`
            : date !== null
              ? 'window unknown'
              : 'no declared window';
          const status = item.windowStatus !== 'own' ? ` [${item.windowStatus}]` : '';
          console.log(`    ${item.title ?? item.insight}${latest} ${chalk.dim(`as of ${item.asOf} · ${window}${status}`)}`);
        }
      }
      if (manifest.notes) {
        console.log();
        console.log(chalk.dim(manifest.notes));
      }
    });

  report
    .command('sync')
    .argument('<slug>', 'Report slug')
    .description('Fetch the window measurements a report still owes into the TRANSIENT window cache (canonical caches, snapshot trails and KR bindings untouched)')
    .option('--date <date>', 'Anchor the windows at this YYYY-MM-DD date (default: today)')
    .option('--from <date>', 'Free-range window START (with --date/today as the end)')
    .action(async (slug: string, opts: { date?: string; from?: string }) => {
      const root = ensureContextRoot();
      const manifest = getReport(root, slug);
      if (!manifest) {
        error(`Report not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const date = opts.date ?? null;
      if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
        error(`--date must be a valid YYYY-MM-DD date (got "${date}").`);
        process.exitCode = 1;
        return;
      }
      const from = opts.from ?? null;
      if (from !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)))) {
        error(`--from must be a valid YYYY-MM-DD date (got "${from}").`);
        process.exitCode = 1;
        return;
      }
      // Re-plan after every pass: a slug that appears in two sections with two
      // different pinned windows can only carry one window per pass.
      const MAX_WINDOW_PASSES = 3;
      for (let pass = 1; pass <= MAX_WINDOW_PASSES; pass++) {
        const plan = reportWindowPlan(resolveReport(root, manifest, date, from));
        const slugs = Object.keys(plan);
        if (slugs.length === 0) {
          success(pass === 1
            ? 'Nothing owed — every item already measures its window.'
            : 'All windows measured.');
          return;
        }
        console.log(header(`Pass ${pass}: measuring ${slugs.length} window(s)`));
        for (const s of slugs) console.log(chalk.dim(`  ${s} · ${plan[s].fromISO}→${plan[s].toISO}`));
        const { results, failed } = await syncAll(root, { force: true, only: slugs, windows: plan });
        for (const r of results) {
          if (r.status === 'failed') warn(`${r.slug}: ${r.error}`);
          else console.log(`  ✓ ${r.slug}${r.latest !== undefined && r.latest !== null ? ` · ${r.latest}` : ''}`);
        }
        if (failed.length === slugs.length) {
          error('No progress this pass — every window fetch failed (see above).');
          process.exitCode = 1;
          return;
        }
      }
      const remaining = Object.keys(reportWindowPlan(resolveReport(root, manifest, date, from)));
      if (remaining.length > 0) {
        warn(`Still owed after ${MAX_WINDOW_PASSES} passes: ${remaining.join(', ')}`);
        process.exitCode = 1;
      } else {
        success('All windows measured.');
      }
    });

  report
    .command('comment')
    .argument('<slug>', 'Report slug')
    .description('Generate the report\'s AI commentary for a view (headless pure-text claude run; the dated file lands in lab/reports/.commentary/). Reports with `commentary: false` refuse.')
    .option('--date <date>', 'The report view to comment on (YYYY-MM-DD; default: live)')
    .option('--from <date>', 'Free-range window START of the commented view')
    .option('--model <model>', 'Model for the run (default: sonnet)')
    .action(async (slug: string, opts: { date?: string; from?: string; model?: string }) => {
      const root = ensureContextRoot();
      const manifest = getReport(root, slug);
      if (!manifest) {
        error(`Report not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const date = opts.date ?? null;
      if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
        error(`--date must be a valid YYYY-MM-DD date (got "${date}").`);
        process.exitCode = 1;
        return;
      }
      try {
        console.log(chalk.dim('  Generating commentary (headless claude, pure text — no tools, no writes by the model)…'));
        const sections = resolveReport(root, manifest, date, opts.from ?? null);
        const commentary = await generateReportCommentary(root, manifest, sections, date, { model: opts.model });
        success(`Commentary written: lab/reports/.commentary/${slug}/${commentary.dateKey}.md (${commentary.model})`);
        console.log();
        console.log(commentary.body);
      } catch (err) {
        handleLabError(err);
        process.exitCode = 1;
      }
    });

  const credentials = lab
    .command('credentials')
    .description('Manage lab/credentials.json (gitignore-first — never printed back)');

  credentials
    .command('set')
    .argument('<key>', 'Credential key (referenced by manifests as {{cred:key}})')
    .description('Store a credential value (hidden prompt; --value is shell-history-risky)')
    .option('--value <value>', 'Provide the value directly (visible in shell history — prefer the interactive prompt)')
    .action(async (key: string, opts: { value?: string }) => {
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);
      try {
        const value = opts.value ?? await password({ message: `Value for credential "${key}":` });
        if (!value || !value.trim()) {
          error('A non-empty value is required.');
          process.exitCode = 1;
          return;
        }
        writeCredential(projectRoot, root, key, value);
        success(`Credential "${key}" stored in lab/credentials.json (mode 0600, gitignored).`);
      } catch (err) {
        handleLabError(err);
      }
    });

  credentials
    .command('list')
    .description('List credential KEY NAMES only — values are never printed')
    .action(() => {
      const root = ensureContextRoot();
      const names = listCredentialNames(root);
      console.log(header('Lab Credentials (names only)'));
      if (names.length === 0) {
        console.log(chalk.dim('  (none yet — dreamcontext lab credentials set <key>)'));
        return;
      }
      for (const name of names) console.log(`  ${chalk.magentaBright(name)}`);
      // Self-heal nudge: warn if the file exists but isn't covered by a gitignore.
      const projectRoot = projectRootFor(root);
      const covered = gitignoreCovers(root, ['lab/credentials.json'])
        || gitignoreCovers(projectRoot, ['_dream_context/lab/credentials.json']);
      if (!covered) {
        warn('lab/credentials.json is not covered by a governing .gitignore — run `dreamcontext doctor` then re-run `lab credentials set` to self-heal.');
      }
    });
}
