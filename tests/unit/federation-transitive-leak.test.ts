import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { ingestEntry } from '../../src/lib/federation-ingest.js';
import { computeDigest } from '../../src/lib/federation-digest.js';
import { crossVaultRecall } from '../../src/lib/federation-recall.js';
import { DIGEST_SCHEMA_VERSION, type DigestEntry } from '../../src/lib/federation-inbox.js';

function makeDir(prefix: string): string {
  const dir = join(tmpdir(), `dc-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function makeVault(base: string, name: string, home: string, shareable: boolean): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'knowledge'), { recursive: true });
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE, shareable });
  addVault(name, projectRoot, home);
  return join(projectRoot, '_dream_context');
}

const SECRET = 'classified observability tracing pipeline from vault A';

/** An entry as if it had been pushed FROM vault A. */
function entryFromA(): DigestEntry {
  return {
    version: DIGEST_SCHEMA_VERSION,
    id: 'A:knowledge/secret@2026-06-10',
    origin: { vault: 'A', entryId: 'knowledge/secret@2026-06-10', sourceTimestamp: '2026-06-10' },
    kind: 'knowledge',
    title: 'A Secret Pipeline',
    summary: SECRET,
    recallScore: 9,
    links: ['knowledge/secret.md'],
  };
}

describe('federation transitive-leak guard', () => {
  let home: string;
  let base: string;
  let bRoot: string;

  beforeEach(() => {
    home = makeDir('tl-home');
    base = makeDir('tl-base');
    // Vault B is shareable, and ingests a doc that ORIGINATED in vault A.
    bRoot = makeVault(base, 'B', home, true);
    makeVault(base, 'C', home, false); // the third vault (current querier)
    const result = ingestEntry(bRoot, entryFromA());
    // Sanity: the ingested doc carries federated:true.
    expect(result.path).toContain('knowledge');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('(a) crossVaultRecall by C against B does NOT return the A-originated doc', () => {
    const { hits } = crossVaultRecall('observability tracing pipeline', {
      vaults: [{ name: 'C', current: true }, { name: 'B' }],
      home,
      topK: 10,
    });
    // No hit may carry the secret content that B merely passed through from A.
    expect(hits.some((h) => h.doc.body.includes(SECRET) || h.doc.description.includes(SECRET))).toBe(
      false,
    );
  });

  it('(b) computeDigest from B for C does NOT include the A-originated doc', () => {
    const profile = { terms: ['observability', 'tracing', 'pipeline'], query: 'observability tracing pipeline' };
    const entries = computeDigest(bRoot, 'B', profile, null, 10);
    // B must never re-export what it ingested from A.
    expect(entries.some((e) => e.summary.includes(SECRET) || e.origin.vault === 'A')).toBe(false);
  });
});
