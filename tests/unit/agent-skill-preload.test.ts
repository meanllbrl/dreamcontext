import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

/**
 * Which skill each shipped agent PRELOADS (`skills:` frontmatter), and whether its
 * body still tells the truth about that.
 *
 * A preloaded skill is injected whole into the sub-agent's context at startup. The
 * full `dreamcontext` skill is the main session's operating manual; a haiku explorer
 * or a sleep specialist does not need its Entity Router or ECO rules, so every agent
 * preloads the small `dreamcontext-agent-core` instead. The exception is the four
 * agents whose JOB is judging a brain against the skill's current conventions: they
 * keep the full manual, because the skill IS their spec.
 *
 * Switching a preload is only half the change. An agent body that still says "the
 * skill defines the schema" or "without the dreamcontext skill you would…" sends the
 * agent looking for text it no longer has. The phrase guard catches that, and the
 * citation check proves every `references/<file>.md § "<Heading>"` pointer an agent
 * was given lands on a heading that exists.
 */

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const AGENT_DIRS = ['agents', join('skill-packs', 'agents')];

const FULL_SKILL = 'dreamcontext';
const AGENT_CORE = 'dreamcontext-agent-core';

/** Conformance judges: they grade a brain against the full skill, so they keep it. */
const FULL_SKILL_AGENTS = new Set([
  'curator-auditor', 'curator-verifier', 'initializer-scout', 'initializer-verifier',
]);

/** Every agent that used to preload the full skill and now preloads agent-core. */
const AGENT_CORE_AGENTS = new Set([
  // core agents
  'dreamcontext-explore', 'initializer-ingestor', 'curator-worker',
  'sleep-migration', 'sleep-learn', 'sleep-tasks', 'sleep-product', 'sleep-state',
  // skill-pack agents
  'council-persona', 'council-synthesizer', 'discover-brand',
  'goal-implementer', 'goal-plan-reviewer', 'goal-planner', 'goal-validator',
  'marketing-creative', 'marketing-monitor', 'marketing-strategy',
  'review-cloud-functions', 'review-edge-cases', 'review-frontend', 'review-router',
  'review-security', 'reviewer',
]);

/** Claims that only hold when the FULL skill is preloaded. */
const FULL_SKILL_CLAIMS = [
  /\bthe (dreamcontext )?skill (also )?defines\b/i,
  /\bwithout the (dreamcontext )?skill\b/i,
  /auto-loaded by the dreamcontext skill/i,
  /\bif the dreamcontext skill is unavailable\b/i,
  /\bthe skill's\b/i,
];

/** `references/<file>.md § "<Heading>"` or `SKILL.md § "<Heading>"`, optionally backticked. */
const CITATION = /(references\/[a-z-]+\.md|SKILL\.md)`?\s+§\s+"([^"]+)"/g;

interface ShippedAgent {
  name: string;
  path: string;
  skills: string[];
  content: string;
}

function loadAgents(): ShippedAgent[] {
  const out: ShippedAgent[] = [];
  for (const dir of AGENT_DIRS) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.md')).sort()) {
      const path = join(dir, file);
      const content = readFileSync(join(ROOT, path), 'utf-8');
      const { data } = matter(content);
      const skills = Array.isArray(data.skills) ? data.skills.map(String) : [];
      out.push({ name: file.replace(/\.md$/, ''), path, skills, content });
    }
  }
  return out;
}

/** name -> SKILL.md path, for every skill the package ships (core folders + packs). */
function shippedSkills(): Map<string, string> {
  const map = new Map<string, string>();
  const candidates: string[] = [];
  for (const entry of readdirSync(ROOT)) {
    if (entry === 'skill' || entry.startsWith('skill-')) candidates.push(join(entry, 'SKILL.md'));
  }
  for (const rel of candidates) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const { data } = matter(readFileSync(abs, 'utf-8'));
    if (typeof data.name === 'string') map.set(data.name, rel);
  }
  // A pack installs to `.claude/skills/<pack-dir>/`, so its folder name IS the skill
  // name an agent preloads, whatever its SKILL.md frontmatter says.
  for (const pack of readdirSync(join(ROOT, 'skill-packs'))) {
    const rel = join('skill-packs', pack, 'SKILL.md');
    if (existsSync(join(ROOT, rel))) map.set(pack, rel);
  }
  return map;
}

function headingsOf(rel: string): string[] {
  return readFileSync(join(ROOT, rel), 'utf-8')
    .split('\n')
    .map((l) => /^#{1,3} (.+)$/.exec(l)?.[1]?.trim())
    .filter((h): h is string => typeof h === 'string');
}

const AGENTS = loadAgents();

describe('shipped agents preload the right dreamcontext skill', () => {
  it('found the agent directories (sanity)', () => {
    expect(AGENTS.length).toBeGreaterThanOrEqual(30);
  });

  it('no agent preloads both the full skill and agent-core', () => {
    const both = AGENTS.filter((a) => a.skills.includes(FULL_SKILL) && a.skills.includes(AGENT_CORE));
    expect(both.map((a) => a.path)).toEqual([]);
  });

  it('only the conformance judges preload the full skill', () => {
    const full = AGENTS.filter((a) => a.skills.includes(FULL_SKILL)).map((a) => a.name).sort();
    expect(full).toEqual([...FULL_SKILL_AGENTS].sort());
  });

  it.each([...AGENT_CORE_AGENTS])('%s preloads dreamcontext-agent-core', (name) => {
    const agent = AGENTS.find((a) => a.name === name);
    expect(agent, `agent ${name} not found`).toBeDefined();
    expect(agent!.skills).toContain(AGENT_CORE);
  });

  it('every skill an agent names is one the package ships', () => {
    const shipped = shippedSkills();
    expect(shipped.get(FULL_SKILL)).toBe(join('skill', 'SKILL.md'));
    expect(shipped.get(AGENT_CORE)).toBe(join('skill-agent-core', 'SKILL.md'));
    const missing = AGENTS.flatMap((a) => a.skills
      .filter((s) => !shipped.has(s))
      .map((s) => `${a.path}: ${s}`));
    expect(missing).toEqual([]);
  });
});

describe('agent bodies only claim the skill they actually preload', () => {
  const withoutFullSkill = AGENTS.filter((a) => !a.skills.includes(FULL_SKILL));

  it.each(FULL_SKILL_CLAIMS.map((re) => [String(re), re] as const))(
    'no agent without the full skill says %s',
    (_label, re) => {
      const offenders = withoutFullSkill
        .filter((a) => re.test(a.content))
        .map((a) => `${a.path}: ${re.exec(a.content)?.[0]}`);
      expect(offenders).toEqual([]);
    },
  );
});

describe('every reference citation in an agent resolves to a real heading', () => {
  const citations = AGENTS.flatMap((a) => [...a.content.matchAll(CITATION)].map((m) => ({
    agent: a.path,
    file: m[1] === 'SKILL.md' ? join('skill', 'SKILL.md') : join('skill', m[1]),
    heading: m[2],
  })));

  it('agents cite the references they now point to (sanity)', () => {
    expect(citations.length).toBeGreaterThanOrEqual(5);
  });

  it('each cited file exists and has a heading starting with the cited text', () => {
    const broken = citations.filter((c) => {
      if (!existsSync(join(ROOT, c.file))) return true;
      return !headingsOf(c.file).some((h) => h.startsWith(c.heading));
    }).map((c) => `${c.agent} -> ${c.file} § "${c.heading}"`);
    expect(broken).toEqual([]);
  });
});
