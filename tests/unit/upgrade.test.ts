import { describe, it, expect, vi } from 'vitest';
import { runUpgrade } from '../../src/cli/commands/upgrade.js';

describe('runUpgrade --check', () => {
  it('does NOT call the installer when --check is true', () => {
    const installer = vi.fn();
    const latestVersion = () => '9.9.9';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      runUpgrade(true, { installer, latestVersion });
      expect(installer).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('prints current and latest version when --check is true and latest is known', () => {
    const installer = vi.fn();
    const latestVersion = () => '9.9.9';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      runUpgrade(true, { installer, latestVersion });
      // Should have printed something containing version info
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      // Must include the injected latest version
      expect(output).toContain('9.9.9');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('prints offline message when --check is true and latest is null', () => {
    const installer = vi.fn();
    const latestVersion = () => null;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      runUpgrade(true, { installer, latestVersion });
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output.toLowerCase()).toContain('unknown');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('calls the installer when check is false (default install mode)', async () => {
    const installer = vi.fn();
    const latestVersion = () => '9.9.9';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // runUpgrade is async; await it and inject no-op vault/app deps so the
      // cascade tail (app + per-project refresh) is deterministic and never
      // touches live machine state during the test.
      await runUpgrade(false, {
        installer,
        latestVersion,
        appInstalledCheck: () => false,
        vaultLister: () => [],
      });
      expect(installer).toHaveBeenCalledOnce();
      expect(installer).toHaveBeenCalledWith(['install', '-g', 'dreamcontext@latest']);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('T12: liveLatest takes precedence over latestVersion (live wins)', () => {
    const installer = vi.fn();
    const liveLatest = () => '9.9.9';
    const latestVersion = () => '1.0.0';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      runUpgrade(true, { installer, liveLatest, latestVersion });
      expect(installer).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('9.9.9');
      expect(output).not.toContain('1.0.0');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('T13: liveLatest returning null is used as-is → "unknown" (no fall-through)', () => {
    const installer = vi.fn();
    const liveLatest = () => null;
    // latestVersion present but MUST NOT be consulted (source-fn, not value, selection)
    const latestVersion = vi.fn(() => '1.0.0');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      runUpgrade(true, { installer, liveLatest, latestVersion });
      expect(installer).not.toHaveBeenCalled();
      expect(latestVersion).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output.toLowerCase()).toContain('unknown');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('runUpgrade — one command refreshes app + every project', () => {
  const installer = () => {};
  const silence = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  it('with --yes: updates the desktop app (if installed) then every registered project, in order', async () => {
    const spy = silence();
    const order: string[] = [];
    try {
      await runUpgrade(false, {
        installer,
        yes: true,
        appInstalledCheck: () => true,
        appUpdater: () => { order.push('app'); return { ok: true }; },
        vaultLister: () => [
          { name: 'alpha', path: '/tmp/alpha' },
          { name: 'beta', path: '/tmp/beta' },
        ],
        projectUpdater: (v) => { order.push(v.name); return { vault: v, ok: true }; },
      });
    } finally {
      spy.mockRestore();
    }
    expect(order).toEqual(['app', 'alpha', 'beta']);
  });

  it('does not touch the app updater when the app is not installed', async () => {
    const spy = silence();
    let appCalled = false;
    try {
      await runUpgrade(false, {
        installer,
        yes: true,
        appInstalledCheck: () => false,
        appUpdater: () => { appCalled = true; return { ok: true }; },
        vaultLister: () => [],
      });
    } finally {
      spy.mockRestore();
    }
    expect(appCalled).toBe(false);
  });

  it('non-interactive without --yes refreshes nothing (hint only, no spawns)', async () => {
    const spy = silence();
    let projCalled = false;
    let appCalled = false;
    try {
      await runUpgrade(false, {
        installer,
        // no `yes`, no `confirmAll` injected, and vitest stdin is not a TTY
        appInstalledCheck: () => true,
        appUpdater: () => { appCalled = true; return { ok: true }; },
        vaultLister: () => [{ name: 'alpha', path: '/tmp/alpha' }],
        projectUpdater: (v) => { projCalled = true; return { vault: v, ok: true }; },
      });
    } finally {
      spy.mockRestore();
    }
    expect(appCalled).toBe(false);
    expect(projCalled).toBe(false);
  });

  it('declining the project prompt refreshes nothing', async () => {
    const spy = silence();
    let projCalled = false;
    try {
      await runUpgrade(false, {
        installer,
        appInstalledCheck: () => false,
        vaultLister: () => [{ name: 'alpha', path: '/tmp/alpha' }],
        projectUpdater: (v) => { projCalled = true; return { vault: v, ok: true }; },
        confirmAll: async () => false,
      });
    } finally {
      spy.mockRestore();
    }
    expect(projCalled).toBe(false);
  });

  it('accepting the project prompt refreshes every project', async () => {
    const spy = silence();
    const updated: string[] = [];
    try {
      await runUpgrade(false, {
        installer,
        appInstalledCheck: () => false,
        vaultLister: () => [
          { name: 'alpha', path: '/tmp/alpha' },
          { name: 'beta', path: '/tmp/beta' },
        ],
        projectUpdater: (v) => { updated.push(v.name); return { vault: v, ok: true }; },
        confirmAll: async () => true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(updated).toEqual(['alpha', 'beta']);
  });

  it('isolates a failing project: one bad vault does not abort the rest', async () => {
    const spy = silence();
    const attempted: string[] = [];
    try {
      await runUpgrade(false, {
        installer,
        yes: true,
        appInstalledCheck: () => false,
        vaultLister: () => [
          { name: 'alpha', path: '/tmp/alpha' },
          { name: 'beta', path: '/tmp/beta' },
        ],
        // alpha fails (updater returns { ok: false }, mirroring the real
        // defaultProjectUpdater which catches and never throws); beta MUST still
        // be attempted — a single bad vault cannot abort the fan-out.
        projectUpdater: (v) => {
          attempted.push(v.name);
          return v.name === 'alpha'
            ? { vault: v, ok: false, error: 'boom' }
            : { vault: v, ok: true };
        },
      });
    } finally {
      spy.mockRestore();
    }
    expect(attempted).toEqual(['alpha', 'beta']);
  });
});
