/**
 * S4 at unit level: two Codex accounts as T3 instances in authOverlay mode share one continuation
 * key (their sessions are shared, so a switch resumes the same thread) while their credentials
 * live in separate private homes. The live cross-account resume needs a second Codex login (W2).
 */
import { join, resolve } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { CodexSettings } from '@t3tools/contracts';
import * as HostProcess from '@t3tools/shared/HostProcess';
import { resolveCodexHomeLayout } from '@t3tools/server/provider/Drivers/CodexHomeLayout';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { codexInstanceSettings } from '../../../src/lib/t3-bridge/accounts.js';

// Resolved: T3 resolves the home it is given, and on Windows `/Users/someone` gains a drive.
const HOME = resolve('/Users/someone');
const layout = (accountId: string | null) => {
  const s = codexInstanceSettings(HOME, accountId);
  const config = Schema.decodeSync(CodexSettings)({ homePath: s.homePath, shadowHomePath: s.shadowHomePath });
  return Effect.runSync(resolveCodexHomeLayout(config).pipe(
    Effect.provideService(HostProcess.HomeDirectory, HOME),
    Effect.provide(NodeServices.layer),
  ));
};

describe('codex accounts as T3 instances', () => {
  it('two non-#0 accounts run in authOverlay with private homes and ONE continuation key', () => {
    const a = layout('work');
    const b = layout('personal');
    expect(a.mode).toBe('authOverlay');
    expect(b.mode).toBe('authOverlay');
    expect(a.effectiveHomePath).toBe(join(HOME, '.dreamcontext/codex-accounts/work'));
    expect(b.effectiveHomePath).toBe(join(HOME, '.dreamcontext/codex-accounts/personal'));
    expect(a.continuationKey).toBe(`codex:home:${join(HOME, '.codex')}`);
    expect(b.continuationKey).toBe(a.continuationKey);
  });

  it('account #0 is ~/.codex itself, with the same continuation key', () => {
    const z = layout(null);
    expect(z.sharedHomePath).toBe(join(HOME, '.codex'));
    expect(z.continuationKey).toBe(layout('work').continuationKey);
  });

  it('non-#0 accounts keep credentials in a file inside their own home; ids are confined', () => {
    expect(codexInstanceSettings(HOME, 'work').launchArgs).toContain('cli_auth_credentials_store="file"');
    expect(() => codexInstanceSettings(HOME, '../etc')).toThrow();
  });
});
