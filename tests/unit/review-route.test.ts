import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterPlanError, areasOf, parseRouterPlan, pickEndReview } from '../../src/lib/review-route.js';
import { REVIEW_PICK_UNREADABLE_EXIT, builderReviewPick, type BuilderDeps } from '../../src/cli/commands/builder.js';

/**
 * Which end review a Develop run or goal-skill's Phase 5 gets (owner, 2026-10-14): one
 * reviewer for a small or one-area diff, the multi-review team for a Full tier, a hot path,
 * or UI plus another area. The router (an LLM) classifies; pickEndReview decides.
 */

describe('pickEndReview', () => {
  it('a small diff in one area gets one reviewer', () => {
    expect(pickEndReview({ tier: 'lite', domains: ['backend'], specialists: ['edge-cases'] }))
      .toEqual({ kind: 'reviewer', reason: 'lite tier, one area: backend', team: [] });
    expect(pickEndReview({ tier: 'trivial', domains: ['frontend'], specialists: ['frontend'] }).kind).toBe('reviewer');
  });

  it('UI alone is one area: one reviewer', () => {
    expect(pickEndReview({ tier: 'lite', domains: ['frontend'], specialists: ['frontend', 'edge-cases'] }).kind).toBe('reviewer');
  });

  it('UI plus any other area gets the team, says which, and names the team', () => {
    expect(pickEndReview({ tier: 'lite', domains: ['frontend', 'backend'], specialists: ['frontend', 'edge-cases'] }))
      .toEqual({ kind: 'multi-review', reason: 'UI plus backend', team: ['review-edge-cases', 'review-frontend'] });
    expect(pickEndReview({ tier: 'trivial', domains: ['cloud-functions', 'frontend'] }).team)
      .toEqual(['review-edge-cases', 'review-cloud-functions', 'review-frontend']);
  });

  it('a frontend specialist means UI even when domains forgot it', () => {
    expect(pickEndReview({ tier: 'lite', domains: ['backend'], specialists: ['frontend', 'edge-cases'] }).reason).toBe('UI plus backend');
  });

  it('two known areas without UI stay with one reviewer (the owner rule pairs UI with another area)', () => {
    expect(pickEndReview({ tier: 'lite', domains: ['backend', 'cloud-functions'] }))
      .toEqual({ kind: 'reviewer', reason: 'lite tier, backend + cloud-functions, no UI', team: [] });
  });

  it('a Full tier gets the team whatever it touches; edge-cases alone brings the generalist with it', () => {
    expect(pickEndReview({ tier: 'full', domains: ['backend'], specialists: ['edge-cases'] }))
      .toEqual({ kind: 'multi-review', reason: 'full tier', team: ['review-edge-cases', 'reviewer'] });
    expect(pickEndReview({ tier: ' Full ', domains: [] }).kind).toBe('multi-review');
  });

  it('a hot path gets the team with security on it, even when the router called the tier lite', () => {
    expect(pickEndReview({ tier: 'lite', domains: ['backend'], hot_path_triggers: ['src/auth/session.ts matched auth/ rule'] }))
      .toEqual({ kind: 'multi-review', reason: 'hot path: src/auth/session.ts matched auth/ rule', team: ['review-edge-cases', 'review-security'] });
  });

  it('a plan with no tier, or one it does not know, is read as Full and still gets a team', () => {
    expect(pickEndReview({ domains: ['backend'] })).toEqual({ kind: 'multi-review', reason: 'the plan names no tier, read as full', team: ['review-edge-cases', 'reviewer'] });
    expect(pickEndReview({ tier: 'medium', domains: ['backend'] }).kind).toBe('multi-review');
  });

  // Seen live on 2026-10-14: an installed router that predates the vocabulary answered
  // cli/server/agent-skills. Read as "one area", that would have been the single reviewer.
  it('an area outside the vocabulary gets the team: a classification we cannot read is more review', () => {
    expect(pickEndReview({ tier: 'lite', domains: ['cli', 'server', 'agent-skills', 'tests'], specialists: ['edge-cases'] }))
      .toEqual({ kind: 'multi-review', reason: 'area outside the vocabulary: cli, server, agent-skills', team: ['review-edge-cases', 'reviewer'] });
    expect(pickEndReview({ tier: 'lite', domains: ['web', 'server'], specialists: ['frontend', 'edge-cases'] }).team)
      .toEqual(['review-edge-cases', 'review-frontend']);
  });

  it('edge-cases, tests and docs are never an area', () => {
    expect(areasOf({ domains: ['frontend', 'tests', 'docs', 'edge-cases'] })).toEqual(['frontend']);
    expect(pickEndReview({ tier: 'lite', domains: ['frontend', 'tests', 'docs'] }).kind).toBe('reviewer');
  });

  it('a router that predates `domains`: UI gets the team (it cannot say what else changed), the rest one reviewer', () => {
    expect(areasOf({ specialists: ['frontend', 'cloud-functions', 'security', 'edge-cases'] })).toEqual(['frontend', 'cloud-functions']);
    expect(pickEndReview({ tier: 'lite', specialists: ['frontend', 'edge-cases'] }))
      .toEqual({ kind: 'multi-review', reason: 'UI, and the plan names no areas', team: ['review-edge-cases', 'review-frontend'] });
    expect(pickEndReview({ tier: 'lite', specialists: ['edge-cases'] }).kind).toBe('reviewer');
  });

  it('ignores non-string junk in the lists', () => {
    expect(areasOf({ domains: ['frontend', 3 as unknown as string, '', ' Backend '] })).toEqual(['frontend', 'backend']);
  });
});

describe('parseRouterPlan', () => {
  it('reads the last ```json block of the router reply', () => {
    const reply = 'Routing.\n```json\n{"tier":"full"}\n```\nthen\n```json\n{"tier":"lite","domains":["backend"]}\n```\n';
    expect(parseRouterPlan(reply)).toEqual({ tier: 'lite', domains: ['backend'] });
  });

  it('reads a fence in any case, with text after the tag, or on one line', () => {
    expect(parseRouterPlan('```JSON\n{"tier":"lite"}\n```')).toEqual({ tier: 'lite' });
    expect(parseRouterPlan('```json (dispatch plan)\n{"tier":"full"}\n```')).toEqual({ tier: 'full' });
    expect(parseRouterPlan('```json {"tier":"trivial"}```')).toEqual({ tier: 'trivial' });
  });

  it('reads the last block that parses: an untagged fence, another tag, or past a prose mention', () => {
    expect(parseRouterPlan('Plan:\n```\n{"tier":"lite"}\n```')).toEqual({ tier: 'lite' });
    expect(parseRouterPlan('```jsonc\n{"tier":"full"}\n```')).toEqual({ tier: 'full' });
    expect(parseRouterPlan('I end on one ```json block:\n```json\n{"tier":"trivial"}\n```')).toEqual({ tier: 'trivial' });
    expect(parseRouterPlan('```json\n{"tier":"full"}\n```\nquoted: ```ts\nconst x = 1;\n```')).toEqual({ tier: 'full' });
  });

  it('reads bare JSON', () => {
    expect(parseRouterPlan(' {"tier":"trivial"} ')).toEqual({ tier: 'trivial' });
  });

  it('refuses a reply with no plan, or one that is not an object', () => {
    expect(() => parseRouterPlan('The diff looks fine.')).toThrow(RouterPlanError);
    expect(() => parseRouterPlan('```json\n["frontend"]\n```')).toThrow(RouterPlanError);
    expect(() => parseRouterPlan('```json\nnull\n```')).toThrow(RouterPlanError);
    // A broken last plan is not rescued by an earlier example: that could pick less review.
    expect(() => parseRouterPlan('e.g. ```json\n{"tier":"trivial"}\n```\nPlan:\n```json\n{"tier":"full",}\n```')).toThrow(RouterPlanError);
  });
});

describe('dreamcontext builder review-pick', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-pick-'));
  const run = (file: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: BuilderDeps = { cwd: () => dir, print: (l) => out.push(l), printErr: (l) => err.push(l), ps: () => '', kill: () => {} };
    return { code: builderReviewPick(deps, file), out, err };
  };

  it('prints the pick on one line and exits 0', () => {
    const f = join(dir, 'route.md');
    writeFileSync(f, '```json\n{"tier":"lite","domains":["frontend","backend"]}\n```\n');
    expect(run(f)).toEqual({ code: 0, out: ['multi-review: UI plus backend; team: review-edge-cases, review-frontend'], err: [] });
    writeFileSync(f, '```json\n{"tier":"lite","domains":["backend"]}\n```\n');
    expect(run(f).out).toEqual(['reviewer: lite tier, one area: backend']);
  });

  it('exits 2 and asks for the router again when the reply holds no plan', () => {
    const f = join(dir, 'prose.md');
    writeFileSync(f, 'I reviewed it and it is fine.');
    const r = run(f);
    expect(r.code).toBe(REVIEW_PICK_UNREADABLE_EXIT);
    expect(r.out).toEqual([]);
    expect(r.err.join('\n')).toMatch(/re-run the review-router/);
  });

  it('exits 2 when the file is missing', () => {
    const r = run(join(dir, 'nope.md'));
    expect(r.code).toBe(REVIEW_PICK_UNREADABLE_EXIT);
    expect(r.err.join('\n')).toMatch(/no file/);
  });
});
