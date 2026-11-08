// Mac mode, AC9, after the phone left its own interface (hands-free W2): the phone's drawer IS the
// new shell's. It lists the chosen projects by NAME from /api/vaults (the launcher poll is refused
// there) and the Mac's running chats from /api/agent/live-chats, read once by the window; a live
// row opens ADOPTED (the evicting reattach=1) in its own project through the drawer's one intent,
// never parked for another surface to pick up. Checked against the source, like
// chat-account-switch-restart.test.ts: root vitest runs under plain Node and these are React
// modules. The live behaviour is scripts/verify/handsfree-mac.mjs.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const code = (p: string) => readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('phone drawer (AC9) = the new shell\'s drawer', () => {
  const projects = code('dashboard/src/hooks/useShellProjects.ts');
  const chats = code('dashboard/src/hooks/useDrawerChats.ts');
  const chrome = code('dashboard/src/components/layout/WindowChrome.tsx');
  const surface = code('dashboard/src/components/sleepy/AgentSurface.tsx');

  it('reads projects from /vaults on the tunnel (never the launcher poll) and live chats from /agent/live-chats with the vault named', () => {
    expect(projects).toMatch(/useLauncherStatus\(enabled && !tunnel\)/);
    expect(projects).toMatch(/api\.get<[\s\S]{0,120}?>\('\/vaults'\)/);
    expect(projects).toMatch(/enabled: enabled && tunnel/);
    expect(chats).toMatch(/new ApiClient\(o\.activeVault\)\.get<LiveChatsWire>\('\/agent\/live-chats'\)/);
    expect(chrome).toMatch(/useDrawerChats\(\{ activeVault, drawerVisible, enabled: newShell \}\)/);
  });

  it('a row opens through ONE intent in its own project; a live row adopts with reattach=1', () => {
    expect(chrome).toMatch(/const openChatRow = useCallback\(\(vault: string, row: HomeRow\) => \{\s*void queueDrawerIntent\(vault, \{ kind: 'open-chat', row \}\);/);
    expect(surface).toMatch(/else if \(plan\.kind === 'adopt'\) \{ setSuperView\('panes'\); adoptLiveChat\(plan\.chat\); \}/);
    expect(surface).toMatch(/const adoptLiveChat = useCallback\(\(chat: LiveChatWire\) => \{\s*resumePastSession\([\s\S]*?'1'\)/);
    expect(surface).toMatch(/spawn\(bypass, past\.id, true, 'chat', '', '', true, '', false, '', false, DEFAULT_CHAT_MODE, '', '', reattach\)/);
    expect(surface).toMatch(/createChatSession\(vault \?\? '', [\s\S]{0,200}origin, null, reattach, lean, mirror\)/);
  });

  it('no parked adoption is left: the drawer intent replaced macAdopt\'s sessionStorage hand-off', () => {
    expect(existsSync(join(ROOT, 'dashboard/src/components/handsfree/macAdopt.ts'))).toBe(false);
    expect(surface).not.toMatch(/takePendingMacAdopt|takePendingPhoneOpen|dc-mac-pending/);
  });

  it('the roster restore (hydrate) opens every restored chat PASSIVELY', () => {
    expect(surface).toMatch(/const s = spawn\(m\.bypass, m\.sessionId, true, kind, '', launch\.model \?\? '', true, '', false, launch\.effort \?\? '', true, savedMode, launch\.account \?\? '', '', 'passive'\)/);
  });
});
