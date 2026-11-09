import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { keptWebIds } from '../../dashboard/src/components/sleepy/super/webBudget.js';
import { THEME_BRIDGE, themeMessage } from '../../dashboard/src/lib/sandboxHtml.js';

const read = (p: string) => readFileSync(p, 'utf-8');
const reader = read('dashboard/src/components/appLink/DocumentReader.tsx');

/** Owner 2026-11-01: "isn't it cached, it keeps reloading". */
describe('a project page on a web card reloads only when its file changes', () => {
  it('stays in the kept set with nothing on screen, like a live page', () => {
    expect([...keptWebIds(['file-a'], [], ['file-a', 'file-b'])]).toEqual(['file-a']);
    const surface = read('dashboard/src/components/sleepy/super/SuperSurface.tsx');
    expect(surface).toMatch(/const webCards = state\.containers\.filter\(\(c\) => c\.kind === 'web'\)/);
    expect(surface).toMatch(/keptWebIds\(lru, heldOnScreen, webCards,/);
  });

  it('a theme never rebuilds the srcdoc', () => {
    expect(reader).toMatch(/\[html, zoomBridge, fill, reportsFit, ownCanvas, schemeOf\],/);
  });

  it('the theme bridge swaps the rule, and only for its parent', () => {
    const style = { textContent: ':root { color-scheme: light; }' };
    const parent = {};
    let listener: (e: unknown) => void = () => {};
    runInNewContext(THEME_BRIDGE, {
      parent,
      window: { addEventListener: (_: string, f: (e: unknown) => void) => { listener = f; } },
      document: { querySelectorAll: () => [{ textContent: 'kit' }, style] },
    });
    const data = themeMessage({ '--x': '1' }, 'dark');
    listener({ source: {}, data });
    expect(style.textContent).toBe(':root { color-scheme: light; }');
    listener({ source: parent, data });
    expect(style.textContent).toBe(':root { color-scheme: dark; --x: 1; }');
  });

  it('a web card follows its file by stat and keeps the old page until the new one is ready', () => {
    expect(reader).toMatch(/useProjectHtml\(path, vaultReads, fill\)/);
    expect(reader).toMatch(/&probe=1/);
    expect(reader).toMatch(/html\?\.raw === raw \|\| watch/);
    expect(read('src/server/routes/agent-chat.ts')).toMatch(/sendProbe\(res, st\.size, textCap, st\.mtimeMs\)/);
  });
});
