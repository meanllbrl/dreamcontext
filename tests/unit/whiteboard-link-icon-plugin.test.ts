import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hideWidgetLinkIcon } from '../../dashboard/excalidraw-widget-link-icon';

const EXCALIDRAW_DIST = join(__dirname, '..', '..', 'dashboard', 'node_modules', '@excalidraw', 'excalidraw', 'dist');

/** Every chunk of one Excalidraw build, joined: the guard lives in whichever chunk it lives in. */
function build(kind: 'dev' | 'prod'): string {
  const dir = join(EXCALIDRAW_DIST, kind);
  return readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n');
}

describe('dc-excalidraw-widget-link-icon', () => {
  it('skips the link icon for a dreamcontext:// link and keeps it for any other', () => {
    const { code, count } = hideWidgetLinkIcon('if(e.link&&!n.selectedElementIds[e.id]){draw()}');
    expect(count).toBe(1);
    const draws = (link: string, selected = false) => {
      let drew = false;
      new Function('e', 'n', 'draw', code)({ id: 'a', link }, { selectedElementIds: { a: selected } }, () => { drew = true; });
      return drew;
    };
    expect(draws('dreamcontext://insight/mrr')).toBe(false);
    expect(draws('https://example.com')).toBe(true);
    expect(draws('https://example.com', true)).toBe(false);
  });

  // An Excalidraw upgrade that moves the guard would ship the icon back over every widget.
  for (const kind of ['dev', 'prod'] as const) {
    it(`finds the guard exactly once in the installed ${kind} build`, () => {
      expect(hideWidgetLinkIcon(build(kind)).count).toBe(1);
    });
  }
});
