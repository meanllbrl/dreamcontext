/**
 * "Üyeleri yönet" (plan-r10 1d, r8-09; Wave 3 lane C): the modal hosts today's panels
 * (TeamPanel, OrgView, NewTeammate, TeamApproval, TeamAmendments, TeamSyncStrip), edits members of
 * all projects too, has NO chat pane, and "Sohbeti aç" opens the member's stage. A source scan:
 * the modal is React with query hooks all through it (root vitest has no DOM), like
 * aiteam-page.test.ts. The rendered modal is scripts/verify/super-members.mjs's job.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, 'dashboard/src', rel), 'utf-8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const modal = code(read('components/aiteam/ManageMembersModal.tsx'));

describe('the modal', () => {
  it('is the pinned test id, a real dialog', () => {
    expect(modal).toContain('data-testid="manage-members-modal"');
    expect(modal).toMatch(/role="dialog" aria-modal="true"/);
  });

  it('hosts the panels: profile, routines, files, team; the org chart; a new member; the one card; amendments; sync', () => {
    for (const tag of ['<TeamPanel', '<OrgView', '<NewTeammate', '<TeamApproval', '<TeamAmendments', '<TeamSyncStrip']) {
      expect(modal, tag).toContain(tag);
    }
    expect(modal).toMatch(/team=\{\{ rows, tree, onTalk: openChat \}\}/);
    // The create flow keeps the board it was asked for.
    expect(modal).toMatch(/whiteboard=\{creating\.whiteboard\}/);
  });

  it('has NO chat pane: no composer, no conversation, no stage, no run drawer', () => {
    expect(modal).not.toMatch(/TeamConversation|AgentStage|stageSession|RunFoot|TeamRoster|<Composer|ChatPane|AgentConversation/);
    // And nothing it imports from aiteam/ mounts one either (TeamPanel, OrgChart, NewTeammate...).
    for (const f of ['TeamPanel.tsx', 'OrgChart.tsx', 'NewTeammate.tsx', 'TeamApproval.tsx', 'TeamAmendments.tsx', 'TeamSyncStrip.tsx', 'TeamTab.tsx']) {
      expect(code(read(`components/aiteam/${f}`)), f).not.toMatch(/<Composer\b|<ChatPane\b|<AgentStage\b|<TeamConversation\b/);
    }
  });

  it('"Sohbeti aç" closes the modal and opens the member\'s stage', () => {
    expect(modal).toMatch(/t\('aiteam\.manage\.openChat'\)/);
    expect(modal).toMatch(/const openChat = useCallback\(\(slug: string\) => \{ onClose\(\); requestOpenAgents\(\{ slug \}\); \}/);
    expect(modal).toMatch(/onClick=\{\(\) => openChat\(current\.slug\)\}/);
  });

  it('lists members of all projects too, tagged, editable here', () => {
    expect(modal).toMatch(/r\.global && <span className="mm-tag">\{t\('drawer\.team\.globalAll'\)\}/);
    expect(modal).not.toMatch(/filter\(\(r\) => !r\.global\)\.map/);
  });

  it('opens on the asked member, or the create flow, and follows a new request while open', () => {
    expect(modal).toMatch(/useState<string \| null>\(focus\.slug \?\? null\)/);
    expect(modal).toMatch(/focus\.create \? \{ start: 'blank'/);
    expect(modal).toMatch(/if \(focus\.nonce === seen\.current\) return;/);
  });
});

describe('focus and Esc (end review M6)', () => {
  it('the first control takes focus, Tab is trapped, focus returns to the opener; Esc closes only the modal', () => {
    expect(modal).toMatch(/focusablesIn\(modalRef\.current\)\[0\]\?\.focus\(\);/);
    expect(modal).toMatch(/return \(\) => \{ if \(opener\?\.isConnected\) opener\.focus\(\); \};/);
    expect(modal).toMatch(/if \(e\.key === 'Tab'\) \{ trapTab\(e, modalRef\.current\); return; \}/);
    expect(modal).toMatch(/if \(e\.key !== 'Escape' \|\| e\.defaultPrevented\) return;\s*e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);/);
    expect(modal).toMatch(/window\.addEventListener\('keydown', onKey, true\)/);
    const list = code(read('components/layout/newshell/TeamList.tsx'));
    expect(list).toMatch(/if \(e\.key !== 'Escape' \|\| e\.defaultPrevented\) return;\s*e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);/);
    expect(list).toMatch(/if \(opener\?\.isConnected && /);
  });

  it('trapTab wraps at both ends and pulls a focus that left back in', async () => {
    const { trapTab, focusablesIn } = await import('../../dashboard/src/components/aiteam/focusTrap.js');
    const focused: string[] = [];
    const el = (id: string) => ({ id, hasAttribute: () => false, getAttribute: () => null, focus: () => { focused.push(id); } }) as unknown as HTMLElement;
    const a = el('a'); const b = el('b'); const c = el('c');
    const root = { querySelectorAll: () => [a, b, c], contains: (n: unknown) => n === a || n === b || n === c };
    expect(focusablesIn(root).map((x) => (x as unknown as { id: string }).id)).toEqual(['a', 'b', 'c']);
    let prevented = 0;
    const ev = (shiftKey: boolean) => ({ shiftKey, preventDefault: () => { prevented += 1; } });
    trapTab(ev(false), root, c);
    trapTab(ev(true), root, a);
    trapTab(ev(false), root, b);
    trapTab(ev(false), root, { id: 'outside' } as unknown as Element);
    expect(focused).toEqual(['a', 'c', 'a']);
    expect(prevented).toBe(3);
    expect(focusablesIn(null)).toEqual([]);
  });
});

describe('a project not on screen: queued, never a timer (end review Major 4)', () => {
  const chrome = code(read('components/layout/WindowChrome.tsx'));
  const inst = code(read('ProjectInstance.tsx'));

  it('"Üyeleri yönet" for another project is queued per project and taken by its instance once active', () => {
    const at = chrome.indexOf('const manageMembers = useCallback');
    const body = chrome.slice(at, chrome.indexOf('}, [activate, addTab, consumeManage]);', at));
    expect(body).not.toMatch(/requestAnimationFrame|setTimeout/);
    expect(body).toMatch(/setPendingManage\(\(prev\) => \(\{ \.\.\.prev, \[target\]: nonce \}\)\)/);
    expect(body).toMatch(/if \(!intentLands\(result, !!tab && !tab\.cold\)\) consumeManage\(target, nonce\)/);
    expect(chrome).toMatch(/pendingManage=\{pendingManage\[p\.vault\] \?\? null\}/);
    expect(inst).toMatch(/if \(pendingManage === null \|\| !isActive\) return;\s*onManageConsumed\?\.\(vault, pendingManage\);\s*openManage\(\{\}\);/);
  });

  it('the ChromeApi exposes queueDrawerIntent: the drawer\'s own per-project pending-intent path', () => {
    expect(chrome).toMatch(/queueDrawerIntent\(vault: string, intent: DrawerIntent\): void;/);
    expect(chrome).toMatch(/queueDrawerIntent: \(\) => \{\},/);
    expect(chrome).toMatch(/queueDrawerIntent: \(vault: string, intent: DrawerIntent\) => \{ void queueDrawerIntent\(vault, intent\); \}/);
    // The Global ekip list opens a member in its project through the same queue (`pick` -> onIntent).
    expect(code(read('components/layout/newshell/ChatDrawer.tsx'))).toMatch(/if \(g\?\.openIn\) openMember\(g\.openIn, m\)/);
    expect(chrome).toMatch(/onIntent=\{\(vault, intent\) => void queueDrawerIntent\(vault, intent\)\}/);
  });
});

describe('where it is opened from', () => {
  it('ProjectInstance mounts it for the active project only, never on a phone', () => {
    const inst = code(read('ProjectInstance.tsx'));
    expect(inst).toMatch(/\{manage && isActive && <ManageMembersModal focus=\{manage\} onClose=\{closeManage\} \/>\}/);
    expect(inst).toMatch(/if \(isMacPhoneSurface\(\)\) return;/);
  });

  it('the Ekip lists offer it on the desktop only; the alias page and the drawer call requestManageMembers', () => {
    expect(code(read('components/layout/newshell/ChatDrawer.tsx'))).toMatch(/!phone && p\.onManage/);
    expect(code(read('components/layout/newshell/TeamList.tsx'))).toMatch(/!p\.sheet && p\.onManage/);
    expect(code(read('components/layout/WindowChrome.tsx'))).toMatch(/requestManageMembers\(\)/);
    expect(code(read('pages/AiTeamPage.tsx'))).toMatch(/requestManageMembers\(/);
  });
});
