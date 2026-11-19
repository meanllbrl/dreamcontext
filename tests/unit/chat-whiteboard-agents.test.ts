/**
 * Wave 4b, lane T9: Chat and the whiteboard read ONE roster, the agents (`/api/agents`), and
 * "Talk to it" lands in Chat as a new conversation with that agent (S3, S1).
 *
 * The React surfaces are dashboard TSX that root vitest cannot mount (plain Node, no DOM), so they are pinned by a
 * source scan with comments stripped (prose explaining a rule never satisfies it); what renders
 * is `scripts/verify/chat-agent-picker.mjs` and `whiteboard-agent*.mjs`'s job.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_MODES } from '../../src/server/chat-modes.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');
/** Source with comments removed, so prose explaining a rule never satisfies the rule. */
const code = (p: string): string =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const D = 'dashboard/src/components';
const FILES = {
  menus: `${D}/sleepy/chat/ComposerMenus.tsx`,
  composer: `${D}/sleepy/chat/Composer.tsx`,
  surface: `${D}/sleepy/AgentSurface.tsx`,
  pickers: `${D}/whiteboard/WidgetPickers.tsx`,
  widget: `${D}/whiteboard/widgets/AgentWidget.tsx`,
  canvas: `${D}/whiteboard/WhiteboardCanvas.tsx`,
  page: 'dashboard/src/pages/WhiteboardsPage.tsx',
};


describe('Chat and the whiteboard read /api/agents, never the automations list (S3)', () => {
  it('no surface of this lane reads useAutomations any more', () => {
    for (const [name, path] of Object.entries(FILES)) {
      expect(code(path), name).not.toMatch(/\buseAutomations\b|\bAutomationSummary\b/);
    }
  });

  it('every surface that lists agents reads useAgents', () => {
    for (const path of [FILES.menus, FILES.composer, FILES.pickers, FILES.widget]) {
      expect(code(path), path).toMatch(/\buseAgents\(/);
    }
  });

  it('conversation asks the CHAT verdict, never the old automation approval', () => {
    for (const path of [FILES.menus, FILES.pickers, FILES.widget]) {
      const src = code(path);
      expect(src, path).toMatch(/approvedForChat/);
      expect(src, path).not.toMatch(/\.approved\b(?!For)/);
      expect(src, path).not.toMatch(/approvedToRun/);
    }
  });

  it('every face in Chat and on the board is the agent route\'s', () => {
    for (const path of [FILES.menus, FILES.pickers, FILES.widget]) {
      const avatars = code(path).match(/<AgentAvatar\b[^>]*\/>/g) ?? [];
      expect(avatars.length, path).toBeGreaterThan(0);
      for (const a of avatars) expect(a, path).toMatch(/of="agent"/);
    }
  });

  it('an unapproved agent offers its Agents page, never an approve command or the Automations page', () => {
    for (const path of [FILES.menus, FILES.pickers, FILES.widget]) {
      const src = code(path);
      expect(src, path).toMatch(/requestOpenAgents\(\{\s*slug/);
      expect(src, path).not.toMatch(/kind:\s*'automation'/);
      expect(src, path).not.toMatch(/Approve it in Automations/);
      expect(src, path).not.toMatch(/useApproveAgent/);
    }
  });

  it('the chat picker no longer disables the unapproved row; it routes it to the Agents page', () => {
    const src = code(FILES.menus);
    expect(src).not.toMatch(/disabled:\s*!a\./);
    expect(src).toMatch(/if \(slug && opts\.unapproved\) openOnAgentsPage\(slug\)/);
    expect(src).toMatch(/agents\.picker\.unapproved/);
    expect(src).toMatch(/agents\.picker\.manage/);
  });

  it('the board makes no agent of its own: New agent and Edit go to the Agents page', () => {
    expect(code(FILES.canvas)).not.toMatch(/AgentDialog/);
    // The create flow is the Agents page's; the board only presets itself as the new agent's home.
    expect(code(FILES.canvas)).toMatch(/requestOpenAgents\(\{\s*create:\s*true,\s*whiteboard:\s*boardSlug\s*\}\)/);
    expect(code(FILES.widget)).not.toMatch(/AgentDialog|whiteboard\.agent\.edit/);
  });
});

describe('Talk to it lands in Chat as a new conversation (S1), never as a chat mode (S3)', () => {
  const src = code(FILES.surface);
  const listener = src.slice(src.indexOf('useInstanceEvent<TalkToAgentDetail>(TALK_TO_AGENT_EVENT'));
  // The listener's own close (`  });` at its indent), not the first `});` inside it: the body's
  // `setTalkRequest({ … });` ends in the same three characters.
  const handler = listener.slice(0, listener.indexOf('\n  });'));

  it('AgentSurface listens on its own bus and ACKs in the listener', () => {
    expect(src).toMatch(/import \{ TALK_TO_AGENT_EVENT, type TalkToAgentDetail \} from '\.\.\/\.\.\/lib\/talkToAgent'/);
    expect(handler).toMatch(/setTalkRequest\(\{ slug: detail\.slug, since: Date\.now\(\) \}\);/);
    expect(handler).toMatch(/detail\.accepted = true;/);
    // The ACK is written synchronously, before any await or timer could defer it.
    expect(handler).not.toMatch(/await|setTimeout|then\(/);
    // Only a surface already known unable to start Claude refuses, so the sender can say so:
    // that return comes BEFORE the ACK, so the off path never reaches it.
    const refuse = handler.indexOf('caps !== null && settingsReady && !canSpawn) return;');
    const ack = handler.indexOf('detail.accepted = true;');
    expect(refuse).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(refuse);
    // The ACK is the listener's last statement: nothing after it can un-set or defer it.
    expect(handler.slice(ack + 'detail.accepted = true;'.length).trim()).toBe('');
  });

  it('it opens a NEW chat bound to the agent, through the same binding the composer pick uses', () => {
    const open = src.slice(src.indexOf('const openAgentChat = useCallback'), src.indexOf('}, [canSpawn, spawn, panes, activePaneId]);'));
    expect(open).toMatch(/const claudeId = newClaudeId\(\);/);
    expect(open).toMatch(/bindChatAgent\(claudeId, slug\);/);
    expect(open).toMatch(/spawn\(false, claudeId, false, 'chat'\)/);
    expect(open).toMatch(/agent: slug/);
    expect(open).toMatch(/setExpanded\(true\)/);
    // No chat mode is named: the agent is who it talks to, the mode stays the project default.
    expect(open).not.toMatch(/mode:/);
  });

  it('`agent` is not a chat mode', () => {
    expect(CHAT_MODES as readonly string[]).not.toContain('agent');
  });
});
