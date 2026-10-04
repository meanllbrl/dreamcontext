/**
 * `close` at the project end of the relay (`useAssistantDoorbell.runVerb`): the window finds the
 * chat by its conversation id and closes its tab through the surface's one end-of-conversation
 * path (`closeChat` → `closeSessionById`). A chat that is gone answers a plain sentence, and a
 * close never pulls the window forward.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../dashboard/src/lib/agentPrompt', () => ({ preparePrompt: vi.fn() }));
vi.mock('../../dashboard/src/lib/assistantBridge', () => ({ listenForAssistantCommands: vi.fn(() => () => {}) }));
const win = vi.hoisted(() => ({ setFocus: vi.fn(async () => {}) }));
vi.mock('../../dashboard/node_modules/@tauri-apps/api/window.js', () => ({ getCurrentWindow: () => win }));

const { runVerb } = await import('../../dashboard/src/components/assistant/useAssistantDoorbell');

describe('a project closing one of its chats (runVerb close)', () => {
  let deps: Parameters<typeof runVerb>[0];
  let closeChat: ReturnType<typeof vi.fn<(claudeId: string) => boolean>>;
  beforeEach(() => {
    vi.clearAllMocks();
    closeChat = vi.fn(() => true);
    deps = {
      vault: 'acme',
      findChat: vi.fn((id: string) => (id === 'c-1' ? { claudeId: 'c-1' } as never : null)),
      openChat: vi.fn(() => ({ claudeId: 'new-1' }) as never),
      reveal: vi.fn(),
      openPage: vi.fn(),
      closeChat,
    };
  });

  it('found: closes it through closeChat and answers {sessionId, closed:true} — without focusing or revealing', async () => {
    const out = await runVerb(deps, 'close', { sessionId: 'c-1', vault: 'acme' });
    expect(out).toEqual({ ok: true, result: { sessionId: 'c-1', closed: true } });
    expect(closeChat).toHaveBeenCalledWith('c-1');
    expect(deps.reveal).not.toHaveBeenCalled();
    expect(win.setFocus).not.toHaveBeenCalled();
  });

  it('not open in this project: a plain sentence, nothing closed', async () => {
    const out = await runVerb(deps, 'close', { sessionId: 'gone', vault: 'acme' });
    expect(out).toEqual({ ok: false, error: 'that chat is not open in this project any more' });
    expect(closeChat).not.toHaveBeenCalled();
  });

  it('the live chat exists but no tab holds it (closeChat false): the same sentence', async () => {
    closeChat.mockReturnValue(false);
    const out = await runVerb(deps, 'close', { sessionId: 'c-1', vault: 'acme' });
    expect(out).toEqual({ ok: false, error: 'that chat is not open in this project any more' });
  });

  it('no session id: refused before anything is looked up', async () => {
    const out = await runVerb(deps, 'close', { vault: 'acme' });
    expect(out).toMatchObject({ ok: false });
    expect(deps.findChat).not.toHaveBeenCalled();
    expect(closeChat).not.toHaveBeenCalled();
  });
});
