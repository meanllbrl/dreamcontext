/**
 * A click on a chat row redrew every open transcript of every project, three times
 * (scripts/verify/chat-switch.mjs, counted: 34 ChatPane renders a hop, 2 to 5 with these holds).
 * The repo has no DOM test environment, so what renders is the static half and the rest is a
 * source scan of the seams; the timing itself is the browser check's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { useVaultId, VaultProvider } from '../../dashboard/src/context/VaultContext';

const read = (p: string) => readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', p), 'utf-8');

describe('a window render does not reach the transcripts', () => {
  it('I18nProvider and ScopedLocale hand out one value per locale', () => {
    const src = read('context/I18nContext.tsx');
    expect(src).not.toMatch(/value=\{\{/);
    expect(src.match(/useMemo<I18nContextValue>/g)).toHaveLength(2);
  });

  it('a project switch reaches only the readers of isActive', () => {
    const src = read('context/VaultContext.tsx');
    const body = (name: string) => src.slice(src.indexOf(`export function ${name}`)).split('\n}\n')[0];
    expect(body('useApi')).toContain('useVaultId()');
    expect(body('useInstanceEvent')).toContain('useVaultId()');
    for (const f of ['components/sleepy/ChatPane.tsx', 'components/sleepy/chat/Composer.tsx', 'components/sleepy/chat/TranscriptItem.tsx']) {
      expect(read(f), f).not.toContain('useVault()');
    }
  });

  it('useVaultId names the project, and has no isActive to subscribe to', () => {
    let seen: Record<string, unknown> = {};
    const Probe = () => { seen = useVaultId(); return null; };
    renderToStaticMarkup(createElement(VaultProvider, { vault: 'acme', instanceId: 'inst-1', isActive: false, bus: new EventTarget() }, createElement(Probe)));
    expect(seen.vault).toBe('acme');
    expect(seen.instanceId).toBe('inst-1');
    expect('isActive' in seen).toBe(false);
  });

  it('a drawer intent lands before the click paints, but never before the listeners exist', () => {
    const src = read('components/layout/newshell/DrawerIntentBridge.tsx');
    expect(src).toContain('if (mounted.current) ring();');
    expect(src).toMatch(/useEffect\(\(\) => \{\n\s+mounted\.current = true;\n\s+ring\(\);/);
  });
});
