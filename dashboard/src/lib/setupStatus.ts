/**
 * The setup status chip beside the sleep score (owner 2026-11-03): ONLY big problems draw it,
 * and only they are red. "Big" = something that stops the app from working at all:
 *
 *   network missing                                  red   "No internet"
 *   node / npm / cli missing or off the shell PATH   red   (each has its one-click fix)
 *   no agent tool installed (Claude missing AND no Codex/Antigravity installed)   red
 *   no agent tool signed in (Claude signed out AND none of the others signed in)  red
 *   this project's folder is gone from disk          red   (fix: remove it from the app)
 *   Claude missing or signed out BUT another tool works   one GRAY row: sleep, automations and
 *                                                     builders run on `claude -p` today
 *
 * NEVER drawn: Codex, Antigravity, git, GitHub, gh, the terminal, and any `unknown` or
 * `unsupported` status (cannot tell = do not alarm). A `blocked` row is downstream of another
 * row and is never shown on its own; a sign-in blocked only by the network is unknown, never
 * "signed out". Claude found on disk but off the shell PATH still runs in the app (every spawn
 * injects its folder), so it counts as installed here.
 *
 * Pure: every row of that table is pinned by `tests/unit/setup-status.test.ts`. A false red is
 * the worst failure this chip can have.
 */
import type { AgentToolInfo } from '../hooks/useAgentCapabilities';
import type { CheckId, FixId, ReadinessCheck, ReadinessReport } from './onboardingTypes';

export type SetupProblemTone = 'bad' | 'quiet';

export interface SetupProblem {
  /** Stable id: a check id, or `no-agent`, `no-signin`, `claude-only`, `project-missing`. */
  id: string;
  tone: SetupProblemTone;
  /** Short chip label key. */
  labelKey: string;
  /** One line under the label in the popover. */
  detailKey: string;
  /** The one-click fix, when the report offers a runnable one. */
  fix: FixId | null;
}

type Tri = 'ok' | 'bad' | 'unknown';

function find(report: ReadinessReport, id: CheckId): ReadinessCheck | undefined {
  return report.checks.find((c) => c.id === id);
}

/** A plain row: only missing / needs-action is bad. Blocked rows have a cause listed elsewhere. */
function plain(c: ReadinessCheck | undefined): Tri {
  if (!c) return 'unknown';
  if (c.status === 'ok') return 'ok';
  if (c.status === 'missing' || c.status === 'needs-action') return 'bad';
  return 'unknown';
}

/** Claude's install: on disk but off the shell PATH still runs in the app. */
function claudeInstalled(c: ReadinessCheck | undefined): Tri {
  if (!c) return 'unknown';
  if (c.status === 'needs-action' && c.reason === 'not-on-path') return 'ok';
  return plain(c);
}

/** Claude's sign-in: blocked by a missing Claude is signed out; blocked by the network is unknown. */
function claudeSignedIn(c: ReadinessCheck | undefined): Tri {
  if (!c) return 'unknown';
  if (c.status === 'blocked') {
    const by = c.blockedBy ?? [];
    return by.length > 0 && by.every((d) => d === 'claude') ? 'bad' : 'unknown';
  }
  return plain(c);
}

function fixOf(c: ReadinessCheck | undefined): FixId | null {
  return c?.fix && c.fix.runnable && c.fix.kind !== 'manual' ? c.fix.id : null;
}

export interface SetupStatusInput {
  report: ReadinessReport | undefined;
  /** `GET /api/agent/tools`, or null while it has not answered (agent rows then wait). */
  tools: readonly AgentToolInfo[] | null;
  /** The open project's folder is gone from disk (the registry still lists it). */
  projectMissing: boolean;
}

export function setupProblems({ report, tools, projectMissing }: SetupStatusInput): SetupProblem[] {
  const out: SetupProblem[] = [];
  if (projectMissing) {
    out.push({ id: 'project-missing', tone: 'bad', labelKey: 'setupStatus.projectMissing', detailKey: 'setupStatus.projectMissing.detail', fix: null });
  }
  if (!report) return out;

  for (const id of ['network', 'node', 'npm', 'cli'] as const) {
    const c = find(report, id);
    if (plain(c) === 'bad') {
      out.push({ id, tone: 'bad', labelKey: `setupStatus.${id}`, detailKey: `setupStatus.${id}.detail`, fix: fixOf(c) });
    }
  }

  // The agent rows wait for the tool list: deciding without it could call a Codex user's
  // machine "no agent installed" for the second before it answers.
  if (tools === null) return out;
  const others = tools.filter((t) => t.tool !== 'claude');
  const otherInstalled = others.some((t) => t.installed);
  const otherSignedIn = others.some((t) => t.installed && t.signedIn);
  const claudeCheck = find(report, 'claude');
  const authCheck = find(report, 'claude-auth');
  const installed = claudeInstalled(claudeCheck);
  const signedIn = claudeSignedIn(authCheck);

  if (installed === 'bad' && !otherInstalled) {
    out.push({ id: 'no-agent', tone: 'bad', labelKey: 'setupStatus.noAgent', detailKey: 'setupStatus.noAgent.detail', fix: fixOf(claudeCheck) });
  } else if (signedIn === 'bad' && !otherSignedIn) {
    out.push({ id: 'no-signin', tone: 'bad', labelKey: 'setupStatus.noSignin', detailKey: 'setupStatus.noSignin.detail', fix: installed === 'bad' ? fixOf(claudeCheck) : fixOf(authCheck) });
  } else if ((installed === 'bad' || signedIn === 'bad') && otherSignedIn) {
    out.push({
      id: 'claude-only', tone: 'quiet', labelKey: 'setupStatus.claudeOnly', detailKey: 'setupStatus.claudeOnly.detail',
      fix: installed === 'bad' ? fixOf(claudeCheck) : fixOf(authCheck),
    });
  }
  return out;
}

/** The chip's text: the first problem, then "· +N" for the other red ones. Null = draw nothing. */
export function chipSummary(problems: readonly SetupProblem[]): { first: SetupProblem; more: number; tone: SetupProblemTone } | null {
  if (problems.length === 0) return null;
  const bad = problems.filter((p) => p.tone === 'bad');
  if (bad.length === 0) return { first: problems[0], more: 0, tone: 'quiet' };
  return { first: bad[0], more: bad.length - 1, tone: 'bad' };
}
