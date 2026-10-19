/**
 * Wave 5, lane W5-B: the follow-ups the wave 4b builders reported. The strings their fallbacks
 * stood in for (English and Turkish), the feed's agent list typed with the agent that runs each
 * automation, the `AgentDraft` alias gone, a feed message wearing its AGENT's face, and a board's
 * "New agent" opening the create dialog with that board preset as the home board.
 *
 * Root vitest is plain Node with no DOM, so components are pinned by reading their source; the
 * pure helpers (`readOpenAgentsDetail`, `focusIntent`, `createForm`) are driven directly.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../dashboard/src/context/VaultContext', () => ({
  useApi: () => null,
  useVault: () => ({ vault: null, instanceId: 'test', isActive: true, bus: new EventTarget() }),
  useInstanceEvent: () => undefined,
  emitInstance: () => undefined,
}));

import { readOpenAgentsDetail } from '../../dashboard/src/lib/openAgents';
import type { AgentFeed } from '../../dashboard/src/hooks/useAutomations';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

/** The source with its comments taken out, so a pin cannot pass on a comment. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const I18N = read('dashboard/src/context/I18nContext.tsx');
const TR_START = I18N.indexOf('const TR_PARTIAL');
const EN_BLOCK = I18N.slice(0, TR_START);
const TR_BLOCK = I18N.slice(TR_START, I18N.indexOf('const PARTIALS'));

/** The value a strings block gives `key`, or null when it has none. */
function valueIn(block: string, key: string): string | null {
  const esc = key.replace(/\./g, '\\.');
  const m = block.match(new RegExp(`'${esc}':\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`));
  return m ? (m[1] ?? m[2]).replace(/\\'/g, "'") : null;
}

const W5_KEYS = [
  'agents.identity.photoType',
  'agents.profile.missing',
  'agents.profile.callSettingNone',
  'agents.profile.flowSet',
  'automations.pickAgentOwn',
  'automations.new',
  'tasks.assignWhatHappens',
  'tasks.assignUnknownAgent',
  'tasks.assignUnknownTask',
  'tasks.assignTryAgain',
  'tasks.assignLoading',
  'tasks.assignReviewLoading',
  'tasks.assignReviewFailed',
  'tasks.unassignAgentFailed',
] as const;

describe('the wave 4 fallback strings now have keys', () => {
  it('every key is in English and in Turkish, and the Turkish is not the English', () => {
    for (const key of W5_KEYS) {
      const en = valueIn(EN_BLOCK, key);
      const tr = valueIn(TR_BLOCK, key);
      expect(en, `${key} (en)`).toBeTruthy();
      expect(tr, `${key} (tr)`).toBeTruthy();
      expect(tr, `${key} is translated`).not.toBe(en);
    }
  });

  it('the English is the text the call site already falls back to', () => {
    const sites = [
      'dashboard/src/components/agents/AgentIdentityDialog.tsx',
      'dashboard/src/components/agents/AgentProfilePanel.tsx',
      'dashboard/src/components/agents/AutomationDialog.tsx',
      'dashboard/src/pages/AutomationsPage.tsx',
      'dashboard/src/components/tasks/AssignToAgentComposer.tsx',
      'dashboard/src/components/tasks/TaskDetailPanel.tsx',
      'dashboard/src/lib/assignToAgent.ts',
    ].map(read).join('\n').replace(/\s+/g, ' ');
    for (const key of W5_KEYS) {
      const en = valueIn(EN_BLOCK, key)!;
      expect(sites.includes(`'${en}'`) || sites.includes(`"${en}"`), `${key}: "${en}"`).toBe(true);
    }
  });

  it('keeps placeholders in both languages and no em dash in the copy', () => {
    for (const key of W5_KEYS) {
      const en = valueIn(EN_BLOCK, key)!;
      const tr = valueIn(TR_BLOCK, key)!;
      for (const ph of en.match(/\{\w+\}/g) ?? []) expect(tr, `${key} keeps ${ph}`).toContain(ph);
      expect(en + tr, key).not.toMatch(/—/);
    }
  });

  it('no agent, automation or task call site still reads a key the strings file lacks', () => {
    const files = [
      'dashboard/src/components/agents/AgentIdentityDialog.tsx',
      'dashboard/src/components/agents/AgentProfilePanel.tsx',
      'dashboard/src/components/agents/AutomationDialog.tsx',
      'dashboard/src/components/tasks/AssignToAgentComposer.tsx',
      'dashboard/src/components/tasks/TaskDetailPanel.tsx',
      'dashboard/src/lib/assignToAgent.ts',
    ];
    for (const f of files) {
      for (const [, key] of code(read(f)).matchAll(/'((?:agents|automations|tasks)\.[A-Za-z.]+)'/g)) {
        expect(valueIn(EN_BLOCK, key), `${f}: ${key}`).not.toBeNull();
      }
    }
  });
});

describe('useAutomations: the feed agent list and no AgentDraft', () => {
  it('types the agent that runs each automation on the feed agent list', () => {
    const row: AgentFeed['agents'][number] = {
      slug: 'morning-scout', title: 'Morning scout', agent: 'scout', agentTitle: 'Scout', hasPhoto: false,
    };
    const older: AgentFeed['agents'][number] = { slug: 'digest', title: 'Digest', hasPhoto: true };
    expect(row.agent).toBe('scout');
    expect(older.agent).toBeUndefined();
  });

  it('the AgentDraft alias is gone from the dashboard and its tests', () => {
    const src = read('dashboard/src/hooks/useAutomations.ts');
    expect(code(src)).not.toMatch(/\bAgentDraft\b/);
    expect(code(read('tests/unit/agents-dashboard-data.test.ts'))).not.toMatch(/\bAgentDraft\b/);
  });
});

describe('a feed message wears its agent\'s face', () => {
  const src = code(read('dashboard/src/components/agents/AgentMessage.tsx'));

  it('derives the face with agentFaceOf from AgentMemberCard', () => {
    expect(src).toMatch(/import \{ agentFaceOf \} from '\.\/AgentMemberCard';/);
    expect(src).toMatch(/const face = agentFaceOf\(message\);/);
  });

  it('every avatar names the face and passes of={face.of}', () => {
    const avatars = [...src.matchAll(/<AgentAvatar\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(avatars.length).toBeGreaterThanOrEqual(3);
    for (const a of avatars) {
      expect(a).toMatch(/slug=\{face\.slug\}/);
      expect(a).toMatch(/title=\{face\.title\}/);
      expect(a).toMatch(/of=\{face\.of\}/);
    }
  });

  it('the shown names are the agent\'s, while a click still opens the automation', () => {
    expect(src).toMatch(/<span className="agent-reply-preview-name">\{face\.title\}<\/span>/);
    expect(src).toMatch(/<span className="agent-msg-name agent-msg-name--plain">\{face\.title\}<\/span>/);
    expect(src).toMatch(/onClick=\{\(\) => onOpenAgent\(message\.slug\)\}>\s*\{face\.title\}/);
    expect(src).not.toMatch(/>\s*\{message\.title\}\s*</);
  });
});

describe('New agent on a board presets that board as home', () => {
  it('keeps a board slug only alongside create, and only in the shape the server accepts', () => {
    expect(readOpenAgentsDetail({ create: true, whiteboard: 'growth-board' })).toEqual({ create: true, whiteboard: 'growth-board' });
    expect(readOpenAgentsDetail({ whiteboard: 'growth-board' })).toEqual({});
    expect(readOpenAgentsDetail({ slug: 'scout', whiteboard: 'growth-board' })).toEqual({ slug: 'scout' });
    expect(readOpenAgentsDetail({ create: true, whiteboard: '../x' })).toEqual({ create: true });
    expect(readOpenAgentsDetail({ create: true, whiteboard: 'Growth' })).toEqual({ create: true });
    expect(readOpenAgentsDetail({ create: true, whiteboard: 'a'.repeat(65) })).toEqual({ create: true });
    expect(readOpenAgentsDetail({ create: true, whiteboard: 7 })).toEqual({ create: true });
  });

  it('the page carries the board into the create intent, and nowhere else', async () => {
    const { focusIntent } = await import('../../dashboard/src/pages/AgentsPage');
    expect(focusIntent({ create: true, whiteboard: 'growth-board', nonce: 1 }))
      .toEqual({ select: null, create: true, whiteboard: 'growth-board' });
    expect(focusIntent({ create: true, nonce: 2 })).toEqual({ select: null, create: true, whiteboard: null });
  });

  it('the dialog starts a new agent on that board, and a plain create stays blank', async () => {
    const { createForm, EMPTY_IDENTITY_FORM } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    expect(createForm('growth-board')).toEqual({ ...EMPTY_IDENTITY_FORM, whiteboard: 'growth-board' });
    expect(createForm()).toEqual(EMPTY_IDENTITY_FORM);
    expect(createForm(null)).toEqual(EMPTY_IDENTITY_FORM);
  });

  it('wires the board from the canvas, through the page, into the dialog', () => {
    const canvas = code(read('dashboard/src/components/whiteboard/WhiteboardCanvas.tsx'));
    expect(canvas).toMatch(/requestOpenAgents\(\{ create: true, whiteboard: boardSlug \}\)/);
    const page = code(read('dashboard/src/pages/AgentsPage.tsx'));
    expect(page).toMatch(/<AgentIdentityDialog slug=\{dialog\.slug\} whiteboard=\{dialog\.whiteboard\}/);
    const dialog = code(read('dashboard/src/components/agents/AgentIdentityDialog.tsx'));
    expect(dialog).toMatch(/useState<IdentityForm>\(\(\) => \(editing \? EMPTY_IDENTITY_FORM : createForm\(whiteboard\)\)\)/);
  });
});
