---
name: mirror-with-drift-test
description: >-
  When one codebase layer cannot import from another (separate tsconfig/bundle),
  a source-of-truth list/constant must be MIRRORED into the importing layer — and
  mirrors rot silently. Guard it: a textual drift test parses BOTH files and fails
  the moment they disagree. Used in chartRegistry RENDERS mirroring types.ts RENDERS,
  and lab-html-kit.css mirrored as a TS string.
type: knowledge
tags:
  - kind:pattern
  - architecture
  - topic:testing
  - topic:build
date: '2026-08-25'
---

# Mirror-With-Drift-Test Pattern

## Why This Exists

Cross-layer imports are sometimes impossible due to build boundaries:
- The **dashboard** (Vite bundle, `dashboard/tsconfig.json`) cannot import from `src/` (CLI bundle, `tsconfig.json`)
- A **test** cannot import a `.css` file as a string when vitest stubs `.css?raw` to `''`

When a source-of-truth constant (enum, list, CSS) must exist in both layers, you have two bad options:
1. **Duplicate by hand** → one side inevitably falls behind, the mismatch is silent until runtime
2. **Extract to a shared module** → increases build complexity, doesn't work when one side needs the *content* as data (e.g. CSS as a string for injection)

The mirror-with-drift-test pattern is the third option: **duplicate deliberately, then make drift impossible via a compile-time guard.**

## The Pattern

### 1. Designate ONE source of truth

The authoritative copy lives where the domain logic owns it. Examples:
- `src/lib/lab/types.ts` owns `RENDERS` (the CLI validates against it, doctor uses it, adapters return these kinds)
- `dashboard/src/components/lab/lab-html-kit.css` owns the kit classes (it's the reference CSS file)

### 2. Mirror it where needed

The consuming layer copies the constant:
- `dashboard/src/components/lab/chartRegistry.ts` mirrors `RENDERS` as a const array (same order, same values)
- `dashboard/src/components/lab/labHtmlKit.ts` mirrors `lab-html-kit.css` as `LAB_HTML_KIT_CSS` (byte-identical string)

**Document the mirror relationship** in a comment at both sites:
```typescript
/**
 * The render list has ONE owner: `RENDERS` in src/lib/lab/types.ts.
 * The dashboard cannot import from `src/` (separate bundle), so this
 * MIRRORS it — and a textual drift test fails if they disagree.
 */
export const RENDERS = ['number', 'line', 'pie', ...] as const;
```

### 3. Write a textual drift test

A unit test that:
1. Reads BOTH files from disk (as text, not imports)
2. Parses/extracts the mirrored value from each
3. Asserts byte-for-byte or value-for-value equality
4. **Fails the build** if they drift

Examples:
- `tests/unit/lab-render-registry.test.ts` parses `RENDERS = [...]` from both `types.ts` and `chartRegistry.ts` via regex
- `tests/unit/lab-html-body.test.ts` reads `LAB_HTML_KIT_CSS` from the TS file and the `.css` file, compares as trimmed strings

```typescript
import { readFileSync } from 'node:fs';

it('mirrors RENDERS exactly, in the same order', () => {
  const source = readFileSync(REGISTRY_PATH, 'utf-8');
  const block = /RENDERS\s*=\s*\[([^\]]*)\]/.exec(source);
  const mirrored = [...block![1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  expect(mirrored).toEqual([...RENDERS]);  // RENDERS imported from types.ts
});
```

### 4. Keep the mirror up to date

When the source-of-truth changes:
1. Update the mirror (same commit)
2. The drift test fails if you forget
3. The build blocks until the mirror matches

## When to Use This

✅ **Use when:**
- Cross-layer import is impossible (tsconfig/bundle boundaries)
- The constant is **stable** (changes infrequently — e.g., enum of render types, not runtime config)
- Drift would cause **silent runtime errors** (wrong render key → blank card, missing CSS class → unstyled)
- The mirrored value is **parseable** (array literal, object keys, string constant)

❌ **Don't use when:**
- You can import directly (no build boundary) — just import
- The value is **volatile** (changes every build) — extract to shared config
- The mirror is **large** (>500 lines) — consider code generation instead
- The drift test would be **unreliable** (regex too brittle, false negatives)

## Real Uses (as of 2026-08-25)

1. **chartRegistry RENDERS** (`tests/unit/lab-render-registry.test.ts`)
   - Source: `src/lib/lab/types.ts` RENDERS (11 render types)
   - Mirror: `dashboard/src/components/lab/chartRegistry.ts` RENDERS
   - Test: regex-parses both arrays, asserts exact match + order
   - Why: dashboard needs the list to build `CHART_REGISTRY: Record<Render, ...>`, cannot import from `src/`

2. **lab-html-kit CSS** (`tests/unit/lab-html-body.test.ts`)
   - Source: `dashboard/src/components/lab/lab-html-kit.css` (curated class kit)
   - Mirror: `dashboard/src/components/lab/labHtmlKit.ts` LAB_HTML_KIT_CSS string
   - Test: reads both files, compares trimmed content byte-for-byte
   - Why: the kit must be injected into an iframe's srcdoc as a string; vitest stubs `.css?raw` to `''` so runtime import fails in tests

## Alternatives Considered

- **Code generation** (e.g., build script reads source → writes mirror): viable for large/complex mirrors, overkill for a 10-item enum
- **Shared JSON config**: works when both sides consume the same shape; doesn't work when one side needs the raw CSS as a string
- **Runtime validation**: catches drift, but only at runtime — the drift test catches it at build time

## Related

- See `lab-wellknown-tweaks.test.ts` for a similar pattern: RangeControl's preset list mirrors the engine's `DEFAULT_RANGE_OPTIONS`
- The feature-integration-pattern mandates marker tests that pin cross-file contracts (e.g., SKILL.md entity count → skill test); this is the textual-parse variant of that rule
