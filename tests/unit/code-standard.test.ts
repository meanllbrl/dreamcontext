/**
 * The `engineering` skill pack is retired (owner, 2026-11-04: "ajanlar yutsun onu"): its rules
 * live in the agents, so they hold in a project that never installed the pack. These tests
 * keep it that way:
 *  - every agent copy of a shared block equals the one in src/lib/code-standard.ts;
 *  - the `claude -p` planner and builders, which never read an agent file, get the blocks
 *    through their printed briefs;
 *  - no shipped agent declares or loads `engineering`, and the catalog no longer offers it;
 *  - Codex and Antigravity role translations follow (they read `skills:` live).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { CODE_STANDARD, PLAN_STANDARD, DOMAIN_RULES } from '../../src/lib/code-standard.js';
import { PLANNER_BRIEF } from '../../src/lib/planner-brief.js';
import { BUILDER_BRIEF } from '../../src/lib/builder-brief.js';
import { roleToml } from '../../src/lib/codex-skills.js';
import { antigravityRoleMd } from '../../src/lib/antigravity-roles.js';

const ROOT = join(__dirname, '..', '..');
const AGENTS = join(ROOT, 'agents');
const read = (p: string): string => readFileSync(p, 'utf-8');
const agent = (name: string): string => read(join(AGENTS, `${name}.md`));

const BLOCKS = { CODE_STANDARD, PLAN_STANDARD, DOMAIN_RULES } as const;
type Block = keyof typeof BLOCKS;

/** Which agent carries which block. A new carrier is added here, with its copy. */
const CARRIERS: Record<string, Block[]> = {
  reviewer: ['CODE_STANDARD', 'DOMAIN_RULES'],
  'goal-implementer': ['CODE_STANDARD', 'DOMAIN_RULES'],
  'goal-planner': ['CODE_STANDARD', 'PLAN_STANDARD'],
  'goal-plan-reviewer': ['CODE_STANDARD', 'PLAN_STANDARD'],
};

/** Every agent-shaped file the package ships: the agents and the marketing council personas. */
function shippedAgentFiles(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(AGENTS)) if (f.endsWith('.md')) out.push(join(AGENTS, f));
  const personas = join(ROOT, 'assets', 'marketing-council-personas');
  if (existsSync(personas)) for (const f of readdirSync(personas)) if (f.endsWith('.md')) out.push(join(personas, f));
  return out;
}

describe('the code standard reaches every agent that builds or judges code', () => {
  for (const [name, blocks] of Object.entries(CARRIERS)) {
    for (const block of blocks) {
      it(`${name} carries ${block} word for word, behind its drift marker`, () => {
        const text = agent(name);
        expect(text).toContain(`<!-- Verbatim copy of ${block} (src/lib/code-standard.ts); a drift test holds them equal. -->\n${BLOCKS[block]}`);
      });
    }
  }

  it('no agent carries a marker for a block it is not listed for (a stale copy cannot hide)', () => {
    for (const f of readdirSync(AGENTS).filter((x) => x.endsWith('.md'))) {
      const name = f.replace(/\.md$/, '');
      const markers = [...read(join(AGENTS, f)).matchAll(/Verbatim copy of (CODE_STANDARD|PLAN_STANDARD|DOMAIN_RULES) /g)].map((m) => m[1]);
      expect(markers.sort(), name).toEqual([...(CARRIERS[name] ?? [])].sort());
    }
  });

  it('the specialists hold their own domain inline', () => {
    expect(agent('review-cloud-functions')).toMatch(/## The three guards/);
    expect(agent('review-cloud-functions')).toMatch(/`event\.id` is checked and recorded in the SAME transaction/);
    expect(agent('review-security')).toMatch(/### Firestore security rules/);
    expect(agent('review-frontend')).toMatch(/\*\*Missing feedback state\*\*/);
    expect(agent('review-edge-cases')).toMatch(/\*\*Non-idempotent retry path\*\*/);
    expect(agent('goal-validator')).toMatch(/one that passes only on a re-run is flaky, which is a FAIL/);
  });

  it('the claude -p planner and builders get the blocks through their briefs', () => {
    expect(PLANNER_BRIEF).toContain(CODE_STANDARD);
    expect(PLANNER_BRIEF).toContain(PLAN_STANDARD);
    expect(BUILDER_BRIEF).toContain(CODE_STANDARD);
    expect(BUILDER_BRIEF).toContain(DOMAIN_RULES);
    expect(PLANNER_BRIEF).not.toMatch(/`engineering`/);
  });

  it('Codex and Antigravity roles carry the standard and open no engineering skill', () => {
    const md = agent('reviewer');
    const codex = roleToml(md);
    const anti = antigravityRoleMd(md);
    expect(codex?.toml).toBeTruthy();
    expect(anti?.md).toBeTruthy();
    for (const text of [codex!.toml, anti!.md]) {
      expect(text).not.toMatch(/open these skills:[^\n.]*engineering/);
      expect(text).toContain('## The code standard');
      expect(text).toContain('## When the change is one of these');
    }
  });
});

describe('the engineering pack is gone', () => {
  it('no shipped agent declares the engineering skill or tells itself to load it', () => {
    const offenders: string[] = [];
    for (const f of shippedAgentFiles()) {
      const raw = read(f);
      const skills = matter(raw).data.skills;
      if (Array.isArray(skills) && skills.includes('engineering')) offenders.push(`${f}: skills`);
      if (/skills\/engineering\b|`engineering`(?: skill| pack|:)|\*\*engineering\*\*/.test(raw)) offenders.push(`${f}: body`);
    }
    expect(offenders).toEqual([]);
  });

  it('nothing ships it any more: no pack folder, and the reviewer is a core agent', () => {
    expect(existsSync(join(ROOT, 'skill-packs'))).toBe(false);
    expect(existsSync(join(ROOT, 'skill-engineering'))).toBe(false);
    expect(existsSync(join(ROOT, 'agents', 'reviewer.md'))).toBe(true);
  });
});
