/**
 * A member stage's own cards in the window (plan r4 K-AC1, K2, K3, G2, G4, R4):
 *  - SuperContainer draws no close control on a member card, and its body is live from medium up
 *    (a click on its switch neither opens it side by side nor starts a drag);
 *  - a small member card is its summary tile; the render prop gets the sub-type;
 *  - the window's own close and its group close leave them (superLayout patch, closableIn);
 *  - the delete dialog's words come from the server's plan: routines by name (by project for a
 *    global member), no undo, a trash copy; in-app only (no window.confirm);
 *  - the routine create on the stage is preset to the member.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyLayoutPatch, patchEchoed } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { deleteDialog } from '../../dashboard/src/components/sleepy/super/MemberCardBody.js';
import { panelCloseOf } from '../../dashboard/src/components/sleepy/super/GroupPanel.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../dashboard/src/components/sleepy/super/${rel}`, import.meta.url)), 'utf8');

describe('member cards in the window', () => {
  it('a close patch naming a member card leaves it and counts as echoed', () => {
    const state = {
      v: 1, containers: [
        { id: 'member-r', kind: 'member', ref: 'routines', shape: 'square', place: 'float' },
        { id: 'insight-a', kind: 'insight', ref: 'a', shape: 'square', place: 'float' },
      ], groups: [], view: { mode: 'float' },
    } as never;
    const next = applyLayoutPatch(state, { closed: ['member-r', 'insight-a'] });
    expect(next.containers.map((c: { id: string }) => c.id)).toEqual(['member-r']);
    expect(patchEchoed(next, { closed: ['member-r', 'insight-a'] })).toBe(true);
    expect(panelCloseOf({ kind: 'member' })).toBeNull();
  });

  it('SuperContainer: no close for a member card, its body is live from medium up, controls are not a drag', () => {
    const src = read('SuperContainer.tsx');
    expect(src).toMatch(/const closeBtn = c\.kind === 'member' \? null/);
    expect(src).toMatch(/if \(c\.kind === 'member' && !small\) return;/);
    expect(src).toMatch(/data-inert=\{full \? undefined : 'true'\} data-member-card/);
    expect(src).toMatch(/!inFullscreen\(e\.target\) && !onControl\(c, e\.target\)\) props\.onPress/);
    const surface = read('SuperSurface.tsx');
    expect(surface).toMatch(/c\.kind === 'agenda' \|\| c\.kind === 'member'\) continue;/);
    expect(surface).toMatch(/if \(byId\.get\(id\)\?\.kind === 'member'\) return;/);
    expect(surface).toContain("member={c.kind === 'member' ? props.member?.card : undefined}");
    // The stage modules never import the chat UI: the body is a render prop.
    expect(surface).not.toContain('MemberCardBody');
    expect(src).not.toContain('MemberCardBody');
  });

  it('the delete dialog is filled from the plan: routines by name, by project for a global member, no undo, a trash copy', () => {
    const t = (k: string) => ({
      'superStage.member.cards.deleteTitle': '{name} silinsin mi?',
      'superStage.member.cards.deleteGoes': 'Uygulamada geri alma yok. Silinenler:',
      'superStage.member.cards.deleteSelf': 'Üyenin kendisi ve konuşma sahnesi',
      'superStage.member.cards.deleteRoutines': '{n} rutini: {names}',
      'superStage.member.cards.deleteApprovals': "Bu Mac'teki onayları",
      'superStage.member.cards.deleteEveryProject': 'Her projeden çıkar',
      'superStage.member.cards.deleteStays': 'Kalanlar: ... Bir kopyası çöp klasöründe durur.',
      'superStage.member.cards.deleteConfirmRoutines': 'Üyeyi ve {n} rutini sil',
      'superStage.member.cards.deleteConfirm': 'Üyeyi sil',
      'superStage.member.cards.cancel': 'Vazgeç',
    } as Record<string, string>)[k] ?? k;
    const d = deleteDialog({ slug: 'ua', title: 'UA Manager', global: false, blockers: [], routines: [
      { project: 'tilki', slug: 'a', title: 'Sabah bütçe kontrolü' }, { project: 'tilki', slug: 'b', title: 'Haftalık kreatif raporu' },
    ] }, t);
    expect(d.title).toBe('UA Manager silinsin mi?');
    expect(d.body).toContain('2 rutini: Sabah bütçe kontrolü, Haftalık kreatif raporu');
    expect(d.body).toContain('Uygulamada geri alma yok');
    expect(d.body).toContain('çöp klasöründe');
    expect(d.confirmLabel).toBe('Üyeyi ve 2 rutini sil');
    expect(d.destructive).toBe(true);
    const g = deleteDialog({ slug: 'c', title: 'Critic', global: true, blockers: [], routines: [{ project: 'globex', slug: 'w', title: 'Weekly' }] }, t);
    expect(g.body).toContain('Weekly (globex)');
    expect(g.body).toContain('Her projeden çıkar');
    expect(deleteDialog({ slug: 'x', title: 'X', global: false, blockers: [], routines: [] }, t).confirmLabel).toBe('Üyeyi sil');
  });

  it('the body asks in-app, presets a new routine to the member, and its delete is disabled while it works', () => {
    const body = read('MemberCardBody.tsx');
    expect(body).not.toMatch(/window\.confirm\(|[^.\w]confirm\(/);
    expect(body).toContain('confirmAction(');
    expect(body).toContain("initial={{ title: '', description: '', mode: 'sched', agent: p.slug }}");
    expect(body).toMatch(/data-testid="member-delete" disabled=\{busy \|\| p\.working\}/);
    expect(body).toContain("{ withRoutines: true, dryRun: true }");
    // The member's own unsplit manifest is the member: never a routine row with a Sil.
    expect(body).toContain('routineOf(a, slug) && !(a.slug === slug && !a.agent)');
    // Its dialogs draw at the window's level, never inside the card's strict-contained clip.
    expect(body).toContain('createPortal(');
    expect(body).toMatch(/<WindowLayer>\s*<AutomationDialog/);
    expect(body).toMatch(/<WindowLayer>\s*<AgentIdentityDialog/);
  });
});
