import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConsentPatch, consentPath, moveConsent, pendingApproval, readConsent, restoreConsent } from '../../src/lib/apps/data-consent.js';
import { setAppConfig, readAppConfig } from '../../src/lib/apps/app-config.js';
import type { DataDecl } from '../../src/lib/apps/data-share.js';

/** app-veri-ortak criterion 2, library half: the owner's consent file (K3). */

let home: string;
const HASH = 'abcdef0123456789';
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-consent-'))); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const decl = (...shared: string[]): DataDecl => ({ shared: shared.map((path) => ({ path, why: 'w' })), local: [{ path: 'cache/', why: 'refetched' }] });

describe('the consent file', () => {
  it('lives in ~/.dreamcontext/apps/share/<hash>.json, 0600; a bad hash is refused', () => {
    const r = applyConsentPatch(home, HASH, decl('favorites/'), { approve: ['favorites/'] });
    expect(r.ok).toBe(true);
    const p = consentPath(home, HASH);
    expect(p).toBe(join(home, '.dreamcontext', 'apps', 'share', `${HASH}.json`));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readConsent(home, HASH)).toMatchObject({ approved: ['favorites/'], excluded: [], declined: false });
    expect(() => consentPath(home, '../x')).toThrow();
    expect(applyConsentPatch(home, '../x', decl('a/'), { approve: ['a/'] })).toEqual({ ok: false, error: 'bad_app' });
  });

  it('a new declared path asks only it; a narrowed declaration asks nothing', () => {
    applyConsentPatch(home, HASH, decl('favorites/'), { approve: ['favorites/'] });
    const c = readConsent(home, HASH);
    expect(pendingApproval(decl('favorites/'), c)).toEqual([]);
    expect(pendingApproval(decl('favorites/', 'notes/'), c)).toEqual(['notes/']);
    expect(pendingApproval(decl(), c)).toEqual([]);
    expect(pendingApproval(null, c)).toEqual([]);
  });

  it('an unticked path is excluded and stays excluded until unexcluded', () => {
    applyConsentPatch(home, HASH, decl('favorites/', 'notes/'), { approve: ['favorites/'], exclude: ['notes/'] });
    expect(pendingApproval(decl('favorites/', 'notes/'), readConsent(home, HASH))).toEqual([]);
    applyConsentPatch(home, HASH, decl('favorites/', 'notes/'), { unexclude: ['notes/'] });
    expect(readConsent(home, HASH)?.excluded).toEqual([]);
  });

  it('decline keeps it local; a later approve lifts the decline', () => {
    applyConsentPatch(home, HASH, decl('favorites/'), { decline: true });
    expect(readConsent(home, HASH)?.declined).toBe(true);
    expect(pendingApproval(decl('favorites/'), readConsent(home, HASH))).toEqual([]);
    applyConsentPatch(home, HASH, decl('favorites/'), { approve: ['favorites/'] });
    expect(readConsent(home, HASH)?.declined).toBe(false);
  });

  it('a bad body is refused and writes nothing', () => {
    const d = decl('favorites/');
    for (const body of [null, 'x', [], {}, { approve: 'favorites/' }, { approve: ['../x/'] }, { exclude: ['.env'] }, { approve: ['cache/'] },
      { approve: Array.from({ length: 21 }, (_, i) => `p${i}/`) }, { decline: 'yes' }, { other: 1 }]) {
      const r = applyConsentPatch(home, HASH, d, body);
      expect(r.ok, JSON.stringify(body)).toBe(false);
    }
    expect(applyConsentPatch(home, HASH, null, { approve: ['favorites/'] }).ok).toBe(false);
    expect(existsSync(consentPath(home, HASH))).toBe(false);
  });

  it('a corrupt file reads as null, never throws', () => {
    mkdirSync(join(home, '.dreamcontext', 'apps', 'share'), { recursive: true });
    writeFileSync(consentPath(home, HASH), '{nope');
    expect(readConsent(home, HASH)).toBeNull();
    writeFileSync(consentPath(home, HASH), JSON.stringify({ approved: ['/etc/'], excluded: [], declined: false }));
    expect(readConsent(home, HASH)).toBeNull();
  });

  it('writing an app setting leaves the consent file intact', () => {
    applyConsentPatch(home, HASH, decl('favorites/'), { approve: ['favorites/'] });
    const before = readFileSync(consentPath(home, HASH), 'utf-8');
    const configId = 'f'.repeat(32);
    setAppConfig(home, configId, [{ key: 'insight', type: 'text', label: 'Insight', required: false }], { insight: 'mrr' });
    expect(readAppConfig(home, configId)).toEqual({ insight: 'mrr' });
    expect(readFileSync(consentPath(home, HASH), 'utf-8')).toBe(before);
    expect(JSON.stringify(readAppConfig(home, configId))).not.toContain('approved');
  });

  it('goes with the app to the trash and comes back on restore', () => {
    applyConsentPatch(home, HASH, decl('favorites/'), { approve: ['favorites/'] });
    const trash = join(home, 'trash-entry');
    expect(moveConsent(home, HASH, trash)).toBe(true);
    expect(readConsent(home, HASH)).toBeNull();
    expect(restoreConsent(home, HASH, trash)).toBe(true);
    expect(readConsent(home, HASH)?.approved).toEqual(['favorites/']);
    expect(moveConsent(home, 'feedbeef00000000', trash)).toBe(false);
  });
});
