/**
 * Wave 4b, lane T8: the Automations page after agents became their own entity (S2, S3).
 *
 * Two halves. The member card is RENDERED (static markup, the hooks it calls pinned), because
 * whose face it wears and whose name it says are the claim, and only the markup proves them.
 * The create dialog, the zero-state and the feed are React surfaces with query and mutation
 * hooks all through them, so the rest is a source scan of the exact seams the plan pins:
 * the create sends `agent` + `job`, the 409 `agent_unapproved` is handled in place with a way
 * to the agent, the on-call starter opens the Agents page in create mode, and no surface on
 * this page still draws an automation's own slug as a face.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { AutomationSummary } from '../../dashboard/src/hooks/useAutomations';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => {},
    t: (key: string) => (key === 'automations.runsAs' ? 'Runs as {name}' : key),
  }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/hooks/useAutomations.js', async (orig) => ({
  ...(await orig<typeof import('../../dashboard/src/hooks/useAutomations.js')>()),
  useSetAutomationEnabled: () => ({ mutate: () => {}, isPending: false }),
}));

const { AgentMemberCard, agentFaceOf, runsAsTitle } = await import('../../dashboard/src/components/agents/AgentMemberCard.js');

const ROOT = join(import.meta.dirname, '..', '..');
const DASH = join(ROOT, 'dashboard/src');
const read = (rel: string) => readFileSync(join(DASH, rel), 'utf-8');

function summary(over: Partial<AutomationSummary> = {}): AutomationSummary {
  return {
    slug: 'morning-scout',
    title: 'Morning scout',
    mode: 'sched',
    hasPhoto: false,
    description: 'List what changed.',
    cadenceLabel: 'daily 09:00',
    enabled: true,
    schedule: null,
    scheduleLabel: 'daily 09:00',
    scheduleError: null,
    nextFireAt: null,
    model: 'opus',
    effort: 'medium',
    timeoutMinutes: 30,
    catchupHours: 0,
    approved: true,
    approvalReason: null,
    cache: null,
    review: 'off',
    pendingQuestion: null,
    ...over,
  } as AutomationSummary;
}

const renderCard = (s: AutomationSummary) => renderToStaticMarkup(createElement(AgentMemberCard, {
  summary: s,
  onOpenProfile: () => {},
  onEdit: () => {},
  onOpenDetail: () => {},
  onToast: () => {},
}));

describe('whose face a run target wears (agentFaceOf)', () => {
  it('a bound automation wears its agent: the agent slug, the agent name, the agent route', () => {
    expect(agentFaceOf({ slug: 'morning-scout', title: 'Morning scout', agent: 'scout', agentTitle: 'Scout' }))
      .toEqual({ slug: 'scout', title: 'Scout', of: 'agent' });
  });

  it('an older backend (no `agent`) keeps the automation route under its own slug', () => {
    expect(agentFaceOf({ slug: 'digest', title: 'Digest' })).toEqual({ slug: 'digest', title: 'Digest', of: 'automation' });
  });

  it('an agent with no title on the wire falls back to the automation title, never to blank', () => {
    expect(agentFaceOf({ slug: 'x', title: 'X job', agent: 'x-agent', agentTitle: '' }).title).toBe('X job');
  });
});

describe('"Runs as" appears only when it says something (runsAsTitle)', () => {
  it('names a different agent', () => {
    expect(runsAsTitle({ slug: 'morning-scout', title: 'Morning scout', agent: 'scout', agentTitle: 'Scout' })).toBe('Scout');
  });

  it('is silent for an unsplit file (its agent is itself) and on an older backend', () => {
    expect(runsAsTitle({ slug: 'digest', title: 'Digest', agent: 'digest', agentTitle: 'Digest' })).toBeNull();
    expect(runsAsTitle({ slug: 'digest', title: 'Digest' })).toBeNull();
  });

  it('is silent when the agent shares the automation\'s name', () => {
    expect(runsAsTitle({ slug: 'a', title: 'Scout', agent: 'scout', agentTitle: 'Scout' })).toBeNull();
  });
});

describe('the member card shows the agent\'s face and title', () => {
  it('reads the photo from the AGENT route under the agent slug, and says who it runs as', () => {
    const html = renderCard(summary({ hasPhoto: true, agent: 'scout', agentTitle: 'Scout' }));
    expect(html).toContain('/agents/scout/photo');
    expect(html).not.toContain('/automations/morning-scout/photo');
    expect(html).toContain('Runs as Scout');
    // The card is still the automation's: its own name leads.
    expect(html).toContain('Morning scout');
  });

  it('draws the agent\'s initials when there is no photo', () => {
    const html = renderCard(summary({ agent: 'scout', agentTitle: 'Scout' }));
    expect(html).toMatch(/class="agent-av"[^>]*>S</);
  });

  it('a legacy automation (no agent on the wire) still renders as before', () => {
    const html = renderCard(summary({ hasPhoto: true }));
    expect(html).toContain('/automations/morning-scout/photo');
    expect(html).not.toContain('Runs as');
  });
});

describe('the create dialog picks an agent (S2)', () => {
  const dialog = read('components/agents/AutomationDialog.tsx');

  it('AgentDialog is renamed to AutomationDialog, and nothing imports the old path', () => {
    expect(existsSync(join(DASH, 'components/agents/AgentDialog.tsx'))).toBe(false);
    expect(existsSync(join(DASH, 'components/agents/AgentDialog.css'))).toBe(false);
    expect(dialog).toMatch(/export function AutomationDialog\(/);
    expect(dialog).toContain("import './AutomationDialog.css';");
    for (const rel of ['components/agents/AgentsMembers.tsx', 'components/automations/AutomationsEmptyState.tsx']) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/agents\/AgentDialog'|\.\/AgentDialog'/);
      expect(src, rel).toMatch(/AutomationDialog/);
    }
  });

  it('reads the roster from useAgents and shows each agent\'s approval state in the picker', () => {
    expect(dialog).toMatch(/useAgents\(\{ enabled: pickable \}\)/);
    expect(dialog).toMatch(/a\.approvedForChat \? a\.title : `\$\{a\.title\} · \$\{t\('agents\.picker\.unapproved'\)\}`/);
    expect(dialog).toContain("t('automations.pickAgent')");
  });

  it('a create with an agent picked sends agent + job and no identity field', () => {
    const bound = dialog.match(/const draft: AutomationDraft = bound[\s\S]*?\n {4}\? \{([\s\S]*?)\n {4}\}\n {4}: \{/);
    expect(bound, 'the bound draft').not.toBeNull();
    const body = bound![1];
    expect(body).toMatch(/agent: choice/);
    expect(body).toMatch(/job: job\.trim\(\)/);
    expect(body).not.toMatch(/\bprompt\b|\bmodel\b|\beffort\b|\bwhiteboard\b/);
    expect(dialog).toContain("t('automations.job')");
  });

  it('a 409 agent_unapproved is shown in place, with a link that opens that agent on the AI Team page', () => {
    expect(dialog).toMatch(/err instanceof RequestError && err\.code === 'agent_unapproved'/);
    expect(dialog).toMatch(/setRefusedSlug\(choice\)/);
    expect(dialog).toContain("t('automations.agentUnapproved')");
    expect(dialog).toMatch(/openAgents\(\{ slug: unapprovedAgent\.slug \}\)/);
    expect(dialog).toMatch(/requestOpenAgents\(focus\)/);
    // In place, never a browser dialog (silent no-ops in the desktop app's WKWebView).
    const code = dialog.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/(^|[^\w.])(window\.)?(confirm|alert|prompt)\(/m);
  });

  it('an edit is the form it always was: no picker, prompt-gated, legacy shape', () => {
    expect(dialog).toMatch(/const pickable = !editing && !start\?\.whiteboard;/);
    expect(dialog).toMatch(/const bound = pickable && choice !== OWN_AGENT;/);
  });
});

describe('the zero-state\'s on-call starter opens the Agents page in create mode (S2)', () => {
  const empty = read('components/automations/AutomationsEmptyState.tsx');

  it('calls requestOpenAgents({ create: true }) for the call starter, onStart for the rest', () => {
    expect(empty).toMatch(/s\.mode === 'call'\s*\?\s*requestOpenAgents\(\{ create: true \}\)\s*:\s*onStart\(/);
  });
});

describe('every face on this page is the agent\'s', () => {
  it('no member, popover, thread or chip face draws an automation\'s own slug any more', () => {
    for (const rel of [
      'components/agents/AgentMemberCard.tsx',
      'components/agents/AgentProfilePopover.tsx',
      'components/agents/AgentThreadPanel.tsx',
    ]) {
      const src = read(rel);
      expect(src, rel).toMatch(/agentFaceOf\(/);
      expect(src, rel).not.toMatch(/<AgentAvatar\s+slug=\{(summary|message|a)\.slug\}/);
    }
    const filters = read('components/agents/AgentsFeedFilters.tsx');
    expect(filters.match(/of=\{c\.face\?\.of\}/g)?.length).toBe(2);
    expect(read('components/agents/AgentsFeed.tsx')).toMatch(/face: agentFaceOf\(/);
  });

  it('the AI Team draws every face from the agent route under the agent slug', () => {
    for (const rel of ['components/aiteam/TeamRoster.tsx', 'components/aiteam/TeamConversation.tsx']) {
      const src = read(rel);
      expect(src, rel).toMatch(/<AgentAvatar of="agent" slug=\{(row|agent)\.slug\}|<AgentAvatar of="agent" slug=\{slug\}/);
      expect(src, rel).not.toMatch(/<AgentAvatar\s+slug=/);
    }
  });
});

describe('S3: agent is not a chat mode', () => {
  it('CHAT_MODES does not gain an agent entry', () => {
    const modes = read('lib/chatModes.ts');
    expect(modes).not.toMatch(/['"]agent['"]\s*[,:\]]/);
  });
});
