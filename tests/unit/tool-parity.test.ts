import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEADLESS_ENVELOPES } from '../../src/lib/t3-bridge/headless-envelope.js';

const ROOT = join(__dirname, '..', '..');

describe('docs/tool-parity.md', () => {
  it('is what the generator writes', () => {
    expect(() => execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-tool-parity.mjs'), '--check'])).not.toThrow();
  });

  it('has a row for every headless surface', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'tool-parity.md'), 'utf-8');
    for (const s of Object.keys(HEADLESS_ENVELOPES)) expect(doc).toContain(`| ${s} |`);
  });

  it('records the Codex sleep run as works or experimental', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'tool-parity.md'), 'utf-8');
    expect(doc).toMatch(/\| Sleep \| works \| (works|experimental) \|/);
  });
});
