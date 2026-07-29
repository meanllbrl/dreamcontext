---
name: Architecture Overview
description: How the snapshot is assembled from budget sections.
type: knowledge
pinned: true
tags:
  - 'domain:knowledge'
  - 'kind:architecture'
---

The snapshot accumulates blocks into a parts array and seals them into named
budget sections. Splitting a seal at any element boundary is byte-neutral,
because the render join inserts exactly one newline between the two groups
either way.

The demotion ladder only engages when the full render exceeds the budget.
