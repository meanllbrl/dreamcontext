/**
 * Which end review a finished run gets, read off the review-router's dispatch plan:
 * `dreamcontext builder review-pick <file>`.
 *
 * Owner, 2026-10-14: Develop and goal-skill closed every run with ONE generalist `reviewer`,
 * and a mobile-to-web port shipped unresponsive and erroring with that reviewer's PASS. The
 * multi-review team (a frontend, security, cloud-functions and edge-cases specialist, each on
 * its own files) is what found 2 Critical + 6 Major on the Jarvis change, but it costs 2-4x
 * the tokens of one reviewer, so it is chosen by the diff, not always:
 *
 *   - Full tier, or any hot-path file             -> multi-review
 *   - UI plus another area (backend, functions...) -> multi-review
 *   - anything else (small, or one area)           -> one reviewer
 *
 * The router (an LLM) classifies; this function decides, so the choice is the same every time
 * and a lead cannot talk itself into "small enough for one reviewer". An unreadable plan is an
 * error (re-run the router), never a silent default. A plan with no tier is read as Full: when
 * the classification is missing, the run gets more review, not less.
 *
 * tests/unit/review-route.test.ts pins every branch.
 */

/** The fields of the review-router's JSON this decision reads. Older routers omit `domains`. */
export interface RouterPlan {
  tier?: string;
  specialists?: string[];
  hot_path_triggers?: string[];
  domains?: string[];
}

export interface EndReviewPick {
  kind: 'reviewer' | 'multi-review';
  reason: string;
  /** For multi-review: the agents to dispatch, always review-edge-cases first. Empty for a reviewer. */
  team: string[];
}

/** The router's UI area. */
const UI_AREA = 'frontend';

/** The areas the review-router names (its step 4b). Anything else is read as unknown. */
export const KNOWN_AREAS: ReadonlySet<string> = new Set(['frontend', 'backend', 'cloud-functions', 'data', 'infra']);

/**
 * Names that are not an AREA of the product: edge-cases is a reviewer the router adds to every
 * Lite diff, and tests or docs ride along with any change.
 */
const NOT_AN_AREA = new Set(['edge-cases', 'tests', 'test', 'docs', 'doc']);

/** Specialists whose name is also an area. `security` is a lens, not a part of the product. */
const SPECIALIST_AREAS = new Set(['frontend', 'cloud-functions']);

/** The specialists with a `review-<name>` agent, besides edge-cases which every team gets. */
const TEAM_SPECIALISTS = ['security', 'cloud-functions', 'frontend'] as const;

export class RouterPlanError extends Error {}

/**
 * The router's plan from its output: the last fenced block (\`\`\`json in any case, another tag
 * or none, one line or many) whose body is a JSON object, or the whole text when it is bare
 * JSON. Reading the last block that PARSES, not the last that opens, keeps a prose mention of a
 * fence or a quoted snippet from hiding the plan. Throws {@link RouterPlanError} otherwise.
 */
export function parseRouterPlan(text: string): RouterPlan {
  const asObject = (body: string): RouterPlan | null => {
    try {
      const v: unknown = JSON.parse(body.trim());
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as RouterPlan) : null;
    } catch {
      return null;
    }
  };
  // Every stretch between two fence marks, its tag line dropped. Pairing marks by position would
  // let one stray mark in prose shift every block after it; trying each stretch cannot.
  const stretches = text.split('```').slice(1, -1);
  // The plan the router ends on is json-tagged. When that last json block is broken, an earlier
  // block (an example, a quote) must not stand in for it: that could pick less review.
  const lastJson = [...stretches].reverse().find((seg) => /^json\b/i.test(seg));
  if (lastJson !== undefined && !asObject(lastJson.replace(/^json\b[^\n{]*/i, ''))) {
    throw new RouterPlanError('its last ```json block is not a JSON object');
  }
  const bodies = stretches.map((seg) => seg.replace(/^[a-z]*[^\n{]*/i, ''));
  for (const body of [...bodies.reverse(), text]) {
    const plan = asObject(body);
    if (plan) return plan;
  }
  throw new RouterPlanError('no JSON dispatch plan in it (the router ends on exactly one ```json block)');
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean) : [];

/**
 * The areas the diff touches: the router's `domains`, plus the areas its specialists imply (a
 * `frontend` specialist means UI even when `domains` forgot it). Edge-cases, tests and docs are
 * never an area.
 */
export function areasOf(plan: RouterPlan): string[] {
  const named = [...strings(plan.domains), ...strings(plan.specialists).filter((s) => SPECIALIST_AREAS.has(s))];
  return [...new Set(named.filter((a) => !NOT_AN_AREA.has(a)))];
}

/** The team a multi-review pick dispatches: edge-cases always, plus each named specialist. */
function teamOf(plan: RouterPlan, areas: string[], hotPath: boolean): string[] {
  const named = new Set([...strings(plan.specialists), ...areas]);
  if (hotPath) named.add('security');
  const team = ['review-edge-cases', ...TEAM_SPECIALISTS.filter((s) => named.has(s)).map((s) => `review-${s}`)];
  // Edge-cases alone is not a team: the generalist reads the whole change beside it.
  return team.length === 1 ? [...team, 'reviewer'] : team;
}

export function pickEndReview(plan: RouterPlan): EndReviewPick {
  const tier = typeof plan.tier === 'string' ? plan.tier.trim().toLowerCase() : '';
  const hotPaths = strings(plan.hot_path_triggers);
  const areas = areasOf(plan);
  const multi = (reason: string): EndReviewPick => ({ kind: 'multi-review', reason, team: teamOf(plan, areas, hotPaths.length > 0) });

  if (hotPaths.length > 0) {
    return multi(`hot path: ${plan.hot_path_triggers!.filter((h) => typeof h === 'string')[0]}`);
  }
  if (tier === 'full') return multi('full tier');
  if (tier !== 'trivial' && tier !== 'lite') return multi('the plan names no tier, read as full');
  // An area outside the vocabulary is a classification we cannot read: more review, not less.
  const unknown = areas.filter((a) => !KNOWN_AREAS.has(a));
  if (unknown.length > 0) return multi(`area outside the vocabulary: ${unknown.join(', ')}`);
  // A router that predates `domains` cannot say what else a UI diff touches.
  if (areas.includes(UI_AREA) && strings(plan.domains).length === 0) return multi('UI, and the plan names no areas');
  if (areas.includes(UI_AREA) && areas.length > 1) {
    return multi(`UI plus ${areas.filter((a) => a !== UI_AREA).join(', ')}`);
  }
  const what = areas.length === 0 ? 'no product area' : areas.length === 1 ? `one area: ${areas[0]}` : `${areas.join(' + ')}, no UI`;
  return { kind: 'reviewer', reason: `${tier} tier, ${what}`, team: [] };
}
