import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE AGENTS PAGE SPEAKS ONLY IN TOKENS — every colour, text size, weight, duration and curve
 * in the stylesheets the page owns comes from `tokens.css`, so light and dark render one layout
 * and the type ladder stays two sizes and two weights (the Elevated UX pass, 2026-09-25).
 *
 * WHY A SOURCE SCAN. A hard-coded `rgba(0,0,0,0.08)` shadow looks right in light and vanishes
 * in dark; a stray `13px` passes every screenshot that does not happen to measure it. The runtime
 * suites sample what they render; this reads every declaration. `AGENTS_CSS_ROOT` points the scan
 * at another `dashboard/src` (the mutation proof runs it against the pre-fix files).
 *
 * Refused in a declaration: a hex colour, `rgb()/rgba()/hsl()`, a numeric `font-size`, a
 * `font-weight` other than 400/600 (or their tokens), a non-zero time literal (`150ms`, `1.1s`),
 * and `cubic-bezier(`. `tokens.css` itself is where those literals belong and is not scanned.
 */

const ROOT = process.env.AGENTS_CSS_ROOT ?? join(new URL('../../', import.meta.url).pathname, 'dashboard/src');

const FILES = [
  'components/agents/AgentsFeed.css',
  'components/agents/AgentsFeedFilters.css',
  'components/agents/AgentMemberCard.css',
  'components/agents/AgentsMembers.css',
  'pages/AutomationsPage.css',
  'components/automations/AutomationsDispatcherBar.css',
  'components/automations/AutomationsEmptyState.css',
];

interface Decl { file: string; line: number; prop: string; value: string }

function declarations(file: string): Decl[] {
  const src = readFileSync(join(ROOT, file), 'utf8');
  // Blank comments out but keep their newlines, so line numbers stay true.
  const text = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: Decl[] = [];
  const re = /(^|[;{\s])(-?[a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const prop = m[2];
    if (prop.startsWith('--')) continue; // a custom property is a local name, checked where used
    const line = text.slice(0, m.index + m[1].length).split('\n').length;
    out.push({ file, line, prop, value: m[3].trim() });
  }
  return out;
}

function offence({ prop, value }: Decl): string | null {
  if (/#[0-9a-f]{3,8}\b/i.test(value)) return 'hex colour';
  if (/\b(rgba?|hsla?)\(/i.test(value)) return 'literal colour function';
  if (/cubic-bezier\(/i.test(value)) return 'literal curve';
  if (prop === 'font-size' && /^[\d.]/.test(value)) return 'numeric font-size';
  if (prop === 'font-weight' && !/^(400|600|inherit|var\(--font-weight-(normal|semibold)\))$/.test(value)) {
    return 'weight off the 400/600 ladder';
  }
  if (/^(transition|animation)/.test(prop)) {
    const times = value.match(/(?<![\w-])\d*\.?\d+m?s\b/g) ?? [];
    if (times.some((t) => parseFloat(t) !== 0)) return 'literal duration';
  }
  return null;
}

describe('Agents page stylesheets use tokens only', () => {
  for (const file of FILES) {
    it(file, () => {
      if (!existsSync(join(ROOT, file))) return; // a file the page does not have (yet) has nothing to refuse
      const bad = declarations(file)
        .map((d) => ({ d, why: offence(d) }))
        .filter((x) => x.why)
        .map(({ d, why }) => `${d.file}:${d.line} ${d.prop}: ${d.value}  (${why})`);
      expect(bad).toEqual([]);
    });
  }
});
