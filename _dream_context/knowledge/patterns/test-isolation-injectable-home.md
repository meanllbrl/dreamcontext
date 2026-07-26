---
name: test-isolation-injectable-home
description: Pattern for isolating tests that touch home-directory state (~/.dreamcontext/*) from the developer's real machine via injectable home parameter and environment-level isolation
type: knowledge
tags:
  - kind:pattern
  - layer:testing
  - domain:quality
created: "2026-07-26"
updated: "2026-07-26"
---

# Test Isolation: Injectable Home

## Problem

Unit/integration tests that read or write `~/.dreamcontext/*` files (registry, approvals, credentials, heartbeat) can pollute the developer's real machine, causing:
1. Cross-test pollution THROUGH THE REAL FILESYSTEM (one test's writes break another)
2. False-positive test passes (test expects empty, finds pre-existing state from real usage)
3. Violation of "ships disabled" guarantees (test creates files that should only exist after explicit user action)

The failure is often **invisible when the test file runs in isolation** and only appears in full-suite runs.

## Solution Shape

Two complementary approaches, chosen by whether production code can accept a `home` parameter:

### A. Production code CAN take injectable home

**Best when:** the function signature can accept `home?: string` without breaking existing callers (e.g., library functions, CLI commands).

```typescript
// Production code
export function readRegistry(home?: string): Registry {
  const path = registryPath(home);  // uses home ?? os.homedir()
  // ...
}

// Test
it('reads empty registry', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'test-'));
  const registry = readRegistry(tmpHome);
  expect(registry.projects).toEqual({});
  rmSync(tmpHome, { recursive: true });
});
```

**Key practices:**
- All home-touching functions accept `home?: string` parameter
- Helper `registryPath(home?: string)` centralizes the `home ?? os.homedir()` logic
- Tests pass a fresh `mkdtempSync()` dir per test (or `beforeEach`)
- Clean up in `afterEach` or `afterAll`

### B. Production code CANNOT take injectable home

**Best when:** the code legitimately runs against the real home (e.g., server route handlers, CLI --help output) and adding `home` param would be wrong.

```typescript
// Production code (unchanged)
export function handleRoute(req, res) {
  const registry = readRegistry();  // no param, uses os.homedir()
  // ...
}

// Test — isolate at ENVIRONMENT level
describe('route handler', () => {
  let realHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'test-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (realHome !== undefined) {
      process.env.HOME = realHome;
    } else {
      delete process.env.HOME;  // was previously unset
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('handles request', () => {
    // test body — os.homedir() now returns tmpHome
  });
});
```

**Key practices:**
- Capture `process.env.HOME` in `beforeEach`, restore in `afterEach`
- Handle both cases: was set (restore) or was unset (delete the key)
- `os.homedir()` honours `$HOME` on POSIX, so this works transparently
- Clean up the temp dir in `afterEach`

## Proof of Isolation

Don't just assert the test is green. **Prove the real home was untouched:**

```typescript
// In the test suite or a dedicated smoke test
afterAll(() => {
  const realRegistryPath = join(os.homedir(), '.dreamcontext', 'automations.json');
  expect(existsSync(realRegistryPath)).toBe(false);  // or your expected state
});
```

If the real path exists when it shouldn't, the test leaked. This assertion catches pollution that would otherwise be invisible.

## Detection: Why Full-Suite Runs Matter

The automations wave-4 gate found this failure **only in a full-suite run**:
- `automations-tick.test.ts` passed when run in isolation
- Failed in full suite because `automations-route.test.ts` (same wave, different file) wrote `~/.dreamcontext/automations.json` with 21 tmp-path entries
- The tick test deliberately omits `home` to prove the default resolves, so it found the pollution

**Lesson:** gate each wave on the WHOLE suite, not just the new tests. File-isolated green is necessary but not sufficient.

## Occurrences

1. **vault-registry (did it right, template)**: `tests/unit/vault-registry.test.ts` passes `tmpdir` as `home` to isolate from developer's real registry. Pattern established.
2. **automations wave-4 (got it wrong, then fixed)**: Route tests called registry without `home` param → wrote to real `~/.dreamcontext/` → broke tick tests → violated "ships disabled" guarantee. Fixed via environment-level isolation (`process.env.HOME`). Caught by full-suite gate.
3. **Lab credentials**: `tests/unit/lab-credentials.test.ts` uses injectable `home` to avoid touching real `~/.dreamcontext/lab/credentials.json`.

## When to Apply

Any test that touches:
- `~/.dreamcontext/` (registry, approvals, credentials, heartbeat, logs)
- `~/.ssh/`, `~/.aws/`, `~/.config/` (if testing those paths)
- Any machine-global state that survives across tests

If the code writes to a home-relative path, the test MUST isolate.

## Related

- `knowledge/vault-registry-multivault.md` — first recorded use of injectable home for testing
- Bookmark `bm_VBYACBp6` (2026-07-25) — automations wave-4 failure + fix
- Pattern: `per-session-live-state-files.md` — for ephemeral session state (different concern: those are per-project, not per-machine)
