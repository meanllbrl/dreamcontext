import { describe, it, expect } from 'vitest';
import { appUpdateOrigin } from '../../src/lib/apps/assistant.js';
import { appChatBriefing, appUpdatesBriefing } from '../../src/server/chat-surface.js';
import { updateCheckDue } from '../../dashboard/src/components/apps/updateCheck.js';
import type { AppSource } from '../../src/lib/apps/registry.js';

/**
 * An installed app's assistant told the owner it would `git pull` updates itself (2026-11-09).
 * Its briefing now says how updates really come, for every kind of app, in the one text that
 * Claude, Codex and Antigravity all receive.
 */

const source = (over: Partial<AppSource> = {}): AppSource => ({
  host: 'github', fullName: 'acme/yuk', repoId: '1', ownerId: '2', owner: 'acme', public: false,
  mode: 'following', autoUpdate: false, upstreamSha: 'a'.repeat(40), ...over,
});

describe('appUpdateOrigin', () => {
  it('an installed app that follows its original', () => {
    expect(appUpdateOrigin({ origin: 'installed', source: source({ autoUpdate: true }) })).toEqual({ kind: 'installed', from: 'acme/yuk', public: false, autoUpdate: true });
  });
  it('an installed app made the owner\'s own copy', () => {
    expect(appUpdateOrigin({ origin: 'installed', provenance: { fullName: 'acme/yuk', license: 'MIT' } })).toEqual({ kind: 'own-copy', from: 'acme/yuk' });
  });
  it('the owner\'s own app, published or not', () => {
    expect(appUpdateOrigin({})).toEqual({ kind: 'own', published: null });
    expect(appUpdateOrigin({ publish: { host: 'github', fullName: 'me/yuk', repoId: '3', public: false, lastSha: 'b', at: 'x' } })).toEqual({ kind: 'own', published: 'me/yuk' });
    // A first publish still under way has pushed nothing yet.
    expect(appUpdateOrigin({ publish: { host: 'github', fullName: 'me/yuk', repoId: '3', public: false, lastSha: '', at: 'x' } })).toEqual({ kind: 'own', published: null });
  });
});

describe('the update paragraph', () => {
  const never = /Never pull, fetch, merge, reset or copy code/;
  it('installed: the check verb, the owner\'s click on the card, and no self-pull', () => {
    const t = appUpdatesBriefing('yuk', { kind: 'installed', from: 'acme/yuk', public: false, autoUpdate: false });
    expect(t).toContain('`dreamcontext apps update yuk` checks for one and changes nothing');
    expect(t).toContain('Applying it is the owner\'s click on that card');
    expect(t).toContain('Undo goes back');
    expect(t).toContain('Auto-update is off');
    expect(t).toMatch(never);
  });
  it('installed: auto-update on, and a public app that never updates by itself', () => {
    expect(appUpdatesBriefing('yuk', { kind: 'installed', from: 'acme/yuk', public: false, autoUpdate: true })).toContain('Auto-update is on for this app');
    const pub = appUpdatesBriefing('yuk', { kind: 'installed', from: 'acme/yuk', public: true, autoUpdate: false });
    expect(pub).toContain('A public app never updates by itself');
    expect(pub).not.toContain('turn it on');
  });
  it('own copy and own app: no original to update from', () => {
    const copy = appUpdatesBriefing('yuk', { kind: 'own-copy', from: 'acme/yuk' });
    expect(copy).toContain('takes no updates from the original any more');
    expect(copy).toMatch(never);
    const own = appUpdatesBriefing('yuk', { kind: 'own', published: 'me/yuk' });
    expect(own).toContain('there is no original it takes updates from');
    expect(own).toContain('publishes again');
    expect(own).toMatch(never);
  });
  it('rides the app chat briefing, for the own assistant and a bound member alike', () => {
    const base = { name: 'Yük', slug: 'yuk', appRoot: '/a', dataDir: '/d', updates: { kind: 'installed', from: 'acme/yuk', public: false, autoUpdate: false } as const };
    for (const own of [true, false]) expect(appChatBriefing({ ...base, own })).toContain('### Updates\nThis app was installed from `acme/yuk`');
    expect(appChatBriefing({ ...base, own: true })).toContain('`dreamcontext apps update yuk`, `dreamcontext apps do');
  });
  it('a bound member is told a changing tool does not run from this window (gece-apps C2: it was a silent deny)', () => {
    const base = { name: 'Yük', slug: 'yuk', appRoot: '/a', dataDir: '/d' };
    const member = appChatBriefing({ ...base, own: false });
    expect(member).toContain('A tool of this app that reads runs as `dreamcontext apps do yuk <id>`.');
    expect(member).toContain('does not run from this window, even with `--confirm`');
    expect(member).toContain("the owner runs it from the app's own screen or in main Chat");
    expect(appChatBriefing({ ...base, own: true })).not.toContain('does not run from this window');
  });
});

describe('the Apps page checks on open', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  it('only installed apps that follow an original, not checked in the last 10 minutes', () => {
    expect(updateCheckDue([
      { slug: 'never', origin: 'installed', source: { lastCheck: null } },
      { slug: 'old', origin: 'installed', source: { lastCheck: '2026-11-09T11:00:00Z' } },
      { slug: 'fresh', origin: 'installed', source: { lastCheck: '2026-11-09T11:55:00Z' } },
      { slug: 'copy', origin: 'installed', source: null },
      { slug: 'old-own-copy', origin: 'installed', source: { mode: 'own', lastCheck: null } },
      { slug: 'mine', origin: 'own', source: null },
    ], now)).toEqual(['never', 'old']);
  });
});
