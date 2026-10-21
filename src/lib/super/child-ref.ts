import type { SuperState } from './types.js';

/**
 * A child named by the first characters of its session id (field 2026-10-21: `super read
 * a0a190b2` answered `unknown_child`; `super state` and the events print the whole id, but the
 * Super Agent copies what it sees in a line and a transcript path shows eight characters).
 *
 * ONE place for every verb: {@link expandChildRefs} rewrites the child fields of a verb's body to
 * full ids before the verb runs, so no verb has a prefix rule of its own.
 */

/** The fewest characters a prefix may have. Shorter than this is a guess, never a reference. */
export const MIN_CHILD_PREFIX = 8;
/** How many candidates an ambiguity error lists. */
const MAX_CANDIDATES = 6;

export type ChildRef =
  | { id: string }
  | { error: 'unknown_child' | 'ambiguous_child'; message: string; matches?: string[] };

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** The recorded children a prefix can name: own keys only, never the Super Agent itself. */
function childIds(state: Pick<SuperState, 'children' | 'session'>): string[] {
  return Object.keys(state.children).filter((id) => id !== state.session && !FORBIDDEN.has(id));
}

/**
 * `raw` is a recorded child's whole id, or the start of exactly one (at least
 * {@link MIN_CHILD_PREFIX} characters). Several children sharing the prefix is an ERROR that
 * names them, never a pick. A string that names nothing is `unknown_child`.
 */
export function resolveChildRef(state: Pick<SuperState, 'children' | 'session'>, raw: string): ChildRef {
  const ids = childIds(state);
  if (ids.includes(raw)) return { id: raw };
  if (raw.length < MIN_CHILD_PREFIX) {
    return { error: 'unknown_child', message: `"${raw.slice(0, 80)}" is not one of your children (an id prefix needs at least ${MIN_CHILD_PREFIX} characters; \`dreamcontext super state\` lists them)` };
  }
  const hits = ids.filter((id) => id.startsWith(raw));
  if (hits.length === 1) return { id: hits[0] };
  if (hits.length === 0) return { error: 'unknown_child', message: `"${raw.slice(0, 80)}" is not one of your children (\`dreamcontext super state\` lists them)` };
  return {
    error: 'ambiguous_child',
    message: `"${raw.slice(0, 80)}" starts ${hits.length} of your children: ${hits.slice(0, MAX_CANDIDATES).join(', ')}${hits.length > MAX_CANDIDATES ? ', …' : ''}; give more characters`,
    matches: hits.slice(0, MAX_CANDIDATES),
  };
}

/** Which body fields hold a child id, per verb. `refs` of `open` only when its kind names a child. */
const CHILD_FIELDS: Record<string, { one?: string[]; many?: string[] }> = {
  brief: { one: ['child'] },
  read: { one: ['child'] },
  answer: { one: ['child'] },
  send: { one: ['child'] },
  resume: { one: ['child'] },
  update: { one: ['child'] },
  'worktree-remove': { one: ['child'] },
  end: { one: ['child'], many: ['children'] },
  merge: { many: ['children'] },
  delegate: { one: ['succeeds'] },
};
const CHILD_CARD_KINDS = new Set(['chat', 'browser']);

export type ExpandedBody = { body: Record<string, unknown> } | { error: Extract<ChildRef, { error: string }> };

/**
 * `body` with every child field of `verb` spelled as a full id. An id that matches nothing is
 * left as given, so the verb's own refusal (its wording, its status) still answers; an
 * AMBIGUOUS prefix is the one outcome decided here.
 */
export function expandChildRefs(state: Pick<SuperState, 'children' | 'session'>, verb: string, body: Record<string, unknown>): ExpandedBody {
  const spec = CHILD_FIELDS[verb] ?? (verb === 'open' && typeof body.kind === 'string' && CHILD_CARD_KINDS.has(body.kind) ? { one: ['ref'], many: ['refs'] } : null);
  if (!spec) return { body };
  const out: Record<string, unknown> = { ...body };
  const fix = (v: unknown): { value: unknown } | { error: Extract<ChildRef, { error: string }> } => {
    if (typeof v !== 'string' || !v) return { value: v };
    const r = resolveChildRef(state, v);
    if ('id' in r) return { value: r.id };
    return r.error === 'ambiguous_child' ? { error: r } : { value: v };
  };
  for (const key of spec.one ?? []) {
    if (!(key in out)) continue;
    const r = fix(out[key]);
    if ('error' in r) return r;
    out[key] = r.value;
  }
  for (const key of spec.many ?? []) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    const next: unknown[] = [];
    for (const item of list) {
      const r = fix(item);
      if ('error' in r) return r;
      next.push(r.value);
    }
    out[key] = next;
  }
  return { body: out };
}
