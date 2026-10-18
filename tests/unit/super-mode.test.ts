/**
 * The Super Agent is a chat MODE that only the Chat header's hand-over button starts
 * (task chat-gets-a-super-agent-mode…, plan-r7 D1). So:
 *  - the server accepts it, briefs it under its own heading, and reads that heading back;
 *  - no picker offers it, and it never gets a mid-conversation mode-switch note;
 *  - every path that lets an AGENT spawn or re-mode a chat keeps its own basic/plan/develop
 *    list, so no agent can open a second super chat or turn a chat into one (AC1).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_MODES, NON_PICKER_MODES, PICKER_MODES, SUPER_MODE_HEADING, modeBriefing } from '../../src/server/chat-modes.js';
import { modeFromSystemPrompt, modeNoteSources } from '../../src/server/chat-mode-drift.js';
import { sanitizeChatMode } from '../../src/server/routes/agent-spawn-shared.js';
import { pickWindowArgs } from '../../src/server/routes/window-control.js';
import { runWindowVerb, type WindowVerbDeps } from '../../dashboard/src/components/sleepy/windowVerbs';
import { CHAT_MODE_ROWS } from '../../dashboard/src/lib/chatModes.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('super is a chat mode the picker never offers', () => {
  it('is a server mode, outside the picker on both sides', () => {
    expect(CHAT_MODES as readonly string[]).toContain('super');
    expect(NON_PICKER_MODES as readonly string[]).toEqual(['assistant', 'super']);
    expect(PICKER_MODES as readonly string[]).not.toContain('super');
    expect(CHAT_MODE_ROWS.map((r) => r.id as string)).not.toContain('super');
  });

  it('is briefed under its own heading, and that heading reads back as super', () => {
    const brief = modeBriefing('super', { worktreeAllowed: true });
    expect(brief.startsWith(`${SUPER_MODE_HEADING}\n`)).toBe(true);
    expect(brief).toBe(modeBriefing('super', { worktreeAllowed: false }));
    expect(modeFromSystemPrompt(`# Surface: dreamcontext Chat\n\n${brief}`)).toBe('super');
  });

  it('never gets a mode-switch note, and a conversation born as super is never re-briefed', () => {
    expect(modeNoteSources({ snapshot: 'basic', held: 'basic' }, 'super')).toEqual([]);
    expect(modeNoteSources({ snapshot: 'super', held: 'super' }, 'develop')).toEqual([]);
    expect(modeNoteSources({ snapshot: 'basic', held: 'basic' }, 'develop')).toEqual(['resume', 'compact']);
  });

  it('the chat upgrade keeps it (the one-per-vault rule is the upgrade handler\'s, not the sanitizer\'s)', () => {
    expect(sanitizeChatMode('super', 'acme-app')).toBe('super');
    expect(sanitizeChatMode('Super', 'acme-app')).toBe('basic');
    // The Assistant's hidden vault is bound to the Assistant whatever is asked.
    expect(sanitizeChatMode('super', '__assistant__')).toBe('assistant');
  });

  it('a saved super tab stays super on the client (never degrades to a Basic tab)', () => {
    const src = read('dashboard/src/components/sleepy/AgentSurface.tsx');
    const fn = src.slice(src.indexOf('function knownChatMode('), src.indexOf('function quoteIfNeeded('));
    expect(fn).toMatch(/if \(v === 'super'\) return 'super';/);
  });
});

describe('no agent-facing spawn path accepts super (AC1)', () => {
  it('`window new` and `window mode` refuse it on the server', () => {
    expect(pickWindowArgs('new', { mode: 'super' })).toMatch(/mode must be one of basic \| plan \| develop/);
    expect(pickWindowArgs('mode', { mode: 'super' })).toMatch(/mode must be one of basic \| plan \| develop/);
  });

  it('the window refuses it too: `new` opens Basic, `mode` is an error', async () => {
    const deps: WindowVerbDeps = {
      self: 'a',
      panes: [{ id: 'p1', tabs: ['a'], active: 'a' }],
      activePaneId: 'p1',
      tabs: [{ sid: 'a', tab: 'conv-a', title: 'a', kind: 'chat', mode: 'basic', busy: false, asking: false, dormant: false }],
      openNew: vi.fn(async () => 'conv-new'),
      split: vi.fn(), join: vi.fn(), focus: vi.fn(),
      setMode: vi.fn(() => 'now' as const),
      setModel: vi.fn(() => true), setEffort: vi.fn(() => true),
      send: vi.fn(() => 'sent' as const), close: vi.fn(),
    };
    await runWindowVerb(deps, 'new', { mode: 'super', prompt: 'x' });
    expect(deps.openNew).toHaveBeenCalledWith(expect.objectContaining({ mode: 'basic' }));
    const r = await runWindowVerb(deps, 'mode', { mode: 'super' });
    expect(r.ok).toBe(false);
    expect(deps.setMode).not.toHaveBeenCalled();
  });

  it('the Assistant\'s `chat` (server, notch doorbell, CLI) stays basic/plan/develop', () => {
    const route = read('src/server/routes/assistant.ts');
    const chatCase = route.slice(route.indexOf("case 'chat': {"), route.indexOf("case 'send': {"));
    expect(chatCase).toMatch(/\['basic', 'plan', 'develop'\]\.includes\(/);
    expect(chatCase).not.toMatch(/super/);
    const doorbell = read('dashboard/src/components/assistant/useAssistantDoorbell.ts');
    expect(doorbell).toMatch(/args\.mode === 'plan' \|\| args\.mode === 'develop' \? args\.mode : 'basic'/);
    for (const cli of ['src/cli/commands/assistant.ts', 'src/cli/commands/window.ts']) {
      expect(read(cli), cli).not.toMatch(/super/);
    }
  });

  it('the window-control mode lists name exactly basic, plan and develop', () => {
    expect(read('src/server/routes/window-control.ts')).toMatch(/const MODES = \['basic', 'plan', 'develop'\] as const;/);
    expect(read('dashboard/src/components/sleepy/windowVerbs.ts')).toMatch(/const MODES: readonly ChatMode\[\] = \['basic', 'plan', 'develop'\];/);
  });
});
