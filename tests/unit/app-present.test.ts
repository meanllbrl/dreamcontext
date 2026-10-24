import { describe, it, expect } from 'vitest';
import { desktopAppPresent, type AppManifest } from '../../src/cli/commands/app.js';

const manifest: AppManifest = { version: '0.31.0', path: 'C:\\app\\dreamcontext-beta.exe', installedAt: 1, source: 'local' };
const never = () => false;
const always = () => true;

describe('desktopAppPresent', () => {
  it('is false with no manifest, on every platform', () => {
    expect(desktopAppPresent(null, 'darwin', always)).toBe(false);
    expect(desktopAppPresent(null, 'win32', always)).toBe(false);
  });

  it('macOS: any manifest counts, even when its path is missing', () => {
    expect(desktopAppPresent(manifest, 'darwin', never)).toBe(true);
  });

  it('Windows: a manifest whose exe exists counts', () => {
    expect(desktopAppPresent(manifest, 'win32', always)).toBe(true);
  });

  it('Windows: a manifest whose exe is gone (uninstalled) does not', () => {
    expect(desktopAppPresent(manifest, 'win32', never)).toBe(false);
  });

  it('Windows: checks the manifest path itself', () => {
    const seen: string[] = [];
    desktopAppPresent(manifest, 'win32', (p) => { seen.push(p); return true; });
    expect(seen).toEqual([manifest.path]);
  });
});
