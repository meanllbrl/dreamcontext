/**
 * AI Team, wave 2: the page's surfaces.
 *
 * The team list is RENDERED (static markup, its two hooks pinned), because what a row says
 * and in which order is the claim (A2). The conversation, the panel and the model picker are
 * React surfaces with query and mutation hooks all through them, so the rest is a source scan
 * of the seams the plan pins: Chat's own Composer, the answer path while a question waits
 * (A4), the routine editor's reuse (A5), the temporary model (A8) and the empty states (A9).
 * What renders end to end is the A13 browser proof.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { TeamRow } from '../../dashboard/src/components/aiteam/teamModel';

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
      'aiteam.section.allProjects': 'All projects', 'aiteam.section.thisProject': 'This project',
      'aiteam.section.readonly': "{owner}'s · read-only", 'aiteam.tag.global': 'All projects',
      'aiteam.tag.globalHint': 'Stays on this Mac.',
    } as Record<string, string>)[key] ?? key,
  }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/components/automations/AutomationsDispatcherBar.js', () => ({
  AutomationsDispatcherBar: () => null,
}));

const { TeamRoster } = await import('../../dashboard/src/components/aiteam/TeamRoster.js');

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, 'dashboard/src', rel), 'utf-8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function row(slug: string, over: Partial<TeamRow> = {}): TeamRow {
  return {
    slug, title: slug, hasPhoto: false, role: '', routines: [], status: 'idle', workingSince: null,
    preview: null, lastAt: null, unread: 0, section: 'team', ...over,
  };
}

const render = (rows: TeamRow[], draft: { title: string } | null = null) => renderToStaticMarkup(createElement(TeamRoster, {
  rows, selected: rows[0]?.slug ?? null, draft, onSelect: () => {}, onNew: () => {}, onToast: () => {}, nextRun: 'Next run · tomorrow 09:00',
}));

describe('the team list (A2)', () => {
  const html = render([
    row('growth', { title: 'Growth analyst', status: 'needs', section: 'needs', preview: 'What now?', lastAt: '2026-10-19T18:00:00Z' }),
    row('scout', { title: 'Scout', status: 'working', workingSince: Date.now() - 72_000 }),
    row('brief', { title: 'Brief', status: 'paused', unread: 1, preview: 'Morning.' }),
    row('support', { title: 'Support', status: 'approval' }),
  ]);

  it('sections in order, one row each, the count in the head', () => {
    expect(html).toContain('4 teammates');
    expect(html.indexOf('Needs you')).toBeLessThan(html.indexOf('>Team<'));
    expect([...html.matchAll(/data-team-row="([a-z]+)"/g)].map((m) => m[1])).toEqual(['growth', 'scout', 'brief', 'support']);
  });

  it('each state wears its own word: needs you, working with its time, paused, approval, unread', () => {
    expect(html).toMatch(/aiteam-face-dot--needs/);
    expect(html).toMatch(/aiteam-tag aiteam-tag--warn">Needs you/);
    expect(html).toMatch(/aiteam-row-preview aiteam-row-preview--live">Working · 1m 1[12]s/);
    expect(html).toMatch(/aiteam-face-dot--working/);
    expect(html).toContain('Routine paused');
    expect(html).toContain('Needs your approval');
    expect(html).toMatch(/sidebar-badge">1</);
    expect(html).not.toMatch(/Beta|maturity/);
  });

  it('a new teammate being written stands at the top as a draft row', () => {
    const d = render([row('growth')], { title: 'Store reviewer' });
    expect(d.indexOf('aiteam-row--draft')).toBeLessThan(d.indexOf('data-team-row="growth"'));
    expect(d).toContain('Store reviewer · not added yet');
  });
});

describe('teammates in all projects', () => {
  const ads = (over: Partial<TeamRow> = {}) => row('ads', { title: 'Ads Manager', global: true, ...over });
  const local = row('scout', { title: 'Scout' });
  const at = (html: string, text: string) => { const i = html.indexOf(text); expect(i, text).toBeGreaterThan(-1); return i; };

  it('nobody in all projects: the one-heading list of today, no card', () => {
    const html = render([local]);
    expect(html).toContain('Team');
    expect(html).not.toContain('data-roster-section="all-projects"');
    expect(html).not.toContain('This project');
  });

  it('two sections, all projects first in its own card, each with its count', () => {
    const html = render([ads(), row('legal', { title: 'Legal', global: true }), local]);
    expect(html).toMatch(/All projects<span class="aiteam-section-count"> · 2<\/span>/);
    expect(html).toContain('title="Stays on this Mac."');
    expect(html).toMatch(/This project<span class="aiteam-section-count"> · 1<\/span>/);
    expect(at(html, 'data-roster-section="all-projects"')).toBeLessThan(at(html, 'data-roster-section="team"'));
    // The heading says it: no chip repeats it on the rows of the card.
    expect(html).not.toContain('data-global-chip');
  });

  it('needs you stays first and keeps the chip; read-only stays last', () => {
    const html = render([
      ads({ status: 'needs', section: 'needs' }),
      row('legal', { title: 'Legal', global: true }),
      local,
      row('kim', { title: 'Theirs', section: 'readonly', readOnly: true, ownerLabel: 'Kim' }),
    ]);
    expect(at(html, 'Needs you')).toBeLessThan(at(html, 'data-roster-section="all-projects"'));
    expect(at(html, 'data-roster-section="team"')).toBeLessThan(at(html, 'data-readonly-section'));
    expect(html).toMatch(/All projects<span class="aiteam-section-count"> · 1<\/span>/);
    expect(html).toContain('data-global-chip');
  });

  it('only members of all projects: no empty This project heading', () => {
    expect(render([ads()])).not.toContain('data-roster-section="team"');
  });

  it('the tree keeps them with the chip, reporting straight to you', () => {
    const html = renderToStaticMarkup(createElement(TeamRoster, {
      rows: [ads(), local], selected: null, draft: null, view: 'tree', onSelect: () => {}, onNew: () => {}, onToast: () => {}, nextRun: '',
    }));
    expect(html).toContain('data-tree-section="you"');
    expect(html).toContain('data-global-chip');
  });

  it('no way to place them, and nobody can be placed under them', () => {
    const tab = code(read('components/aiteam/TeamTab.tsx'));
    expect(tab).toMatch(/!summary\?\.implicit && !everywhere/);
    expect(tab).toMatch(/!summary\?\.implicit && !readOnly && !everywhere && addable/);
    expect(tab).toMatch(/addable = [^;]*a\.scope !== 'global'/s);
    expect(code(read('components/aiteam/PlaceInTeam.tsx'))).toMatch(/options = [^;]*\(a\.scope !== 'global' \|\| a\.slug === current\)/s);
    expect(code(read('components/aiteam/OrgChart.tsx'))).toContain('data-global-chip');
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

describe('the page (A1, A9)', () => {
  const page = code(read('pages/AiTeamPage.tsx'));

  it('list | conversation | panel, the list and the conversation taking turns on a phone', () => {
    expect(page).toMatch(/aiteam--panel/);
    expect(page).toMatch(/const narrow = width < NARROW_BELOW;/);
    expect(page).toMatch(/onBack=\{narrow \? \(\) => setMobileShow\('list'\) : undefined\}/);
    expect(page).toMatch(/aiteam-panel-scrim/);
  });

  it('a team with nobody in it opens on three starters, a blank start and the safety line', () => {
    expect(page).toMatch(/TEAM_STARTERS\.map/);
    expect(page).toMatch(/t\('agents\.empty\.blank'\)/);
    expect(page).toMatch(/t\('aiteam\.zero\.safety'\)/);
  });
});
