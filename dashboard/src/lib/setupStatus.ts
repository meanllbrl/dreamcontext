/**
 * The setup status chip beside the sleep score (owner 2026-11-03): ONLY big problems draw it,
 * and only they are red. "Big" = something that stops the app from working at all:
 *
 *   network missing on two reads in a row            red   "No internet" (one slow probe is not an outage)
 *   node / npm / cli `missing`                       red   (each has its one-click fix; `needs-action`,
 *                                                     e.g. off the shell PATH, is not: the app runs anyway)
 *   no agent tool installed (Claude missing AND no Codex/Antigravity installed)   red
 *   no agent tool signed in (Claude signed out AND none of the others signed in)  red
 *   this project's folder is gone from disk          red   (fix: remove it from the app)
 *   Claude missing or signed out BUT another tool works   one GRAY row: sleep, automations and
 *                                                     builders run on `claude -p` today
 *
 * Claude's sign-in is read from the app's own Claude account list (`GET /api/agent/accounts`, the
 * accounts chats actually open on): one account the app can use = signed in, whatever
 * `claude auth status` says about the default folder (on a multi-account Mac it says "signed
 * out" while every chat works: owner's machine, 2026-11-03). Only an empty list falls back to
 * the report's `claude-auth` row; no answer at all is unknown.
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

/** Only `missing` is bad for node, npm and the CLI: a shell probe that timed out or ran another
 *  shell reads `needs-action` while the app itself runs fine. */
function missingOnly(c: ReadinessCheck | undefined): Tri {
  if (!c) return 'unknown';
  if (c.status === 'ok') return 'ok';
  return c.status === 'missing' ? 'bad' : 'unknown';
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
  /** The app's Claude accounts (`state` of each), or null while unanswered (sign-in = unknown). */
  claudeAccounts: readonly { state: string }[] | null;
  /** The open project's folder is gone from disk (the registry still lists it). */
  projectMissing: boolean;
  /** The report said offline on two different reads in a row. One failed 3 s ping is not enough. */
  offlineConfirmed?: boolean;
}

/** Signed in by the app's own account list; the report only speaks for a machine with none. */
function claudeSignedInByApp(accounts: SetupStatusInput['claudeAccounts'], auth: ReadinessCheck | undefined): Tri {
  if (accounts === null) return 'unknown';
  if (accounts.some((a) => a.state === 'ok')) return 'ok';
  if (accounts.length > 0) return 'bad';
  return claudeSignedIn(auth);
}

export function setupProblems({ report, tools, claudeAccounts, projectMissing, offlineConfirmed = false }: SetupStatusInput): SetupProblem[] {
  const out: SetupProblem[] = [];
  if (projectMissing) {
    out.push({ id: 'project-missing', tone: 'bad', labelKey: 'setupStatus.projectMissing', detailKey: 'setupStatus.projectMissing.detail', fix: null });
  }
  if (!report) return out;

  const network = find(report, 'network');
  if (missingOnly(network) === 'bad' && offlineConfirmed) {
    out.push({ id: 'network', tone: 'bad', labelKey: 'setupStatus.network', detailKey: 'setupStatus.network.detail', fix: null });
  }
  for (const id of ['node', 'npm', 'cli'] as const) {
    const c = find(report, id);
    if (missingOnly(c) === 'bad') {
      out.push({ id, tone: 'bad', labelKey: `setupStatus.${id}`, detailKey: `setupStatus.${id}.detail`, fix: fixOf(c) });
    }
  }

  // The agent rows wait for the tool list: deciding without it could call a Codex user's
  // machine "no agent installed" for the second before it answers.
  if (tools === null) return out;
  const others = tools.filter((t) => t.tool !== 'claude');
  const otherInstalled = others.some((t) => t.installed);
  // A tool that is signed in but will not start (no Node, a broken install) does not work.
  const otherSignedIn = others.some((t) => t.installed && t.signedIn && t.ready);
  const claudeCheck = find(report, 'claude');
  const authCheck = find(report, 'claude-auth');
  const installed = claudeInstalled(claudeCheck);
  // A Claude that is not installed cannot be signed in, whatever a stale account folder says.
  const signedIn = installed === 'bad' ? 'bad' : claudeSignedInByApp(claudeAccounts, authCheck);

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
