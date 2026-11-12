import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  cloudDisable,
  cloudEnable,
  cloudIndex,
  cloudKeyClear,
  cloudKeyCopyVoice,
  cloudKeySet,
  cloudStatus,
  registerRecallCloudCommands,
  type CloudCliDeps,
} from '../../src/cli/commands/recall-cloud.js';
import {
  RECALL_KEY_ENV,
  readRecallCloudConfig,
  readVaultConsent,
  recallCloudKeyInfo,
  recordCloudUsage,
  setRecallCloudKey,
  grantVaultConsent,
} from '../../src/lib/recall-cloud-config.js';
import { writeVoiceConfig } from '../../src/lib/voice/config.js';
import { CloudRecallError } from '../../src/lib/embeddings/openrouter.js';
import { DEFAULT_RERANK_MODEL } from '../../src/lib/embeddings/fusion-config.js';
import { spawnCloudIndexRefresh } from '../../src/lib/recall-cloud-index-spawn.js';
import type { BuildCloudIndexResult } from '../../src/lib/embeddings/vector-store.js';

const SECRET = 'sk-or-v1-THIS-IS-A-FAKE-RECALL-KEY-0123456789abcdef';
const VOICE_SECRET = 'sk-or-v1-THIS-IS-A-FAKE-VOICE-KEY-0123456789abcdef';

let home: string;
let root: string;
let out: string[];
let err: string[];

const okBuild: BuildCloudIndexResult = { embedded: 3, reused: 0, evicted: 0, spentUsd: 0.001, aborted: null };

function makeDeps(over: Partial<CloudCliDeps> = {}): CloudCliDeps & { build: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; setHybrid: ReturnType<typeof vi.fn> } {
  const deps = {
    isTTY: () => true,
    env: {} as NodeJS.ProcessEnv,
    home,
    print: (l: string) => { out.push(l); },
    printErr: (l: string) => { err.push(l); },
    confirm: vi.fn(async () => true),
    readSecret: vi.fn(async () => SECRET),
    root: () => root,
    loadCorpus: () => [],
    setHybrid: vi.fn(),
    build: vi.fn(async () => okBuild),
    ...over,
  };
  return deps as never;
}

const allOutput = (): string => [...out, ...err].join('\n');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rc-home-'));
  root = mkdtempSync(join(tmpdir(), 'rc-root-'));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env[RECALL_KEY_ENV];
});

describe('enable', () => {
  it('refuses without a TTY and writes nothing', async () => {
    setRecallCloudKey(SECRET, 'manual', home);
    const deps = makeDeps({ isTTY: () => false });
    expect(await cloudEnable(deps, 'cloud')).toBe(1);
    expect(readVaultConsent(root, home)).toBeNull();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.build).not.toHaveBeenCalled();
    expect(allOutput()).toContain('TTY');
  });

  it('refuses in a spawned session even with a TTY', async () => {
    setRecallCloudKey(SECRET, 'manual', home);
    const deps = makeDeps({ env: { DREAMCONTEXT_SPAWNED: 'develop' } });
    expect(await cloudEnable(deps, 'cloud')).toBe(1);
    expect(readVaultConsent(root, home)).toBeNull();
    expect(deps.setHybrid).not.toHaveBeenCalled();
    expect(allOutput()).toContain('spawned session');
  });

  it('has no --yes: the command definition does not accept it', () => {
    const recall = new Command('recall');
    registerRecallCloudCommands(recall, makeDeps());
    const enable = recall.commands.find((c) => c.name() === 'cloud')!.commands.find((c) => c.name() === 'enable')!;
    expect(enable.options.map((o) => o.long)).not.toContain('--yes');
  });

  it('rejects an unknown tier, an unknown rerank model and a missing key', async () => {
    const deps = makeDeps();
    expect(await cloudEnable(deps, 'cloud')).toBe(1); // no key yet
    expect(err.join('\n')).toContain('No recall key');
    setRecallCloudKey(SECRET, 'manual', home);
    expect(await cloudEnable(deps, 'weird')).toBe(1);
    expect(await cloudEnable(deps, 'cloud', { rerank: 'nope' })).toBe(1);
    expect(await cloudEnable(deps, 'cloud', { maxUsd: '-1' })).toBe(1);
    expect(readVaultConsent(root, home)).toBeNull();
  });

  it('shows the disclosure BEFORE the confirm, then grants, sets hybrid and builds', async () => {
    setRecallCloudKey(SECRET, 'manual', home);
    let shownBeforeConfirm = 0;
    const deps = makeDeps();
    deps.confirm.mockImplementation(async () => { shownBeforeConfirm = out.length; return true; });
    expect(await cloudEnable(deps, 'cloud')).toBe(0);
    expect(shownBeforeConfirm).toBeGreaterThan(5);
    expect(out.slice(0, shownBeforeConfirm).join('\n')).toContain('NOT zero-data-retention');
    const consent = readVaultConsent(root, home);
    expect(consent?.tier).toBe('cloud');
    expect(consent?.surface).toBe('cli-tty');
    expect(consent?.rerankModel).toBe(DEFAULT_RERANK_MODEL);
    expect(deps.setHybrid).toHaveBeenCalledWith(root);
    expect(out.join('\n')).toContain('Recall mode set to hybrid');
    expect(deps.build).toHaveBeenCalledTimes(1);
    expect(deps.build.mock.calls[0][3]).toMatchObject({ trigger: 'explicit' });
    expect(allOutput()).not.toContain(SECRET);
  });

  it('leaves everything untouched when the confirm is declined', async () => {
    setRecallCloudKey(SECRET, 'manual', home);
    const deps = makeDeps();
    deps.confirm.mockResolvedValue(false);
    expect(await cloudEnable(deps, 'cloud')).toBe(1);
    expect(readVaultConsent(root, home)).toBeNull();
    expect(deps.setHybrid).not.toHaveBeenCalled();
    expect(deps.build).not.toHaveBeenCalled();
  });

  it('forces no rerank model for cloud-index and honours --rerank none / a chosen model for cloud', async () => {
    setRecallCloudKey(SECRET, 'manual', home);
    expect(await cloudEnable(makeDeps(), 'cloud-index', { rerank: 'rerank-2.5' })).toBe(0);
    expect(readVaultConsent(root, home)?.rerankModel).toBeNull();
    expect(await cloudEnable(makeDeps(), 'cloud', { rerank: 'none' })).toBe(0);
    expect(readVaultConsent(root, home)?.rerankModel).toBeNull();
    expect(await cloudEnable(makeDeps(), 'cloud', { rerank: 'rerank-2.5' })).toBe(0);
    expect(readVaultConsent(root, home)?.rerankModel).toBe('voyageai/rerank-2.5');
  });

  it('reports a build failure by kind only and keeps the consent', async () => {
    setRecallCloudKey(SECRET, 'manual', home);
    const deps = makeDeps();
    deps.build.mockRejectedValue(new CloudRecallError('auth'));
    expect(await cloudEnable(deps, 'cloud')).toBe(1);
    expect(err.join('\n')).toContain('(auth)');
    expect(allOutput()).not.toContain(SECRET);
  });
});

describe('key', () => {
  it('stores a key from the hidden prompt, audits it, and never prints it', async () => {
    const deps = makeDeps();
    expect(await cloudKeySet(deps)).toBe(0);
    expect(recallCloudKeyInfo(home)).toMatchObject({ present: true, source: 'file', origin: 'manual' });
    expect(allOutput()).not.toContain(SECRET);
    expect(readFileSync(join(home, '.dreamcontext', 'recall-cloud-audit.log'), 'utf-8')).toContain('"key_set"');
    expect(readFileSync(join(home, '.dreamcontext', 'recall-cloud-audit.log'), 'utf-8')).not.toContain(SECRET);
  });

  it('copies from a NAMED env var (origin env-copy), without a TTY, and rejects a value in its place', async () => {
    const deps = makeDeps({ isTTY: () => false, env: { OPENROUTER_API_KEY: SECRET } });
    expect(await cloudKeySet(deps, { fromEnv: 'OPENROUTER_API_KEY' })).toBe(0);
    expect(recallCloudKeyInfo(home).origin).toBe('env-copy');
    expect(readRecallCloudConfig(home).openRouterKey).toBe(SECRET);
    expect(await cloudKeySet(deps, { fromEnv: SECRET })).toBe(1);
    expect(await cloudKeySet(deps, { fromEnv: 'UNSET_VAR' })).toBe(1);
    expect(allOutput()).not.toContain(SECRET);
  });

  it('needs a terminal for the prompt and is refused in a spawned session', async () => {
    expect(await cloudKeySet(makeDeps({ isTTY: () => false }))).toBe(1);
    expect(await cloudKeySet(makeDeps({ env: { DREAMCONTEXT_AUTOMATION_RUN: 'x' } }))).toBe(1);
    expect(recallCloudKeyInfo(home).present).toBe(false);
  });

  it('copy-voice needs a TTY, no spawn marker and a confirm; the key never prints', async () => {
    writeVoiceConfig({ openRouterKey: VOICE_SECRET }, home);
    expect(await cloudKeyCopyVoice(makeDeps({ isTTY: () => false }))).toBe(1);
    expect(await cloudKeyCopyVoice(makeDeps({ env: { DREAMCONTEXT_SPAWNED: 'peer' } }))).toBe(1);
    const declined = makeDeps();
    declined.confirm.mockResolvedValue(false);
    expect(await cloudKeyCopyVoice(declined)).toBe(1);
    expect(recallCloudKeyInfo(home).present).toBe(false);
    const deps = makeDeps();
    expect(await cloudKeyCopyVoice(deps)).toBe(0);
    expect(deps.confirm.mock.calls[0][0]).toContain('Voice OpenRouter credit');
    expect(recallCloudKeyInfo(home).origin).toBe('voice-copy');
    expect(allOutput()).not.toContain(VOICE_SECRET);
    expect(readFileSync(join(home, '.dreamcontext', 'recall-cloud-audit.log'), 'utf-8')).toContain('key_copy_voice');
  });

  it('copy-voice reports a missing Voice key; clear removes the key', async () => {
    expect(await cloudKeyCopyVoice(makeDeps())).toBe(1);
    setRecallCloudKey(SECRET, 'manual', home);
    expect(cloudKeyClear(makeDeps())).toBe(0);
    expect(recallCloudKeyInfo(home).present).toBe(false);
  });
});

describe('status / disable', () => {
  it('prints the key only as presence + source and origin, also with --json', () => {
    setRecallCloudKey(SECRET, 'manual', home);
    grantVaultConsent(root, { tier: 'cloud', rerankModel: DEFAULT_RERANK_MODEL, surface: 'dashboard' }, home);
    expect(cloudStatus(makeDeps(), { json: true })).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json).toMatchObject({ tier: 'cloud', consent: 'valid', key: true, keySource: 'file', consentSurface: 'dashboard' });
    expect(allOutput()).not.toContain(SECRET);
    out.length = 0;
    cloudStatus(makeDeps());
    expect(out.join('\n')).toContain('Granted from the dashboard');
    expect(allOutput()).not.toContain(SECRET);
  });

  it('disable revokes consent and --purge removes the cloud index files', () => {
    setRecallCloudKey(SECRET, 'manual', home);
    grantVaultConsent(root, { tier: 'cloud-index', rerankModel: null, surface: 'cli-tty' }, home);
    for (const f of ['voyage-4.f32', 'voyage-4.json', 'voyage-4.meta.json']) writeFileSync(join(root, '.embeddings', f), 'x');
    expect(cloudDisable(makeDeps(), { purge: true })).toBe(0);
    expect(readVaultConsent(root, home)).toBeNull();
    expect(existsSync(join(root, '.embeddings', 'voyage-4.f32'))).toBe(false);
    expect(existsSync(join(root, '.embeddings', '.vault-id'))).toBe(true);
  });
});

describe('index', () => {
  it('runs an explicit build for a person and an automatic one for anything else', async () => {
    const human = makeDeps();
    expect(await cloudIndex(human, { maxUsd: '0.5' })).toBe(0);
    expect(human.build.mock.calls[0][3]).toMatchObject({ trigger: 'explicit', maxUsd: 0.5 });
    const noTty = makeDeps({ isTTY: () => false });
    await cloudIndex(noTty);
    expect(noTty.build.mock.calls[0][3]).toMatchObject({ trigger: 'auto' });
    const spawned = makeDeps({ env: { DREAMCONTEXT_SPAWNED: 'lab' } });
    await cloudIndex(spawned);
    expect(spawned.build.mock.calls[0][3]).toMatchObject({ trigger: 'auto' });
    const auto = makeDeps();
    await cloudIndex(auto, { auto: true });
    expect(auto.build.mock.calls[0][3]).toMatchObject({ trigger: 'auto' });
  });

  it('is quiet and exits 0 under --auto, loud and non-zero otherwise when aborted', async () => {
    const aborted: BuildCloudIndexResult = { ...okBuild, embedded: 0, aborted: 'throttled' };
    const auto = makeDeps();
    auto.build.mockResolvedValue(aborted);
    expect(await cloudIndex(auto, { auto: true })).toBe(0);
    expect(out).toEqual([]);
    const manual = makeDeps();
    manual.build.mockResolvedValue(aborted);
    expect(await cloudIndex(manual)).toBe(1);
    expect(out.join('\n')).toContain('30 minutes');
  });

  it('reports a failure by kind and withholds the message of any other error, so the key cannot leak', async () => {
    setRecallCloudKey(SECRET, 'manual', home);
    const deps = makeDeps();
    deps.build.mockRejectedValue(new Error(`boom ${SECRET}`));
    expect(await cloudIndex(deps)).toBe(1);
    expect(allOutput()).not.toContain(SECRET);
    expect(allOutput()).not.toContain('boom');
    expect(allOutput()).toContain('Index build failed: unexpected Error');
  });
});

describe('registration', () => {
  it('exposes the pinned verbs, with index --auto hidden', () => {
    const recall = new Command('recall');
    registerRecallCloudCommands(recall, makeDeps());
    const cloud = recall.commands.find((c) => c.name() === 'cloud')!;
    expect(cloud.commands.map((c) => c.name()).sort()).toEqual(['disable', 'enable', 'index', 'key', 'status']);
    const key = cloud.commands.find((c) => c.name() === 'key')!;
    expect(key.commands.map((c) => c.name()).sort()).toEqual(['clear', 'copy-voice', 'set']);
    const auto = cloud.commands.find((c) => c.name() === 'index')!.options.find((o) => o.long === '--auto')!;
    expect(auto.hidden).toBe(true);
  });
});

describe('spawnCloudIndexRefresh', () => {
  const consented = (): void => {
    setRecallCloudKey(SECRET, 'manual', home);
    grantVaultConsent(root, { tier: 'cloud', rerankModel: DEFAULT_RERANK_MODEL, surface: 'cli-tty' }, home);
  };
  const writeMeta = (patch: Record<string, unknown>): void => {
    mkdirSync(join(root, '.embeddings'), { recursive: true });
    writeFileSync(join(root, '.embeddings', 'voyage-4.meta.json'), JSON.stringify({
      version: 1, profile: 'voyage-4', model: 'm', dims: 1024, disclosureVersion: 1, eligibleTypesHash: 'h',
      eligibleTotal: 1, coveredDocs: 1, spentUsd: 0, updatedAt: new Date().toISOString(), lastAutoStartAt: null, churnStrikes: 0, ...patch,
    }));
  };

  it('does nothing for a local vault', () => {
    const launch = vi.fn();
    expect(spawnCloudIndexRefresh(root, 'sleep', { home, launch, cliEntry: '/x/cli.js' })).toEqual({ spawned: false, reason: 'tier_local' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches once for a consented vault, and the child gets neither the key nor a tab identity', () => {
    consented();
    process.env[RECALL_KEY_ENV] = SECRET;
    process.env.DREAMCONTEXT_TAB_SESSION = 'tab-1';
    const launch = vi.fn();
    const res = spawnCloudIndexRefresh(root, 'sleep', { home, launch, cliEntry: '/x/cli.js' });
    delete process.env.DREAMCONTEXT_TAB_SESSION;
    expect(res).toEqual({ spawned: true, reason: null });
    const [entry, cwd, env] = launch.mock.calls[0] as [string, string, NodeJS.ProcessEnv];
    expect(entry).toBe('/x/cli.js');
    expect(cwd).toBe(join(root, '..'));
    expect(env[RECALL_KEY_ENV]).toBeUndefined();
    expect(env.DREAMCONTEXT_TAB_SESSION).toBeUndefined();
    expect(JSON.stringify(launch.mock.calls)).not.toContain(SECRET);
  });

  it('skips for throttle, the rolling cap and a live build lock, never for churn', () => {
    consented();
    const launch = vi.fn();
    const run = () => spawnCloudIndexRefresh(root, 'sleep', { home, launch, cliEntry: '/x/cli.js' });
    writeMeta({ lastAutoStartAt: new Date().toISOString() });
    expect(run().reason).toBe('throttled');
    writeMeta({});
    writeFileSync(join(root, '.embeddings', 'voyage-4.build.lock'), '{}');
    expect(run().reason).toBe('lock_busy');
    rmSync(join(root, '.embeddings', 'voyage-4.build.lock'));
    recordCloudUsage(root, 'index', 5, { auto: true }, home);
    expect(run().reason).toBe('daily_index_cap');
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches a vault the old churn guard paused (strikes 3): the index never stops updating', () => {
    consented();
    const launch = vi.fn();
    writeMeta({ churnStrikes: 3 });
    expect(spawnCloudIndexRefresh(root, 'sleep', { home, launch, cliEntry: '/x/cli.js' })).toEqual({ spawned: true, reason: null });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
