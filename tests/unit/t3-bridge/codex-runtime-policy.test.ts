/**
 * Pins the Codex `turn/start` parameters per chat permission mode (plan r5 §6, W1 criterion 10),
 * built by T3's own `buildCodexTurnStartParams` from the policy our bridge hands it.
 *
 * The rule this exists for: our `auto` must never reach Codex as T3's `auto`, whose approvals
 * reviewer is `auto_review` (a model that approves sandbox escapes). Every sandboxed mode keeps
 * the reviewer `user`, so any escalation comes to the owner as an approval card.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as CodexAdapterV2 from '@t3tools/server/orchestration-v2/Adapters/CodexAdapterV2';
import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';
import { codexRuntimePolicy, writableRoots } from '../../../src/lib/t3-bridge/policy.js';

const PROJECT = '/work/acme-app';
const LINKED = '/work/acme-api';
const TMP = '/private/var/folders/xx/dc-codex-abc';

function turnStart(mode: string) {
  const policy = codexRuntimePolicy({ mode, cwd: PROJECT, extraRoots: [LINKED], privateTmp: TMP });
  return Effect.runSync(CodexAdapterV2.buildCodexTurnStartParams({
    nativeThreadId: 'thread-1',
    codexInput: [{ type: 'text', text: 'hi', text_elements: [] } as never],
    runtimePolicy: policy as never,
    modelSelection: { instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID, model: 'gpt-5.5' } as never,
  })) as unknown as Record<string, unknown>;
}

describe('codex turn/start per mode', () => {
  it.each(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'something-unknown'])(
    '%s never sends the auto_review approvals reviewer',
    (mode) => {
      const p = turnStart(mode);
      expect(p.approvalsReviewer).toBe('user');
      expect(JSON.stringify(p)).not.toContain('auto_review');
    },
  );

  it('auto: on-request approvals, workspace-write sandbox on the project, linked repo and private tmp only', () => {
    const p = turnStart('auto');
    expect(p.approvalPolicy).toBe('on-request');
    expect(p.sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: [PROJECT, LINKED, TMP],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });

  it('acceptEdits is the same sandbox as auto', () => {
    expect(turnStart('acceptEdits').sandboxPolicy).toEqual(turnStart('auto').sandboxPolicy);
  });

  it('default and plan run read-only with untrusted approvals; plan sets the plan collaboration mode', () => {
    expect(turnStart('default')).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } });
    const plan = turnStart('plan');
    expect(plan).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } });
    expect((plan.collaborationMode as { mode: string }).mode).toBe('plan');
  });

  it('bypass is full access with no approvals (the same trust as Claude bypass)', () => {
    expect(turnStart('bypassPermissions')).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  });

  it('a root under ~/.dreamcontext, the home itself or / is never writable', () => {
    const home = homedir();
    const roots = writableRoots({
      mode: 'auto',
      cwd: PROJECT,
      extraRoots: [join(home, '.dreamcontext'), join(home, '.dreamcontext', 'claude-accounts', 'x'), home, '/', 'relative/path'],
      home,
    });
    expect(roots).toEqual([PROJECT]);
  });
});
