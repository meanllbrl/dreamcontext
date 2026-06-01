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

  it('calls the installer when check is false (default install mode)', () => {
    const installer = vi.fn();
    const latestVersion = () => '9.9.9';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      runUpgrade(false, { installer, latestVersion });
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
