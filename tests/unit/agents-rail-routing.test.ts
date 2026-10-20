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

describe('AI Team: one rail row for agents and automations (A1)', () => {
  it('the Workspace group runs Chat, Tasks, AI Team; no Agents row, no maturity tag on AI Team', () => {
    const src = code(read(SIDEBAR));
    expect(src).toMatch(/export type Page = [^;]*'agents'/);
    expect(src).not.toMatch(/\{\s*page:\s*'agents'/);
    const row = /\{\s*page:\s*'automations',\s*labelKey:\s*'nav\.aiTeam'([^}]*)\}/.exec(src);
    expect(row, 'no AI Team rail row').toBeTruthy();
    expect(row![1]).not.toMatch(/maturity/);
    const chat = src.indexOf("launch: 'chat'");
    const tasks = src.indexOf("page: 'tasks'");
    const team = src.indexOf("page: 'automations'");
    expect(chat).toBeLessThan(tasks);
    expect(tasks).toBeLessThan(team);
  });

  it('the old agents page key lights the AI Team row', () => {
    expect(code(read(SIDEBAR))).toMatch(/activePage === 'agents' \? 'automations' : activePage/);
  });

  it('the label is AI Team in English and Turkish', () => {
    const { en, tr } = locales();
    expect(en.get('nav.aiTeam')).toBe('AI Team');
    expect(tr.get('nav.aiTeam')).toBe('AI Team');
  });
});

describe('routing (A1, requestOpenAgents)', () => {
  it('both page keys render the AI Team with both focus channels', () => {
    const src = code(read(INSTANCE));
    expect(src).toMatch(/case 'automations':\s*case 'agents':\s*return \(\s*<AiTeamPage\s+automationFocus=\{automationFocus\}\s+onAutomationFocusDone=\{onAutomationFocusDone\}\s+agentsFocus=\{agentsFocus\}\s+onAgentsFocusDone=\{onAgentsFocusDone\}/);
    expect(src).not.toMatch(/AgentsPage|AutomationsPage/);
  });

  it('a page/agents link lands on the page with the slug as the page\'s own focus', () => {
    const src = code(read(INSTANCE));
    expect(src).toMatch(/parsed\.page === 'agents'\)\s*\{\s*nav\.navigate\('agents', null\);\s*onAgentsFocus\(parsed\.id \? \{ slug: parsed\.id \} : \{\}\);/);
  });

  it('the open-agents and talk-to-agent bridges act only in the ACTIVE instance', () => {
    const src = code(read(INSTANCE));
    for (const name of ['OpenAgentsBridge', 'TalkToAgentBridge']) {
      const at = src.indexOf(`function ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf('\n}\n', at));
      expect(body, name).toMatch(/if \(!isActive\) return;/);
      expect(body, name).toMatch(/window\.addEventListener\(/);
      expect(body, name).toMatch(/window\.removeEventListener\(/);
      expect(src, `${name} is not mounted`).toMatch(new RegExp(`<${name}[ />]`));
    }
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

  it('the AI Team takes an agent focus (profile or create) and an automation focus (its agent)', () => {
    const src = code(read(PAGE));
    expect(src).toMatch(/if \(agentsFocus\.create\)/);
    expect(src).toMatch(/setPanel\('profile'\)/);
    expect(src).toMatch(/setSelected\(a\?\.agent \?\? automationFocus\.slug\)/);
    expect(src).toMatch(/useAgents\(\)/);
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
