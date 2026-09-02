import { getReport, resolveReport } from '../lib/lab/reports-store.js';
import {
  commentaryDateKey,
  generateReportCommentary,
  type GenerateOptions,
  type ReportCommentary,
} from '../lib/lab/report-commentary.js';

/**
 * Background report-commentary jobs. Same reason the sync job exists: a
 * headless `claude -p` run takes far longer than the server's 30s socket
 * ceiling, so the POST only STARTS the run and the UI polls. One job per
 * (contextRoot, slug, dateKey) — a second click adopts the running one.
 */

export interface LabCommentaryJobState {
  id: string;
  slug: string;
  dateKey: string;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  commentary: ReportCommentary | null;
}

const JOB_TTL_MS = 60 * 60 * 1000;

const jobs = new Map<string, LabCommentaryJobState>(); // `${root}|${slug}|${dateKey}`

function key(contextRoot: string, slug: string, dateKey: string): string {
  return `${contextRoot}|${slug}|${dateKey}`;
}

function prune(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [k, job] of jobs) {
    if (job.status !== 'running' && (job.finishedAt ?? 0) < cutoff) jobs.delete(k);
  }
}

export function currentLabCommentaryJob(
  contextRoot: string,
  slug: string,
  date: string | null,
): LabCommentaryJobState | null {
  prune();
  return jobs.get(key(contextRoot, slug, commentaryDateKey(date))) ?? null;
}

/** Test seam. */
export function _resetLabCommentaryJobs(): void {
  jobs.clear();
}

/** Start (or adopt) a commentary generation. Returns immediately. */
export function startLabCommentaryJob(
  contextRoot: string,
  slug: string,
  date: string | null,
  opts: GenerateOptions = {},
  /** Free-range window start of the view being commented (navigator custom range). */
  from: string | null = null,
): { job: LabCommentaryJobState; started: boolean } {
  prune();
  const dateKey = commentaryDateKey(date);
  const existing = jobs.get(key(contextRoot, slug, dateKey));
  if (existing?.status === 'running') return { job: existing, started: false };

  const job: LabCommentaryJobState = {
    id: `lcj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    slug,
    dateKey,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    commentary: null,
  };
  jobs.set(key(contextRoot, slug, dateKey), job);
  void run(contextRoot, slug, date, from, job, opts);
  return { job, started: true };
}

async function run(
  contextRoot: string,
  slug: string,
  date: string | null,
  from: string | null,
  job: LabCommentaryJobState,
  opts: GenerateOptions,
): Promise<void> {
  try {
    const report = getReport(contextRoot, slug);
    if (!report) throw new Error(`Report not found: ${slug}`);
    // Resolve at generation time — after the page's window syncs settled and
    // WITH the view's custom range, so the model reads the same numbers the
    // reader sees.
    const sections = resolveReport(contextRoot, report, date, from);
    job.commentary = await generateReportCommentary(contextRoot, report, sections, date, opts);
    job.status = 'success';
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message ?? String(err);
  } finally {
    job.finishedAt = Date.now();
  }
}
