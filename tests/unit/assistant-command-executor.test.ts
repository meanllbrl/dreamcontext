/**
 * The notch's relay executor (`components/assistant/commandExecutor.ts`): a delegated verb goes to
 * the window the project is ALREADY open in (as one tab among several), else to the project's OWN
 * new window — never a chip in somebody else's window — and when even that window cannot be built
 * the answer is `ceiling`.
 *
 * Owner 2026-09-28: "yeni pencere açıp o pencerede soru sormasın … var olana bağlanıp orada soru
 * sorsun." The browser registry is a localStorage heartbeat that goes stale when macOS throttles a
 * background window; the server's live-instance list is what decides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const desktop = vi.hoisted(() => ({
  openVaultWindow: vi.fn(async (_vault: string) => {}),
  sendDesktopNotification: vi.fn(async () => true),
  vaultWindowLabel: (vault: string) => `vault-${vault}`,
}));
const registry = vi.hoisted(() => ({ resolveLiveWindowForVault: vi.fn(async (_vault: string): Promise<string | null> => null) }));
const events = vi.hoisted(() => ({ emitTo: vi.fn(async () => {}) }));
const webview = vi.hoisted(() => ({ alive: ['main', 'vault-acme', 'assistant'] as string[] }));
const server = vi.hoisted(() => ({ labels: [] as string[], refuse: new Set<string>() }));

vi.mock('../../dashboard/src/lib/desktop', () => desktop);
vi.mock('../../dashboard/src/lib/windowRegistry', () => registry);
vi.mock('../../dashboard/src/lib/assistantBridge', () => ({ ASSISTANT_COMMAND_EVENT: 'dream://assistant-command', ASSISTANT_WAKE_EVENT: 'dream://assistant-wake' }));
vi.mock('../../dashboard/node_modules/@tauri-apps/api/webviewWindow.js', () => ({
  WebviewWindow: { getAll: async () => webview.alive.map((label) => ({ label })) },
}));
vi.mock('../../dashboard/src/components/assistant/tile', () => ({ tileWindows: vi.fn() }));
vi.mock('../../dashboard/node_modules/@tauri-apps/api/event.js', () => events);

const { executeAssistantCommand } = await import('../../dashboard/src/components/assistant/commandExecutor');

const binds: Array<{ id: string; vault: string; label: string }> = [];
beforeEach(() => {
  vi.clearAllMocks();
  binds.length = 0;
  registry.resolveLiveWindowForVault.mockResolvedValue(null);
  desktop.openVaultWindow.mockResolvedValue(undefined);
  webview.alive = ['main', 'vault-acme', 'assistant'];
  server.labels = [];
  server.refuse = new Set();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body: string }) => {
    if (url.startsWith('/api/assistant/windows?')) {
      return { ok: true, json: async () => ({ labels: server.labels }) } as unknown as Response;
    }
    const id = url.split('/')[4];
    const body = JSON.parse(init!.body) as { vault: string; label: string };
    binds.push({ id, ...body });
    return { ok: !server.refuse.has(body.label) } as Response;
  }));
});

const rang = () => events.emitTo.mock.calls as unknown as Array<[string, string, unknown]>;

describe('delegated verbs (notch → project window)', () => {
  it('a project live as a tab in a window: binds to THAT label and rings it, no new window', async () => {
    server.labels = ['main'];
    registry.resolveLiveWindowForVault.mockResolvedValue('main');
    const out = await executeAssistantCommand({ id: 'c1', verb: 'send', args: { vault: 'acme', sessionId: 's', text: 'hi' } });
    expect(out).toBeNull();
    expect(desktop.openVaultWindow).not.toHaveBeenCalled();
    expect(binds).toEqual([{ id: 'c1', vault: 'acme', label: 'main' }]);
    expect(rang()).toEqual([['main', 'dream://assistant-command', { commandId: 'c1', vault: 'acme' }]]);
  });

  it('THE OWNER\'S BUG: the browser registry went stale (throttled background window) — the server still names the tab\'s window, no second window is built', async () => {
    server.labels = ['main'];
    registry.resolveLiveWindowForVault.mockResolvedValue(null);
    const out = await executeAssistantCommand({ id: 'c6', verb: 'chat', args: { vault: 'acme', prompt: 'bu hafta ne yapacağız' } });
    expect(out).toBeNull();
    expect(desktop.openVaultWindow).not.toHaveBeenCalled();
    expect(binds).toEqual([{ id: 'c6', vault: 'acme', label: 'main' }]);
    expect(rang()).toEqual([['main', 'dream://assistant-command', { commandId: 'c6', vault: 'acme' }]]);
  });

  it('a label the server lists but whose window is gone is skipped', async () => {
    server.labels = ['dead', 'main'];
    webview.alive = ['main', 'assistant'];
    await executeAssistantCommand({ id: 'c7', verb: 'focus', args: { vault: 'acme' } });
    expect(binds.map((b) => b.label)).toEqual(['main']);
    expect(desktop.openVaultWindow).not.toHaveBeenCalled();
  });

  it('a COLD tab (the window lists it, no live instance): woken in place, then rung there — no new window', async () => {
    registry.resolveLiveWindowForVault.mockResolvedValue('main');
    server.labels = [];
    const out = await executeAssistantCommand({ id: 'c8', verb: 'chat', args: { vault: 'acme', prompt: 'go' } });
    expect(out).toBeNull();
    expect(desktop.openVaultWindow).not.toHaveBeenCalled();
    expect(rang()).toEqual([
      ['main', 'dream://assistant-wake', { vault: 'acme' }],
      ['main', 'dream://assistant-command', { commandId: 'c8', vault: 'acme' }],
    ]);
    expect(binds).toEqual([{ id: 'c8', vault: 'acme', label: 'main' }]);
  });

  it('a project live nowhere: gets its OWN window, the command is bound to that window', async () => {
    const out = await executeAssistantCommand({ id: 'c2', verb: 'chat', args: { vault: 'acme', prompt: 'go' } });
    expect(out).toBeNull();
    expect(desktop.openVaultWindow).toHaveBeenCalledWith('acme');
    expect(binds).toEqual([{ id: 'c2', vault: 'acme', label: 'vault-acme' }]);
    expect(rang()).toEqual([['vault-acme', 'dream://assistant-command', { commandId: 'c2', vault: 'acme' }]]);
  });

  it('open with newWindow skips the live window and builds its own', async () => {
    registry.resolveLiveWindowForVault.mockResolvedValue('main');
    server.labels = ['main'];
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
