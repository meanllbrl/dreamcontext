/**
 * Agent feedback loop — let a dreamcontext-driven agent take responsibility for
 * reporting gaps it hits (unseen memory, a missing CLI command, a bug, friction)
 * by filing a structured GitHub issue against the upstream project.
 *
 * This module holds the pure / testable core: GitHub CLI detection, the issue
 * body template, duplicate detection, and the issue-create wrapper. The command
 * layer (cli/commands/feedback.ts) orchestrates detection → preview → confirm.
 *
 * Issues ALWAYS target the fixed upstream repo, never the user's own project
 * remote — feedback flows from the user's project to the dreamcontext maintainers.
 */

import { execFileSync } from 'node:child_process';
import { platform, release, arch } from 'node:os';
import { dreamcontextVersion } from './manifest.js';

/** The canonical upstream repository that receives all agent feedback. */
export const UPSTREAM_REPO = 'meanllbrl/dreamcontext';

/** Marker label applied to every agent-filed issue (created on demand). */
export const FEEDBACK_LABEL = 'agent-feedback';

/** A hidden marker embedded in every body so dedup/analytics can find them. */
export const FEEDBACK_MARKER = '<!-- filed via `dreamcontext feedback` (agent feedback loop) -->';

export type FeedbackCategory =
  | 'bug'
  | 'missing-cli'
  | 'unseen-memory'
  | 'feature'
  | 'docs'
  | 'other';

/** Human label + the GitHub built-in label we co-apply per category. */
const CATEGORY_META: Record<FeedbackCategory, { title: string; ghLabel?: string }> = {
  bug: { title: 'Bug', ghLabel: 'bug' },
  'missing-cli': { title: 'Missing CLI command', ghLabel: 'enhancement' },
  'unseen-memory': { title: 'Memory not surfaced', ghLabel: 'bug' },
  feature: { title: 'Feature request', ghLabel: 'enhancement' },
  docs: { title: 'Docs gap', ghLabel: 'documentation' },
  other: { title: 'Feedback' },
};

export function isFeedbackCategory(value: string): value is FeedbackCategory {
  return Object.prototype.hasOwnProperty.call(CATEGORY_META, value);
}

export const FEEDBACK_CATEGORIES = Object.keys(CATEGORY_META) as FeedbackCategory[];

// ─── GitHub CLI detection ─────────────────────────────────────────────────────

export interface GhStatus {
  /** `gh` binary is on PATH. */
  installed: boolean;
  /** `gh auth status` reports an authenticated account. */
  authenticated: boolean;
  /** The logged-in account login, when detectable. */
  account?: string;
}

/** Thin seam so tests can inject command output without spawning processes. */
export type CommandRunner = (cmd: string, args: string[]) => { ok: boolean; stdout: string; stderr: string };

const defaultRunner: CommandRunner = (cmd, args) => {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
};

/**
 * Parse the account login out of `gh auth status` output.
 * gh prints e.g. "✓ Logged in to github.com account meanllbrl (keyring)".
 */
export function parseGhAccount(authOutput: string): string | undefined {
  const match = authOutput.match(/account\s+([^\s(]+)/i);
  return match ? match[1] : undefined;
}

export function detectGitHubCli(run: CommandRunner = defaultRunner): GhStatus {
  const version = run('gh', ['--version']);
  if (!version.ok) return { installed: false, authenticated: false };

  // gh writes auth status to stderr historically; merge both streams.
  const auth = run('gh', ['auth', 'status']);
  const combined = `${auth.stdout}\n${auth.stderr}`;
  const authenticated = auth.ok || /Logged in to/i.test(combined);
  return {
    installed: true,
    authenticated,
    account: authenticated ? parseGhAccount(combined) : undefined,
  };
}

// ─── Issue body template ──────────────────────────────────────────────────────

export interface FeedbackInput {
  category: FeedbackCategory;
  title: string;
  /** What the agent was trying to do when it hit the gap. */
  scenario: string;
  /** What the agent expected dreamcontext to do / provide. */
  expected?: string;
  /** What was actually missing, broken, or surprising. */
  gap?: string;
  /** Reproduction steps or the exact command(s) involved. */
  repro?: string;
  /** The agent's proposed improvement (command, behavior, doc, fix). */
  proposal?: string;
}

export interface EnvironmentInfo {
  dreamcontextVersion: string;
  node: string;
  os: string;
}

export function collectEnvironment(): EnvironmentInfo {
  return {
    dreamcontextVersion: dreamcontextVersion(),
    node: process.version,
    os: `${platform()} ${release()} (${arch()})`,
  };
}

function section(heading: string, body: string | undefined, fallback: string): string {
  const value = body && body.trim().length > 0 ? body.trim() : fallback;
  return `### ${heading}\n\n${value}`;
}

/**
 * Build the full structured issue body. Every field maps to a fixed heading so
 * filed issues are uniform and the maintainer always gets the whole scenario.
 */
export function buildIssueBody(input: FeedbackInput, env: EnvironmentInfo): string {
  const todo = '_(not provided)_';
  const parts = [
    section('Scenario — what the agent was doing', input.scenario, todo),
    section('Expected — what dreamcontext should have done', input.expected, todo),
    section('Gap — what was missing, broken, or surprising', input.gap, todo),
    section('Reproduction / commands', input.repro, todo),
    section('Proposed improvement', input.proposal, todo),
    [
      '### Environment',
      '',
      `- dreamcontext: \`${env.dreamcontextVersion}\``,
      `- node: \`${env.node}\``,
      `- os: \`${env.os}\``,
      `- category: \`${input.category}\` (${CATEGORY_META[input.category].title})`,
    ].join('\n'),
    FEEDBACK_MARKER,
  ];
  return parts.join('\n\n');
}

/** Labels to apply for a category (marker + built-in), de-duplicated. */
export function labelsFor(category: FeedbackCategory): string[] {
  const gh = CATEGORY_META[category].ghLabel;
  return gh ? [FEEDBACK_LABEL, gh] : [FEEDBACK_LABEL];
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

export interface IssueRef {
  number: number;
  title: string;
  url: string;
}

/** Normalize a title for fuzzy comparison: lowercase, strip prefixes/punct. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(feat|fix|bug|docs|chore)(\([^)]*\))?:\s*/i, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Jaccard token overlap between two normalized titles (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Find an open issue whose title closely matches the candidate (≥ threshold). */
export function findDuplicate(
  candidateTitle: string,
  existing: IssueRef[],
  threshold = 0.6,
): IssueRef | undefined {
  let best: { ref: IssueRef; score: number } | undefined;
  for (const ref of existing) {
    const score = titleSimilarity(candidateTitle, ref.title);
    if (score >= threshold && (!best || score > best.score)) best = { ref, score };
  }
  return best?.ref;
}

/** Query upstream open issues carrying the feedback marker label. */
export function listFeedbackIssues(run: CommandRunner = defaultRunner): IssueRef[] {
  const res = run('gh', [
    'issue', 'list',
    '--repo', UPSTREAM_REPO,
    '--state', 'open',
    '--limit', '100',
    '--json', 'number,title,url',
  ]);
  if (!res.ok || !res.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout) as IssueRef[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Label + issue creation ───────────────────────────────────────────────────

/** Ensure the marker label exists upstream; best-effort, never throws. */
export function ensureFeedbackLabel(run: CommandRunner = defaultRunner): void {
  run('gh', [
    'label', 'create', FEEDBACK_LABEL,
    '--repo', UPSTREAM_REPO,
    '--color', '5319e7',
    '--description', 'Filed by a dreamcontext agent via the feedback loop',
    '--force',
  ]);
}

export interface CreateResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/** Create the issue upstream. Returns the new issue URL on success. */
export function createIssue(
  input: FeedbackInput,
  body: string,
  run: CommandRunner = defaultRunner,
): CreateResult {
  const labels = labelsFor(input.category);
  const args = [
    'issue', 'create',
    '--repo', UPSTREAM_REPO,
    '--title', input.title,
    '--body', body,
  ];
  for (const l of labels) args.push('--label', l);

  const res = run('gh', args);
  if (res.ok) {
    const url = res.stdout.trim().split('\n').filter(Boolean).pop();
    return { ok: true, url };
  }
  // Retry without labels — a label may not exist on the repo.
  const retry = run('gh', ['issue', 'create', '--repo', UPSTREAM_REPO, '--title', input.title, '--body', body]);
  if (retry.ok) {
    const url = retry.stdout.trim().split('\n').filter(Boolean).pop();
    return { ok: true, url };
  }
  return { ok: false, error: (res.stderr || retry.stderr || 'gh issue create failed').trim() };
}
