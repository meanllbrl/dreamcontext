import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The quest party's visual rules, read off the source (chat/atoms.tsx + atoms.css, and T7's
 * quest/quest.css once it lands).
 *
 * - Theme tokens only: no hex anywhere in the atom sheet or the quest sheet, so both themes
 *   follow for free.
 * - Every role the registry can name has a character (RoleCharacter.tsx) and a body colour in
 *   both themes, so no teammate renders blank or inherits the other theme's paint.
 * - Running is motion (`chat-a-work`), and every use of it stands down under reduced motion.
 * - A verdict never spends `--color-warning` (reserved for genuinely hot things), and a
 *   character's face is drawn in `--color-text`, never `--color-ink`: `--color-ink` is the
 *   light theme's charcoal and does not flip in dark, where the face would vanish on its disc.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const CHAT = join(ROOT, 'dashboard/src/components/sleepy/chat');
const ATOMS_TSX = join(CHAT, 'atoms.tsx');
const ATOMS_CSS = join(CHAT, 'atoms.css');
const QUEST_CSS = join(ROOT, 'dashboard/src/components/sleepy/quest/quest.css');
const ROLES_TS = join(ROOT, 'dashboard/src/lib/agentRoles.ts');
const CHARACTER_TSX = join(CHAT, 'RoleCharacter.tsx');
const CHARACTER_CSS = join(CHAT, 'RoleCharacter.css');
const TOKENS_CSS = join(ROOT, 'dashboard/src/styles/tokens.css');

const read = (p: string): string => readFileSync(p, 'utf-8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const HEX = /#[0-9a-fA-F]{3,8}\b/;

/** Every innermost `selector { body }` rule. Nested at-rule wrappers are skipped, not parsed. */
function rules(css: string): { selector: string; body: string }[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));
}

/** The bodies of every `@media (prefers-reduced-motion: reduce) { … }` block, braces matched. */
function reducedMotionBlocks(css: string): string[] {
  const src = stripComments(css);
  const out: string[] = [];
  const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

describe('quest party style rules', () => {
  it('atoms.css carries no hex colour', () => {
    const offenders = stripComments(read(ATOMS_CSS)).split('\n').filter((l) => HEX.test(l));
    expect(offenders).toEqual([]);
  });

  it.skipIf(!existsSync(QUEST_CSS))('quest/quest.css carries no hex colour', () => {
    const offenders = stripComments(read(QUEST_CSS)).split('\n').filter((l) => HEX.test(l));
    expect(offenders).toEqual([]);
  });

  it('every AgentRoleId has a character, a body colour and a colour in both themes', () => {
    const union = /export type AgentRoleId\s*=([^;]+);/.exec(read(ROLES_TS))?.[1] ?? '';
    const ids = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(14);

    const tsx = read(CHARACTER_TSX);
    const at = tsx.indexOf('const CAST');
    expect(at, 'CAST not found in RoleCharacter.tsx').toBeGreaterThan(-1);
    const cast = tsx.slice(at, tsx.indexOf('\n};', at));
    for (const id of ids) {
      expect(cast, `no character for role "${id}"`).toMatch(new RegExp(`(?:^|\\s)'?${id}'?:\\s*\\(\\)\\s*=>`, 'm'));
    }

    // Every body hue the sheet names is declared in BOTH theme blocks of tokens.css.
    const css = read(CHARACTER_CSS);
    const tokens = [...new Set([...css.matchAll(/var\((--role-c-[a-z-]+)\)/g)].map((m) => m[1]))];
    expect(tokens.length).toBeGreaterThanOrEqual(14);
    const tokenCss = read(TOKENS_CSS);
    for (const t of tokens) {
      const n = tokenCss.split('\n').filter((l) => l.trim().startsWith(`${t}:`)).length;
      expect(n, `${t} must be declared in the light AND the dark block`).toBe(2);
    }
  });

  it('RoleCharacter.css carries no hex colour', () => {
    const offenders = stripComments(read(CHARACTER_CSS)).split('\n').filter((l) => HEX.test(l));
    expect(offenders).toEqual([]);
  });

  it('reduced motion stills every chat-a-work animation', () => {
    const css = read(ATOMS_CSS);
    const animated = rules(css)
      .filter((r) => /animation(?:-name)?:[^;]*\bchat-a-work\b/.test(r.body))
      .map((r) => r.selector);
    expect(animated.length).toBeGreaterThan(0);

    const stilled = reducedMotionBlocks(css).flatMap((block) =>
      rules(block).filter((r) => /animation:\s*none/.test(r.body)).flatMap((r) => r.selector.split(',').map((s) => s.trim())),
    );
    for (const selector of animated) {
      for (const one of selector.split(',').map((s) => s.trim())) {
        expect(stilled, `${one} animates chat-a-work with no reduced-motion stand-down`).toContain(one);
      }
    }
  });

  it('a verdict never uses the warning colour', () => {
    const verdictRules = rules(read(ATOMS_CSS)).filter((r) => r.selector.includes('.chat-a-verdict'));
    expect(verdictRules.length).toBeGreaterThan(0);
    for (const r of verdictRules) {
      expect(r.body, `${r.selector} uses --color-warning`).not.toMatch(/--color-warning/);
    }
  });

  it('avatar rules never draw in --color-ink', () => {
    const avatarRules = rules(read(ATOMS_CSS)).filter((r) => r.selector.includes('.chat-a-avatar'));
    expect(avatarRules.length).toBeGreaterThan(0);
    for (const r of avatarRules) {
      expect(r.body, `${r.selector} uses --color-ink`).not.toMatch(/--color-ink\b/);
    }
  });
});
