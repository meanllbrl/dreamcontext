/**
 * The new layout is always Chat and always on (task settings-konuya-gore-17-menuye…, wave 5):
 * a saved `chatView:false, enabled:false` opens Chat in the new shell and behaves as before in
 * classic. Read sites only; nothing is written back.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let mode: 'new' | 'classic' | null = 'classic';
vi.mock('../../dashboard/src/lib/uxMode', async (orig) => ({
  ...(await orig<object>()),
  readShellModeFrozen: () => mode,
}));

const { agentSurfaceSettings } = await import('../../dashboard/src/lib/agentSettings');

const SRC = join(__dirname, '..', '..', 'dashboard', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf-8');

describe('agentSurfaceSettings', () => {
  beforeEach(() => { mode = 'classic'; });

  it('new shell: off and Terminal read as on and Chat', () => {
    mode = 'new';
    const saved = { enabled: false, chatView: false, hotkey: 'Ctrl+A' };
    expect(agentSurfaceSettings(saved)).toEqual({ enabled: true, chatView: true, hotkey: 'Ctrl+A' });
    expect(saved).toEqual({ enabled: false, chatView: false, hotkey: 'Ctrl+A' }); // never written back
  });

  it('classic and an unsettled window keep the saved choice', () => {
    const saved = { enabled: false, chatView: false };
    expect(agentSurfaceSettings(saved)).toBe(saved);
    mode = null;
    expect(agentSurfaceSettings(saved)).toBe(saved);
  });

  it('already on and Chat: the same object', () => {
    mode = 'new';
    const s = { enabled: true, chatView: true };
    expect(agentSurfaceSettings(s)).toBe(s);
  });
});

describe('every read site goes through it', () => {
  it.each([
    ['components/sleepy/AgentSurface.tsx', /const s = agentSurfaceSettings\(raw\);/],
    ['components/brain/BrainSyncControl.tsx', /agentSurfaceSettings\(readAgentSettings\(\)\)/],
    ['components/tasks/KanbanBoard.tsx', /const surface = agentSurfaceSettings\(agentSettings\);/],
    ['components/tasks/detail/GiveToAgentMenu.tsx', /const s = agentSurfaceSettings\(settings\);/],
    ['components/layout/SleepDebtTracker.tsx', /const surface = agentSurfaceSettings\(agentSettings\);/],
    ['hooks/useOnboarding.ts', /agentSurfaceSettings\(\{ enabled: cfg\.enabled, chatView: cfg\.chatView \}\)/],
    ['components/layout/useNavBadges.ts', /agentSurfaceSettings\(cfg\)\.enabled/],
    ['pages/onboarding/handoffPlan.ts', /agentSurfaceSettings\(settings\)\.chatView/],
  ])('%s', (file, re) => {
    expect(read(file)).toMatch(re);
  });

  it('AgentSurface seeds its first state through it, and ⌃A stays with the field in the new shell', () => {
    const src = read('components/sleepy/AgentSurface.tsx');
    expect(src).toMatch(/useState<AgentSettings>\(\(\) => tunnelSettings\(readAgentSettings\(\)\)\)/);
    expect(src).toMatch(/if \(windowed \|\| !caps\?\.desktop \|\| !agentSettings\.enabled \|\| !agentSettings\.hotkey\.trim\(\)\) return;/);
  });
});

describe('a Codex chat never flips Claude\'s switch', () => {
  it('the composer picker and the limit card write the pane\'s own tool', () => {
    const picker = read('components/sleepy/chat/model-picker/ComposerModelPicker.tsx');
    expect(picker).toMatch(/api\.post\('\/agent\/accounts\/rules', \{ tool: 'codex', patch: \{ autoSwitch: !autoSwitch \} \}\)/);
    const banners = read('components/sleepy/chat/Banners.tsx');
    expect(banners).toMatch(/api\.post\('\/agent\/accounts\/rules', \{ tool: 'codex', patch: \{ autoSwitch: true \} \}\)/);
    expect(read('components/sleepy/ChatPane.tsx')).toMatch(/tool=\{session\.tool === 'codex' \? 'codex' : ''\}/);
  });
});

describe('classic Settings lost its dead new-shell branches', () => {
  it('no search bar, no Models section, no Eco row there', () => {
    const page = read('pages/SettingsPage.tsx');
    expect(page).not.toMatch(/useIsNewShell|newShell|ModelsSection|EcoModeRow|settings-search/);
    expect(page).toMatch(/const show = \(id: SettingsSectionId\) => activeSection === id;/);
  });
});
