import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySpecialistFrontmatter,
  agentBaselineSha,
  canonicalAgentForm,
  isCustomizedAgent,
} from '../../src/lib/sleep-specialist-frontmatter.js';

/**
 * A6 of the sleep umbrella. Two guarantees are load-bearing and easy to break:
 * injecting a model must not disturb a single byte of the agent's BODY, and
 * "did a human customize this?" must not fire on our own injection, on a CRLF
 * checkout, or on a re-ordered frontmatter — a false positive there silently
 * pauses auto-sleep, a false negative silently overwrites someone's edits.
 */

const REAL_AGENT = readFileSync(
  join(__dirname, '..', '..', 'agents', 'sleep-tasks.md'), 'utf8',
);

const MINIMAL = `---
name: sleep-state
description: does things
tools: Read, Write
model: claude-sonnet-4-5-20250929
---

# Body

Some prose.
`;

function bodyOf(content: string): string {
  const lf = content.split('\r\n').join('\n');
  return lf.slice(lf.indexOf('\n---', 3));
}

describe('applySpecialistFrontmatter', () => {
  it('replaces an existing model: key', () => {
    const out = applySpecialistFrontmatter(MINIMAL, { model: 'claude-opus-5' });
    expect(out).toContain('model: claude-opus-5');
    expect(out).not.toContain('claude-sonnet-4-5-20250929');
  });

  it('inserts effort: when the file has none, right after name:', () => {
    const out = applySpecialistFrontmatter(MINIMAL, { effort: 'low' });
    const lines = out.split('\n');
    expect(lines[1]).toBe('name: sleep-state');
    expect(lines[2]).toBe('effort: low');
  });

  it('replaces an existing effort: rather than adding a second one', () => {
    const once = applySpecialistFrontmatter(MINIMAL, { effort: 'low' });
    const twice = applySpecialistFrontmatter(once, { effort: 'high' });
    expect(twice.split('\n').filter((l) => l.startsWith('effort:'))).toEqual(['effort: high']);
  });

  it('is a no-op without an override', () => {
    expect(applySpecialistFrontmatter(MINIMAL, undefined)).toBe(MINIMAL);
    expect(applySpecialistFrontmatter(MINIMAL, {})).toBe(MINIMAL);
  });

  it('leaves the BODY byte-identical on a real shipped agent', () => {
    const out = applySpecialistFrontmatter(REAL_AGENT, { model: 'claude-opus-5', effort: 'medium' });
    expect(bodyOf(out)).toBe(bodyOf(REAL_AGENT));
    expect(out).toContain('model: claude-opus-5');
    expect(out).toContain('effort: medium');
  });

  it('leaves other frontmatter keys — including folded blocks — untouched', () => {
    const out = applySpecialistFrontmatter(REAL_AGENT, { model: 'claude-opus-5' });
    expect(out).toContain('description: >');
    expect(out).toContain('tools: Read, Write, Edit, Bash, Glob, Grep');
    expect(out).toContain('skills:');
  });

  it('refuses to rewrite a file with no parseable frontmatter block', () => {
    const noFm = '# Just a heading\n\nmodel: not-frontmatter\n';
    expect(applySpecialistFrontmatter(noFm, { model: 'claude-opus-5' })).toBe(noFm);
  });

  it('is idempotent — applying the same override twice changes nothing', () => {
    const once = applySpecialistFrontmatter(REAL_AGENT, { model: 'claude-opus-5', effort: 'low' });
    expect(applySpecialistFrontmatter(once, { model: 'claude-opus-5', effort: 'low' })).toBe(once);
  });
});

describe('isCustomizedAgent', () => {
  const baseline = agentBaselineSha(REAL_AGENT);

  it('a freshly installed copy is not customized', () => {
    expect(isCustomizedAgent(REAL_AGENT, baseline)).toBe(false);
  });

  it('OUR OWN model/effort injection is not a customization', () => {
    const injected = applySpecialistFrontmatter(REAL_AGENT, { model: 'claude-opus-5', effort: 'medium' });
    expect(isCustomizedAgent(injected, baseline)).toBe(false);
  });

  it('a CRLF checkout is not a customization', () => {
    expect(isCustomizedAgent(REAL_AGENT.split('\n').join('\r\n'), baseline)).toBe(false);
  });

  it('re-ordered frontmatter keys are not a customization', () => {
    const reordered = `---
description: does things
name: sleep-state
tools: Read, Write
---

# Body
`;
    const original = `---
name: sleep-state
tools: Read, Write
description: does things
---

# Body
`;
    expect(isCustomizedAgent(reordered, agentBaselineSha(original))).toBe(false);
  });

  it('a body edit IS a customization', () => {
    const edited = REAL_AGENT.replace('# Sleep — Tasks Specialist', '# Sleep — MY Tasks Specialist');
    expect(edited).not.toBe(REAL_AGENT);
    expect(isCustomizedAgent(edited, baseline)).toBe(true);
  });

  it('a non-model frontmatter edit IS a customization', () => {
    const edited = REAL_AGENT.replace('tools: Read, Write, Edit, Bash, Glob, Grep', 'tools: Read');
    expect(isCustomizedAgent(edited, baseline)).toBe(true);
  });

  it('a package body change with the project not yet updated is NOT a customization (baseline is pinned)', () => {
    // The baseline was recorded when THIS project installed. A newer package
    // shipping a different body must not read as the user having edited theirs.
    const installedThen = REAL_AGENT;
    const pinned = agentBaselineSha(installedThen);
    expect(isCustomizedAgent(installedThen, pinned)).toBe(false);
  });

  it('a manifest that predates baselineSha reads as UNCUSTOMIZED (never a false pause on upgrade)', () => {
    expect(isCustomizedAgent(REAL_AGENT, undefined)).toBe(false);
  });

  it('malformed YAML frontmatter reads as CUSTOMIZED and never throws', () => {
    const broken = '---\nname: [unclosed\n  bad: : :\n---\n\n# Body\n';
    expect(() => canonicalAgentForm(broken)).not.toThrow();
    expect(isCustomizedAgent(broken, baseline)).toBe(true);
  });
});
