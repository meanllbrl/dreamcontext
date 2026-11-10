/**
 * The last two W6 mount points (uye-bildirim K7, K8, criterion 12):
 *  - the drawer's facts bridge carries the surface's per-member counts (`memberWaits`, main's
 *    record) up as the Ekip row's `waits`, so the side menu's red count counts a refusal or a
 *    stalled job the member's own summary never reports, and a change of those counts alone is a
 *    new surface state (never swallowed as "the same");
 *  - the Super stage's Agenda names a routine by its own title, falling back to its slug.
 * The pure parts are driven for real; the mounts inside DrawerFactsBridge and SuperSurface (hooks
 * and a large component tree) are pinned on their source, the way owner-reach-mounts.test.ts does.
 * Fictional members and routines (synthetic-fixtures pattern).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameSurfaceState, type DrawerSurfaceState } from '../../dashboard/src/lib/drawerIntents.js';
import { superNotepad, type JobLook } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { memberWaitCounts } from '../../dashboard/src/components/aiteam/teamModel.js';
type SuperQueueItem = import('../../dashboard/src/lib/superTypes.js').SuperQueueItem;

const here = fileURLToPath(new URL('.', import.meta.url));
const src = (rel: string) => readFileSync(join(here, '../../dashboard/src', rel), 'utf8');

describe('the drawer carries what main holds for each member', () => {
  const base: DrawerSurfaceState = { superOn: true, superSelected: false };

  it('a change of the member counts alone is a new surface state', () => {
    expect(sameSurfaceState({ ...base, memberWaits: { turing: 1 } }, { ...base, memberWaits: { turing: 1 } })).toBe(true);
    expect(sameSurfaceState({ ...base, memberWaits: { turing: 1 } }, { ...base, memberWaits: { turing: 2 } })).toBe(false);
    expect(sameSurfaceState(base, { ...base, memberWaits: { turing: 1 } })).toBe(false);
    expect(sameSurfaceState(base, { ...base })).toBe(true);
  });

  it('counts a refused member and a routine, never a closed item or a nudge', () => {
    expect(memberWaitCounts([
      { kind: 'member', state: 'escalated', member: 'turing' },
      { kind: 'routine', state: 'pending', member: 'turing' },
      { kind: 'member', state: 'done', member: 'turing' },
      { kind: 'nudge', state: 'pending', member: 'turing' },
      { kind: 'member', state: 'escalated', member: 'lovelace' },
    ])).toEqual({ turing: 2, lovelace: 1 });
  });

  it('the bridge passes the counts up as `waits` and re-publishes when they change', () => {
    const bridge = src('components/layout/newshell/DrawerFactsBridge.tsx');
    expect(bridge).toContain('...(surface.memberWaits ? { waits: surface.memberWaits } : {})');
    // Read through the key: without it a new count alone would never reach the side menu.
    expect(bridge).toMatch(/const windowsKey = JSON\.stringify\(\[[^\]]*surface\.memberWaits/);
  });
});

describe('the Agenda names a routine by its own title', () => {
  const look = (routineTitleFor?: (slug: string) => string): JobLook => ({
    live: () => null, titleFor: (s) => s, modelFor: () => null, superTitle: 'Super Agent',
    ...(routineTitleFor ? { routineTitleFor } : {}),
  });
  const routine = (over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
    id: 'q-rt1', sessionId: 'sup-1', kind: 'routine', state: 'pending', createdAt: 3,
    routine: 'morning-digest', fact: 'not-approved:abc123', ownerText: 'Did not run at 07:00', ...over,
  } as SuperQueueItem);
  const waitingRow = (l: JobLook, q: SuperQueueItem) =>
    superNotepad({ queue: [q], pad: [] } as unknown as Parameters<typeof superNotepad>[0], l).waiting.find((r) => r.item === q.id);

  it('by the title the automations list gives it', () => {
    const titles: Record<string, string> = { 'morning-digest': 'Morning digest' };
    expect(waitingRow(look((s) => titles[s] ?? ''), routine())?.text).toBe('Morning digest');
  });

  it('by its slug when the list does not know it, with or without a member', () => {
    expect(waitingRow(look(() => ''), routine())?.text).toBe('morning-digest');
    expect(waitingRow(look(), routine({ member: 'turing' }))?.text).toBe('morning-digest');
  });

  it("the stage's look is given the routine's title from the automations list", () => {
    const surface = src('components/sleepy/super/SuperSurface.tsx');
    expect(surface).toContain('routineTitleFor: (slug) => routineTitleIn(agendaRoutines, slug)');
    expect(surface).toContain('...(routineTitleFor ? { routineTitleFor } : {})');
    // Read only while a routine is open in main's record: a member's stage never holds one.
    expect(surface).toMatch(/const agendaRoutines = useAutomations\(\{ enabled: !member && state\.queue\.some\(\(q\) => q\.kind === 'routine'/);
  });
});
