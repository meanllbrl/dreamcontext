/**
 * The shapes a later cross-tool fallback needs, fixed now (Track T W2, plan r5 §4e):
 *   1. readings pooled by (tool, accountId);
 *   2. `chooseTarget` answers {tool, accountId}, and only ever the chat's own tool;
 *   3. `FallbackPolicy` is `'never'` by default (and has no other value yet);
 *   4. `fallbackTools` is an OPTIONAL approval-hash field: absent, every hash is unchanged;
 *   5. no chat changes tool through policy, and a test-only forced Claude → Codex target moves a
 *      pane through `replaceSession` with a handoff record.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_FALLBACK_POLICY, asFallbackPolicy, chooseTarget, poolKey, poolReadings, type AccountReading,
} from '../../src/lib/account-switch.js';
import { replaceSession } from '../../src/lib/t3-bridge/replace-session.js';
import { readHandoffRecord } from '../../src/lib/context-watch.js';
import { approvalFields, canonicalApprovalPayload, manifestHash } from '../../src/lib/automations/registry.js';
import { APPROVAL_DIFF_FIELDS, type AutomationManifest } from '../../src/lib/automations/types.js';

const now = Date.now();
const full: AccountReading = { id: 'x', limits: { limits: [{ key: 'session', percent: 99, resetsAt: now + 3_600_000 }, { key: 'weekly', percent: 99, resetsAt: now + 86_400_000 }], fetchedAtMs: now } };
const room: AccountReading = { id: 'y', limits: { limits: [{ key: 'session', percent: 5, resetsAt: now + 3_600_000 }, { key: 'weekly', percent: 5, resetsAt: now + 86_400_000 }], fetchedAtMs: now } };

describe('§4e fallback shapes', () => {
  it('pools readings by (tool, accountId): the same id under two tools is two entries', () => {
    const pool = poolReadings({ claude: [{ ...full, id: 'a' }], codex: [{ ...room, id: 'a' }] });
    expect([...pool.keys()].sort()).toEqual([poolKey('claude', 'a'), poolKey('codex', 'a')].sort());
    expect(pool.get('codex:a')?.tool).toBe('codex');
  });

  it('chooseTarget returns {tool, accountId} inside the chat\'s own tool', () => {
    const pool = poolReadings({ codex: [{ ...full, id: 'c1' }, { ...room, id: 'c2' }] });
    const r = chooseTarget(pool, 'codex', { threshold: 90, currentId: 'c1', now });
    expect(r.target).toEqual({ tool: 'codex', accountId: 'c2' });
  });

  it('FallbackPolicy defaults to never, reads anything else as never, and no chat changes tool through policy', () => {
    expect(DEFAULT_FALLBACK_POLICY).toBe('never');
    expect(asFallbackPolicy('claude-then-codex')).toBe('never');
    // Every Claude account is full while a Codex account has room: the Claude chat still gets no target.
    const pool = poolReadings({ claude: [{ ...full, id: 'k1' }, { ...full, id: 'k2' }], codex: [{ ...room, id: 'c1' }] });
    const r = chooseTarget(pool, 'claude', { threshold: 90, currentId: 'k1', now });
    expect(r.target).toBeNull();
    expect(r.accountId).toBeNull();
    const again = chooseTarget(pool, 'claude', { threshold: 90, currentId: 'k1', now }, asFallbackPolicy('anything'));
    expect(again.target).toBeNull();
  });

  it('a test-only forced Claude → Codex target moves the pane through replaceSession, with a handoff record and a fresh thread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-fallback-shape-'));
    try {
      const ctx = join(root, '_dream_context');
      mkdirSync(join(ctx, 'state'), { recursive: true });
      writeFileSync(join(ctx, 'state', 'move-me.md'), '---\nname: Move me\nstatus: in_progress\nupdated_at: "2026-10-31"\n---\n');
      const pane = '9d9d9d9d-0000-4000-8000-000000000004';
      const steps: string[] = [];
      const out = await replaceSession({ tool: 'claude', accountId: 'main', threadId: 'claude-session-1' }, { tool: 'codex', accountId: 'primary' }, {
        contextRoot: ctx, pane, home: root,
        close: () => { steps.push('close claude'); },
        open: (plan, prompt) => { steps.push(`open ${plan.target.tool} resume=${plan.resume || 'fresh'} prompt=${prompt ? 'yes' : 'no'}`); },
      });
      expect(steps).toEqual(['close claude', 'open codex resume=fresh prompt=yes']);
      expect(out.handoff).toBe(true);
      expect(readHandoffRecord(ctx, pane)).toMatchObject({ task: 'move-me', fromSession: 'claude-session-1', tab: pane });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fallbackTools is optional in the approval hash: absent changes nothing, present changes the hash', () => {
    const base = {
      prompt: 'p', outputInstructions: '', model: 'sonnet', effort: null, timeoutMinutes: 10, outputDir: 'out',
      learning: false, review: 'off', mode: 'sched', flow: null,
    } as unknown as AutomationManifest;
    expect(canonicalApprovalPayload(base)).not.toContain('fallbackTools');
    expect(manifestHash({ ...base, fallbackTools: [] })).toBe(manifestHash(base));
    const withFallback = { ...base, fallbackTools: ['codex'] };
    expect(manifestHash(withFallback)).not.toBe(manifestHash(base));
    expect(canonicalApprovalPayload(withFallback).endsWith('"fallbackTools":["codex"]}')).toBe(true);
    // No manifest can carry it yet (no parser reads it), so the review surface is unchanged.
    expect(Object.keys(approvalFields(base))).toEqual([...APPROVAL_DIFF_FIELDS]);
  });
});
