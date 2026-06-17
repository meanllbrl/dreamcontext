---
id: know_7BQ5ktp-
name: licensing-policy
description: >-
  dreamcontext licensing decision: Apache-2.0 (permissive OSS) chosen
  2026-06-06; rationale, rejected alternatives, and the irrevocable-MIT
  constraint.
tags:
  - decisions
  - devops
pinned: false
date: '2026-06-06'
---

## Decision (2026-06-06)

**License: Apache-2.0** — chosen over MIT (previous), PolyForm Internal Use, and BSL.

### Why Apache-2.0 over the prior MIT
- Same permissiveness as MIT (anyone may use, modify, distribute, **and sell**; build commercial products) — so adoption is unaffected.
- Adds two things MIT lacks: an **explicit patent grant** (Apache §3/§5, each contributor licenses their patents — keeps the project safe to use commercially) and **trademark protection** (Apache §6 excludes the marks from the grant).
- The 'dreamcontext' name/brand is protected separately via TRADEMARK.md + NOTICE: fork freely, but ship under your own name.

### Why not a source-available license
A "no-resale / no-commercial-products, but personal + internal-company use allowed" restriction **cannot be expressed by any OSI open-source license** — the Open Source Definition §6 forbids restricting commercial use or fields of endeavour. Enforcing it would require a **source-available** license (e.g. PolyForm Internal Use 1.0.0 or BSL 1.1), which is not open source and dampens adoption + contributor trust. dreamcontext deliberately stays fully open under Apache-2.0 and relies on **trademark** (not the code license) to protect the brand.

### Hard constraints surfaced (still true)
- **MIT is irrevocable for already-published code.** v0.5.4 shipped to npm under MIT and the repo was public-MIT; anyone holding 0.5.x keeps MIT rights permanently. Relicensing only governs new versions (0.6.0+). Switching early (pre-traction) minimizes the MIT surface in the wild.
- **Architecture/ideas are NOT protectable by license.** Copyright protects code, not design. Repo is public → architecture is disclosed; a clean-room reimplementation that competes is legally fair game. Licenses only restrict use of *our actual code*. Real architecture protection would require closed-source (trade secret) or patents.
- **GitHub license badge** is detected from LICENSE file content and updates only after the new Apache LICENSE is committed + pushed (showed MIT until then).

### Files changed this decision
LICENSE (Apache 2.0 full text, Copyright 2026 Mehmet Nuraydin), NOTICE (attribution + trademark pointer; added to package.json `files`), TRADEMARK.md (brand policy), CONTRIBUTING.md (Apache + DCO sign-off, no CLA), package.json `license`: MIT->Apache-2.0, README License section, GitHub repo description (AgentContext->dreamcontext). Visual explainer board: _dream_context/knowledge/diagrams/licensing.excalidraw.md (generator scripts/diagrams/licensing.board.cjs).

### Governance
Contributions under Apache-2.0 with **DCO** sign-off (`git commit -s`), not a CLA — Apache's per-contributor patent grant covers the patent risk; DCO keeps provenance clean.
