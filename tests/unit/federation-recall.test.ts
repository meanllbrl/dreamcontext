import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import {
  crossVaultRecall,
  currentVaultTarget,
  resolveAllShareableVaults,
  namespacedKey,
  type CrossVaultTarget,
} from '../../src/lib/federation-recall.js';

function makeHome(): string {
  const dir = join(tmpdir(), `dc-fedrecall-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.7.0',
  disableNativeMemory: true,
};

/** Create a project dir with `_dream_context/`, a config, and register it. */
function makeVault(
  base: string,
  name: string,
  opts: { shareable?: boolean; home: string },
): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'knowledge'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE, shareable: opts.shareable });
  addVault(name, projectRoot, opts.home);
  return projectRoot;
}

/** Write a knowledge markdown doc into a vault. */
function writeKnowledge(
  projectRoot: string,
  slug: string,
  body: string,
  frontmatter: Record<string, string | boolean> = {},
): void {
  const fmLines = Object.entries({ title: slug, ...frontmatter })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const path = join(projectRoot, '_dream_context', 'knowledge', `${slug}.md`);
  writeFileSync(path, `---\n${fmLines}\n---\n\n${body}\n`);
}

describe('crossVaultRecall (federation P1.2/P1.3)', () => {
  let home: string;
  let base: string;

  beforeEach(() => {
    home = makeHome();
    base = makeHome();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('namespaces hits <vault>::<type>/<slug> and does not collide on a shared slug (P1.3)', () => {
    const cur = makeVault(base, 'cur', { home, shareable: false });
    const peer = makeVault(base, 'peer', { home, shareable: true });
    // SAME slug in both vaults — must produce two distinct namespaced keys.
    writeKnowledge(cur, 'auth-design', 'shared widget authentication design notes');
    writeKnowledge(peer, 'auth-design', 'shared widget authentication design notes');

    const { hits } = crossVaultRecall('authentication design widget', {
      vaults: [{ name: 'cur', current: true }, { name: 'peer' }],
      home,
      topK: 10,
    });

    const keys = hits.map((h) => h.key).sort();
    expect(keys).toContain(namespacedKey('cur', 'knowledge', 'auth-design'));
    expect(keys).toContain(namespacedKey('peer', 'knowledge', 'auth-design'));
    // Two hits, two distinct keys — no collision.
    expect(new Set(keys).size).toBe(2);
  });

  it('silently excludes a non-shareable peer (no warning)', () => {
    const cur = makeVault(base, 'cur', { home, shareable: false });
    const priv = makeVault(base, 'priv', { home, shareable: false });
    writeKnowledge(cur, 'cur-doc', 'caching strategy notes for the gateway');
    writeKnowledge(priv, 'priv-doc', 'caching strategy notes for the gateway');

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { hits, skipped } = crossVaultRecall('caching strategy gateway', {
      vaults: [{ name: 'cur', current: true }, { name: 'priv' }],
      home,
      topK: 10,
    });

    const vaults = hits.map((h) => h.vault);
    expect(vaults).toContain('cur');
    expect(vaults).not.toContain('priv'); // non-shareable peer excluded
    expect(skipped).toEqual([]); // exclusion is NOT a skip
    expect(warn).not.toHaveBeenCalled(); // silent — privacy is the default, not an error
  });

  it('ALWAYS includes the current vault regardless of its own shareable flag', () => {
    // Current vault is NOT shareable, yet its own docs must still be searched.
    const cur = makeVault(base, 'cur', { home, shareable: false });
    writeKnowledge(cur, 'local-secret', 'private internal deployment runbook');

    const { hits } = crossVaultRecall('deployment runbook internal', {
      vaults: [{ name: 'cur', current: true }],
      home,
      topK: 10,
    });

    expect(hits.map((h) => h.vault)).toContain('cur');
  });

  it('skips a stale peer (resolution fails) without throwing, warning once, others continue', () => {
    const cur = makeVault(base, 'cur', { home, shareable: false });
    const peer = makeVault(base, 'gone', { home, shareable: true });
    writeKnowledge(cur, 'cur-doc', 'rate limiting middleware design');
    writeKnowledge(peer, 'peer-doc', 'rate limiting middleware design');

    // Delete the peer's _dream_context/ so resolveVaultContextRoot throws VaultError.
    rmSync(join(peer, '_dream_context'), { recursive: true, force: true });
    rmdirSync(peer); // remove the now-empty project dir too

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { hits, skipped } = crossVaultRecall('rate limiting middleware', {
      vaults: [{ name: 'cur', current: true }, { name: 'gone' }],
      home,
      topK: 10,
    });

    expect(skipped).toEqual([{ vault: 'gone', reason: 'stale' }]);
    expect(hits.map((h) => h.vault)).toContain('cur'); // others kept working
    expect(warn).toHaveBeenCalledTimes(1); // warned once
  });

  it('excludes federated:true docs from cross-vault serving (transitive-leak guard)', () => {
    const cur = makeVault(base, 'cur', { home, shareable: false });
    const peer = makeVault(base, 'peer', { home, shareable: true });
    // The peer has a NATIVE doc and an INGESTED-from-elsewhere doc on the same topic.
    writeKnowledge(peer, 'native', 'observability tracing pipeline native to peer');
    writeKnowledge(peer, 'ingested', 'observability tracing pipeline ingested from a third vault', {
      federated: true,
    });
    writeKnowledge(cur, 'cur-doc', 'unrelated billing notes');

    const { hits } = crossVaultRecall('observability tracing pipeline', {
      vaults: [{ name: 'cur', current: true }, { name: 'peer' }],
      home,
      topK: 10,
    });

    const slugs = hits.map((h) => h.doc.slug);
    expect(slugs).toContain('native');
    expect(slugs).not.toContain('ingested'); // federated doc NEVER served across the boundary
  });

  it('resolveAllShareableVaults spans current + shareable peers only', () => {
    makeVault(base, 'cur', { home, shareable: false });
    makeVault(base, 'open', { home, shareable: true });
    makeVault(base, 'closed', { home, shareable: false });

    const current: CrossVaultTarget = { name: 'cur', current: true };
    const targets = resolveAllShareableVaults(current, home);
    const names = targets.map((t) => t.name).sort();
    expect(names).toContain('cur');
    expect(names).toContain('open');
    expect(names).not.toContain('closed'); // non-shareable peer not even attempted
  });

  it('currentVaultTarget resolves a registered current vault by name', () => {
    const cur = makeVault(base, 'cur', { home, shareable: false });
    const { name, target } = currentVaultTarget(cur, home);
    expect(name).toBe('cur');
    expect(target.current).toBe(true);
    expect(target.name).toBe('cur');
  });
});
