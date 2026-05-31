import { describe, it, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh');

describe('install.sh syntax', () => {
  it('passes sh -n (syntax check) without error', () => {
    expect(() =>
      execFileSync('sh', ['-n', INSTALL_SH], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});

describe('install.sh security rules', () => {
  let content: string;

  it('file can be read', () => {
    content = readFileSync(INSTALL_SH, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('contains no eval', () => {
    content = readFileSync(INSTALL_SH, 'utf-8');
    // Reject bare `eval ` or `eval(` — not `evaluate` or comment references
    expect(content).not.toMatch(/\beval\s+[^#]/);
  });

  it('contains no sudo', () => {
    content = readFileSync(INSTALL_SH, 'utf-8');
    // Reject sudo as a command invocation (not in comments or strings)
    const lines = content.split('\n');
    for (const line of lines) {
      const stripped = line.replace(/#.*$/, '').trim();
      expect(stripped).not.toMatch(/\bsudo\b/);
    }
  });

  it('contains no nested remote pipe-to-sh (curl|wget ... | sh|bash)', () => {
    content = readFileSync(INSTALL_SH, 'utf-8');
    // The dangerous pattern: piping a remote fetch directly into sh/bash
    expect(content).not.toMatch(/\b(curl|wget)\b[^;|\n]*\|\s*(sh|bash)\b/);
  });
});

describe('package.json files[] includes install.sh', () => {
  it('files array contains install.sh', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain('install.sh');
  });
});
