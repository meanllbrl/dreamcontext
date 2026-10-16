// Mac mode, AC9: on the phone surface the drawer lists projects by NAME from /api/vaults (the
// launcher poll is refused there) and a "Mac'te açık" section from /api/agent/live-chats; a tap
// adopts with the evicting reattach=1 (another project's chat is parked for that surface).
// Checked against the source, like chat-account-switch-restart.test.ts: root vitest runs under
// plain Node and these are React modules. The live behaviour is scripts/verify/handsfree-mac.mjs.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const code = (p: string) => readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('phone drawer (AC9)', () => {
  const drawer = code('dashboard/src/components/sleepy/MobileSessionDrawer.tsx');
  const surface = code('dashboard/src/components/sleepy/AgentSurface.tsx');

  it('reads projects from /vaults and live chats from /agent/live-chats only on the mac surface', () => {
    expect(drawer).toMatch(/useLauncherStatus\(open && projectsOpen && !mac\)/);
    expect(drawer).toMatch(/\('\/vaults'\),\s*enabled: open && mac/);
    expect(drawer).toMatch(/\('\/agent\/live-chats'\),\s*enabled: open && mac/);
    expect(drawer).toContain("t('handsfree.mac.liveSection')");
  });

  it('a tap adopts here with reattach=1, or parks the adoption for the other project', () => {
    expect(drawer).toMatch(/setPendingMacAdopt\(chat\);\s*void chrome\.addTab\(chat\.vault\)/);
    expect(drawer).toMatch(/onAdoptLive\?\.\(chat\)/);
    expect(surface).toMatch(/const adoptLiveChat = useCallback\(\(chat: LiveChatWire\) => \{\s*resumePastSession\([\s\S]*?'1'\)/);
    expect(surface).toMatch(/spawn\(bypass, past\.id, true, 'chat', '', '', true, '', false, '', false, DEFAULT_CHAT_MODE, '', '', reattach\)/);
    expect(surface).toMatch(/createChatSession\(vault \?\? '', [\s\S]{0,200}origin, null, reattach\)/);
  });

  it('AC16: one chosen project shows its name only; several show the project list (only the chosen ones, from /vaults)', () => {
    expect(drawer).toMatch(/const macMulti = mac && vaults\.length > 1/);
    expect(drawer).toMatch(/\{mac && !macMulti \? \(/);
    expect(drawer).toMatch(/projectsOpen && \(!mac \|\| macMulti\)/);
  });

  it('AC18: rows come from drawerRows (live + draining excluded from past), a past tap re-asks the Mac and adopts a live one, rows show the state label', () => {
    expect(drawer).toMatch(/drawerRows\(\{\s*live: live\?\.chats \?\? \[\], draining: live\?\.draining \?\? \[\]/);
    expect(drawer).toMatch(/const fresh = await api\.get<LiveChatsWire>\('\/agent\/live-chats'\);\s*const d = pastTap\(s\.id, fresh\.chats\);\s*if \('adopt' in d\) \{ adopt\(d\.adopt\); return; \}/);
    expect(drawer).toContain('onClick={() => { void tapPast(s); }}');
    expect(drawer).toContain('t(liveStateKey(c.state))');
    expect(drawer).toContain('activeStateKey(s.info)');
  });

  it('the roster restore (hydrate) opens every restored chat PASSIVELY', () => {
    expect(surface).toMatch(/const s = spawn\(m\.bypass, m\.sessionId, true, kind, '', '', true, '', false, '', true, savedMode, '', '', 'passive'\)/);
  });
});

describe('parked adoption (macAdopt.ts)', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as Record<string, unknown>).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  });

  it('is taken once, by the named project only', async () => {
    const { setPendingMacAdopt, takePendingMacAdopt } = await import('../../dashboard/src/components/handsfree/macAdopt');
    setPendingMacAdopt({ conversationId: 'c1', vault: 'alpha', title: 'x', busy: true, state: 'asking' });
    expect(takePendingMacAdopt('beta')).toBeNull();
    expect(takePendingMacAdopt('alpha')).toEqual({ conversationId: 'c1', vault: 'alpha', title: 'x', busy: true, state: 'asking' });
    expect(takePendingMacAdopt('alpha')).toBeNull();
  });
});
