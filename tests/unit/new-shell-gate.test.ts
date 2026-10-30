/**
 * Source guard for the new shell's one gate (task codex-tarzi-yeni-kabuk W1, D2): only
 * `lib/uxMode.ts` reads the stored `shell`, and every file that branches on the new shell gets
 * its answer from that module, never from its own check.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..', 'dashboard', 'src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ rel: relative(SRC, p), src: readFileSync(p, 'utf-8') }));

describe('the new shell gate', () => {
  it('only uxMode.ts reads the settled switch', () => {
    const readers = files.filter((f) => f.src.includes('readShellPrefSettled')).map((f) => f.rel).sort();
    expect(readers).toEqual(['lib/launcherPrefs.ts', 'lib/uxMode.ts']);
  });

  it('nobody keeps the switch in localStorage', () => {
    for (const f of files) expect(f.src, f.rel).not.toMatch(/localStorage\.(setItem|getItem)\([^)]*(shell|experimentalUx)/i);
  });

  it('every new-shell branch reads the gate from uxMode', () => {
    const branching = files.filter((f) => f.rel !== 'lib/uxMode.ts'
      && (/data-shell=\{|newShell \?|if \(newShell\)|newShell &&/.test(f.src)));
    expect(branching.length).toBeGreaterThan(5);
    for (const f of branching) {
      expect(f.src, f.rel).toMatch(/from '(\.\.\/)*(\.\/)?(lib\/)?uxMode'|from '\.\.\/\.\.\/lib\/uxMode'|from '\.\.\/\.\.\/\.\.\/lib\/uxMode'|from '\.\/lib\/uxMode'|from '\.\.\/lib\/uxMode'/);
    }
  });

  it('both window roots are wrapped, the single-purpose windows are not', () => {
    const app = files.find((f) => f.rel === 'App.tsx')!.src;
    expect(app.match(/<ShellModeProvider>/g)).toHaveLength(2);
    const firstProvider = app.indexOf('<ShellModeProvider>');
    for (const marker of ['<Notch />', '<ViewerWindow', '<InboxWindow />']) {
      expect(app.indexOf(marker), marker).toBeGreaterThan(-1);
      expect(app.indexOf(marker), marker).toBeLessThan(firstProvider);
    }
  });
});

describe('W1 review fixes stay in place', () => {
  const src = (rel: string) => files.find((f) => f.rel === rel)!.src;
  it("the rail's badges live as long as the project, not as long as it is on screen", () => {
    const c = src('components/layout/newshell/NewShellControls.tsx');
    expect(c.indexOf('useNavBadges()')).toBeGreaterThan(-1);
    expect(c.indexOf('useNavBadges()')).toBeLessThan(c.indexOf('if (!isActive) return null'));
    expect(src('components/layout/newshell/Rail.tsx')).not.toMatch(/useNavBadges\(\)/);
  });
  it('embedded Space stops its window keys and its drift while its project is hidden', () => {
    const s = src('pages/space/SpaceLauncher.tsx');
    expect(s).toContain('const live = !openOverride || isActive;');
    expect(s).toContain('if (reduced || !live) return;');
    expect(s).toContain('if (!live) return undefined;');
  });
  it('Esc on the new picker or More closes the menu, not the chat', () => {
    expect(src('components/sleepy/AgentSurface.tsx')).toContain("if (document.querySelector('.ns-menu')) return;");
  });
});
