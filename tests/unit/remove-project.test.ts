/**
 * "Remove from app…" on a project's right-click menu (owner 2026-11-03, option A only): the
 * question is asked in the app's own confirm (never `window.confirm`), a yes drops the registry
 * entry through `/launcher/unregister`, a no does nothing, and there is no delete anywhere.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirmRemoveProject, nextProjectAfterRemove } from '../../dashboard/src/lib/removeProject.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const t = (k: string) => ({
  'shell.drawer.removeTitle': 'Remove "{name}"?',
  'shell.drawer.removeBody': 'Stays at {path}',
  'shell.drawer.removeConfirm': 'Remove',
  'shell.drawer.removeCancel': 'Cancel',
} as Record<string, string>)[k] ?? k;

describe('confirmRemoveProject', () => {
  it('unregisters after a yes, naming the project and its folder in the question', async () => {
    const confirm = vi.fn(async () => true);
    const unregister = vi.fn(async () => ({ removed: true }));
    const out = await confirmRemoveProject('Acme', '/Users/x/acme', { confirm, unregister, t });
    expect(out).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Remove "Acme"?', body: 'Stays at /Users/x/acme', confirmLabel: 'Remove', cancelLabel: 'Cancel' });
    // Not a destructive alert: nothing on disk is touched.
    expect((confirm.mock.calls[0][0] as { destructive?: boolean }).destructive).toBeFalsy();
    expect(unregister).toHaveBeenCalledWith('Acme');
  });

  it('does nothing on a no', async () => {
    const unregister = vi.fn(async () => ({}));
    const out = await confirmRemoveProject('Acme', null, { confirm: async () => false, unregister, t });
    expect(out).toBe(false);
    expect(unregister).not.toHaveBeenCalled();
  });

  it('lets a failed unregister reach the caller (it is reported, never read as removed)', async () => {
    await expect(confirmRemoveProject('Acme', null, {
      confirm: async () => true, unregister: async () => { throw new Error('offline'); }, t,
    })).rejects.toThrow('offline');
  });
});

describe('nextProjectAfterRemove', () => {
  it('lands on the next project, then the one before, never the removed one', () => {
    expect(nextProjectAfterRemove(['a', 'b', 'c'], 'b')).toBe('c');
    expect(nextProjectAfterRemove(['a', 'b', 'c'], 'c')).toBe('b');
    expect(nextProjectAfterRemove(['a'], 'a')).toBeNull();
    expect(nextProjectAfterRemove(['a', 'b'], 'zz')).toBe('a');
  });
});

describe('the menu item', () => {
  const drawer = read('dashboard/src/components/layout/newshell/ChatDrawer.tsx');
  const chrome = read('dashboard/src/components/layout/WindowChrome.tsx');

  it('sits in the project menu behind a separator, outside the device shell', () => {
    const at = drawer.indexOf('data-testid="drawer-project-remove"');
    expect(at).toBeGreaterThan(-1);
    expect(drawer.lastIndexOf('ns-drawer-menu-sep', at)).toBeGreaterThan(drawer.indexOf("t('shell.drawer.closeProject')"));
    expect(chrome).toMatch(/deviceShell \? \{\} : \{ onRemoveProject:/);
  });

  it('lands only on a project this window can hold, and says so when it cannot', () => {
    expect(chrome).toMatch(/projectOrderRef\.current\.filter\(\(n\) => n === name \|\| !findWindowForVault\(n\)\)/);
    expect(chrome).toMatch(/if \(landed !== 'added' && landed !== 'focused-tab'\)/);
    expect(chrome).toMatch(/shell\.drawer\.removedStillOpen/);
  });

  it('asks through confirmAction and never window.confirm, and offers no delete', () => {
    const lib = read('dashboard/src/lib/removeProject.ts');
    expect(chrome).toMatch(/confirm: confirmAction/);
    expect(lib + drawer).not.toMatch(/window\.confirm\(/);
    expect(chrome).not.toMatch(/launcher\/trash/);
  });

  it('ships Turkish and English copy', () => {
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    expect(i18n).toContain("'shell.drawer.removeProject': 'Uygulamadan kaldır…'");
    expect(i18n).toContain("'shell.drawer.removeProject': 'Remove from app…'");
  });
});
