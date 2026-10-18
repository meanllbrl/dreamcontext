/**
 * The CSS motion contract, enforced over ALL dashboard CSS and every TS/TSX file (AC7, task
 * "the desktop app stays light on an 8GB MacBook Air"; contract: styles/global.css).
 *
 * For every rule that runs an endless animation:
 *   (i)   the `@keyframes` it names set only `transform` / `opacity` (plus the motion-path
 *         `offset-*`, which composes into the transform, and per-keyframe
 *         `animation-timing-function`) — anything else repaints on the main thread every frame;
 *   (ii)  each endless position names its keyframes through `var(--dc-motion-status-name, …)` or
 *         `var(--dc-motion-ambient-name, …)` and its play-state through `var(--dc-motion-play, …)`;
 *   (iii) in a list, the play-state list is as long as the animation list and only the endless
 *         positions carry the variable, so a one-shot entrance is never removed or paused;
 * and everywhere:
 *   (iv)  no literal `animation-play-state` (and no `paused`/`running` inside an `animation`
 *         shorthand) outside `@media (prefers-reduced-motion)`; in a rule that sets the
 *         shorthand, `animation-play-state` comes after it (the shorthand resets it);
 *   (v)   no endless animation set from TS/TSX (inline styles cannot be rested or paused);
 *   (vi)  every window starts lib/motionClock.ts at boot, so whatever runs is stepped at 15-20 fps
 *         and never left on the display link (task: durum animasyonları WindowServer'ı yormaz).
 * And `global.css` carries the root rules that drive the variables.
 *
 * Runs over every file, so it is green only once every lane's CSS follows the contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Declaration, type Node as CssNode, type Root, type Rule } from 'postcss';

const SRC = fileURLToPath(new URL('../../dashboard/src', import.meta.url));

/**
 * TS files allowed to carry an endless animation, each with its reason. Only CSS shipped INTO a
 * sandboxed iframe belongs here: it runs in a separate document the app's motion contract
 * cannot reach, and the iframe's own lifetime bounds it.
 */
const TS_ALLOWLIST: Record<string, string> = {
  'components/sleepy/chat/chatHtmlKit.ts': 'the design kit injected into sandboxed dream-html iframes — a separate document, outside the contract',
  'components/whiteboard/htmlWidgetFrame.ts': 'the srcdoc of a sandboxed whiteboard HTML widget — a separate document, outside the contract',
};

/** Properties a looping keyframe may set: composited ones only. */
const COMPOSITED = /^(transform|opacity|offset(-[a-z]+)?|animation-timing-function)$/;
const NAME_VAR = /^var\(\s*--dc-motion-(status|ambient)-name\s*,\s*([A-Za-z_][\w-]*)\s*\)$/;
const PLAY_VAR = /^var\(\s*--dc-motion-play\s*,\s*running\s*\)$/;

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** Split a value on top-level commas / whitespace (parentheses kept whole). */
function splitTop(value: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    const isSep = sep === ',' ? ch === ',' : /\s/.test(ch);
    if (isSep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function inReducedMotion(node: CssNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    // Only the REDUCE branch is exempt: a `no-preference` block is the normal path.
    if (p.type === 'atrule' && (p as AtRule).name === 'media' && /prefers-reduced-motion\s*:\s*reduce/.test((p as AtRule).params)) return true;
  }
  return false;
}

function inKeyframes(node: CssNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'atrule' && /keyframes$/.test((p as AtRule).name)) return true;
  }
  return false;
}

const cssFiles = walk(SRC, ['.css']);
const parsed: Array<{ file: string; root: Root }> = cssFiles.map((f) => ({
  file: relative(SRC, f),
  root: postcss.parse(readFileSync(f, 'utf8'), { from: f }),
}));

/** Every @keyframes block by name → the properties it sets (all definitions merged). */
const keyframes = new Map<string, Set<string>>();
for (const { root } of parsed) {
  root.walkAtRules(/keyframes$/, (at) => {
    const props = keyframes.get(at.params.trim()) ?? new Set<string>();
    at.walkDecls((d) => { props.add(d.prop.toLowerCase()); });
    keyframes.set(at.params.trim(), props);
  });
}

interface Position { text: string; endless: boolean }

/** Endless motion set from TS/TSX: a style value (which may wrap onto the next line), an SVG
 *  <animate>, a Web Animation. No CSS variable can remove or pause any of them. */
const TS_ENDLESS_PATTERNS: readonly RegExp[] = [
  /animation[\w-]*['"]?\s*[:=]\s*(?:\n\s*)?[^\n]*\binfinite\b/gi,
  /repeatCount\s*=\s*\{?\s*["']indefinite["']/g,
  /iterations\s*:\s*(?:Infinity|Number\.POSITIVE_INFINITY)\b/g,
];

/** `infinite`, or a count so large it is endless in practice (`9999` would dodge the rule). */
const ENDLESS_COUNT = 50;
function endlessText(text: string): boolean {
  if (/\binfinite\b/.test(text)) return true;
  return splitTop(text, ' ').some((tok) => /^\d+(\.\d+)?$/.test(tok) && Number(tok) > ENDLESS_COUNT);
}

/** The animation positions a rule runs, from its shorthand or its longhands. */
function positionsOf(rule: Rule): { positions: Position[]; decl: Declaration } | null {
  const decls = rule.nodes.filter((n): n is Declaration => n.type === 'decl');
  const short = [...decls].reverse().find((d) => d.prop === 'animation');
  if (short) {
    const positions = splitTop(short.value, ',').map((text) => ({ text, endless: endlessText(text) }));
    return { positions, decl: short };
  }
  const name = [...decls].reverse().find((d) => d.prop === 'animation-name');
  const count = [...decls].reverse().find((d) => d.prop === 'animation-iteration-count');
  if (!name || !count || !endlessText(count.value)) return null;
  const names = splitTop(name.value, ',');
  const counts = splitTop(count.value, ',');
  return {
    positions: names.map((text, i) => ({ text, endless: endlessText(counts[i % counts.length] ?? '') })),
    decl: name,
  };
}

/** The keyframes name a position refers to (through the variable, or bare). */
function nameOf(position: string): { name: string | null; viaVar: boolean } {
  for (const tok of splitTop(position, ' ')) {
    const m = NAME_VAR.exec(tok);
    if (m) return { name: m[2], viaVar: true };
  }
  for (const tok of splitTop(position, ' ')) {
    if (/^[A-Za-z_][\w-]*$/.test(tok) && !/^(infinite|linear|ease(-in|-out|-in-out)?|step-(start|end)|alternate(-reverse)?|normal|reverse|forwards|backwards|both|none|paused|running)$/.test(tok)) {
      return { name: tok, viaVar: false };
    }
  }
  return { name: null, viaVar: false };
}

describe('CSS motion contract', () => {
  it('global.css carries the root rules that drive the motion variables', () => {
    const g = readFileSync(join(SRC, 'styles/global.css'), 'utf8').replace(/\s+/g, ' ');
    expect(g).toContain(":root[data-window-active='false'] { --dc-motion-ambient-name: none; }");
    expect(g).toContain(":root[data-window-hidden='true'] { --dc-motion-play: paused; }");
    // Light mode rests decoration only; status keeps moving on the clock (owner, 2026-10-18).
    expect(g).toContain(":root[data-light='true'] { --dc-motion-ambient-name: none; }");
    expect(g).not.toMatch(/:root\[data-light='true'\] \{[^}]*--dc-motion-status-name/);
    expect(g).toMatch(/:root\[data-light='true'\] \*,[^{]*\{ backdrop-filter: none !important; -webkit-backdrop-filter: none !important; \}/);
  });

  it('there are endless animations to check (the scan is not vacuous)', () => {
    let n = 0;
    for (const { root } of parsed) root.walkRules((r) => { if (!inKeyframes(r) && positionsOf(r)?.positions.some((p) => p.endless)) n++; });
    expect(n).toBeGreaterThan(20);
  });

  it('(i) endless keyframes animate only transform / opacity', () => {
    const bad: string[] = [];
    for (const { file, root } of parsed) {
      root.walkRules((rule) => {
        if (inKeyframes(rule)) return;
        const found = positionsOf(rule);
        if (!found) return;
        for (const p of found.positions) {
          if (!p.endless) continue;
          const { name } = nameOf(p.text);
          if (!name) { bad.push(`${file}:${rule.source?.start?.line} no keyframes name in "${p.text}"`); continue; }
          const props = keyframes.get(name);
          if (!props) { bad.push(`${file}:${rule.source?.start?.line} @keyframes ${name} not found`); continue; }
          const extra = [...props].filter((pr) => !COMPOSITED.test(pr));
          if (extra.length) bad.push(`${file}:${rule.source?.start?.line} @keyframes ${name} sets ${extra.join(', ')}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('(ii)+(iii) endless positions are named and played through the variables', () => {
    const bad: string[] = [];
    for (const { file, root } of parsed) {
      root.walkRules((rule) => {
        if (inKeyframes(rule)) return;
        const found = positionsOf(rule);
        if (!found || !found.positions.some((p) => p.endless)) return;
        const at = `${file}:${rule.source?.start?.line} (${rule.selector.replace(/\s+/g, ' ')})`;
        for (const p of found.positions) {
          const { viaVar } = nameOf(p.text);
          if (p.endless && !viaVar) bad.push(`${at} endless "${p.text}" not named through --dc-motion-status-name / --dc-motion-ambient-name`);
          if (!p.endless && /--dc-motion-/.test(p.text)) bad.push(`${at} one-shot "${p.text}" carries a motion variable`);
        }
        const play = rule.nodes.filter((n): n is Declaration => n.type === 'decl' && n.prop === 'animation-play-state').pop();
        if (!play) { bad.push(`${at} no animation-play-state: var(--dc-motion-play, running)`); return; }
        const states = splitTop(play.value, ',');
        if (states.length !== found.positions.length) {
          bad.push(`${at} play-state list (${states.length}) ≠ animation list (${found.positions.length})`);
          return;
        }
        found.positions.forEach((p, i) => {
          const s = states[i];
          if (p.endless && !PLAY_VAR.test(s)) bad.push(`${at} endless position ${i + 1} plays "${s}", not var(--dc-motion-play, running)`);
          if (!p.endless && s !== 'running') bad.push(`${at} one-shot position ${i + 1} plays "${s}", not running`);
        });
      });
    }
    expect(bad).toEqual([]);
  });

  it('(iv) no literal play-state; play-state after the shorthand', () => {
    const bad: string[] = [];
    for (const { file, root } of parsed) {
      root.walkDecls((d) => {
        if (inKeyframes(d) || inReducedMotion(d)) return;
        const at = `${file}:${d.source?.start?.line}`;
        if (d.prop === 'animation-play-state' && !/var\(\s*--dc-motion-play/.test(d.value)) {
          bad.push(`${at} literal animation-play-state: ${d.value} (use a local --dc-motion-play)`);
        }
        if (d.prop === 'animation' && splitTop(d.value, ',').some((p) => splitTop(p, ' ').some((t) => t === 'paused' || t === 'running'))) {
          bad.push(`${at} play-state keyword inside the animation shorthand: ${d.value}`);
        }
      });
      root.walkRules((rule) => {
        const decls = rule.nodes.filter((n): n is Declaration => n.type === 'decl');
        const lastShort = decls.map((d) => d.prop).lastIndexOf('animation');
        const lastPlay = decls.map((d) => d.prop).lastIndexOf('animation-play-state');
        if (lastShort >= 0 && lastPlay >= 0 && lastPlay < lastShort) {
          bad.push(`${file}:${rule.source?.start?.line} animation-play-state before the animation shorthand (reset by it)`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('(v) no endless animation set from TS/TSX', () => {
    const bad: string[] = [];
    for (const f of walk(SRC, ['.ts', '.tsx'])) {
      const rel = relative(SRC, f);
      if (rel in TS_ALLOWLIST) continue;
      const text = readFileSync(f, 'utf8');
      for (const re of TS_ENDLESS_PATTERNS) {
        for (const m of text.matchAll(re)) {
          const line = text.slice(0, m.index).split('\n').length;
          bad.push(`${rel}:${line} ${m[0].replace(/\s+/g, ' ').trim().slice(0, 120)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('(v) the TS/TSX scan sees a wrapped value, an SVG <animate> and a Web Animation', () => {
    // The scan's OWN patterns (a copy here would stay green with the scan's broken).
    const hit = (t: string) => TS_ENDLESS_PATTERNS.some((r) => new RegExp(r.source, r.flags.replace('g', '')).test(t));
    expect(hit("style={{ animation:\n  'spin 1s linear infinite' }}")).toBe(true);
    expect(hit('<animate attributeName="r" repeatCount="indefinite" />')).toBe(true);
    expect(hit('el.animate(frames, { duration: 900, iterations: Infinity })')).toBe(true);
    expect(hit('el.animate(frames, { duration: 900, iterations: 1 })')).toBe(false);
  });

  it('only the reduce branch of prefers-reduced-motion is exempt', () => {
    const declIn = (css: string) => {
      let d: Declaration | null = null;
      postcss.parse(css).walkDecls('animation', (x) => { d = x; });
      return d!;
    };
    expect(inReducedMotion(declIn('@media (prefers-reduced-motion: reduce) { .a { animation: x 1s infinite; } }'))).toBe(true);
    expect(inReducedMotion(declIn('@media (prefers-reduced-motion:reduce) { .a { animation: x 1s infinite; } }'))).toBe(true);
    expect(inReducedMotion(declIn('@media (prefers-reduced-motion: no-preference) { .a { animation: x 1s infinite; } }'))).toBe(false);
    expect(inReducedMotion(declIn('.a { animation: x 1s infinite; }'))).toBe(false);
  });

  it('a huge finite count counts as endless; a small one or a timing function does not', () => {
    expect(endlessText('pulse 1s ease 9999')).toBe(true);
    expect(endlessText('pulse 1s cubic-bezier(.2, 80, .2, 1) 2')).toBe(false);
    expect(endlessText('pop 200ms ease-out both')).toBe(false);
  });

  it('(vi) every window steps its endless animations at 15-20 fps, never on the display link', () => {
    // The contract's variables decide WHETHER an animation runs; lib/motionClock.ts decides how
    // often it moves (task: durum animasyonları WindowServer'ı yormaz, AC4). Every window boots
    // through main.tsx -> App.tsx, so the clock is started there, at module scope, unconditionally.
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    expect(main).toMatch(/import \{ App \} from '\.\/App';/);
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/^import \{ initMotionClock \} from '\.\/lib\/motionClock';$/m);
    expect(app).toMatch(/^initMotionClock\(\);$/m);
    const clock = readFileSync(join(SRC, 'lib', 'motionClock.ts'), 'utf8');
    const fps = Number(/export const MOTION_FPS = (\d+);/.exec(clock)?.[1]);
    expect(fps).toBeGreaterThanOrEqual(15);
    expect(fps).toBeLessThanOrEqual(20);
    // It holds what the contract runs: endless by the same line this guard uses.
    expect(clock).toMatch(new RegExp(`export const ENDLESS_COUNT = ${ENDLESS_COUNT};`));
    expect(readFileSync(join(SRC, 'styles', 'global.css'), 'utf8')).toMatch(/lib\/motionClock\.ts/);
  });

  it('every allowlisted TS file still exists and says why', () => {
    for (const [rel, why] of Object.entries(TS_ALLOWLIST)) {
      expect(statSync(join(SRC, rel)).isFile()).toBe(true);
      expect(why.length).toBeGreaterThan(20);
    }
  });
});

// Light mode keeps STATUS motion (it removes only ambient decoration): a `:root[data-light='true']`
// rule that restyles an element whose animation is a status animation was written for the old
// Light mode that stopped it. With the animation running again it freezes the look (a spinner
// whose whole border is one colour turns with nothing visibly moving) or breaks it (an
// indeterminate bar forced to full width that still sweeps off its track).
describe('Light mode leaves status animations alone', () => {
  it('no Light-mode rule restyles an element that runs a status animation', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC, ['.css'])) {
      const root = postcss.parse(readFileSync(file, 'utf-8'), { from: file });
      const statusSelectors = new Set<string>();
      root.walkRules((rule) => {
        const animated = rule.nodes?.some((n) => n.type === 'decl'
          && /^animation(-name)?$/.test((n as Declaration).prop)
          && /--dc-motion-status-name/.test((n as Declaration).value));
        if (animated) for (const s of rule.selectors) statusSelectors.add(s.replace(/\s+/g, ' ').trim());
      });
      root.walkRules((rule) => {
        for (const s of rule.selectors) {
          const m = s.replace(/\s+/g, ' ').trim().match(/^:root\[data-light=['"]true['"]\] (.+)$/);
          if (m && statusSelectors.has(m[1])) offenders.push(`${relative(SRC, file)}: ${s}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
