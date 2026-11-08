/**
 * The AI Team page is gone (plan-r10 1d, Wave 3 lane C): `pages/AiTeamPage.tsx` is the deep-link
 * alias that opens "Üyeleri yönet" (`aiteam/ManageMembersModal.tsx`, see
 * manage-members-modal.test.ts), plus an app's embedded team screen, which still reads a member's
 * conversation through `TeamConversation` (AC23). What is left here: the list's rules
 * (`listedRows`, `buildRoster`), the panels the modal hosts (a source scan of the seams the plan
 * pins: the routine editor's reuse, the new teammate), the embedded conversation, and the alias.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TeamRow } from '../../dashboard/src/components/aiteam/teamModel';
import { workingLine } from '../../dashboard/src/components/aiteam/teamModel';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => {},
    t: (key: string) => ({
      'aiteam.title': 'AI Team', 'aiteam.count.many': '{n} teammates', 'aiteam.new': 'New',
      'aiteam.section.needs': 'Needs you', 'aiteam.section.team': 'Team', 'aiteam.tag.needs': 'Needs you',
      'aiteam.tag.paused': 'Routine paused', 'aiteam.tag.approval': 'Needs your approval',
      'aiteam.working': 'Working · {time}', 'aiteam.time.now': 'now', 'aiteam.row.noMessages': 'No messages yet',
      'aiteam.newTeammate': 'New teammate', 'aiteam.draft.named': '{name} · not added yet',
      'aiteam.section.allProjects': 'All projects',
      'aiteam.section.readonly': "{owner}'s · read-only", 'aiteam.tag.global': 'All projects',
      'aiteam.tag.globalHint': 'Stays on this Mac.',
    } as Record<string, string>)[key] ?? key,
  }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/components/automations/AutomationsDispatcherBar.js', () => ({
  AutomationsDispatcherBar: () => null,
}));

const { listedRows } = await import('../../dashboard/src/components/aiteam/teamTree.js');
const { buildRoster } = await import('../../dashboard/src/components/aiteam/teamModel.js');

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, 'dashboard/src', rel), 'utf-8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function row(slug: string, over: Partial<TeamRow> = {}): TeamRow {
  return {
    slug, title: slug, hasPhoto: false, role: '', routines: [], status: 'idle', workingSince: null,
    preview: null, lastAt: null, unread: 0, section: 'team', ...over,
  };
}

describe('teammates in all projects', () => {
  const ads = (over: Partial<TeamRow> = {}) => row('ads', { title: 'Ads Manager', global: true, ...over });
  const local = row('scout', { title: 'Scout' });

  it('the list holds this project, and a member of all projects once it has something here', () => {
    const rows = [
      local,
      ads({ lastAt: '2026-10-19T18:00:00Z' }),
      row('quiet', { global: true }),
      row('paused', { global: true, status: 'paused' }),
      row('asks', { global: true, status: 'needs', section: 'needs' }),
      row('runs', { global: true, status: 'working' }),
      row('gate', { global: true, status: 'approval' }),
    ];
    expect(listedRows(rows).map((r) => r.slug)).toEqual(['scout', 'ads', 'asks', 'runs']);
  });

  it('a stage talk counts: the server\'s fact gives the row its last talk', () => {
    const agent = { slug: 'ads', title: 'Ads', hasPhoto: false, roleLine: '', description: '', approvedForChat: true, approvedToRun: true, approvalReason: null, model: null, effort: null, scope: 'global' as const };
    expect(buildRoster([{ ...agent, lastTalkAt: '2026-10-20T10:00:00.000Z' }], [], null)[0].lastAt).toBe('2026-10-20T10:00:00.000Z');
    expect(buildRoster([agent], [], null)[0].lastAt).toBeNull();
  });

  it('no way to place them, and nobody can be placed under them', () => {
    const tab = code(read('components/aiteam/TeamTab.tsx'));
    expect(tab).toMatch(/!summary\?\.implicit && !everywhere/);
    expect(tab).toMatch(/!summary\?\.implicit && !readOnly && !everywhere && addable/);
    expect(tab).toMatch(/addable = [^;]*a\.scope !== 'global'/s);
    expect(code(read('components/aiteam/PlaceInTeam.tsx'))).toMatch(/options = [^;]*\(a\.scope !== 'global' \|\| a\.slug === current\)/s);
  });

  it('the form offers the choice in the new shell only, where the launcher route is open, without remounting', () => {
    const form = code(read('components/aiteam/NewTeammate.tsx'));
    expect(form).toMatch(/useIsNewShell\(\) && phoneAllows\('POST', '\/api\/launcher\/global-agents'\)/);
    expect(form).toMatch(/scope=\{everywhere \? 'global' : undefined\}/);
    expect(form).toContain('key={starter}');
  });

  it('no word of the interface says Global, in either language', () => {
    const words = read('context/I18nContext.tsx').split('\n').filter((l) => /^\s*'(aiteam|agents\.identity|launcher\.)/.test(l));
    expect(words.length).toBeGreaterThan(100);
    expect(words.filter((l) => /\bglobal\b/i.test(l.split(/':\s/).slice(1).join(' ')))).toEqual([]);
  });
});

describe('the conversation (A3, A4, A8)', () => {
  const src = code(read('components/aiteam/TeamConversation.tsx'));

  it('is Chat\'s own Composer, talking to the agent itself by default', () => {
    expect(src).toMatch(/<Composer\b/);
    expect(src).toMatch(/useAgentThreadHost\(\s*\{ slug, title: agent\.title, runId: '' \}/);
    expect(src).toMatch(/say\.mutate\(\{ slug, text, \.\.\.overrideRef\.current \}/);
  });

  it('answers the open question instead while one waits, and says so above the field', () => {
    expect(src).toMatch(/const id = q\.question\.id;\s*answer\.mutate\(\{ id, kind: 'flow-hitl', answer: text \}/);
    // Answered: dropped from the composer at once, and the sent bubble waits for the re-read.
    expect(src).toMatch(/onSuccess: \(\) => \{ setAnswered\(/);
    expect(src).toMatch(/setSending\(\{ text, since: Date\.now\(\) \}\)/);
    expect(src).toMatch(/className="aiteam-replying"/);
    expect(src).toMatch(/t\('aiteam\.answering'\)/);
  });

  it('a refused send puts the text back', () => {
    expect(src).toMatch(/restoreRef\.current = restoreLastSent/);
    expect(src).toMatch(/const fail = \(err: unknown\) => \{[\s\S]*?restoreRef\.current\(\);/);
  });

  it('the model trigger shows the agent default and a pick is temporary, with a way back', () => {
    expect(src).toMatch(/model: agent\.model \?\? modelConfig\.defaultModel/);
    expect(src).toMatch(/writeTemporaryModel\(safeStorage\(\), slug, next\)/);
    expect(src).toMatch(/modelMenu=\{\{/);
    expect(src).toMatch(/className="aiteam-temp"/);
    expect(src).toMatch(/onClick=\{backToDefault\}/);
    expect(src).not.toMatch(/onSetModelDefault|patchAgentSettings/);
  });

  it('the menu foot replaces "Set as default" only where a surface gives one', () => {
    const menus = code(read('components/sleepy/chat/ComposerMenus.tsx'));
    expect(menus).toMatch(/\{foot && <div className="chat-cmp-menu-foot">\{foot\}<\/div>\}/);
    expect(menus).toMatch(/\{!foot && onSetDefault && \(/);
  });
});

describe('the panel (A5) and the new teammate (A10)', () => {
  it('Routines reuses the dialog\'s slot editor and saves through the update + re-approve path', () => {
    const panel = code(read('components/aiteam/TeamPanel.tsx'));
    expect(panel).toMatch(/<SlotRowEditor\b/);
    expect(panel).toMatch(/useUpdateAgent\(\)/);
    expect(panel).toMatch(/review: review \?/);
    expect(panel).toMatch(/<AgentProfilePanel slug=\{slug\}/);
    expect(code(read('components/agents/AutomationDialog.tsx'))).toMatch(/export function SlotRowEditor\(/);
  });

  it('a save sends the times only when they changed, so an untouched schedule is never rewritten', () => {
    const panel = code(read('components/aiteam/TeamPanel.tsx'));
    expect(panel).toMatch(/JSON\.stringify\(parsed\.slots\) !== seededSlots\.current \? \{ slots: parsed\.slots \} : \{\}/);
  });

  it('finished runs are not polled; a run in flight is', () => {
    const conv = code(read('components/aiteam/TeamConversation.tsx'));
    expect(conv).toMatch(/refetchInterval: m\.status === 'running' \? 2_000 : false/);
    expect(conv).toMatch(/invalidateQueries\(\{ queryKey: \['automations', m\.slug, 'thread', m\.runId\] \}\)/);
  });

  it('Esc does not throw away the inline new-teammate form', () => {
    expect(code(read('components/agents/AgentIdentityDialog.tsx'))).toMatch(/if \(inline\) return;\s*const onKey/);
  });

  it('the new teammate form is the identity dialog, inline, with no schedule', () => {
    const nt = code(read('components/aiteam/NewTeammate.tsx'));
    expect(nt).toMatch(/<AgentIdentityDialog[\s\S]*?\binline\b[\s\S]*?slug=\{null\}/);
    expect(nt).not.toMatch(/SlotRowEditor|slots/);
  });
});

describe('the page is a deep-link alias (plan-r10 1d)', () => {
  const page = code(read('pages/AiTeamPage.tsx'));

  it('draws no roster, stage, Activity feed or conversation of its own', () => {
    expect(page).not.toMatch(/AgentStage|stageSession|TeamRoster|RunFoot/);
    expect(page).not.toMatch(/<OrgView|<TeamPanel|<NewTeammate/);
  });

  it('every arrival opens "Üyeleri yönet": bare, on a member, on the create flow, on an automation\'s member', () => {
    expect(page).toMatch(/requestManageMembers\(\);/);
    expect(page).toMatch(/agentsFocus\.slug \? \{ slug: agentsFocus\.slug \} : \{\}/);
    expect(page).toMatch(/agentsFocus\.create \? \{ create: true \} : \{\}/);
    expect(page).toMatch(/agentsFocus\.create && agentsFocus\.whiteboard \? \{ whiteboard: agentsFocus\.whiteboard \} : \{\}/);
    expect(page).toMatch(/else requestManageMembers\(\{ slug: route\.slug \}\)/);
  });

  it('an automation link (the "needs your answer" banner) of a member\'s routine opens THAT member\'s stage', async () => {
    const { automationLinkRoute } = await import('../../dashboard/src/lib/openAgents.js');
    const agents = [{ slug: 'rota' }, { slug: 'mira' }];
    const automations = [
      { slug: 'rota-weekly', agent: 'rota', runKind: 'automation' },
      { slug: 'mira', runKind: 'agent' },
      { slug: 'legacy-job', runKind: 'automation' },
      { slug: 'ghost-routine', agent: 'gone', runKind: 'automation' },
    ];
    // A member's routine: that member's stage, where its open question is answered.
    expect(automationLinkRoute('rota-weekly', automations, agents)).toEqual({ to: 'member', slug: 'rota' });
    // A member's own call target.
    expect(automationLinkRoute('mira', automations, agents)).toEqual({ to: 'member', slug: 'mira' });
    // A routine of no member, one whose member is not here, and an unknown slug keep the modal.
    expect(automationLinkRoute('legacy-job', automations, agents)).toEqual({ to: 'manage', slug: 'legacy-job' });
    expect(automationLinkRoute('ghost-routine', automations, agents)).toEqual({ to: 'manage', slug: 'gone' });
    expect(automationLinkRoute('nope', automations, agents)).toEqual({ to: 'manage', slug: 'nope' });
  });

  it('an app\'s embedded team screen still reads its member\'s conversation and speaks as the app (AC23)', () => {
    expect(page).toMatch(/if \(embed\) return <EmbeddedTeam/);
    expect(page).toMatch(/<TeamConversation\b/);
    expect(page).toMatch(/sendMessage=\{embedSend\}/);
    expect(page).toMatch(/sayFromApp\(embed, selectedRef\.current \?\? '', text\)/);
    expect(page).toMatch(/runFilter=\{embedChat \? embedRuns : undefined\}/);
    expect(page).toMatch(/<OpenInMainApp grant=\{embed\} page="agents" \/>/);
  });

  it('the drafts and staged chips still die with the page', () => {
    expect(page).toMatch(/useEffect\(\(\) => \(\) => dropThreadScratch\(\), \[\]\)/);
  });
});

describe('several jobs on one row', () => {
  const t = (k: string): string => ({ 'aiteam.working': 'Working · {time}', 'aiteam.workingMany': '{n} jobs · {time}' } as Record<string, string>)[k];
  it('names the count only above one', () => {
    expect(workingLine({ workingCount: 1 }, '1m', t)).toBe('Working · 1m');
    expect(workingLine({ workingCount: 3 }, '1m', t)).toBe('3 jobs · 1m');
  });
});
