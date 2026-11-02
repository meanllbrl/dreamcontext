/**
 * AI Team (2026-10-20) replaced the Agents and Automations pages; this file now pins that
 * the AI Team is reachable from the old keys. History: Wave 4a, lane T6: the Agents page is reachable (rail row, page route, the open-agents request,
 * the `page/agents/<slug>` link), the reversal of ad04364c is RECORDED where the decision lives
 * (S6), and every string the four W4b lanes read already exists in English and Turkish.
 *
 * WHY A SOURCE SCAN. `Sidebar.tsx`, `ProjectInstance.tsx` and `I18nContext.tsx` are dashboard
 * TSX; root vitest runs plain Node without a DOM, so they cannot be mounted here (the same split
 * `sidebar-nav.test.ts` documents). What renders is `scripts/verify/sidebar-rail.mjs`'s job.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

const SIDEBAR = 'dashboard/src/components/layout/Sidebar.tsx';
const INSTANCE = 'dashboard/src/ProjectInstance.tsx';
const I18N = 'dashboard/src/context/I18nContext.tsx';
const PAGE = 'dashboard/src/pages/AiTeamPage.tsx';

/** Source with comments removed, so prose explaining a rule never satisfies the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** The English table and the Turkish partial, as key → value. */
function locales(): { en: Map<string, string>; tr: Map<string, string> } {
  const src = read(I18N);
  const block = (from: number) => src.slice(from, src.indexOf('\n};', from));
  const pairs = (text: string) => new Map(
    [...text.matchAll(/^\s+'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"([^"]*)")/gm)].map((m) => [m[1], m[2] ?? m[3] ?? '']),
  );
  return {
    en: pairs(block(src.indexOf('  en: {'))),
    tr: pairs(block(src.indexOf('const TR_PARTIAL'))),
  };
}

describe('no AI Team rail row (plan-r10 1d, owner uv773y)', () => {
  it('the Workspace group has no Agents or AI Team row; the page keys stay as aliases', () => {
    const src = code(read(SIDEBAR));
    expect(src).toMatch(/export type Page = [^;]*'agents'/);
    expect(src).toMatch(/export type Page = [^;]*'automations'/);
    expect(src).not.toMatch(/\{\s*page:\s*'agents'/);
    expect(src).not.toMatch(/\{\s*page:\s*'automations'/);
  });

  it('no row lights for the alias keys', () => {
    expect(code(read(SIDEBAR))).not.toMatch(/activePage === 'agents' \? 'automations'/);
  });
});

describe('routing (plan-r10 1c, 1d: requestOpenAgents, requestManageMembers)', () => {
  it('both page keys render the alias with both focus channels', () => {
    const src = code(read(INSTANCE));
    expect(src).toMatch(/case 'automations':\s*case 'agents':\s*return \(\s*<AiTeamPage\s+automationFocus=\{automationFocus\}\s+onAutomationFocusDone=\{onAutomationFocusDone\}\s+agentsFocus=\{agentsFocus\}\s+onAgentsFocusDone=\{onAgentsFocusDone\}/);
    expect(src).not.toMatch(/AgentsPage|AutomationsPage/);
  });

  it('a page/agents link lands on the alias with the slug as its own focus', () => {
    const src = code(read(INSTANCE));
    expect(src).toMatch(/parsed\.page === 'agents'\)\s*\{\s*nav\.navigate\('agents', null\);\s*onAgentsFocus\(parsed\.id \? \{ slug: parsed\.id \} : \{\}\);/);
  });

  it('the open-agents and talk-to-agent bridges act only in the ACTIVE instance', () => {
    const src = code(read(INSTANCE));
    for (const name of ['OpenAgentsBridge', 'TalkToAgentBridge']) {
      const at = src.indexOf(`function ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf('\n}\n', at));
      expect(body, name).toMatch(/if \(!isActive\) return( undefined)?;/);
      expect(body, name).toMatch(/window\.addEventListener\(/);
      expect(body, name).toMatch(/window\.removeEventListener\(/);
      expect(src, `${name} is not mounted`).toMatch(new RegExp(`<${name}[ />]`));
    }
  });

  it('a member request rings the member intent on the bus; create, a board and a bare request open the modal', () => {
    const src = code(read(INSTANCE));
    const at = src.indexOf('function OpenAgentsBridge');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toMatch(/routeOpenAgents\(readOpenAgentsDetail\(/);
    expect(body).toMatch(/memberIntent\(route\.slug, title, route\.task\)/);
    expect(body).toMatch(/emitInstance<DrawerIntent>\(bus, DRAWER_INTENT_EVENT, intent\)/);
    expect(body).toMatch(/route\.to === 'manage'\) \{ onManage\(route\.detail\)/);
    expect(body).toMatch(/MANAGE_MEMBERS_EVENT/);
    // It never lands on a page any more.
    expect(body).not.toMatch(/nav\.navigate/);
    expect(src).toMatch(/<ManageMembersModal focus=\{manage\} onClose=\{closeManage\} \/>/);
  });

  it('a plain navigate(\'agents\', slug) (an agent recall hit) becomes the page\'s own focus, once per nonce', () => {
    const src = code(read(INSTANCE));
    const at = src.indexOf('function NavFocusAgentsBridge');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toMatch(/page !== 'agents' \|\| !focusId \|\| nonce === landed\.current/);
    expect(body).toMatch(/readOpenAgentsDetail\(\{ slug: focusId \}\)/);
    expect(src).toMatch(/<NavFocusAgentsBridge nav=\{nav\} onAgentsFocus=\{focusAgents\} \/>/);
  });

  it('the alias turns an agent focus (profile or create) and an automation focus (its agent) into the modal', () => {
    const src = code(read(PAGE));
    expect(src).toMatch(/requestManageMembers\(\{/);
    expect(src).toMatch(/agentsFocus\.create \? \{ create: true \} : \{\}/);
    // An automation link: a member's routine opens that member's stage; any other keeps the modal.
    expect(src).toMatch(/automationLinkRoute\(automationFocus\.slug, automationsQ\.data, agentsQ\.data\)/);
    expect(src).toMatch(/if \(route\.to === 'member'\) requestOpenAgents\(\{ slug: route\.slug \}\);\s*else requestManageMembers\(\{ slug: route\.slug \}\);/);
    expect(src).not.toMatch(/AgentStage|stageSession|TeamRoster|RunFoot/);
  });

  it('the corner Chat button and dock step aside on the AI Team, as on a whiteboard (A9)', () => {
    const css = read('dashboard/src/components/sleepy/AgentTerminal.css');
    for (const page of ['automations', 'agents']) {
      expect(css).toContain(`.project-instance[data-page="${page}"] .agent-fab`);
    }
  });
});

describe('every W4b string exists in English and Turkish', () => {
  /** The keys the plan names for the four lanes, plus the page's own. */
  const REQUIRED = [
    'nav.agents',
    'agents.page.title', 'agents.page.empty', 'agents.page.new',
    'agents.profile.talk', 'agents.profile.talkFailed', 'agents.profile.usage', 'agents.profile.callSettings',
    'agents.approval.chatOk', 'agents.approval.chatNo', 'agents.approval.runOk', 'agents.approval.runNo',
    'agents.approval.review', 'agents.approval.approve',
    'agents.identity.createTitle', 'agents.identity.create', 'agents.identity.save',
    'agents.picker.manage',
    'automations.pickAgent', 'automations.job',
    'tasks.assignToAgent', 'tasks.assignDisclosure', 'tasks.approveAndAssign',
  ];

  it('each required key is in both', () => {
    const { en, tr } = locales();
    for (const key of REQUIRED) {
      expect(en.has(key), `en is missing ${key}`).toBe(true);
      expect(tr.has(key), `tr is missing ${key}`).toBe(true);
    }
  });

  it('every new English key has a Turkish twin that is not just the English', () => {
    const { en, tr } = locales();
    const fresh = [...en.keys()].filter((k) => /^(agents\.(page|roster|profile|approval|identity|picker)\.|automations\.(pickAgent|newAgent|agentUnapproved|job|runsAs|openAgent)|tasks\.(assign|approveAndAssign|agent|unassignAgent)|nav\.agents$)/.test(k));
    expect(fresh.length).toBeGreaterThan(100);
    // Same words are fine where Turkish uses them too ("Model").
    const sameOk = new Set(['agents.profile.model', 'agents.identity.model']);
    for (const key of fresh) {
      expect(tr.has(key), `tr is missing ${key}`).toBe(true);
      if (!sameOk.has(key)) expect(tr.get(key), key).not.toBe(en.get(key));
    }
  });

  it('no new copy uses an em dash', () => {
    const { en, tr } = locales();
    for (const [locale, map] of Object.entries({ en, tr })) {
      for (const [key, value] of map) {
        if (!/^(agents\.(page|roster|profile|approval|identity|picker)\.|automations\.(pickAgent|job)|tasks\.assign|nav\.agents$)/.test(key)) continue;
        expect(value, `${locale} ${key}`).not.toContain('—');
      }
    }
  });
});
