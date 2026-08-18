---
id: "feat_Cg7Gw_vV"
type: "feature"
name: "doctor-machine-readable-diagnostics"
description: "doctor --json emits a structured diagnostic contract: stable code per check, subject/evidence/supportedFixes for agent repair loops"
pinned: false
date: "2026-08-18"
status: "in_review"
created: "2026-08-18"
updated: "2026-08-18"
released_version: null
tags: ["topic:cli", "kind:architecture", "domain:quality"]
related_tasks: ["feat-doctor-machine-readable-diagnostics-json-supportedfixes"]
---

## Why

Verifier agents parsing doctor prose and repairing by guessing led to guess-and-retry spirals. The archify review (2026-08-17) showed the diagnostic-contract shape that closes this loop: machine-readable failures with stable codes, subjects, evidence, and supported fixes enable deterministic repair.

## User Stories

- [x] As a verifier agent (curator-verifier, initializer-verifier), I want doctor to emit structured diagnostics so I can repair brain defects by choosing from supported fixes instead of guessing what's broken
- [x] As a repair worker (curator-worker), I want each diagnostic to carry its supported fixes so I can apply the exact repair the tool stands behind
- [x] As a goal validator, I want to cite doctor --json findings with their stable codes and evidence when blocking brain-touching goals
- [x] As a developer debugging brain structure, I want stable diagnostic codes so I can track recurring issues across sessions

## Acceptance Criteria

- [x] CheckResult interface carries optional code/subject/evidence/supportedFixes fields
- [x] `doctor --json` emits `{ version, summary: {ok, warn, error}, checks }` with every check carrying a stable code
- [x] deriveCode() guarantees a stable slug per check name as fallback when code is unset
- [x] Exit codes unchanged from prose mode (0 for all-ok, 1 for any warn/error)
- [x] Human prose output path untouched (not JSON)
- [x] First-wave annotation complete: missing/empty/placeholder files, malformed JSON, missing directories, objective slug/date/status/metric validation, core-file ceiling, snapshot bands, link drift (--heal-links advertised), taxonomy-missing
- [x] `doctor --heal-links` (the existing flag) advertised in supportedFixes for link-drift findings
- [x] Unit tests cover deriveCode, report shape, no input mutation, enriched core-file-ceiling check, cli-reference doc-pin
- [x] Wiring 1 (SKILL.md): Troubleshooting row + Setup list name doctor --json
- [x] Wiring 3 (cli-reference.md): doctor row flags + diagnostic-contract section with repair protocol
- [x] Wiring 5 (sub-agents): curator-verifier + initializer-verifier run doctor --json and quote code+evidence; curator-worker repairs from supportedFixes; goal-validator cites doctor --json
- [x] Wiring 7 (cross-refs): troubleshooting.md → cli-reference; cli-reference ↔ knowledge/patterns/diagnostic-repair-loop.md
- [x] Wiring 8 (regression lock): doc-pin assertion in doctor-json.test.ts
- [x] Wiring 9 (propagate): dreamcontext update run

## Constraints & Decisions

- **[2026-08-17]** First-wave annotation only — lab/theses/people/data-structures checks keep derived codes + message; annotate incrementally when a consumer needs them. Do NOT invent supportedFixes the tool can't stand behind.
- **[2026-08-17]** supportedFixes lists a CLI verb only when it verifiably exists (doctor --heal-links, taxonomy init); otherwise a concrete textual repair.
- **[2026-08-17]** Pattern source: archify (tt-a1i/archify, MIT) review — see knowledge/patterns/diagnostic-repair-loop.md
- **[2026-08-17]** Entity Router: considered, NOT applicable — doctor is a diagnostic command, not a creatable entity
- **[2026-08-17]** Sleep wiring: considered, NOT applicable — doctor is awake tooling; no specialist owns it
- **[2026-08-17]** Skill-pack scan: goal-skill wired via goal-validator; multi-review / others considered-not-applicable

## Technical Details

**Core contract** (`src/cli/commands/doctor.ts`):

```typescript
export interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  code?: string;                    // Stable slug (e.g. doctor/core-file-ceiling)
  subject?: Record<string, unknown>; // What's broken: file, entity, field
  evidence?: Record<string, unknown>; // Measured proof: bytes, counts, matched text
  supportedFixes?: string[];        // Concrete repairs to choose from
}

export interface DoctorReport {
  version: 1;
  summary: { ok: number; warn: number; error: number };
  checks: Array<CheckResult & { code: string }>;
}
```

**deriveCode()** guarantees every check carries a stable code even before hand-annotation. **buildDoctorReport()** rolls up summary counts and ensures `code` is present.

**Annotated checks** (first wave): missing-file, empty-file, placeholder-content, malformed-json, missing-directory, core-file-ceiling, snapshot-band-overflow, link-drift, taxonomy-missing, objective-slug-invalid, objective-date-invalid, objective-status-invalid, objective-metric-malformed.

**Consumer agents**: curator-verifier, initializer-verifier (run `doctor --json`, parse diagnostics, repair from supportedFixes); curator-worker (applies the repairs); goal-validator (cites code+evidence when blocking goals).

**Tests**: `tests/unit/doctor-json.test.ts` (8 tests) — deriveCode stability, report shape, no mutation, enriched core-file-ceiling, cli-reference doc-pin assertion (regression lock).

## Notes

- Incremental annotation: more checks will gain supportedFixes as repair consumers land. Never invent a fix the tool can't verify.
- Related pattern: knowledge/patterns/diagnostic-repair-loop.md (the general shape harvested from archify)
- The before/after board: knowledge/patterns/doctor-json-before-after/
- Link drift healing: --heal-links was already shipped; the contract now advertises it in supportedFixes

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-08-18 - Feature PRD created
- PRD reconciled from completed task feat-doctor-machine-readable-diagnostics-json-supportedfixes (task_gizfo_Vn). Shipped in commit 343f6d7, merged to main via PR #305 (merge commit 84461fc, 2026-08-17). Status: in_review (tests green, full suite 7068 passing, consumer wiring complete).
