import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createProgram } from '../../src/cli/program.js';
import { buildCliManifest, serializeCliManifest, CLI_MANIFEST_VERSION } from '../../src/lib/cli-manifest.js';

/**
 * The generator AND the drift guard for `dashboard/src/generated/cli-manifest.json`.
 *
 * The dashboard renders a `dreamcontext …` shell call as the action it performed, and to do
 * that it has to know which token is a subcommand and which is an argument. That knowledge
 * comes from the real command tree, not from a list someone maintains by hand — this repo has
 * shipped a mirrored-constant drift twice (the dashboard's sleep thresholds sat two rescales
 * behind the backend and nothing failed). So the file is generated here and compared here:
 * add a command, run `npm run gen:cli-manifest`, and the UI understands it.
 *
 * Regenerate with:  npm run gen:cli-manifest
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, '../../dashboard/src/generated/cli-manifest.json');

describe('cli manifest', () => {
  const manifest = buildCliManifest(createProgram());
  const serialized = serializeCliManifest(manifest);

  it('covers the real command tree', () => {
    // Sanity floor, not a golden count: the point is that the walk actually descended into
    // subcommands rather than returning the ~45 top-level groups and stopping there.
    expect(manifest.endpoints.length).toBeGreaterThan(200);
    expect(manifest.version).toBe(CLI_MANIFEST_VERSION);

    const byPath = new Map(manifest.endpoints.map((e) => [e.path, e]));
    // A group, a leaf with a positional, and a leaf whose options take values — the three
    // shapes the parser depends on. If any of these changes name, the UI's lexicon should be
    // revisited in the same commit, which is what a failure here is asking for.
    expect(byPath.get('tasks')?.group).toBe(true);
    expect(byPath.get('tasks create')?.args).toEqual(['<name>']);
    expect(byPath.get('tasks create')?.valueFlags).toContain('--priority');
    expect(byPath.get('tasks create')?.valueFlags).toContain('-p');
    expect(byPath.get('memory recall')?.group).toBeUndefined();
  });

  it('matches the file checked in for the dashboard', () => {
    const update = process.env.UPDATE_CLI_MANIFEST === '1';
    if (update || !existsSync(MANIFEST_PATH)) {
      mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
      writeFileSync(MANIFEST_PATH, serialized, 'utf-8');
    }
    const onDisk = readFileSync(MANIFEST_PATH, 'utf-8');
    expect(
      onDisk,
      'dashboard/src/generated/cli-manifest.json is stale — run `npm run gen:cli-manifest`',
    ).toBe(serialized);
  });
});
