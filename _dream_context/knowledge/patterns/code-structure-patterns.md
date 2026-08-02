---
name: code-structure-patterns
type: pattern
tags: [topic:architecture, domain:engineering]
updated: "2026-08-01"
description: Code organization patterns for lib modules and CLI commands
---

# Code Structure Patterns

**Source**: Migrated verbatim from `core/1.user.md` by migration 0.23.0 (`distribute-user-md-residue`). This content is un-distilled and preserved as originally written.

## Export Patterns

**No default exports for lib**: named exports only; default exports only where frameworks require them (e.g., React components, Next.js pages).

## Command Registration Pattern

**Register pattern**: commands export `registerXyzCommand(program)`, which are then registered in `src/cli/index.ts`.
