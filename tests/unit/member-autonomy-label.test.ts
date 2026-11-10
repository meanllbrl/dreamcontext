/**
 * A member's autonomy level, shown (owner 2026-11-10): a quiet "Autonomy: Balanced" label on the
 * member's stage head and in a member chat's composer, READ FROM THE MEMBER (the roster), never
 * from a chat's permission state. A member's chat no longer shows the permission control (its word
 * on the trigger, its row in the mode menu), because the member runs by its level; a plain chat
 * keeps both. The label is display only: it feeds no permission decision.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const WORDS: Record<string, string> = {
  'aiteam.autonomy.label': 'Autonomy: {level}',
  'aiteam.autonomy.ask': 'Ask',
  'aiteam.autonomy.balanced': 'Balanced',
  'aiteam.autonomy.free': 'Free',
  'aiteam.autonomy.ask.desc': 'Asks first.',
  'aiteam.autonomy.balanced.desc': 'Works on its own.',
  'aiteam.autonomy.free.desc': 'Decides alone.',
};
const roster = vi.hoisted(() => ({ list: undefined as undefined | Array<{ slug: string; autonomy?: string }> }));

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ t: (k: string) => WORDS[k] ?? k, locale: 'en', setLocale: () => {} }),
}));
vi.mock('../../dashboard/src/hooks/useAgents.js', () => ({
  useAgents: () => ({ data: roster.list }),
  findAgent: (list: Array<{ slug: string }> | undefined, slug: string) => list?.find((a) => a.slug === slug) ?? null,
}));
vi.mock('../../dashboard/src/components/agents/AgentIdentityDialog.js', () => ({ AgentIdentityDialog: () => null }));

const { MemberAutonomy } = await import('../../dashboard/src/components/aiteam/AutonomyChip.js');
const { ModeMenu } = await import('../../dashboard/src/components/sleepy/chat/ComposerMenus.js');

const html = (slug: string, variant: 'head' | 'composer' = 'head') => renderToStaticMarkup(createElement(MemberAutonomy, { slug, variant }));
const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf-8');

describe('the label shows the member\'s level', () => {
  it.each([['ask', 'Ask'], ['balanced', 'Balanced'], ['free', 'Free']])('%s reads "Autonomy: %s"', (level, word) => {
    roster.list = [{ slug: 'masa', autonomy: level }];
    const out = html('masa');
    expect(out).toContain(`data-level="${level}"`);
    expect(out).toContain(`Autonomy: ${word}`);
  });
  it('a member with no level on the roster reads Balanced (an older server)', () => {
    roster.list = [{ slug: 'masa' }];
    expect(html('masa')).toContain('Autonomy: Balanced');
  });
  it('draws nothing until the roster has the member (no guessed level)', () => {
    roster.list = undefined;
    expect(html('masa')).toBe('');
    roster.list = [{ slug: 'other', autonomy: 'free' }];
    expect(html('masa')).toBe('');
  });
  it('is the member\'s own value: a second member keeps its own level', () => {
    roster.list = [{ slug: 'a', autonomy: 'ask' }, { slug: 'b', autonomy: 'free' }];
    expect(html('a')).toContain('Autonomy: Ask');
    expect(html('b')).toContain('Autonomy: Free');
  });
  it('is a button that opens the Edit dialog (a click), in both places', () => {
    roster.list = [{ slug: 'masa', autonomy: 'ask' }];
    expect(html('masa', 'head')).toMatch(/^<button[^>]*aiteam-autonomy--head/);
    expect(html('masa', 'composer')).toMatch(/^<button[^>]*aiteam-autonomy--composer/);
  });
});

describe('the mode menu', () => {
  const menu = (hidePermission: boolean) => renderToStaticMarkup(createElement(ModeMenu, {
    mode: 'plain' as never, onModeChange: () => {}, agent: hidePermission ? 'masa' : '', permission: 'auto',
    onPermissionChange: () => {}, hidePermission, close: () => {},
  }));
  it('a plain chat keeps its Permission row', () => {
    expect(menu(false)).toContain('chat-cmp-permrow');
  });
  it('a member\'s chat offers no permission control of its own', () => {
    const out = menu(true);
    expect(out).not.toContain('chat-cmp-permrow');
    expect(out).not.toContain('chat-cmp-permnote');
  });
});

describe('the composer wiring', () => {
  const composer = read('dashboard/src/components/sleepy/chat/Composer.tsx');
  it('the member label comes from the roster\'s member, never from the chat\'s permission state', () => {
    expect(composer).toMatch(/const memberKnown = !!agentSummary;/);
    expect(composer).toMatch(/<MemberAutonomy slug=\{agent\} variant="composer" \/>/);
    expect(composer).not.toMatch(/MemberAutonomy[^\n]*permissionMode/);
  });
  it('the permission word stands only when there is no member label, and the menu hides its row for a member', () => {
    expect(composer).toMatch(/\{!memberLabel && <span className="chat-cmp-modeltrigger-effort">\{permissionMode\}<\/span>\}/);
    expect(composer).toMatch(/hidePermission=\{!!memberLabel\}/);
  });
  it('the label never feeds a permission decision: the chip file reads no permission state', () => {
    const chip = read('dashboard/src/components/aiteam/AutonomyChip.tsx');
    expect(chip).not.toMatch(/permissionMode|bypass|set_permission|levelPermission/);
  });
});

describe('the stage head', () => {
  it('mounts the label for the member, and the narrow head hides it with the model chip', () => {
    expect(read('dashboard/src/components/sleepy/super/MemberStage.tsx')).toMatch(/<MemberAutonomy slug=\{info\.slug\} variant="head" \/>/);
    expect(read('dashboard/src/components/sleepy/super/TaskStrip.css')).toMatch(/\.super-member-head \.aiteam-autonomy \{ display: none; \}/);
  });
});
