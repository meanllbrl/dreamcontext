/**
 * The notch's relay executor (`components/assistant/commandExecutor.ts`): a delegated verb goes to
 * the project's live window if it has one, else to the project's OWN new window — never a chip in
 * somebody else's window — and when even that window cannot be built the answer is `ceiling`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const desktop = vi.hoisted(() => ({
  openVaultWindow: vi.fn(async (_vault: string) => {}),
  sendDesktopNotification: vi.fn(async () => true),
  vaultWindowLabel: (vault: string) => `vault-${vault}`,
}));
const registry = vi.hoisted(() => ({ resolveLiveWindowForVault: vi.fn(async (_vault: string): Promise<string | null> => null) }));
const events = vi.hoisted(() => ({ emitTo: vi.fn(async () => {}) }));

vi.mock('../../dashboard/src/lib/desktop', () => desktop);
vi.mock('../../dashboard/src/lib/windowRegistry', () => registry);
vi.mock('../../dashboard/src/lib/assistantBridge', () => ({ ASSISTANT_COMMAND_EVENT: 'dream://assistant-command' }));
vi.mock('../../dashboard/src/components/assistant/tile', () => ({ tileWindows: vi.fn() }));
vi.mock('../../dashboard/node_modules/@tauri-apps/api/event.js', () => events);

const { executeAssistantCommand } = await import('../../dashboard/src/components/assistant/commandExecutor');

const binds: Array<{ id: string; vault: string; label: string }> = [];
beforeEach(() => {
  vi.clearAllMocks();
  binds.length = 0;
  registry.resolveLiveWindowForVault.mockResolvedValue(null);
  desktop.openVaultWindow.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    const id = url.split('/')[4];
    binds.push({ id, ...JSON.parse(init.body) });
    return { ok: true } as Response;
  }));
});

describe('delegated verbs (notch → project window)', () => {
  it('a project live in a window: binds to THAT label and rings it, no new window', async () => {
    registry.resolveLiveWindowForVault.mockResolvedValue('main');
    const out = await executeAssistantCommand({ id: 'c1', verb: 'send', args: { vault: 'acme', sessionId: 's', text: 'hi' } });
    expect(out).toBeNull();
    expect(desktop.openVaultWindow).not.toHaveBeenCalled();
    expect(binds).toEqual([{ id: 'c1', vault: 'acme', label: 'main' }]);
    expect(events.emitTo).toHaveBeenCalledWith('main', 'dream://assistant-command', { commandId: 'c1', vault: 'acme' });
  });

  it('a project live nowhere: gets its OWN window, the command is bound to that window', async () => {
    const out = await executeAssistantCommand({ id: 'c2', verb: 'chat', args: { vault: 'acme', prompt: 'go' } });
    expect(out).toBeNull();
    expect(desktop.openVaultWindow).toHaveBeenCalledWith('acme');
    expect(binds).toEqual([{ id: 'c2', vault: 'acme', label: 'vault-acme' }]);
    expect(events.emitTo).toHaveBeenCalledWith('vault-acme', 'dream://assistant-command', { commandId: 'c2', vault: 'acme' });
  });

  it('open with newWindow skips the live window and builds its own', async () => {
    registry.resolveLiveWindowForVault.mockResolvedValue('main');
    await executeAssistantCommand({ id: 'c3', verb: 'open', args: { vault: 'acme', newWindow: true } });
    expect(registry.resolveLiveWindowForVault).not.toHaveBeenCalled();
    expect(desktop.openVaultWindow).toHaveBeenCalledWith('acme');
  });

  it('the own window cannot be built → {error: ceiling}, nothing is bound or rung', async () => {
    desktop.openVaultWindow.mockRejectedValue(new Error('window limit reached'));
    const out = await executeAssistantCommand({ id: 'c4', verb: 'chat', args: { vault: 'acme', prompt: 'go' } });
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/^ceiling: .*acme.*window limit reached/) });
    expect(binds).toEqual([]);
    expect(events.emitTo).not.toHaveBeenCalled();
  });

  it('no project named → refused before anything opens', async () => {
    const out = await executeAssistantCommand({ id: 'c5', verb: 'focus', args: {} });
    expect(out).toEqual({ ok: false, error: 'no project named' });
    expect(desktop.openVaultWindow).not.toHaveBeenCalled();
  });
});
