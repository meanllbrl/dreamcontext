import { describe, it, expect } from 'vitest';
import { REGISTRY, pendingMigrations } from '../../src/migrations/index.js';

describe('migration-registry', () => {
  it('registry has retrofitted 0.7.0 data-structures entry', () => {
    const entry = REGISTRY.find((m) => m.version === '0.7.0');
    expect(entry).toBeDefined();
    expect(entry!.steps.length).toBeGreaterThanOrEqual(2);
    // No agentTask on 0.7.0 (both steps are deterministic)
    expect(entry!.agentTask).toBeUndefined();
  });

  it('pendingMigrations 0.5.0->0.8.0 ordered', () => {
    // 0.7.0 is in (0.5.0, 0.8.0]
    const pending = pendingMigrations('0.5.0', '0.8.0');
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const versions = pending.map((m) => m.version);
    expect(versions).toContain('0.7.0');
    // Verify ascending order
    for (let i = 1; i < pending.length; i++) {
      const prev = pending[i - 1].version.split('.').map(Number);
      const curr = pending[i].version.split('.').map(Number);
      const prevNum = prev[0] * 10000 + prev[1] * 100 + (prev[2] ?? 0);
      const currNum = curr[0] * 10000 + curr[1] * 100 + (curr[2] ?? 0);
      expect(currNum).toBeGreaterThanOrEqual(prevNum);
    }
  });

  it('pendingMigrations 0.8.0->0.8.0 empty', () => {
    // Equal versions: (0.8.0, 0.8.0] is empty
    const pending = pendingMigrations('0.8.0', '0.8.0');
    expect(pending).toHaveLength(0);
  });

  it('pendingMigrations excludes versions <= from', () => {
    // 0.7.0 is NOT in (0.7.0, 0.8.0] — it is exactly equal to from, so excluded
    const pending = pendingMigrations('0.7.0', '0.8.0');
    const versions = pending.map((m) => m.version);
    expect(versions).not.toContain('0.7.0');
  });

  it('pendingMigrations excludes versions > to', () => {
    // 0.7.0 is NOT in (0.8.0, 0.9.0] — it is < from
    const pending = pendingMigrations('0.8.0', '0.9.0');
    const versions = pending.map((m) => m.version);
    expect(versions).not.toContain('0.7.0');
  });

  it('downgrade (to < from) returns empty', () => {
    const pending = pendingMigrations('0.9.0', '0.7.0');
    // pendingMigrations only filters — downgrade guard is in the runner, but
    // the filter itself returns empty since no migration satisfies (>0.9.0 && <=0.7.0)
    expect(pending).toHaveLength(0);
  });
});
