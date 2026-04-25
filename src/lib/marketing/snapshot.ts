/**
 * Marketing snapshot section for SessionStart hook.
 *
 * Returns a `## Marketing` markdown block suitable for appending to the
 * agent context snapshot, or null if marketing isn't bootstrapped.
 *
 * Performance budget: must complete in <500ms (SessionStart is in the hot
 * path of every session). Only local file reads — no network, no subprocess.
 */
import { existsSync, readFileSync } from 'node:fs';
import { marketingRootIfExists, MARKETING_PATHS } from './paths.js';
import { listCohorts, type Cohort } from './cohort.js';
import { listPending, loadIndex } from './learnings.js';

export interface MarketingSnapshotOpts {
  /** Override clock for tests. */
  now?: Date;
}

export function buildMarketingSnapshot(opts: MarketingSnapshotOpts = {}): string | null {
  // Skip silently when marketing isn't set up — keeps the snapshot clean
  // for projects that don't use the meta-marketing skill.
  const root = marketingRootIfExists();
  if (!root || !existsSync(root)) return null;

  const now = opts.now ?? new Date();
  const lines: string[] = ['## Marketing\n'];

  // Active cohorts (launched / monitoring)
  const cohorts = listCohorts();
  const active = cohorts.filter((c) => c.status === 'launched' || c.status === 'monitoring');
  const planning = cohorts.filter((c) => c.status === 'planning');

  if (active.length === 0 && planning.length === 0) {
    lines.push('No active cohorts. Plan one with `mk cohort create <name> --hypothesis-file <path>`.');
    lines.push('');
  } else {
    if (active.length > 0) {
      lines.push(`**Active cohorts (${active.length}):**`);
      for (const c of active) {
        lines.push(`- \`${c.id}\` ${c.name} (${c.status}) — ${cohortHypothesisLine(c)}`);
      }
      lines.push('');
    }
    if (planning.length > 0) {
      lines.push(`**Planning (${planning.length}):** ${planning.map((c) => `\`${c.id}\``).join(', ')}`);
      lines.push('');
    }
  }

  // Last `insights pull` timestamp
  const lastPull = readLastInsightsPull();
  if (lastPull) {
    lines.push(`**Last insights pull:** ${lastPull} (${humanAge(lastPull, now)})`);
  } else {
    lines.push(`**Last insights pull:** never — run \`mk insights pull --campaign <id>\`.`);
  }
  lines.push('');

  // Pending Performance Monitor recs
  const allPending = listPending({ now });
  const stalePending = listPending({ now, olderThanMs: 24 * 60 * 60 * 1000 });
  const idx = loadIndex();
  if (allPending.length === 0 && idx.entries.length === 0) {
    lines.push('**Performance Monitor:** no learnings recorded yet.');
  } else if (allPending.length === 0) {
    lines.push(`**Performance Monitor:** all clear (${idx.entries.length} entries total, no pending recommendations).`);
  } else {
    const staleSuffix = stalePending.length > 0 ? ` — **${stalePending.length} >24h** ⚠` : '';
    lines.push(`**Performance Monitor:** ${allPending.length} pending recommendation${allPending.length === 1 ? '' : 's'}${staleSuffix}`);
    for (const e of allPending.slice(0, 3)) {
      const ageH = Math.floor((now.getTime() - new Date(e.created_at).getTime()) / 3_600_000);
      const cohortTag = e.cohort_id ? `${e.cohort_id} · ` : '';
      lines.push(`  - \`${e.id}\` (${ageH}h) ${cohortTag}${e.summary}`);
    }
    if (allPending.length > 3) {
      lines.push(`  - … and ${allPending.length - 3} more — run \`mk learnings list-pending\`.`);
    }
  }
  lines.push('');

  return lines.join('\n').trimEnd();
}

function cohortHypothesisLine(c: Cohort): string {
  const h = c.hypothesis;
  return `${h.predicted_metric} ≥ ${h.decision_threshold}`;
}

function readLastInsightsPull(): string | null {
  const idxPath = MARKETING_PATHS.insightsDir() + '/_index.json';
  if (!existsSync(idxPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(idxPath, 'utf8')) as { updated_at?: string };
    return raw.updated_at && raw.updated_at !== '1970-01-01T00:00:00Z' ? raw.updated_at : null;
  } catch {
    return null;
  }
}

function humanAge(iso: string, now: Date): string {
  const ageMs = now.getTime() - new Date(iso).getTime();
  if (ageMs < 0) return 'in the future';
  const min = Math.floor(ageMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Convenience for hooks: return list of pending recs older than N hours. */
export function listStaleRecs(hoursOld: number, now: Date = new Date()) {
  return listPending({ olderThanMs: hoursOld * 60 * 60 * 1000, now });
}
