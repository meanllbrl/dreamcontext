import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { channelStatusLine, type UpdateChannelView } from '../../dashboard/src/lib/selfUpdateStatus.js';

/** t() that returns the key with its placeholder, so the test reads which sentence was chosen. */
const STRINGS: Record<string, string> = {
  'settings.beta.status.on': 'on',
  'settings.beta.status.off': 'off',
  'settings.beta.status.stays': 'stays {installed}',
  'settings.beta.status.desktopOnly': 'desktop-only',
};
const t = (k: string) => STRINGS[k] ?? k;
const view = (over: Partial<UpdateChannelView> = {}): UpdateChannelView => ({
  channel: 'stable', appVersion: '0.42.3', stableVersion: '0.42.3', staysUntilStable: false, desktop: true, ...over,
});

describe('the Beta row line (plan npmsiz-beta criterion 5)', () => {
  it('outside the desktop app says where to switch it, whatever the channel', () => {
    expect(channelStatusLine(view({ desktop: false, channel: 'beta' }), t)).toBe('desktop-only');
    expect(channelStatusLine(view({ desktop: false, staysUntilStable: true }), t)).toBe('desktop-only');
  });

  it('on Beta says on', () => {
    expect(channelStatusLine(view({ channel: 'beta' }), t)).toBe('on');
  });

  it('off on a build newer than stable names the build that stays (never a downgrade)', () => {
    expect(channelStatusLine(view({ staysUntilStable: true, stableVersion: '0.42.1' }), t)).toBe('stays 0.42.3');
  });

  it('off otherwise, and off when the running version is unknown', () => {
    expect(channelStatusLine(view(), t)).toBe('off');
    expect(channelStatusLine(view({ staysUntilStable: true, appVersion: null }), t)).toBe('off');
  });

  it('every line exists in English and Turkish, the stays line with its {installed} slot', () => {
    // The dashboard has no Turkish switch on screen yet, so the Turkish copy is checked here.
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard/src/context/I18nContext.tsx'), 'utf8');
    for (const key of ['settings.beta.label', 'settings.beta.hint', ...Object.keys(STRINGS)]) {
      const rows = [...src.matchAll(new RegExp(`'${key.replace(/\./g, '\\.')}': '([^']*)'`, 'g'))].map((m) => m[1]);
      expect(rows, key).toHaveLength(2);
      for (const row of rows) expect(row, key).not.toMatch(/—/);
      if (key.endsWith('.stays')) for (const row of rows) expect(row).toContain('{installed}');
    }
  });
});
