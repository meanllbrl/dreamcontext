import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalApprovalPayload, approvalFields, manifestHash, renderApprovalReview } from '../../src/lib/automations/registry.js';
import { createAutomation, readAutomationFile } from '../../src/lib/automations/store.js';
import { composeRun, legacyPair } from '../../src/lib/agents/compose.js';
import { issueLinkNonce, spendLinkNonce } from '../../src/server/apps/link-nonces.js';
import { buildAppLink, parseAppLink } from '../../src/lib/app-link.js';

/** dreamcontext Apps W3: `app` in the approval hash, `automations create --app`, the app link nonce. */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function brain(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'dc-apps-auto-')));
  dirs.push(d);
  const root = join(d, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  return root;
}
const base = (root: string, slug: string, extra: Record<string, unknown> = {}) =>
  createAutomation(root, { slug, title: 'Nightly', days: 'daily', at: '09:00', prompt: 'Report.', ...extra });

describe('app in the approval hash', () => {
  it('an automation with no app keeps its payload: no key, byte for byte', () => {
    const m = base(brain(), 'no-app');
    expect(m.app).toBeUndefined();
    expect(canonicalApprovalPayload(m)).not.toContain('"app"');
    expect(manifestHash({ ...m, app: undefined })).toBe(manifestHash(m));
    expect(manifestHash({ ...m, app: '' })).toBe(manifestHash(m));
  });
  it('adding, moving or removing it changes the hash, and the review shows it', () => {
    const m = base(brain(), 'with-app', { app: 'meta-ads' });
    expect(m.app).toBe('meta-ads');
    const { app: _drop, ...none } = m;
    expect(manifestHash(m)).not.toBe(manifestHash(none as typeof m));
    expect(manifestHash(m)).not.toBe(manifestHash({ ...m, app: 'other' }));
    expect(canonicalApprovalPayload(m).endsWith('"app":"meta-ads"}')).toBe(true);
    expect(approvalFields(m).app).toBe('meta-ads');
    expect(renderApprovalReview(approvalFields(m))).toContain('meta-ads');
  });
  it('survives the agent split: legacyPair and composeRun carry it, the hash holds', () => {
    const m = base(brain(), 'split', { app: 'meta-ads' });
    const { agent, job } = legacyPair(m);
    expect(job?.app).toBe('meta-ads');
    expect(manifestHash(composeRun(agent, job))).toBe(manifestHash(m));
  });
  it('a bound automation reads it from its own file', () => {
    const root = brain();
    const m = base(root, 'reread', { app: 'meta-ads' });
    expect(readFileSync(m.path, 'utf-8')).toMatch(/^app: meta-ads$/m);
    expect(readAutomationFile(m.path).app).toBe('meta-ads');
  });
  it('refuses a bad slug and an on-call job', () => {
    const root = brain();
    expect(() => base(root, 'bad', { app: '../x' })).toThrow(/app slug/);
    expect(() => base(root, 'call', { app: 'meta-ads', mode: 'call' })).toThrow(/schedule/);
  });
});

describe('the app link nonce', () => {
  it('is one time, bound to its app, and expires', () => {
    const n = issueLinkNonce('h1', '/campaigns');
    expect(spendLinkNonce('h2', n)).toBeNull();
    expect(spendLinkNonce('h1', n)).toBe('/campaigns');
    expect(spendLinkNonce('h1', n)).toBeNull();
    const old = issueLinkNonce('h1', '/x', 0);
    expect(spendLinkNonce('h1', old)).toBeNull();
    expect(spendLinkNonce('h1', 42)).toBeNull();
  });
  it('a link holds the nonce, never a path', () => {
    expect(parseAppLink(`dreamcontext://project/acme/app/meta-ads?n=${'a'.repeat(43)}`)).toMatchObject({ kind: 'app', slug: 'meta-ads' });
    expect(parseAppLink('dreamcontext://project/acme/app/meta-ads?path=//evil')).toBeNull();
    expect(parseAppLink('dreamcontext://project/acme/app/meta-ads?n=short')).toBeNull();
    expect(parseAppLink('dreamcontext://project/acme/app/Meta')).toBeNull();
    expect(parseAppLink('dreamcontext://project/acme/app/meta-ads/x')).toBeNull();
    expect(() => buildAppLink({ kind: 'app', vault: 'acme', slug: 'x', nonce: '//evil' })).toThrow();
  });
});
