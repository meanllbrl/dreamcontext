---
id: vendor-design-system-integration
name: "Vendor Design System Integration (make someone else's components look like yours)"
description: >-
  Three silent failures that hit every attempt to render a third-party component library
  inside an existing surface: filtering the component LIST does not filter its SCHEMAS,
  composite typography tokens are `font` shorthands that ignore overridden primitives, and
  part of the theme is unreachable from CSS. Each one looks like success until measured.
type: knowledge
tags:
  - 'kind:pattern'
  - 'layer:frontend'
  - 'topic:agents'
date: '2026-09-05'
updated: '2026-09-05'
---

# Vendor Design System Integration

## Why This Exists

Found while rendering `@openuidev/react-ui` inside the Chat surface (the `dream-ui` experiment,
Waves 2-4). All three failures below produced *green tests and a wrong screen*: the code did
what it said, and what it said was not what shipped. None is specific to OpenUI — they follow
from how component libraries are built, so the next vendor will have all three.

## The Three

### 1. Filtering the component LIST does not filter the component SCHEMAS

Trimming a library to the subset you can render (19 of 29 components) left the generated agent
briefing still advertising the other ten: `Card`'s children are typed as a union naming every
shipped component, and that union lives in `Card`'s own schema, not in the list you filtered.
The agent was told it could put a `Form` inside a `Card` that could never render one.

**Do:** narrow the type unions in whatever you generate, and make the test walk every *dropped*
name rather than spot-checking a few. The next leak will be somewhere nobody thought to look.

**Also:** a generator may emit sections you did not ask for. `Library.prompt()` writes an
Action/Button section unconditionally — no option removes it (all four combinations of
`toolCalls`/`bindings` produced byte-identical output) — and it taught a URL-opening action
that bypassed a gate the host already had. Strip it, and strip the dangling one-line pointer
to it, because a reference to a section that no longer exists is worse than the section.

### 2. Composite typography tokens are `font` shorthands

Vendor scales define both primitives (`--x-font-size-md: 16px`) and composites
(`--x-text-body-default: 400 16px/1.5 "Inter", sans-serif`). Components read the COMPOSITES.
Override only the primitives and every component keeps the vendor's size, line height and
face while your token dump looks perfectly configured.

**Do:** rebuild every composite from your resolved values. Assert it: no composite may contain
the vendor's default size or family.

### 3. Part of the theme is not CSS at all

A stylesheet override cannot reach a value the library reads through its own runtime. Here the
chart palette comes from React context (`useChartPalette` -> `theme.defaultChartPalette`), so
CSS variables coloured everything except the charts.

**Do:** audit which half of the vendor's theme is CSS and which is runtime, and route each
accordingly (custom properties vs the provider's props). Assume nothing is CSS until checked.

## A Fourth, About Their Dark Mode

A vendor stylesheet usually switches on `@media (prefers-color-scheme: dark)`. If your app's
theme is a user choice rather than the OS preference, those disagree the moment a user picks
Light on a dark-mode machine. Pass the mode explicitly, and force the OS to the *opposite*
value in the test — otherwise the mismatch is invisible on the developer's machine.

## The Rule Underneath All Of Them

**Measure the rendered result, not the configuration.** Every one of these passes a review of
the diff. What caught them: computed pixels on a painted node, a test that walks dropped names,
and a chart that stayed the wrong colour. See `patterns/runtime-measurement-verification`.

## Related

- `patterns/runtime-measurement-verification` — the measuring discipline these need
- `patterns/mirror-with-drift-test` — how the generated briefing is kept honest
- `patterns/dashboard-build-verification` — why a stale bundle makes all of this look green
- Live example: `dashboard/src/components/sleepy/chat/openuiTheme.ts` (composites + chart
  palette), `scripts/gen-openui-briefing.ts` (union narrowing + section stripping)
