import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splitAllLegacy, splitLegacyManifest, SplitInterruptedError } from '../../src/lib/agents/split.js';
import { getAgent, listAgentTargets } from '../../src/lib/agents/store.js';
import {
  createAutomation,
  deriveFlowFromManifest,
  getAutomation,
  getRunTarget,
  writeFlowSection,
} from '../../src/lib/automations/store.js';
import { approveAutomation, automationsRegistryPath, checkApproval, manifestHash } from '../../src/lib/automations/registry.js';
import { negationIsEffective, type AutomationManifest } from '../../src/lib/automations/types.js';

const NOW = new Date('2026-10-11T10:00:00Z');

const SCHED_FILE = [
  '---',
  'id: auto_dig1',
  'title: Digest',
  'mode: sched',
  'photo: automations/photos/digest.png',
  'schedule:',
  '  days: daily',
  '  at: "18:00"',
  'model: opus',
  'effort: high',
  'timeout_minutes: 20',
  'learning: true',
  'review: agent',
  '---',
  '',
  '## Prompt',
  'Summarise the day.',
  '',
  '## Output instructions',
  'One page.',
  '',
  '## Pattern',
  '### Playbook',
  'Be brief.',
  '',
  '## Changelog',
  '- created',
  '',
].join('\n');

let proj: string;
let ctx: string;
let home: string;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'dc-agents-split-'));
  ctx = join(proj, '_dream_context');
  mkdirSync(join(ctx, 'automations'), { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-agents-split-home-'));
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const slotPath = (slug: string) => join(ctx, 'automations', `${slug}.md`);
const agentFilePath = (slug: string) => join(ctx, 'agents', `${slug}.md`);

/** An on-call agent made the way the dashboard makes one: created, then given its derived flow. */
function dashboardCallAgent(slug = 'helper'): AutomationManifest {
  createAutomation(ctx, {
    slug,
    title: 'Helper',
    mode: 'call',
    prompt: 'Answer when asked.',
    model: 'sonnet',
    review: 'agent',
    timeoutMinutes: 30,
    outputInstructions: 'Write a short note.',
  });
  return writeFlowSection(ctx, slug, deriveFlowFromManifest(getAutomation(ctx, slug) as AutomationManifest));
}

describe('splitLegacyManifest: scheduled', () => {
  it('splits into agent + bound job with the same hash, and the approval holds with no registry write', () => {
    writeFileSync(slotPath('digest'), SCHED_FILE);
    const legacy = getAutomation(ctx, 'digest') as AutomationManifest;
    approveAutomation(proj, legacy, NOW, home);
    const registryBefore = readFileSync(automationsRegistryPath(home), 'utf-8');

    expect(splitLegacyManifest(ctx, 'digest', { home })).toEqual({
      outcome: 'split',
      files: ['agents/digest.md', 'automations/digest.md'],
    });
    const job = readFileSync(slotPath('digest'), 'utf-8');
    expect(job).toMatch(/^agent: digest$/m);
    expect(job).not.toContain('## Prompt');
    expect(job).not.toContain('## Pattern');
    expect(job).not.toMatch(/^(model|effort|photo|learning):/m);
    expect(job).toContain('## Output instructions');
    expect(job).toContain('## Changelog');

    const agent = readFileSync(agentFilePath('digest'), 'utf-8');
    expect(agent).toMatch(/^migrated_from: auto_dig1$/m);
    expect(agent).toMatch(/^id: agt_dig1$/m);
    expect(agent).toContain('Be brief.');
    expect(agent).not.toMatch(/^call:/m);

    const after = getRunTarget(ctx, 'digest', 'automation') as AutomationManifest;
    expect(manifestHash(after)).toBe(manifestHash(legacy));
    expect(checkApproval(proj, after, home).approved).toBe(true);
    expect(readFileSync(automationsRegistryPath(home), 'utf-8')).toBe(registryBefore);
  });
});

describe('splitLegacyManifest: on-call', () => {
  it('becomes agent-only with its run settings as call settings, same hash, approved through rule (b)', () => {
    const legacy = dashboardCallAgent();
    expect(legacy.flow).not.toBeNull();
    approveAutomation(proj, legacy, NOW, home);

    expect(splitLegacyManifest(ctx, 'helper', { home }).outcome).toBe('split');
    expect(existsSync(slotPath('helper'))).toBe(false);
    const text = readFileSync(agentFilePath('helper'), 'utf-8');
    expect(text).toMatch(/^call:$/m);
    expect(text).toContain('## Flow');
    expect(text).toContain('Write a short note.');

    const target = getRunTarget(ctx, 'helper', 'agent') as AutomationManifest;
    expect(manifestHash(target)).toBe(manifestHash(legacy));
    expect(checkApproval(proj, target, home, 'run')).toMatchObject({ approved: true, via: 'legacy-key' });
    expect(target).toMatchObject({ timeoutMinutes: 30, review: 'agent', outputInstructions: 'Write a short note.' });
  });

  it('an unapproved manifest stays unapproved after the split', () => {
    dashboardCallAgent();
    splitLegacyManifest(ctx, 'helper', { home });
    expect(checkApproval(proj, getRunTarget(ctx, 'helper', 'agent') as AutomationManifest, home, 'identity').approved).toBe(false);
  });
});

describe('idempotence, determinism, resumption', () => {
  it('a second split changes nothing and a full second pass finds nothing to do', () => {
    writeFileSync(slotPath('digest'), SCHED_FILE);
    dashboardCallAgent();
    const first = splitAllLegacy(ctx, { home });
    expect(first.failed).toBe(0);
    expect(first.results.map((r) => r.outcome)).toEqual(['split', 'split']);
    const bytes = [readFileSync(slotPath('digest'), 'utf-8'), readFileSync(agentFilePath('digest'), 'utf-8'), readFileSync(agentFilePath('helper'), 'utf-8')];

    expect(splitLegacyManifest(ctx, 'digest', { home }).outcome).toBe('already-split');
    expect(splitLegacyManifest(ctx, 'helper', { home }).outcome).toBe('already-split');
    expect(splitAllLegacy(ctx, { home }).results).toEqual([]);
    expect([readFileSync(slotPath('digest'), 'utf-8'), readFileSync(agentFilePath('digest'), 'utf-8'), readFileSync(agentFilePath('helper'), 'utf-8')]).toEqual(bytes);
  });

  it('two machines splitting the same file write the same bytes', () => {
    const other = mkdtempSync(join(tmpdir(), 'dc-agents-split-b-'));
    try {
      const otherCtx = join(other, '_dream_context');
      mkdirSync(join(otherCtx, 'automations'), { recursive: true });
      writeFileSync(slotPath('digest'), SCHED_FILE);
      writeFileSync(join(otherCtx, 'automations', 'digest.md'), SCHED_FILE);
      splitLegacyManifest(ctx, 'digest', { home });
      splitLegacyManifest(otherCtx, 'digest', { home });
      expect(readFileSync(join(otherCtx, 'agents', 'digest.md'), 'utf-8')).toBe(readFileSync(agentFilePath('digest'), 'utf-8'));
      expect(readFileSync(join(otherCtx, 'automations', 'digest.md'), 'utf-8')).toBe(readFileSync(slotPath('digest'), 'utf-8'));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('a crash right after the agent file leaves the legacy file authoritative, and a rerun finishes', () => {
    writeFileSync(slotPath('digest'), SCHED_FILE);
    expect(() => splitLegacyManifest(ctx, 'digest', { home, failAfter: 'agent' })).toThrow(SplitInterruptedError);
    expect(readFileSync(slotPath('digest'), 'utf-8')).toBe(SCHED_FILE);
    expect(existsSync(agentFilePath('digest'))).toBe(true);
    expect(getAgent(ctx, 'digest')).toMatchObject({ implicit: true });
    expect(listAgentTargets(ctx).filter((t) => t.slug === 'digest')).toHaveLength(1);

    expect(splitLegacyManifest(ctx, 'digest', { home }).outcome).toBe('split');
  });
});

describe('conflicts never pin the vault and leave the legacy file untouched', () => {
  it('a foreign agents/<slug>.md', () => {
    writeFileSync(slotPath('digest'), SCHED_FILE);
    mkdirSync(join(ctx, 'agents'), { recursive: true });
    writeFileSync(agentFilePath('digest'), '---\nid: agt_other\ntitle: Someone else\n---\n\n## Prompt\nOther.\n');
    const r = splitLegacyManifest(ctx, 'digest', { home });
    expect(r.outcome).toBe('conflict');
    expect(readFileSync(slotPath('digest'), 'utf-8')).toBe(SCHED_FILE);
    expect(splitAllLegacy(ctx, { home }).failed).toBe(0);
  });

  it('a symlinked manifest', () => {
    const outside = join(proj, 'outside.md');
    writeFileSync(outside, SCHED_FILE);
    symlinkSync(outside, slotPath('evil'));
    expect(splitLegacyManifest(ctx, 'evil', { home }).outcome).toBe('conflict');
    expect(splitAllLegacy(ctx, { home })).toMatchObject({ failed: 0, results: [{ slug: 'evil', outcome: 'conflict' }] });
    expect(existsSync(agentFilePath('evil'))).toBe(false);
  });
});

describe('what the split writes around the files', () => {
  it('ensures the agents block, and shares the agent of a shared manifest', () => {
    writeFileSync(slotPath('digest'), SCHED_FILE.replace('mode: sched', 'mode: sched\nshared: true'));
    splitLegacyManifest(ctx, 'digest', { home });
    const brain = readFileSync(join(ctx, '.gitignore'), 'utf-8');
    expect(negationIsEffective(brain, '!agents/digest.md', ['agents/*.md'])).toBe(true);
    const root = readFileSync(join(proj, '.gitignore'), 'utf-8');
    expect(negationIsEffective(root, '!_dream_context/agents/digest.md', ['_dream_context/agents/*.md'])).toBe(true);
  });

  it('a private manifest gets the block and no negation', () => {
    writeFileSync(slotPath('digest'), SCHED_FILE);
    splitLegacyManifest(ctx, 'digest', { home });
    const brain = readFileSync(join(ctx, '.gitignore'), 'utf-8');
    expect(brain).toContain('agents/*.md');
    expect(brain).not.toContain('!agents/digest.md');
  });

  it('backs the legacy file up machine-locally: folder 0700, file 0600', () => {
    writeFileSync(slotPath('digest'), SCHED_FILE);
    splitLegacyManifest(ctx, 'digest', { home });
    const key = createHash('sha256').update(proj, 'utf8').digest('hex').slice(0, 16);
    const dir = join(home, '.dreamcontext', 'backups', 'agents-split', key);
    expect(readFileSync(join(dir, 'digest.md'), 'utf-8')).toBe(SCHED_FILE);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700); // Windows has no POSIX mode bits
    if (process.platform !== 'win32') expect(statSync(join(dir, 'digest.md')).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
  });
});
