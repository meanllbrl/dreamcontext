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
  resolveConnectedVaults,
  namespacedKey,
  type CrossVaultTarget,
} from '../../src/lib/federation-recall.js';
import { addConnection, markStale } from '../../src/lib/connections.js';

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
  opts: { home: string },
): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'knowledge'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE });
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

/** Write an automation manifest (`automations/<slug>.md`) into a vault. */
function writeAutomation(projectRoot: string, slug: string, body: string): void {
  const dir = join(projectRoot, '_dream_context', 'automations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), `---\nslug: ${slug}\ntitle: ${slug}\nenabled: true\n---\n\n${body}\n`);
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
    const cur = makeVault(base, 'cur', { home });
    const peer = makeVault(base, 'peer', { home });
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

  it('reads every targeted peer — there is no second opt-in to withhold one', () => {
    // The retired `shareable` flag used to make this peer silently return
    // nothing. A peer reaches this function only because the caller wired it up,
    // so being targeted IS the grant.
    const cur = makeVault(base, 'cur', { home });
    const peer = makeVault(base, 'peer', { home });
    writeKnowledge(cur, 'cur-doc', 'caching strategy notes for the gateway');
    writeKnowledge(peer, 'peer-doc', 'caching strategy notes for the gateway');

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { hits, skipped } = crossVaultRecall('caching strategy gateway', {
      vaults: [{ name: 'cur', current: true }, { name: 'peer' }],
      home,
      topK: 10,
    });

    const vaults = hits.map((h) => h.vault);
    expect(vaults).toContain('cur');
    expect(vaults).toContain('peer');
    expect(skipped).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ALWAYS includes the current vault', () => {
    const cur = makeVault(base, 'cur', { home });
    writeKnowledge(cur, 'local-secret', 'private internal deployment runbook');

    const { hits } = crossVaultRecall('deployment runbook internal', {
      vaults: [{ name: 'cur', current: true }],
      home,
      topK: 10,
    });

    expect(hits.map((h) => h.vault)).toContain('cur');
  });

  it('skips a stale peer (resolution fails) without throwing, warning once, others continue', () => {
    const cur = makeVault(base, 'cur', { home });
    const peer = makeVault(base, 'gone', { home });
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
    const cur = makeVault(base, 'cur', { home });
    const peer = makeVault(base, 'peer', { home });
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

  it('serves the CURRENT vault\'s automations but never a peer\'s', () => {
    const cur = makeVault(base, 'cur', { home });
    const peer = makeVault(base, 'peer', { home });
    writeAutomation(cur, 'my-digest', 'nightly paddle revenue digest run');
    writeAutomation(peer, 'their-digest', 'nightly paddle revenue digest run');

    const { hits } = crossVaultRecall('nightly paddle revenue digest', {
      vaults: [{ name: 'cur', current: true }, { name: 'peer' }],
      home,
      topK: 10,
    });

    const slugs = hits.map((h) => h.doc.slug);
    // A manifest body IS the prompt a bypassPermissions session runs, and
    // `shared` defaults false — so a peer's automations never cross the boundary.
    expect(slugs).not.toContain('their-digest');
    // …but the user's OWN automations must stay first-class: plain `memory recall`
    // takes this federated path by default whenever any peer is connected.
    expect(slugs).toContain('my-digest');
  });

  it('honours minLevel across vaults', () => {
    const cur = makeVault(base, 'cur', { home });
    const peer = makeVault(base, 'peer', { home });
    writeKnowledge(cur, 'cur-pinned', 'kubernetes ingress rollout notes', { pinned: true });
    writeKnowledge(cur, 'cur-plain', 'kubernetes ingress rollout notes');
    writeKnowledge(peer, 'peer-pinned', 'kubernetes ingress rollout notes', { pinned: true });
    writeKnowledge(peer, 'peer-plain', 'kubernetes ingress rollout notes');

    const { hits } = crossVaultRecall('kubernetes ingress rollout', {
      vaults: [{ name: 'cur', current: true }, { name: 'peer' }],
      home,
      topK: 10,
      minLevel: 3,
    });

    expect(hits.map((h) => h.doc.slug).sort()).toEqual(['cur-pinned', 'peer-pinned']);
  });

  it('resolveAllShareableVaults spans the current vault + EVERY registered vault', () => {
    makeVault(base, 'cur', { home });
    makeVault(base, 'one', { home });
    makeVault(base, 'two', { home });

    const current: CrossVaultTarget = { name: 'cur', current: true };
    const names = resolveAllShareableVaults(current, home).map((t) => t.name).sort();
    // `--all-vaults` is an explicit flag: it means all of them, with no hidden
    // per-vault opt-in deciding which ones actually answer.
    expect(names).toEqual(['cur', 'one', 'two']);
  });

  it('currentVaultTarget resolves a registered current vault by name', () => {
    const cur = makeVault(base, 'cur', { home });
    const { name, target } = currentVaultTarget(cur, home);
    expect(name).toBe('cur');
    expect(target.current).toBe(true);
    expect(target.name).toBe('cur');
  });
});

describe('resolveConnectedVaults (federation P2)', () => {
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

  const ctx = (projectRoot: string): string => join(projectRoot, '_dream_context');
  const current: CrossVaultTarget = { name: 'cur', current: true };

  it('spans out/both connections, current first', () => {
    const cur = makeVault(base, 'cur', { home });
    makeVault(base, 'outPeer', { home });
    makeVault(base, 'bothPeer', { home });
    addConnection(ctx(cur), 'cur', 'outPeer', 'out', null, home);
    addConnection(ctx(cur), 'cur', 'bothPeer', 'both', null, home);

    const targets = resolveConnectedVaults(current, ctx(cur), home);
    expect(targets[0].current).toBe(true); // current leads
    const names = targets.map((t) => t.name);
    expect(names).toContain('outPeer');
    expect(names).toContain('bothPeer');
  });

  it('excludes an in-only connection (this vault does not reach across it)', () => {
    const cur = makeVault(base, 'cur', { home });
    makeVault(base, 'inPeer', { home });
    addConnection(ctx(cur), 'cur', 'inPeer', 'in', null, home);

    const names = resolveConnectedVaults(current, ctx(cur), home).map((t) => t.name);
    expect(names).not.toContain('inPeer');
    expect(names).toEqual(['cur']);
  });

  it('INCLUDES every out/both peer — drawing the connection is the grant', () => {
    // This is the inverse of the retired `shareable` gate: a peer you connected
    // to can no longer be wired-but-silent.
    const cur = makeVault(base, 'cur', { home });
    makeVault(base, 'peer', { home });
    addConnection(ctx(cur), 'cur', 'peer', 'both', null, home);

    const names = resolveConnectedVaults(current, ctx(cur), home).map((t) => t.name);
    expect(names).toContain('peer');
  });

  it('excludes a stale connection even when out/both', () => {
    const cur = makeVault(base, 'cur', { home });
    makeVault(base, 'dead', { home });
    addConnection(ctx(cur), 'cur', 'dead', 'both', null, home);
    markStale(ctx(cur), 'dead');

    const names = resolveConnectedVaults(current, ctx(cur), home).map((t) => t.name);
    expect(names).not.toContain('dead');
  });

  it('degenerates to current-only with no connections', () => {
    const cur = makeVault(base, 'cur', { home });
    expect(resolveConnectedVaults(current, ctx(cur), home).map((t) => t.name)).toEqual(['cur']);
  });
});
