import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFrontmatter } from '../../src/lib/frontmatter.js';
import { findFederatedCopies } from '../../src/cli/commands/federation.js';

function makeContextRoot(): string {
  const root = join(
    tmpdir(),
    `dc-purge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    '_dream_context',
  );
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  return root;
}

function writeKnowledge(
  root: string,
  slug: string,
  data: Record<string, unknown>,
  body = 'body',
): void {
  writeFrontmatter(join(root, 'knowledge', `${slug}.md`), { name: slug, type: 'knowledge', ...data }, body);
}

describe('findFederatedCopies (federation purge discovery)', () => {
  let root: string;
  beforeEach(() => {
    root = makeContextRoot();
  });
  afterEach(() => {
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('finds only federated:true docs, never native local knowledge', () => {
    writeKnowledge(root, 'native-doc', {});
    writeKnowledge(root, 'from-alpha', { federated: true, origin: { vault: 'alpha' } });
    writeKnowledge(root, 'from-beta', { federated: true, origin: { vault: 'beta' } });

    const all = findFederatedCopies(root);
    expect(all.map((c) => c.relPath).sort()).toEqual([
      'knowledge/from-alpha.md',
      'knowledge/from-beta.md',
    ]);
    // Native doc is never a purge candidate.
    expect(all.some((c) => c.relPath.includes('native-doc'))).toBe(false);
  });

  it('filters by origin.vault when given', () => {
    writeKnowledge(root, 'from-alpha', { federated: true, origin: { vault: 'alpha' } });
    writeKnowledge(root, 'from-beta', { federated: true, origin: { vault: 'beta' } });

    const onlyAlpha = findFederatedCopies(root, 'alpha');
    expect(onlyAlpha).toHaveLength(1);
    expect(onlyAlpha[0].relPath).toBe('knowledge/from-alpha.md');
    expect(onlyAlpha[0].originVault).toBe('alpha');
  });

  it('returns [] when there are no federated copies', () => {
    writeKnowledge(root, 'native-a', {});
    writeKnowledge(root, 'native-b', {});
    expect(findFederatedCopies(root)).toEqual([]);
  });

  it('never reports a file reached through a symlink that escapes knowledge/ (purge-deletion guard)', () => {
    // An out-of-vault file with federated:true frontmatter, reachable only via a
    // symlink planted inside knowledge/. It must NOT become a purge candidate —
    // otherwise `purge` would unlinkSync a file outside the vault.
    const outsideDir = join(dirname(root), 'outside');
    mkdirSync(outsideDir, { recursive: true });
    writeFrontmatter(
      join(outsideDir, 'evil.md'),
      { name: 'evil', type: 'knowledge', federated: true, origin: { vault: 'attacker' } },
      'malicious',
    );
    try {
      symlinkSync(join(outsideDir, 'evil.md'), join(root, 'knowledge', 'evil-link.md'));
    } catch {
      return; // platform without symlink support — skip
    }

    const found = findFederatedCopies(root);
    expect(found.some((c) => c.relPath.includes('evil'))).toBe(false);
    // And the external file is still on disk (proving discovery never targeted it).
    expect(existsSync(join(outsideDir, 'evil.md'))).toBe(true);
  });
});
