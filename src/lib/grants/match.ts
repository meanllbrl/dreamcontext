/**
 * Does a live grant cover this call (plan uye-bildirim K3, gate G1)? Pure: the store hands the
 * grants in, the resolver reads the disk.
 *
 * Nothing a grant says is taken on trust at match time: eligibility is re-run for the grant's own
 * scope (a rule that became ineligible, or one written by hand in another form, never matches),
 * and every pin is re-resolved (a script edited after the rule, a swapped link, an interpreter
 * that now resolves elsewhere: no match, the owner is asked again). A `once` is never consumed
 * here: the enforcer consumes it through the store, where exactly one consumer wins.
 */
import { canonicalInput } from './canonical.js';
import { eligible, type EligibleCtx } from './eligible.js';
import { GRANT_MAX_MS, type Grant } from './types.js';

export interface MatchCall {
  /** Real path of the caller's project root. */
  project: string;
  /** The binding's pin (the session's registry id). */
  pin: string;
  /** The binding's member (a member Super or one of its children); absent for main's crew. */
  member?: string;
  tool: string;
  input: unknown;
}

export type MatchCtx = EligibleCtx & { now?: number };

/** When a grant stops counting: its own expiry, and never past a day for once and job. */
export function grantExpiry(g: Grant): number {
  return g.scope === 'member' ? g.expiresAt : Math.min(g.expiresAt, g.createdAt + GRANT_MAX_MS);
}

function scopeHolds(g: Grant, call: MatchCall): boolean {
  if (g.scope === 'member') return !!g.member && !!call.member && g.member === call.member;
  return !!g.pin && g.pin === call.pin;
}

/** The first live grant covering the call, rules before one-shots (a one-shot is not spent on a
 *  call a rule already allows), or null. */
export function match(grants: readonly Grant[], call: MatchCall, ctx: MatchCtx): Grant | null {
  const now = ctx.now ?? Date.now();
  const canonical = canonicalInput(call.tool, call.input);
  const ordered = [...grants].sort((a, b) => (a.scope === 'once' ? 1 : 0) - (b.scope === 'once' ? 1 : 0));
  for (const g of ordered) {
    if (g.project !== call.project || g.tool !== call.tool) continue;
    if (!(grantExpiry(g) > now)) continue;
    if (!scopeHolds(g, call)) continue;
    const e = eligible(call.tool, call.input, g.scope, ctx);
    if (!e.ok) continue;
    // The forms must agree. A script call is never allowed by exact text: its pin (real path and
    // sha256 taken when he looked) is what he allowed. The writer resolves in the session's folder
    // (inbox.ts grantCtx); a session that went somewhere the server cannot know is asked again,
    // never run unpinned.
    if (e.form !== g.form) continue;
    if (g.form === 'exact') {
      if (g.input === canonical) return g;
      continue;
    }
    const want = g.script;
    const got = e.script;
    if (!want || !got) continue;
    if (want.interpreter !== got.interpreter || want.interpreterPath !== got.interpreterPath
      || want.scriptPath !== got.scriptPath || want.sha256 !== got.sha256) continue;
    if (want.interpreterSha !== undefined) {
      const sha = ctx.resolve.sha256(got.interpreterPath);
      if (sha !== want.interpreterSha) continue;
    }
    // A one-shot is that exact call; a rule covers the pinned script with any arguments.
    if (g.scope === 'once' && g.input !== canonical) continue;
    return g;
  }
  return null;
}
