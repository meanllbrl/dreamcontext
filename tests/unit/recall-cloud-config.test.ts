import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AT_CEILING,
  copyVoiceKeyToRecall,
  evalFrozenDir,
  evalSpendCeilingUsd,
  grantVaultConsent,
  minTier,
  readRecallCloudConfig,
  readRecallCloudUsage,
  readVaultConsent,
  readVaultTier,
  recallCloudApiKey,
  recallCloudConfigPath,
  recallCloudKeyInfo,
  recallCloudStatus,
  recordCloudUsage,
  resolvePromptTier,
  revokeVaultConsent,
  rollingIndexSpendUsd,
  setRecallCloudKey,
  vaultConsentKey,
  appendCloudAudit,
} from '../../src/lib/recall-cloud-config.js';

let tmp: string;
let home: string;
let root: string;
const ENV_KEYS = ['DREAMCONTEXT_RECALL_OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'DREAMCONTEXT_EVAL_MAX_USD', 'DREAMCONTEXT_RECALL_TIER',
  'DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP'];
const saved: Record<string, string | undefined> = {};
const KEY = 'or-test-key-0123456789';
const mode = (p: string): number => statSync(p).mode & 0o777;

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), 'dc-cloud-cfg-'));
  home = join(tmp, 'home');
  root = join(tmp, 'vault', '_dream_context');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('key handling', () => {
  it('has no key by default and never reads OPENROUTER_API_KEY or voice.json implicitly', () => {
    process.env.OPENROUTER_API_KEY = 'generic-env-key-abcdef';
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'voice.json'), JSON.stringify({ openRouterKey: 'voice-key-abcdef123' }));
    expect(recallCloudApiKey(home)).toBeNull();
    expect(recallCloudKeyInfo(home)).toEqual({ present: false, source: null, origin: null });
  });

  it('reads DREAMCONTEXT_RECALL_OPENROUTER_KEY as the only env source, and the file wins over it', () => {
    process.env.DREAMCONTEXT_RECALL_OPENROUTER_KEY = 'env-key-0123456789';
    expect(recallCloudApiKey(home)).toEqual({ key: 'env-key-0123456789', source: 'env' });
    expect(recallCloudKeyInfo(home)).toEqual({ present: true, source: 'env', origin: null });
    setRecallCloudKey(KEY, 'manual', home);
    expect(recallCloudApiKey(home)).toEqual({ key: KEY, source: 'file' });
    expect(recallCloudKeyInfo(home)).toEqual({ present: true, source: 'file', origin: 'manual' });
  });

  it('stores the key 0600 and clears it with null', () => {
    setRecallCloudKey(KEY, 'env-copy', home);
    if (process.platform !== 'win32') expect(mode(recallCloudConfigPath(home))).toBe(0o600); // Windows has no POSIX mode bits
    expect(readRecallCloudConfig(home).keyOrigin).toBe('env-copy');
    setRecallCloudKey(null, 'manual', home);
    expect(recallCloudApiKey(home)).toBeNull();
  });

  it('copies the Voice key only on the explicit call, recording its origin', () => {
    expect(copyVoiceKeyToRecall(home)).toBe(false);
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'voice.json'), JSON.stringify({ openRouterKey: 'voice-key-abcdef123' }));
    expect(recallCloudApiKey(home)).toBeNull();
    expect(copyVoiceKeyToRecall(home)).toBe(true);
    expect(recallCloudKeyInfo(home)).toEqual({ present: true, source: 'file', origin: 'voice-copy' });
  });

  it('survives a corrupt config as "no key, no consent"', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(recallCloudConfigPath(home), '{not json');
    expect(readRecallCloudConfig(home).vaults).toEqual({});
    expect(recallCloudApiKey(home)).toBeNull();
  });
});

describe('consent', () => {
  it('is local without consent, and without a key even with consent', () => {
    expect(readVaultTier(root, home)).toBe('local');
    grantVaultConsent(root, { tier: 'cloud', rerankModel: 'voyageai/rerank-2.5-lite', surface: 'cli-tty' }, home);
    expect(readVaultTier(root, home)).toBe('local');
    setRecallCloudKey(KEY, 'manual', home);
    expect(readVaultTier(root, home)).toBe('cloud');
  });

  it('forces rerankModel null on a cloud-index grant', () => {
    const c = grantVaultConsent(root, { tier: 'cloud-index', rerankModel: 'voyageai/rerank-2.5', surface: 'cli-tty' }, home);
    expect(c.rerankModel).toBeNull();
    expect(readVaultConsent(root, home)?.rerankModel).toBeNull();
  });

  it('binds to the vault id: a copied vault does not inherit consent', () => {
    grantVaultConsent(root, { tier: 'cloud', rerankModel: null, surface: 'cli-tty' }, home);
    setRecallCloudKey(KEY, 'manual', home);
    const other = join(tmp, 'copy', '_dream_context');
    mkdirSync(join(other, '.embeddings'), { recursive: true });
    writeFileSync(join(other, '.embeddings', '.vault-id'), readFileSync(join(root, '.embeddings', '.vault-id')));
    // Same id file content but a different real path → no consent.
    expect(readVaultTier(other, home)).toBe('local');
  });

  it('goes stale (re-consent required) on a missing marker, a different disclosure version, or a different rules hash', () => {
    grantVaultConsent(root, { tier: 'cloud', rerankModel: null, surface: 'cli-tty' }, home);
    setRecallCloudKey(KEY, 'manual', home);
    expect(recallCloudStatus(root, home).consent).toBe('valid');

    const cfgPath = recallCloudConfigPath(home);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const k = Object.keys(cfg.vaults)[0];
    cfg.vaults[k].eligibleTypesHash = 'deadbeef';
    writeFileSync(cfgPath, JSON.stringify(cfg));
    expect(readVaultTier(root, home)).toBe('local');
    expect(recallCloudStatus(root, home).consent).toBe('re-consent-required');

    cfg.vaults[k].eligibleTypesHash = JSON.parse(readFileSync(cfgPath, 'utf-8')).vaults[k].eligibleTypesHash;
    rmSync(join(root, '.embeddings', '.vault-id'));
    expect(vaultConsentKey(root)).toBeNull();
    expect(recallCloudStatus(root, home).consent).toBe('re-consent-required');
  });

  it('revokes, and records grant/revoke in a 0600 audit log without the key', () => {
    setRecallCloudKey(KEY, 'manual', home);
    grantVaultConsent(root, { tier: 'cloud', rerankModel: null, surface: 'dashboard' }, home);
    revokeVaultConsent(root, home);
    appendCloudAudit('key_set', null, 'cli', home);
    expect(readVaultConsent(root, home)).toBeNull();
    const log = join(home, '.dreamcontext', 'recall-cloud-audit.log');
    const text = readFileSync(log, 'utf-8');
    expect(text).toContain('"event":"grant"');
    expect(text).toContain('"surface":"dashboard"');
    expect(text).toContain('"event":"revoke"');
    expect(text).not.toContain(KEY);
    if (process.platform !== 'win32') expect(mode(log)).toBe(0o600); // Windows has no POSIX mode bits
  });

  it('keeps the vault id marker in a self-ignored .embeddings directory', () => {
    vaultConsentKey(root, { create: true });
    expect(readFileSync(join(root, '.embeddings', '.gitignore'), 'utf-8').trim()).toBe('*');
  });
});

describe('status', () => {
  it('never contains the key, and flags a dashboard grant', () => {
    setRecallCloudKey(KEY, 'manual', home);
    grantVaultConsent(root, { tier: 'cloud', rerankModel: 'voyageai/rerank-2.5', surface: 'dashboard' }, home);
    const st = recallCloudStatus(root, home);
    expect(JSON.stringify(st)).not.toContain(KEY);
    expect(st).toMatchObject({ key: true, keySource: 'file', tier: 'cloud', consent: 'valid', consentSurface: 'dashboard', rerankModel: 'voyageai/rerank-2.5' });
  });
});

describe('resolvePromptTier', () => {
  beforeEach(() => setRecallCloudKey(KEY, 'manual', home));

  it('returns the consented tier, and local for DREAMCONTEXT_RECALL_TIER=local', () => {
    grantVaultConsent(root, { tier: 'cloud', rerankModel: null, surface: 'cli-tty' }, home);
    expect(resolvePromptTier(root, {}, home)).toEqual({ tier: 'cloud', downgraded: null });
    expect(resolvePromptTier(root, { DREAMCONTEXT_RECALL_TIER: 'local' }, home)).toEqual({ tier: 'local', downgraded: 'env_override' });
  });

  it('downgrades cloud for a spawned session but leaves cloud-index alone (it has no query-time egress)', () => {
    grantVaultConsent(root, { tier: 'cloud', rerankModel: null, surface: 'cli-tty' }, home);
    expect(resolvePromptTier(root, { DREAMCONTEXT_SPAWNED: 'develop' }, home)).toEqual({ tier: 'local', downgraded: 'spawned_session' });
    expect(resolvePromptTier(root, { DREAMCONTEXT_AUTOMATION_RUN: 'daily' }, home).downgraded).toBe('spawned_session');
    grantVaultConsent(root, { tier: 'cloud-index', rerankModel: null, surface: 'cli-tty' }, home);
    expect(resolvePromptTier(root, { DREAMCONTEXT_SPAWNED: 'develop' }, home)).toEqual({ tier: 'cloud-index', downgraded: null });
  });

  it('downgrades to local once the daily query cap is reached', () => {
    grantVaultConsent(root, { tier: 'cloud', rerankModel: null, surface: 'cli-tty' }, home);
    const cfg = JSON.parse(readFileSync(recallCloudConfigPath(home), 'utf-8'));
    cfg.spend = { maxQueriesPerDay: 2 };
    writeFileSync(recallCloudConfigPath(home), JSON.stringify(cfg));
    recordCloudUsage(root, 'query', 0.001, {}, home);
    expect(resolvePromptTier(root, {}, home).tier).toBe('cloud');
    recordCloudUsage(root, 'query', 0.001, {}, home);
    expect(resolvePromptTier(root, {}, home)).toEqual({ tier: 'local', downgraded: 'daily_cap' });
  });
});

describe('usage ledger', () => {
  it('records spend per kind and sums the rolling 24 h index spend (auto only on request)', () => {
    recordCloudUsage(root, 'index', 0.5, { auto: true }, home);
    recordCloudUsage(root, 'index', 0.25, {}, home);
    recordCloudUsage(root, 'eval', 0.1, {}, home);
    const u = readRecallCloudUsage(home);
    expect(u.evalSpentUsd).toBeCloseTo(0.1);
    expect(u.lifetimeUsd).toBeCloseTo(0.85);
    expect(rollingIndexSpendUsd({}, home)).toBeCloseTo(0.75);
    expect(rollingIndexSpendUsd({ autoOnly: true }, home)).toBeCloseTo(0.5);
    if (process.platform !== 'win32') expect(mode(join(home, '.dreamcontext', 'recall-cloud-usage.json'))).toBe(0o600); // Windows has no POSIX mode bits
  });

  it('reads a corrupt ledger as at-ceiling and never overwrites it', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    const p = join(home, '.dreamcontext', 'recall-cloud-usage.json');
    writeFileSync(p, '{broken');
    const u = readRecallCloudUsage(home);
    expect(u.corrupt).toBe(true);
    expect(u.evalSpentUsd).toBe(AT_CEILING);
    expect(rollingIndexSpendUsd({}, home)).toBeGreaterThan(1e6);
    recordCloudUsage(root, 'query', 0.01, {}, home);
    expect(readFileSync(p, 'utf-8')).toBe('{broken');
  });

  it('lets DREAMCONTEXT_EVAL_MAX_USD only LOWER the eval ceiling', () => {
    expect(evalSpendCeilingUsd(home, {})).toBe(5);
    expect(evalSpendCeilingUsd(home, { DREAMCONTEXT_EVAL_MAX_USD: '2.9' })).toBe(2.9);
    expect(evalSpendCeilingUsd(home, { DREAMCONTEXT_EVAL_MAX_USD: '100' })).toBe(5);
    expect(evalSpendCeilingUsd(home, { DREAMCONTEXT_EVAL_MAX_USD: 'nope' })).toBe(5);
  });
});

describe('helpers', () => {
  it('orders tiers local < cloud-index < cloud', () => {
    expect(minTier('cloud', 'local')).toBe('local');
    expect(minTier('cloud', 'cloud-index')).toBe('cloud-index');
    expect(minTier('cloud-index', 'cloud')).toBe('cloud-index');
  });

  it('puts the eval-frozen dir under the injected home', () => {
    expect(evalFrozenDir(home)).toBe(join(home, '.dreamcontext', 'eval-frozen'));
  });

  it('resolves a symlinked root to the same consent key as its target', () => {
    const link = join(tmp, 'link');
    symlinkSync(root, link);
    expect(vaultConsentKey(link, { create: true })).toBe(vaultConsentKey(root));
  });
});
