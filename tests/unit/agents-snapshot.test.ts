/**
 * The snapshot's agent lines come from `listAgentTargets` (src/lib/automations/snapshot.ts).
 *
 * Mutation-tested: computing the agent verdict with `'identity'` instead of `'run'` silences the
 * unapproved-run agent below; dropping the agent loop (automations only) silences it too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAutomationsSnapshot } from '../../src/lib/automations/snapshot.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { splitLegacyManifest } from '../../src/lib/agents/split.js';

const NOW = new Date('2026-10-12T09:00:00.000Z');
let proj: string;
let ctx: string;
let home: string;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'dc-agents-snapshot-'));
  ctx = join(proj, '_dream_context');
  mkdirSync(join(ctx, 'automations'), { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-agents-snapshot-home-'));
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const lines = () => buildAutomationsSnapshot(ctx, { home, now: NOW }).lines;

describe('snapshot agent lines', () => {
  it('a migrated call agent approved before the split shows no approval line', () => {
    const helper = createAutomation(ctx, { slug: 'helper', title: 'Helper', mode: 'call', prompt: 'Help.', review: 'agent' });
    approveAutomation(proj, helper, NOW, home);
    expect(splitLegacyManifest(ctx, 'helper', { home }).outcome).toBe('split');
    expect(lines().join('\n')).not.toContain('helper');
  });

  it('a scheduled agent that only runs through its approved job is not news', () => {
    const digest = createAutomation(ctx, { slug: 'digest', title: 'Digest', prompt: 'Write.', days: 'daily', at: '18:00' });
    approveAutomation(proj, digest, NOW, home);
    expect(lines().join('\n')).not.toContain('needs approval');
  });

  it('an agent not approved to run names the Agents page and no command', () => {
    createAgent(ctx, { slug: 'scout', title: 'Scout', prompt: 'Scout.' });
    const out = lines();
    const line = out.find((l) => l.includes('scout'));
    expect(line).toBe('- agent scout: Scout needs approval on the AI Team page');
    expect(line).not.toContain('dreamcontext');
    expect(buildAutomationsSnapshot(ctx, { home, now: NOW }).hasBlocked).toBe(true);
  });
});
