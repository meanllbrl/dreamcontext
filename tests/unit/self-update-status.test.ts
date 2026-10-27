import { describe, expect, it } from 'vitest';
import { statusLine, type SelfUpdateView } from '../../dashboard/src/lib/selfUpdateStatus.js';

/** t() that returns the key with its placeholders, so the test reads which sentence was chosen. */
const STRINGS: Record<string, string> = {
  'settings.selfUpdate.status.never': 'never',
  'settings.selfUpdate.status.off': 'off',
  'settings.selfUpdate.status.env': 'env {reason}',
  'settings.selfUpdate.status.current': 'current {installed}',
  'settings.selfUpdate.status.updated': 'updated {from}>{to}',
  'settings.selfUpdate.status.updating': 'updating {from}>{latest}',
  'settings.selfUpdate.status.deferred': 'deferred {latest}',
  'settings.selfUpdate.status.failed': 'failed {installed}>{latest}',
  'settings.selfUpdate.status.unknown': 'unknown',
  'settings.selfUpdate.status.log': 'log {path}',
};
const t = (k: string) => STRINGS[k] ?? k;
const view = (over: Partial<SelfUpdateView> = {}, record: Partial<NonNullable<SelfUpdateView['record']>> | null = {}): SelfUpdateView => ({
  enabled: true, disabledBy: null, desktop: true, logPath: '/h/.dreamcontext/logs/self-update.log',
  record: record === null ? null : { checkedAt: 1, at: 1, installed: '0.35.0', latest: '0.36.0', state: 'current', ...record },
  ...over,
});

describe('the self-update status line in Settings', () => {
  it('says what the last check found', () => {
    expect(statusLine(view({}, { installed: '0.36.0' }), t)).toBe('current 0.36.0');
    expect(statusLine(view({}, { state: 'updated', from: '0.35.0', to: '0.36.0' }), t)).toBe('updated 0.35.0>0.36.0');
    expect(statusLine(view({}, { state: 'updating', from: '0.35.0' }), t)).toBe('updating 0.35.0>0.36.0');
    expect(statusLine(view({}, { state: 'deferred', checkedAt: 0 }), t)).toBe('deferred 0.36.0');
    expect(statusLine(view({}, { state: 'unknown' }), t)).toBe('unknown');
  });

  it('a failure points at the log', () => {
    expect(statusLine(view({}, { state: 'failed' }), t)).toBe('failed 0.35.0>0.36.0 log /h/.dreamcontext/logs/self-update.log');
  });

  it('off, off by a variable, and never checked each have their own sentence', () => {
    expect(statusLine(view({ enabled: false, disabledBy: 'turned off in Settings' }), t)).toBe('off');
    expect(statusLine(view({ disabledBy: 'DREAMCONTEXT_AUTO_UPGRADE=0' }), t)).toBe('env DREAMCONTEXT_AUTO_UPGRADE=0');
    expect(statusLine(view({}, null), t)).toBe('never');
    expect(statusLine(view({}, { checkedAt: 0, state: 'disabled' }), t)).toBe('never');
  });
});
