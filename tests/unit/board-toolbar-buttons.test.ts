/**
 * Second-pass review, Major 2 and Minor 8: every control in the board's toolbar and view tabs
 * is a real `<button type="button">`, so Tab reaches it and Enter / Space press it. No `<div>` or
 * `<span>` there takes a click or claims `role="button"`; the only clickable `<div>`s are the
 * full-screen backdrops that close a menu, which are `aria-hidden` and not controls. Toggles
 * say `aria-pressed`, menu triggers say `aria-expanded`. A source scan: root vitest has no DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', '..', 'dashboard', 'src', 'components', 'tasks');
const read = (f: string): string => readFileSync(join(DIR, f), 'utf-8');

/** Every opening `<div …>` / `<span …>` tag, whole (an arrow's `=>` inside `{…}` is not its end). */
function openingTags(src: string, tag: 'div' | 'span'): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

describe('the board toolbar and view tabs use real buttons', () => {
  for (const file of ['BoardToolbar.tsx', 'BoardViewTabs.tsx']) {
    it(`${file}: no div or span takes a click or plays a button`, () => {
      const src = read(file);
      const offenders = (['div', 'span'] as const)
        .flatMap((tag) => openingTags(src, tag))
        .filter((t) => /\bonClick=|role="button"/.test(t))
        .filter((t) => !(/aria-hidden="true"/.test(t) && /data-backdrop/.test(t) && /inset: 0/.test(t)));
      expect(offenders).toEqual([]);
    });
  }

  it('the filter include / exclude toggles and the Back control are buttons', () => {
    const src = read('BoardToolbar.tsx');
    expect(src).toMatch(/<button type="button" aria-pressed=\{incOn\} onClick=\{\(\) => s\.cycleFilter\(section, o\.value, 'inc'\)\}/);
    expect(src).toMatch(/<button type="button" aria-pressed=\{excOn\} onClick=\{\(\) => s\.cycleFilter\(section, o\.value, 'exc'\)\}/);
    expect(src).toMatch(/<button type="button" className="bd-hover bd-hover-text" onClick=\{\(\) => setFilterPane\(null\)\}/);
  });

  it('every chip trigger is a button that says whether its menu is open', () => {
    const src = read('BoardToolbar.tsx');
    for (const key of ['viewtype', 'group', 'props', 'filter', 'sort']) {
      expect(src, key).toContain(`<button type="button" className="bd-chip" aria-expanded={openMenu === '${key}'} onClick={() => toggle('${key}')}`);
    }
    expect(src).toContain('aria-expanded={moreOpen}');
    expect(src).toContain("aria-expanded={openMenu === 'newtask'} onClick={() => toggle('newtask')}");
  });

  it('a view tab is two sibling buttons, the view (aria-pressed) and its options (aria-expanded)', () => {
    const src = read('BoardViewTabs.tsx');
    expect(src).toMatch(/<button\s+type="button"\s+aria-pressed=\{active\}\s+onClick=\{\(\) => p\.onApply\(v\.id\)\}/);
    expect(src).toMatch(/aria-expanded=\{p\.menuOpenId === v\.id\}/);
    expect(src).toMatch(/<button type="button" className="bd-hover bd-hover-text" onClick=\{startCreate\}/);
  });

  it('the button reset keeps the desktop look: padding and margin only, no inline background or border', () => {
    for (const file of ['BoardToolbar.tsx', 'BoardViewTabs.tsx']) {
      expect(read(file), file).toContain("const btn: CSSProperties = { padding: 0, margin: 0, textAlign: 'left' };");
    }
  });

  it('the Order / Status pair has no inline 34px min-height overriding the phone size', () => {
    expect(read('BoardToolbar.tsx')).not.toMatch(/minHeight: 34 \}/);
  });
});
