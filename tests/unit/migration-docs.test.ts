/**
 * AC9 light presence test: CONTRIBUTING.md mentions src/migrations registry
 * convention. This is a light read-only check; the full AC9 is a manual gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..', '..');

describe('migration-docs', () => {
  it('CONTRIBUTING mentions src/migrations registry convention', () => {
    const contributingPath = join(repoRoot, 'CONTRIBUTING.md');
    expect(existsSync(contributingPath)).toBe(true);

    const content = readFileSync(contributingPath, 'utf-8');
    // Must mention migrations and the registry
    expect(content).toContain('src/migrations');
    // Must reference the worked example
    expect(content).toContain('0.7.0');
    // Must have the section header
    expect(content.toLowerCase()).toContain('shipping a migration');
  });
});
