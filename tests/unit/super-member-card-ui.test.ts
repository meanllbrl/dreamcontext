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
import { deleteDialog, instructionsParts, memberRoutines, plainWords } from '../../dashboard/src/components/sleepy/super/MemberCardBody.js';
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

  it('a floating member card\'s live body takes the pointer (owner 2026-11-05: a routine row did nothing)', () => {
    // Every floating body is inert by CSS (the card is one grab handle); a `data-inert` marker
    // alone does not make a body live. The member's live body gets the agenda's carve-out; a
    // small tile (data-inert) and the head stay the handle. The click itself is measured in a
    // real browser by scripts/verify/member-card-click.mjs.
    const css = read('SuperSurface.css');
    expect(css).toMatch(/\.super-card-frame\[data-where='float'\] \.super-card-body \{ pointer-events: none;/);
    expect(css).toMatch(/\.super-card-frame\[data-where='float'\]\[data-kind='member'\] \.super-card-large:not\(\[data-inert\]\) > \.super-card-large-body \{ pointer-events: auto; \}/);
    expect(read('SuperContainer.tsx')).toMatch(/<div className="super-card-large-body">\{p\.member\?\.\(c\.ref as MemberCardRef/);
  });

  it('Rutinler: an unsplit member\'s own manifest is no row; a split member\'s same-name routine is', () => {
    const r = (slug: string, agent: string) => ({ slug, agent, runKind: 'automation', mode: 'sched', enabled: true, title: slug }) as never;
    const all = [r('ua', 'ua'), r('morning', 'ua'), r('other', 'x')];
    expect(memberRoutines(all, 'ua', true).map((a: { slug: string }) => a.slug)).toEqual(['morning']);
    expect(memberRoutines(all, 'ua', false).map((a: { slug: string }) => a.slug)).toEqual(['ua', 'morning']);
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
    expect(body).toContain('memberRoutines((autos.data');
    // Its dialogs draw at the window's level, never inside the card's strict-contained clip.
    expect(body).toContain('createPortal(');
    expect(body).toMatch(/<WindowLayer>\s*<AutomationDialog/);
    expect(body).toMatch(/<WindowLayer>\s*<AgentIdentityDialog/);
  });

  it('Talimatlar: the opening paragraph is the lede, the rest is the body; nothing is said twice or lost', () => {
    const job = 'Sen Defne\'sin, gelir bekçisisin.\nYalnız okursun.\n\n### Önce oku\n- `knowledge/pricing/`\n\nSon cümle burada.';
    const { lede, rest } = instructionsParts(job);
    expect(lede).toBe('Sen Defne\'sin, gelir bekçisisin. Yalnız okursun.');
    expect(rest).toBe('### Önce oku\n- `knowledge/pricing/`\n\nSon cümle burada.');
    // A job that opens with a heading or a list has no lede: all of it is the body.
    expect(instructionsParts('## İş\nOku.')).toEqual({ lede: '', rest: '## İş\nOku.' });
    expect(instructionsParts('- bir\n- iki')).toEqual({ lede: '', rest: '- bir\n- iki' });
    // One paragraph: the lede holds it whole.
    expect(instructionsParts('Tek paragraf.')).toEqual({ lede: 'Tek paragraf.', rest: '' });
    expect(instructionsParts('')).toEqual({ lede: '', rest: '' });
    expect(plainWords('### Başlık\nOku `knowledge/x.md` ve **say**.')).toBe('Başlık Oku knowledge/x.md ve say.');
  });

  it('Talimatlar: a failed or hung read is said with a retry, never "Loading" forever, and never the clipped roster text', () => {
    const src = read('MemberCardBody.tsx');
    const card = src.slice(src.indexOf('function InstructionsCard'), src.indexOf('function SettingsCard'));
    expect(card).not.toContain("t('agents.page.loading')");
    expect(card).toMatch(/detail\.isError \|\| slow \?/);
    expect(card).toContain('data-testid="member-instructions-retry"');
    // A retry restarts the slow-read clock (the query stays pending across a refetch). The hang
    // itself is measured in a real browser by scripts/verify/member-instructions-card.mjs.
    expect(card).toMatch(/\}, \[pending, attempt\]\);/);
    expect(card).toMatch(/const retry = \(\) => \{ setSlow\(false\); setAttempt\(\(n\) => n \+ 1\); void detail\.refetch\(\); \};/);
    // The full card reads the job only from the full record (the roster's description is cut at 600).
    expect(card).toMatch(/const job = detail\.data\?\.prompt\?\.trim\(\) \?\? '';/);
    // Edit is the pencil in the card's top row, the identity dialog as before.
    expect(card).toMatch(/className="mcb-ins-top"[\s\S]*data-testid="member-instructions-edit"[\s\S]*mcb-ins-scroll/);
    expect(card).toContain('<AgentIdentityDialog slug={p.slug}');
  });
});

