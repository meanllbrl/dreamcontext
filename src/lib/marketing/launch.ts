/**
 * Launch flow with full guardrails — PR 3.
 *
 * Per task contract (line 226):
 *   - Typed --confirm <cohort_id> verbatim (no shortcut)
 *   - 6-line human summary printed BEFORE any flip
 *   - Pre-flip WAL: write planned ops first, execute one entity at a time
 *   - mk launch resume <run_id> replays from WAL after crash
 *   - No silent retries on the actual ACTIVE flip step
 *
 * Entity flip order: campaigns → adsets → ads (parents before children — Meta
 * rejects ACTIVE on a child whose parent is PAUSED).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MARKETING_PATHS } from './paths.js';
import {
  loadEntity, saveEntity, gatherEntitiesByCohort,
  type CampaignEntity, type AdSetEntity, type AdEntity, type EntityKind,
} from './entity-store.js';
import { loadCohort, saveCohort } from './cohort.js';
import { resumeEntity } from './meta-client.js';
import type { MetaCtx } from './meta-fetch.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlannedFlip {
  kind: EntityKind;
  /** Local dreamcontext id. */
  id: string;
  /** Meta-side fb_id. Required to flip live; empty for entities still in dry-run. */
  fb_id: string;
  name: string;
  from_status: 'PAUSED';
  to_status: 'ACTIVE';
  flipped_at: string | null;
  error: string | null;
}

export interface LaunchWal {
  id: string;
  verb: 'launch';
  cohort_id: string;
  cohort_name: string;
  started_at: string;
  completed_at: string | null;
  status: 'pending' | 'in_progress' | 'partial' | 'complete' | 'aborted';
  /** Whether this WAL was written under dry-run. Resume rejects mismatched ctx. */
  dry_run: boolean;
  planned: PlannedFlip[];
  flipped_count: number;
  error: string | null;
}

export interface LaunchSummary {
  cohort_id: string;
  cohort_name: string;
  campaigns: number;
  adsets: number;
  ads: number;
  total_daily_budget_minor: number;
  objective: string;
}

// ─── Summary builder ─────────────────────────────────────────────────────────

export function buildLaunchSummary(cohortId: string): LaunchSummary | { error: string } {
  const cohort = loadCohort(cohortId);
  if (!cohort) return { error: `Cohort ${cohortId} not found` };
  const { campaigns, adsets, ads } = gatherEntitiesByCohort(cohortId);
  if (campaigns.length === 0) return { error: 'cohort has no campaigns — create at least one before launch' };
  if (ads.length === 0) return { error: 'cohort has no ads — create at least one before launch' };

  // Total daily budget = sum of campaign-level CBO budgets (where set)
  // PLUS sum of adset-level budgets (where campaign budget is null).
  let totalMinor = 0;
  const cbCampaigns = new Set<string>();
  for (const c of campaigns) {
    if (c.daily_budget != null) {
      totalMinor += c.daily_budget;
      cbCampaigns.add(c.id);
    }
  }
  for (const a of adsets) {
    if (!cbCampaigns.has(a.campaign_id)) totalMinor += a.daily_budget;
  }

  const objective = campaigns.map((c) => c.objective).join(', ');

  return {
    cohort_id: cohort.id,
    cohort_name: cohort.name,
    campaigns: campaigns.length,
    adsets: adsets.length,
    ads: ads.length,
    total_daily_budget_minor: totalMinor,
    objective,
  };
}

/** Format the 6-line human summary printed before any flip. */
export function renderLaunchSummary(s: LaunchSummary): string[] {
  return [
    `Cohort:              ${s.cohort_name} (${s.cohort_id})`,
    `Campaigns:           ${s.campaigns}`,
    `Adsets:              ${s.adsets}`,
    `Ads:                 ${s.ads}`,
    `Total daily budget:  ${(s.total_daily_budget_minor / 100).toFixed(2)} (minor units summed)`,
    `Objective:           ${s.objective}`,
  ];
}

// ─── WAL helpers ─────────────────────────────────────────────────────────────

function isoTs(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function newLaunchWalPath(cohortId: string): string {
  return join(MARKETING_PATHS.runsDir(), `${isoTs()}__launch-${cohortId}.json`);
}

function atomicWriteFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

export function readWal(path: string): LaunchWal | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LaunchWal;
  } catch {
    return null;
  }
}

export function writeWal(path: string, wal: LaunchWal): void {
  atomicWriteFile(path, JSON.stringify(wal, null, 2) + '\n');
}

export function findWalByRunId(runId: string): string | null {
  const dir = MARKETING_PATHS.runsDir();
  if (!existsSync(dir)) return null;
  // runId may be the full filename (without .json) or just a timestamp prefix.
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    if (f.startsWith('by-idem')) continue;
    const stem = f.replace(/\.json$/, '');
    if (stem === runId || f === runId || basename(f, '.json') === runId) {
      return join(dir, f);
    }
  }
  return null;
}

// ─── Plan builder ────────────────────────────────────────────────────────────

export function buildPlannedFlips(cohortId: string): PlannedFlip[] {
  const { campaigns, adsets, ads } = gatherEntitiesByCohort(cohortId);
  const plan: PlannedFlip[] = [];
  // Order matters: campaigns → adsets → ads. Parent must be ACTIVE before child.
  for (const c of campaigns) plan.push(asPlanned(c));
  for (const a of adsets) plan.push(asPlanned(a));
  for (const a of ads) plan.push(asPlanned(a));
  return plan;
}

function asPlanned(e: CampaignEntity | AdSetEntity | AdEntity): PlannedFlip {
  return {
    kind: e.kind,
    id: e.id,
    fb_id: e.fb_id,
    name: e.name,
    from_status: 'PAUSED',
    to_status: 'ACTIVE',
    flipped_at: null,
    error: null,
  };
}

export function createLaunchWal(args: { cohortId: string; cohortName: string; dryRun: boolean }): { walPath: string; wal: LaunchWal } {
  const id = `${isoTs()}__launch-${args.cohortId}`;
  const wal: LaunchWal = {
    id,
    verb: 'launch',
    cohort_id: args.cohortId,
    cohort_name: args.cohortName,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: 'pending',
    dry_run: args.dryRun,
    planned: buildPlannedFlips(args.cohortId),
    flipped_count: 0,
    error: null,
  };
  const walPath = join(MARKETING_PATHS.runsDir(), `${id}.json`);
  writeWal(walPath, wal);
  return { walPath, wal };
}

// ─── Flip executor ───────────────────────────────────────────────────────────

export interface FlipExecResult {
  status: 'complete' | 'partial' | 'aborted';
  flipped: number;
  remaining: number;
  errors: string[];
}

export interface FlipReporter {
  /** Called before each flip attempt. */
  onPlanItem?: (item: PlannedFlip) => void;
  /** Called after a successful flip. */
  onFlipped?: (item: PlannedFlip) => void;
  /** Called after a failed flip — always halts the loop. */
  onError?: (item: PlannedFlip, error: Error) => void;
}

/**
 * Execute the planned flips in order. STOPS at the first error per task
 * contract: "No silent retries on launch flips" — operator decides resume.
 *
 * The actual Graph API call uses metaFetch with noRetry=true so the wrapper's
 * retry loop is bypassed for these specific flips.
 */
export async function executeFlips(
  ctx: MetaCtx,
  walPath: string,
  reporter: FlipReporter = {},
): Promise<FlipExecResult> {
  const wal = readWal(walPath);
  if (!wal) {
    return { status: 'aborted', flipped: 0, remaining: 0, errors: [`WAL not found: ${walPath}`] };
  }

  // Reject ctx mismatch — can't resume a dry-run WAL with live ctx (and vice versa)
  if (wal.dry_run !== ctx.dryRun) {
    const msg = `WAL dry-run mismatch: wal.dry_run=${wal.dry_run}, ctx.dryRun=${ctx.dryRun}`;
    wal.error = msg;
    wal.status = 'aborted';
    writeWal(walPath, wal);
    return { status: 'aborted', flipped: 0, remaining: wal.planned.length, errors: [msg] };
  }

  wal.status = 'in_progress';
  writeWal(walPath, wal);

  const errors: string[] = [];
  let flipped = wal.flipped_count;

  for (const item of wal.planned) {
    if (item.flipped_at != null) continue;   // already done
    reporter.onPlanItem?.(item);

    if (!ctx.dryRun && !item.fb_id) {
      const msg = `${item.kind} ${item.id} has no fb_id — was it created live? Live launch refused.`;
      item.error = msg;
      errors.push(msg);
      wal.error = msg;
      wal.status = 'partial';
      writeWal(walPath, wal);
      reporter.onError?.(item, new Error(msg));
      return { status: 'partial', flipped, remaining: wal.planned.length - flipped, errors };
    }

    try {
      // Use fb_id if present; in dry-run, use the local id so logs show the entity
      const target = item.fb_id || item.id;
      await resumeEntity(ctx, target, { noRetry: true });
      item.flipped_at = new Date().toISOString();
      flipped += 1;
      wal.flipped_count = flipped;
      writeWal(walPath, wal);

      // Reflect status in the local entity record so subsequent reads are accurate
      const live = loadEntity(item.kind, item.id);
      if (live) {
        (live as { status: 'ACTIVE' }).status = 'ACTIVE';
        (live as { updated_at: string }).updated_at = new Date().toISOString();
        saveEntity(live);
      }

      reporter.onFlipped?.(item);
    } catch (e) {
      const msg = (e as Error).message;
      item.error = msg;
      errors.push(`${item.kind} ${item.id}: ${msg}`);
      wal.error = msg;
      wal.status = 'partial';
      writeWal(walPath, wal);
      reporter.onError?.(item, e as Error);
      // HALT — no silent retries. Operator runs `mk launch resume <run_id>` to continue.
      return {
        status: 'partial',
        flipped,
        remaining: wal.planned.length - flipped,
        errors,
      };
    }
  }

  wal.status = 'complete';
  wal.completed_at = new Date().toISOString();
  writeWal(walPath, wal);

  // Mark cohort as launched
  const cohort = loadCohort(wal.cohort_id);
  if (cohort && cohort.status === 'planning') {
    cohort.status = 'launched';
    cohort.updated_at = new Date().toISOString();
    saveCohort(cohort);
  }

  return { status: 'complete', flipped, remaining: 0, errors };
}
