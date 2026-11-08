/**
 * Esc in the new shell (task codex-tarzi-yeni-kabuk W2-A, D4): Chat is a page, so the surface's
 * Esc handler no longer collapses it there. Every in-chat use that owns Esc (menus, Inspect, a
 * stage drag, the composer) is still checked first, and the classic shell keeps collapsing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const surface = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/sleepy/AgentSurface.tsx', import.meta.url)), 'utf-8');

describe('new-shell Esc', () => {
  const at = surface.indexOf("if (ae?.closest('.agent-composer-menu')) return;");
  const tail = surface.slice(at, at + 600);

  it('returns before the collapse in the new shell only', () => {
    expect(at).toBeGreaterThan(0);
    const guard = tail.indexOf("if (readShellModeFrozen() === 'new') return;");
    const collapse = tail.indexOf('setExpanded(false);');
    expect(guard).toBeGreaterThan(0);
    expect(collapse).toBeGreaterThan(guard);
    // Nothing else between the guard and the collapse: classic still collapses on Esc.
    expect(tail.slice(guard, collapse).replace(/\s+/g, ' ')).toMatch(/^if \(readShellModeFrozen\(\) === 'new'\) return; e\.preventDefault\(\); $/);
  });

  it('keeps every in-chat owner of Esc ahead of it', () => {
    const handler = surface.slice(surface.lastIndexOf('const onKey', at), at);
    for (const owner of ['.super-size-menu', '.super-surface[data-presenting]', '.ns-menu', "ae?.closest('.cmd-modal')", "ae?.closest('.agent-composer')"]) {
      expect(handler).toContain(owner);
    }
  });

  it('yields to the Settings window first: it closes itself, the chat behind stays', () => {
    const handler = surface.slice(surface.lastIndexOf('const onKey', at), at);
    const settings = handler.indexOf('if (document.body.dataset.settingsWindow) return;');
    expect(settings).toBeGreaterThan(0);
    expect(settings).toBeLessThan(handler.indexOf('if (tabDrag.get()) return;'));
  });
});
