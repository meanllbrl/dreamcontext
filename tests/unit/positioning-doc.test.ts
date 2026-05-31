import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const PKG_PATH = join(REPO_ROOT, 'package.json');
const POSITIONING_MD = join(REPO_ROOT, '_dream_context', 'knowledge', 'positioning.md');
const SOUL_MD = join(REPO_ROOT, '_dream_context', 'core', '0.soul.md');

function readPkg(): Record<string, unknown> {
  return JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
}

function readPositioning(): string {
  return readFileSync(POSITIONING_MD, 'utf-8');
}

function readSoul(): string {
  return readFileSync(SOUL_MD, 'utf-8');
}

// ─── positioning.md existence and content rules ───────────────────────────────

describe('positioning.md', () => {
  it('exists at _dream_context/knowledge/positioning.md', () => {
    expect(existsSync(POSITIONING_MD)).toBe(true);
  });

  it('contains a Short variant label', () => {
    const content = readPositioning();
    // Must have a Short section heading (case-insensitive)
    expect(content).toMatch(/##\s*Short/i);
  });

  it('contains a Medium variant label', () => {
    const content = readPositioning();
    expect(content).toMatch(/##\s*Medium/i);
  });

  it('contains a Long variant label', () => {
    const content = readPositioning();
    expect(content).toMatch(/##\s*Long/i);
  });

  it('contains a roadmap-framing rule (no-autonomous rule)', () => {
    const content = readPositioning();
    // Should have a Rule section or equivalent
    expect(content).toMatch(/Rule|Roadmap|autonomous/i);
  });

  it('does NOT contain the word "autonomous" (case-insensitive)', () => {
    const content = readPositioning();
    expect(content.toLowerCase()).not.toContain('autonomous');
  });
});

// ─── package.json description and keywords ────────────────────────────────────

describe('package.json description', () => {
  it('length is <= 120 characters', () => {
    const pkg = readPkg();
    const description = String(pkg.description ?? '');
    expect(description.length).toBeLessThanOrEqual(120);
  });

  it('does NOT contain the word "autonomous" (case-insensitive)', () => {
    const pkg = readPkg();
    const description = String(pkg.description ?? '').toLowerCase();
    expect(description).not.toContain('autonomous');
  });

  it('equals the Short variant string from positioning.md', () => {
    const content = readPositioning();
    // Extract the Short variant: the line(s) immediately after "## Short"
    const shortMatch = content.match(/##\s*Short[^\n]*\n+([^\n#]+)/);
    expect(shortMatch).not.toBeNull();
    const shortVariant = shortMatch![1].trim();

    const pkg = readPkg();
    const description = String(pkg.description ?? '').trim();
    expect(description).toBe(shortVariant);
  });
});

describe('package.json keywords', () => {
  it('includes "brain"', () => {
    const pkg = readPkg();
    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect(pkg.keywords as string[]).toContain('brain');
  });
});

// ─── CLI version (via manifest lib) ──────────────────────────────────────────

describe('dreamcontextVersion()', () => {
  it('returns a string matching package.json version', async () => {
    // Import freshly — note: cachedVersion in manifest.ts is module-level,
    // but the value will be 0.5.0 (the correct package.json version).
    const { dreamcontextVersion } = await import('../../src/lib/manifest.js');
    const pkg = readPkg();
    expect(dreamcontextVersion()).toBe(String(pkg.version));
  });

  it('matches package.json and is not the 0.0.0 sentinel or the old 0.1.0 literal', async () => {
    const { dreamcontextVersion } = await import('../../src/lib/manifest.js');
    const version = dreamcontextVersion();
    expect(version).toBe(String(readPkg().version));
    expect(version).not.toBe('0.0.0');
    expect(version).not.toBe('0.1.0');
  });
});

// ─── 0.soul.md Project Identity ───────────────────────────────────────────────

describe('0.soul.md', () => {
  it('does NOT contain the word "autonomous" (case-insensitive)', () => {
    const content = readSoul();
    expect(content.toLowerCase()).not.toContain('autonomous');
  });

  it('contains "## Project Identity" section', () => {
    const content = readSoul();
    expect(content).toContain('## Project Identity');
  });

  it('contains positioning sentence (persistent brain / remembers / knows)', () => {
    const content = readSoul();
    // The Project Identity should contain core positioning language
    expect(content.toLowerCase()).toMatch(/persistent brain|remembers.*built|knows.*works/);
  });

  it('contains roadmap-framing principle (no-autonomous bullet)', () => {
    const content = readSoul();
    // Core Principles should contain the roadmap framing rule
    expect(content).toMatch(/roadmap\s*framing|learning to act|human steering/i);
  });
});
