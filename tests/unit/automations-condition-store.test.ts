/**
 * kosullu-otomasyon C1/C2 in the store and the registry: the `## Condition` section reads, refuses
 * and writes byte-surgically; the witness mark is written only by `approvalEntryFor`, through
 * `approveAutomation` and `approvePair` alike. Fictional project: Northwind Bakery.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  approveMadeHere, conditionFieldsOf, createAutomation, getAutomation, getRunTarget, updateAutomation,
} from '../../src/lib/automations/store.js';
import {
  approveAutomation, approvePair, checkApproval, conditionNeedsWitness, getApproval, manifestHash,
} from '../../src/lib/automations/registry.js';
import { createAgent } from '../../src/lib/agents/store.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

const NOW = new Date('2026-11-15T09:00:00.000Z');
const SCRIPT = '# new orders since the last check?\ntest -s orders/new.csv && cat orders/new.csv';
let proj: string;
let ctx: string;
let home: string;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'dc-cond-store-'));
  ctx = join(proj, '_dream_context');
  mkdirSync(ctx, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-cond-store-home-'));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const make = (over: Record<string, unknown> = {}): AutomationManifest =>
  createAutomation(ctx, { slug: 'new-orders-check', title: 'New orders', days: 'daily', at: '09:00', prompt: 'Summarise the new orders.', condition: SCRIPT, ...over });

describe('reading ## Condition', () => {
  it('write-then-read is identity, the # comment kept whole', () => {
    const m = make();
    expect(m.condition).toBe(SCRIPT);
    expect(getAutomation(ctx, 'new-orders-check')!.condition).toBe(SCRIPT);
    expect(readFileSync(m.path, 'utf8')).toContain('## Condition\n\n```sh\n' + SCRIPT + '\n```');
  });

  it('a file without the heading has no condition fields at all', () => {
    expect(conditionFieldsOf('## Prompt\n\nhi\n', {})).toEqual({});
  });

  it('a section without a fence, or a hidden character, is an invalid condition', () => {
    expect(conditionFieldsOf('## Condition\n\ntest -f x\n', {}).conditionError).toMatch(/fenced sh block/);
    expect(conditionFieldsOf('## Condition\n\n```sh\ntest -f a‮b\n```\n', {}).conditionError).toMatch(/hidden/);
    expect(conditionFieldsOf('## Condition\n\n```sh\nprintf "a\tb"\n```\n', {}).conditionError).toBeUndefined();
  });

  it('condition_wake: false is read beside a script only', () => {
    expect(conditionFieldsOf('## Condition\n\n```sh\nexit 0\n```\n', { condition_wake: false }).conditionWake).toBe(false);
    expect(conditionFieldsOf('## Prompt\n\nhi\n', { condition_wake: false })).toEqual({});
  });
});

describe('writing it', () => {
  it('refuses a ## line or a fence line, and writes nothing', () => {
    expect(() => make({ condition: '## not a comment\nexit 0' })).toThrow(/Invalid condition/);
    expect(() => make({ condition: '  ```\nexit 0' })).toThrow(/Invalid condition/);
    expect(getAutomation(ctx, 'new-orders-check')).toBeNull();
  });

  it('refuses a call-mode agent and a board-limited one', () => {
    expect(() => make({ mode: 'call', days: undefined, at: undefined })).toThrow(/only call/);
  });

  it('an edit changes only the section, byte for byte everywhere else; null removes it', () => {
    const m = make();
    const before = readFileSync(m.path, 'utf8');
    updateAutomation(ctx, 'new-orders-check', { condition: 'test -s orders/urgent.csv' });
    const after = readFileSync(m.path, 'utf8');
    // Every edit restamps `updated:`; everything else outside the section is untouched.
    const noStamp = (t: string) => t.replace(/^updated: .*$/m, 'updated: X');
    expect(noStamp(after.replace('test -s orders/urgent.csv', SCRIPT))).toBe(noStamp(before));
    updateAutomation(ctx, 'new-orders-check', { condition: null });
    expect(getAutomation(ctx, 'new-orders-check')!.condition).toBeUndefined();
    expect(readFileSync(m.path, 'utf8')).not.toContain('## Condition');
  });
});

describe('the witness mark', () => {
  it('approveMadeHere leaves a condition waiting without a witness, and says so', () => {
    const m = make();
    expect(approveMadeHere(ctx, m, NOW, home)).toBe(false);
    expect(checkApproval(proj, m, home).approved).toBe(false);
    expect(approveMadeHere(ctx, m, NOW, home, undefined, { kind: 'owner-terminal' })).toBe(true);
    expect(checkApproval(proj, m, home).approved).toBe(true);
  });

  it('an unchanged condition carries its mark over; a changed one needs a witness again', () => {
    const m = make();
    approveAutomation(proj, m, NOW, home, undefined, { kind: 'owner-terminal' });
    const mark = getApproval(proj, m.slug, home)!.conditionWitnessed;
    // A prompt edit re-stamped with no witness: the same condition keeps its mark.
    const edited = updateAutomation(ctx, m.slug, { prompt: 'Summarise the new orders in two lines.' });
    approveAutomation(proj, edited, NOW, home);
    expect(getApproval(proj, m.slug, home)!.conditionWitnessed).toBe(mark);
    // The script changed: no carry-over.
    const moved = updateAutomation(ctx, m.slug, { condition: 'test -s orders/late.csv' });
    expect(conditionNeedsWitness(moved, getApproval(proj, m.slug, home))).toBe(true);
    expect(() => approveAutomation(proj, moved, NOW, home)).toThrow(/waits for you/);
    // Flipping the wake switch is a change too.
    const flipped = updateAutomation(ctx, m.slug, { condition: SCRIPT, conditionWake: false });
    expect(() => approveAutomation(proj, flipped, NOW, home)).toThrow(/waits for you/);
  });

  it('a manifest without a condition needs no witness and its hash is the old one', () => {
    const plain = createAutomation(ctx, { slug: 'plain', title: 'Plain', days: 'daily', at: '09:00', prompt: 'Hi.' });
    const entry = approveAutomation(proj, plain, NOW, home);
    expect(entry.conditionWitnessed).toBeUndefined();
    expect(entry.manifestSha256).toBe(manifestHash(plain));
  });

  describe('a same-slug pair (createAutomation({ approve }) -> approvePair)', () => {
    const pair = (witness?: { kind: 'owner-terminal' }) => {
      createAgent(ctx, { slug: 'baker', title: 'Baker', prompt: 'Bake reports.' });
      approveAutomation(proj, getRunTarget(ctx, 'baker', 'agent') as AutomationManifest, NOW, home);
      return createAutomation(ctx, { slug: 'baker', title: 'Baker daily', agent: 'baker', days: 'daily', at: '09:00', condition: SCRIPT }, { approve: { now: NOW, home, ...(witness ? { witness } : {}) } });
    };
    for (const marker of ['CLAUDECODE', 'DREAMCONTEXT_AUTOMATION_RUN'] as const) {
      it(`stays waiting with no witness (${marker})`, () => {
        const prev = process.env[marker];
        process.env[marker] = '1';
        try {
          const m = pair();
          expect(checkApproval(proj, m, home).approved).toBe(false);
          expect(getApproval(proj, 'baker', home)?.conditionWitnessed).toBeUndefined();
        } finally {
          if (prev === undefined) delete process.env[marker]; else process.env[marker] = prev;
        }
      });
    }
    it('the owner\'s terminal witness approves the pair', () => {
      const m = pair({ kind: 'owner-terminal' });
      expect(checkApproval(proj, m, home).approved).toBe(true);
    });
    it('approvePair with a wrong shown hash throws and writes nothing', () => {
      const m = pair();
      const agent = getRunTarget(ctx, 'baker', 'agent') as AutomationManifest;
      expect(() => approvePair(proj, m, agent, NOW, home, { kind: 'shown', hash: 'f'.repeat(64) })).toThrow(/changed since you looked/);
      expect(checkApproval(proj, m, home).approved).toBe(false);
      approvePair(proj, m, agent, NOW, home, { kind: 'shown', hash: manifestHash(m) });
      expect(checkApproval(proj, m, home).approved).toBe(true);
    });
  });
});

describe('a hand-planted condition with a ## line', () => {
  it('reads as an invalid condition the card cannot approve', () => {
    const m = createAutomation(ctx, { slug: 'planted', title: 'Planted', days: 'daily', at: '09:00', prompt: 'Hi.' });
    writeFileSync(m.path, `${readFileSync(m.path, 'utf8').trimEnd()}\n\n## Condition\n\n\`\`\`sh\nexit 0\n\`\`\`\n`);
    const read = getAutomation(ctx, 'planted')!;
    expect(read.condition).toBe('exit 0');
    expect(() => approveAutomation(proj, { ...read, conditionError: 'x' }, NOW, home, undefined, { kind: 'owner-terminal' })).toThrow(/cannot run/);
  });
});
