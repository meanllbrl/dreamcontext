import { describe, it, expect } from 'vitest';
import { matchMember } from '../../src/lib/task-backend/member-match.js';
import type { RemoteMember } from '../../src/lib/task-backend/index.js';

/**
 * The matcher is the root-cause fix for "unmapped person:<slug> tags": a user
 * types a short first name ("Emrecan"), and we must resolve it to the canonical
 * full-name member slug ("emrecan-tetik") rather than mint an unmappable slug
 * that the push path silently drops (defaulting the ClickUp assignee to the
 * API-token owner).
 */

const MEMBERS: RemoteMember[] = [
  { slug: 'emrecan-tetik', id: '101', name: 'Emrecan Tetik' },
  { slug: 'aylin-yilmaz', id: '102', name: 'Aylin Yilmaz' },
  { slug: 'mehmet-nuraydin', id: '103', name: 'Mehmet Nuraydın' },
  { slug: 'ahmet-yilmaz', id: '104', name: 'Ahmet Yilmaz' },
];

describe('matchMember', () => {
  it('exact slug → exact', () => {
    const m = matchMember('emrecan-tetik', MEMBERS);
    expect(m.kind).toBe('exact');
    expect(m.kind === 'exact' && m.member.id).toBe('101');
  });

  it('first name → the one member it prefixes (fuzzy)', () => {
    const m = matchMember('Emrecan', MEMBERS);
    expect(m.kind).toBe('fuzzy');
    expect(m.kind === 'fuzzy' && m.member.slug).toBe('emrecan-tetik');
  });

  it('ascii-folds Turkish input before matching', () => {
    // "mehmet" must reach "Mehmet Nuraydın" (dotless ı in the surname).
    const m = matchMember('mehmet', MEMBERS);
    expect(m.kind).toBe('fuzzy');
    expect(m.kind === 'fuzzy' && m.member.slug).toBe('mehmet-nuraydin');
  });

  it('a surname segment shared by two members → ambiguous (never guess)', () => {
    const m = matchMember('Yilmaz', MEMBERS);
    expect(m.kind).toBe('ambiguous');
    expect(m.kind === 'ambiguous' && m.matches.map((x) => x.slug).sort()).toEqual([
      'ahmet-yilmaz',
      'aylin-yilmaz',
    ]);
  });

  it('no match → none', () => {
    expect(matchMember('nobody', MEMBERS).kind).toBe('none');
  });

  it('empty / whitespace input → none', () => {
    expect(matchMember('   ', MEMBERS).kind).toBe('none');
  });

  it('stub members (no remote id) are never assignable candidates', () => {
    const stubs: RemoteMember[] = [{ slug: 'emrecan', id: '', name: 'Emrecan' }];
    // Even an exact-slug hit is rejected when the member carries no real id.
    expect(matchMember('emrecan', stubs).kind).toBe('none');
  });
});
