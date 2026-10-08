import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE UPDATE RELAUNCH QUITS THE APP; IT NEVER CLOSES THE NOTCH.
 *
 * Crash 2026-10-07: the relaunch's `closeAllWindows()` closed every window, the
 * Assistant notch among them. The notch is a tauri-nspanel panel, and closing it
 * makes WebKit remove a KVO observer AppKit no longer knows — an uncaught
 * exception that aborted the whole app. The shell now refuses to close the notch
 * (src/assistant.rs `refuses_close`), so closing windows is no longer a quit and
 * the relaunch asks the shell to exit instead (`quit_app`).
 */

const SHELL = join(__dirname, '../../desktop/src-tauri');

const { invoke, getAll } = vi.hoisted(() => ({ invoke: vi.fn(), getAll: vi.fn() }));

// The dashboard's own copies — the root package has no @tauri-apps dependency.
vi.mock('../../dashboard/node_modules/@tauri-apps/api/core.js', () => ({ invoke }));
vi.mock('../../dashboard/node_modules/@tauri-apps/api/webviewWindow.js', () => ({ WebviewWindow: { getAll } }));

const { quitApp, closeOrder, NOTCH_WINDOW_LABEL } = await import('../../dashboard/src/lib/desktop.js');

function fakeWindow(label: string, closed: string[]) {
  return { label, close: vi.fn(async () => { closed.push(label); }) };
}

describe('quitApp', () => {
  beforeEach(() => {
    invoke.mockReset();
    getAll.mockReset();
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('asks the shell to exit and closes no window', async () => {
    invoke.mockResolvedValue(undefined);
    await quitApp();
    expect(invoke).toHaveBeenCalledWith('quit_app');
    expect(getAll).not.toHaveBeenCalled();
  });

  it('on an older shell without quit_app, closes the notch only after every other window', async () => {
    invoke.mockRejectedValue(new Error('command quit_app not found'));
    const closed: string[] = [];
    getAll.mockResolvedValue([
      fakeWindow(NOTCH_WINDOW_LABEL, closed),
      fakeWindow('main', closed),
      fakeWindow('vault-acme-storefront', closed),
    ]);
    await quitApp();
    expect(closed).toEqual(['main', 'vault-acme-storefront', NOTCH_WINDOW_LABEL]);
  });

  it('does nothing outside the desktop shell', async () => {
    delete (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    await quitApp();
    expect(invoke).not.toHaveBeenCalled();
    expect(getAll).not.toHaveBeenCalled();
  });
});

describe('closeOrder', () => {
  it('puts the notch last and keeps every other window', () => {
    const { first, last } = closeOrder([{ label: 'assistant' }, { label: 'main' }, { label: 'inbox' }]);
    expect(first.map((w) => w.label)).toEqual(['main', 'inbox']);
    expect(last.map((w) => w.label)).toEqual(['assistant']);
  });
});

describe('the shell side of the contract', () => {
  const lib = readFileSync(join(SHELL, 'src/lib.rs'), 'utf8');
  const assistant = readFileSync(join(SHELL, 'src/assistant.rs'), 'utf8');

  it('the TS notch label is the Rust NOTCH_LABEL', () => {
    expect(assistant).toContain(`pub const NOTCH_LABEL: &str = "${NOTCH_WINDOW_LABEL}";`);
  });

  it('quit_app is registered, permitted and granted to the windows that relaunch', () => {
    expect(lib).toMatch(/generate_handler!\[[^\]]*\bquit_app,/);
    const perm = readFileSync(join(SHELL, 'permissions/quit-app.toml'), 'utf8');
    expect(perm).toContain('identifier = "allow-quit-app"');
    expect(perm).toContain('commands.allow = ["quit_app"]');
    const cap = JSON.parse(readFileSync(join(SHELL, 'capabilities/default.json'), 'utf8'));
    expect(cap.permissions).toContain('allow-quit-app');
  });

  it('every close request is routed through the notch guard', () => {
    expect(lib).toMatch(/WindowEvent::CloseRequested \{ api, \.\. \}[\s\S]{0,120}assistant::guard_close\(/);
  });
});
