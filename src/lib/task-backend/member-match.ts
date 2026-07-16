/**
 * Resolve a human-entered person reference to a CANONICAL remote member —
 * pure, no I/O, unit-testable in isolation.
 *
 * The slug taxonomy for assignees is full-name based (e.g. "Aylin Yilmaz" →
 * `aylin-yilmaz`). Users, however, type short first names ("Emrecan", "aylin").
 * Left unresolved, those mint `person:emrecan` tags that map to no remote member
 * and get silently dropped on push (and the remote then defaults the assignee to
 * the API-token owner). This matcher maps the typed input onto the real member
 * roster so only member-backed slugs are ever recorded — the root-cause fix for
 * both the silent-drop and the non-member-picker bugs.
 *
 * Only members carrying a real remote id (`id !== ''`) are assignable
 * candidates; roster/task-derived stubs (id '') are excluded.
 */

import { slugify } from '../id.js';
import { foldAscii } from '../fold-ascii.js';
import type { RemoteMember } from './types.js';

export type MemberMatch =
  | { kind: 'exact'; member: RemoteMember }
  | { kind: 'fuzzy'; member: RemoteMember }
  | { kind: 'ambiguous'; matches: RemoteMember[] }
  | { kind: 'none' };

/** Canonical comparison key: ascii-folded, slugified (matches `memberSlug`). */
function key(s: string): string {
  return slugify(foldAscii(s));
}

/** True when `q` is a whole name-segment of `slug` (so "emrecan" hits "emrecan-tetik"). */
function matchesSegment(slug: string, q: string): boolean {
  return slug === q || slug.startsWith(`${q}-`) || slug.split('-').includes(q);
}

/**
 * Match `input` against the assignable (real-id) members.
 * - exact slug → `exact`
 * - one member whose slug/name contains the input as a name segment → `fuzzy`
 * - several such members → `ambiguous` (caller must not guess)
 * - none → `none`
 */
export function matchMember(input: string, members: RemoteMember[]): MemberMatch {
  const q = key(input);
  if (!q) return { kind: 'none' };

  // Only members with a real remote id can actually be assigned.
  const real = members.filter((m) => m.id !== '');

  const exact = real.find((m) => m.slug === q);
  if (exact) return { kind: 'exact', member: exact };

  const matches = real.filter(
    (m) => matchesSegment(m.slug, q) || matchesSegment(key(m.name), q),
  );
  if (matches.length === 1) return { kind: 'fuzzy', member: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'none' };
}
