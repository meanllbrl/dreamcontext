/**
 * Unit tests for src/lib/setup-drift.ts
 *
 * AC4  (test: setup-drift unit 'setupVersion 0.0.0 yields bootstrap not v0.0.0 claim')
 * AC5  (test: setup-drift unit 'CLI older than setupVersion is warn-only no update instruction')
 * AC9  (test: setup-drift unit 'DRIFT_CHECK 0/off/false disables directive')
 * AC10 (test: setup-drift unit 'cliVersion 0.0.0 fails safe to current')
 */

import { describe, it, expect } from 'vitest';
import { resolveDriftState, buildDriftDirective, type DriftInput } from '../../src/lib/setup-drift.js';

// ─── resolveDriftState ────────────────────────────────────────────────────────

describe('resolveDriftState', () => {
  // AC9
  it("DRIFT_CHECK 0/off/false disables directive", () => {
    for (const v of ['0', 'off', 'false', 'OFF', 'False', 'FALSE']) {
      const state = resolveDriftState({
        cliVersion: '0.7.1',
        setupVersion: '0.5.0',
        driftCheckEnv: v,
      });
      expect(state).toBe('disabled');
    }
  });

  // AC10
  it("cliVersion 0.0.0 fails safe to current", () => {
    const state = resolveDriftState({
      cliVersion: '0.0.0',
      setupVersion: '0.5.0',
    });
    expect(state).toBe('current');
  });

  it("cliVersion 0.0.0 fails safe to current even when stale would apply", () => {
    const state = resolveDriftState({
      cliVersion: '0.0.0',
      setupVersion: '0.1.0',
    });
    expect(state).toBe('current');
  });

  // AC4
  it("setupVersion 0.0.0 yields bootstrap", () => {
    const state = resolveDriftState({
      cliVersion: '0.7.1',
      setupVersion: '0.0.0',
    });
    expect(state).toBe('bootstrap');
  });

  it("stale: cli > setupVersion yields stale", () => {
    const state = resolveDriftState({
      cliVersion: '0.7.1',
      setupVersion: '0.5.0',
    });
    expect(state).toBe('stale');
  });

  // AC5
  it("downgrade: cli < setupVersion yields downgrade", () => {
    const state = resolveDriftState({
      cliVersion: '0.5.0',
      setupVersion: '0.7.1',
    });
    expect(state).toBe('downgrade');
  });

  it("current: cli === setupVersion yields current", () => {
    const state = resolveDriftState({
      cliVersion: '0.7.1',
      setupVersion: '0.7.1',
    });
    expect(state).toBe('current');
  });

  it("disabled takes priority over 0.0.0 cliVersion", () => {
    const state = resolveDriftState({
      cliVersion: '0.0.0',
      setupVersion: '0.0.0',
      driftCheckEnv: '0',
    });
    expect(state).toBe('disabled');
  });

  it("disabled takes priority over bootstrap", () => {
    const state = resolveDriftState({
      cliVersion: '0.7.1',
      setupVersion: '0.0.0',
      driftCheckEnv: 'off',
    });
    expect(state).toBe('disabled');
  });
});

// ─── buildDriftDirective ──────────────────────────────────────────────────────

describe('buildDriftDirective', () => {
  // AC9
  it("DRIFT_CHECK 0/off/false disables directive", () => {
    for (const v of ['0', 'off', 'false']) {
      const result = buildDriftDirective({
        cliVersion: '0.7.1',
        setupVersion: '0.5.0',
        driftCheckEnv: v,
      });
      expect(result).toBeNull();
    }
  });

  // AC10
  it("cliVersion 0.0.0 fails safe to current", () => {
    const result = buildDriftDirective({
      cliVersion: '0.0.0',
      setupVersion: '0.5.0',
    });
    expect(result).toBeNull();
  });

  // AC4
  it("setupVersion 0.0.0 yields bootstrap not v0.0.0 claim", () => {
    const result = buildDriftDirective({
      cliVersion: '0.7.1',
      setupVersion: '0.0.0',
    });
    expect(result).not.toBeNull();
    // Must NOT contain '0.0.0' as a claim about the project version
    expect(result).not.toContain('0.0.0');
    // Must still instruct dreamcontext update
    expect(result).toMatch(/dreamcontext update/);
    // Must contain the actual CLI version
    expect(result).toContain('0.7.1');
  });

  it("bootstrap: contains ## ⚠ Stale Project Assets heading", () => {
    const result = buildDriftDirective({
      cliVersion: '0.7.1',
      setupVersion: '0.0.0',
    });
    expect(result).toContain('## ⚠ Stale Project Assets');
  });

  // AC5
  it("CLI older than setupVersion is warn-only no update instruction", () => {
    const result = buildDriftDirective({
      cliVersion: '0.5.0',
      setupVersion: '0.7.1',
    });
    expect(result).not.toBeNull();
    // Must NOT contain dreamcontext update instruction
    expect(result).not.toMatch(/dreamcontext update/);
    // Must warn
    expect(result).toMatch(/\*\*Note:\*\*/);
    // Must contain both versions
    expect(result).toContain('0.5.0');
    expect(result).toContain('0.7.1');
  });

  it("stale: returns non-null with heading and update instruction", () => {
    const result = buildDriftDirective({
      cliVersion: '0.7.1',
      setupVersion: '0.5.0',
    });
    expect(result).not.toBeNull();
    expect(result).toContain('## ⚠ Stale Project Assets');
    expect(result).toMatch(/dreamcontext update/);
    // Both versions named
    expect(result).toContain('0.5.0');
    expect(result).toContain('0.7.1');
  });

  it("stale: directive states update is content-safe (does not touch _dream_context/)", () => {
    const result = buildDriftDirective({
      cliVersion: '0.7.1',
      setupVersion: '0.5.0',
    });
    expect(result).toContain('content-safe');
    expect(result).toContain('_dream_context/');
  });

  it("stale: includes user fallback phrase", () => {
    const result = buildDriftDirective({
      cliVersion: '0.7.1',
      setupVersion: '0.5.0',
    });
    expect(result).toContain('dreamcontext update');
    // User fallback
    expect(result).toMatch(/dreamcontext update.*yourself/s);
  });

  it("current: returns null", () => {
    const result = buildDriftDirective({
      cliVersion: '0.7.1',
      setupVersion: '0.7.1',
    });
    expect(result).toBeNull();
  });

  it("disabled: returns null", () => {
    const result = buildDriftDirective({
      cliVersion: '0.7.1',
      setupVersion: '0.5.0',
      driftCheckEnv: 'false',
    });
    expect(result).toBeNull();
  });
});
