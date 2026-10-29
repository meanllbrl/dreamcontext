import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * "Attach files…" / "Attach folders…" always reach a picker (owner 2026-10-29: "file picking
 * mostly does not work"). The desktop app's own sheet (`pick_paths`) first; when AppKit refuses
 * it a panel, the separate-process picker (`POST /api/agent/pick-paths`). The browser dashboard
 * has only the latter — it used to get a typed-path `prompt()`, which is not a picker.
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../../dashboard/node_modules/@tauri-apps/api/core.js', () => ({ invoke }));

const { pickFiles, pickFolders, pickerError } = await import('../../dashboard/src/lib/desktop.js');

const fetchMock = vi.fn();
const reply = (status: number, body: unknown) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  invoke.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as { window?: unknown }).window;
});

describe('in the desktop app', () => {
  beforeEach(() => { (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} }; });

  it('uses its own sheet and never the separate process when the sheet answers', async () => {
    invoke.mockResolvedValue(['/Users/x/a.png']);
    expect(await pickFiles()).toEqual(['/Users/x/a.png']);
    expect(invoke).toHaveBeenCalledWith('pick_paths', { directory: false, multiple: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pickerError()).toBeNull();
  });

  it('a cancelled sheet is a cancel: no second picker opens', async () => {
    invoke.mockResolvedValue([]);
    expect(await pickFolders()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('when AppKit refuses a panel, the separate-process picker answers instead', async () => {
    invoke.mockRejectedValue('macOS did not return a file picker. Try again — if it keeps failing, restart dreamcontext.');
    fetchMock.mockReturnValue(reply(200, { paths: ['/Users/x/Proje'] }));
    expect(await pickFolders()).toEqual(['/Users/x/Proje']);
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/pick-paths', expect.objectContaining({ method: 'POST', body: JSON.stringify({ directory: true, multiple: true }) }));
    expect(pickerError()).toBeNull();
  });

  it('both refused: [] and a reason the composer shows', async () => {
    invoke.mockRejectedValue(new Error('nil panel'));
    fetchMock.mockReturnValue(reply(500, { error: 'picker_failed', message: 'osascript is gone' }));
    expect(await pickFiles()).toEqual([]);
    expect(pickerError()).toBe('osascript is gone');
  });
});

describe('in the browser dashboard', () => {
  beforeEach(() => { (globalThis as { window?: unknown }).window = { prompt: vi.fn(() => '/typed/path') }; });

  it('opens the separate-process picker, never a typed-path prompt', async () => {
    fetchMock.mockReturnValue(reply(200, { paths: ['/Users/x/a.pdf', '/Users/x/b.png'] }));
    expect(await pickFiles()).toEqual(['/Users/x/a.pdf', '/Users/x/b.png']);
    expect(invoke).not.toHaveBeenCalled();
    expect((globalThis as unknown as { window: { prompt: ReturnType<typeof vi.fn> } }).window.prompt).not.toHaveBeenCalled();
  });

  it('a refused route is [] with its reason', async () => {
    fetchMock.mockReturnValue(reply(403, { error: 'forbidden', message: 'Only this app\'s own window can open the file picker.' }));
    expect(await pickFolders()).toEqual([]);
    expect(pickerError()).toMatch(/own window/);
  });
});
