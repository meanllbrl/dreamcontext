/**
 * D4 (task codex-tarzi-yeni-kabuk W1): in the new shell the chat overlay is bounded to its
 * instance box, even where `data-sidebar="collapsed"` is left over. The bounding rules must beat
 * the collapsed-sidebar rule on specificity AND come after it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'AgentTerminal.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));

/** (ids, classes+attributes+pseudo-classes, elements) for a simple selector list member. */
function specificity(sel: string): [number, number, number] {
  let s = sel;
  let b = 0;
  // :not(x) counts as x.
  s = s.replace(/:not\(([^)]*)\)/g, (_m, inner) => { b += specificity(inner)[1]; return ''; });
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  b += (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const bare = s.replace(/\.[\w-]+|\[[^\]]+\]|:{1,2}[\w-]+/g, '');
  const c = (bare.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, b, c];
}

function rulesFor(fragment: string): Array<{ selector: string; at: number }> {
  const out: Array<{ selector: string; at: number }> = [];
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    for (const sel of m[1].split(',').map((x) => x.replace(/\/\*[\s\S]*?\*\//g, '').trim())) {
      if (sel.includes(fragment)) out.push({ selector: sel, at: m.index });
    }
  }
  return out;
}

describe('new shell overlay bounding', () => {
  const collapsed = rulesFor('[data-sidebar="collapsed"] .agent-surface.expanded');
  const bounded = rulesFor('[data-shell="new"][data-instance] .agent-surface.expanded');
  it('both rules exist', () => {
    expect(collapsed.length).toBeGreaterThan(0);
    expect(bounded.length).toBeGreaterThan(0);
  });
  it('the new-shell rule wins on specificity and order', () => {
    const c = collapsed[0];
    for (const b of bounded) {
      const [bi, bc] = specificity(b.selector);
      const [ci, cc] = specificity(c.selector);
      expect(bi * 100 + bc).toBeGreaterThan(ci * 100 + cc);
      expect(b.at).toBeGreaterThan(c.at);
    }
    // A phone is the new shell too (hands-free W2): the rule no longer carves it out with
    // `:not([data-mobile])`, and its own `[data-mobile]` rule (inset 0) comes after it.
    expect(specificity(bounded[0].selector)).toEqual([0, 5, 0]);
  });
  it('it is positioned inside the instance, not against the viewport', () => {
    const at = css.indexOf('[data-shell="new"][data-instance] .agent-surface.expanded');
    const body = css.slice(css.indexOf('{', at), css.indexOf('}', at));
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/inset:/);
  });
});
