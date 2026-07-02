---
id: know_flMwFxQ7
name: visual-first-board-ritual
description: >-
  Anıl 2026-06-25 directive (company-wide): every meeting the owner brings a
  visible board of user/work flows; roadmaps live on a board (sprint timeline,
  green=done/blue=in-progress/grey=planned, start+end dates), not in memory.
  Build with /excalidraw.
tags:
  - decisions
  - 'topic:pm'
  - 'topic:roadmap'
pinned: false
date: '2026-06-25'
---

**Source:** Anıl Koman directive — #product Slack, 2026-06-25 (`@channel`, `p1782388879266779`). Company-wide operating rule. Applies to every owner, every product.

## The rule
- **Every meeting, the owner brings a BOARD** that visibly shows **user flows + business/work flows**. We discuss over the board — not from talking points.
- **Roadmaps follow the same rule** — a visible board (horizontal sprint timeline), not a list in someone's head.
- **"Ezbere iş yapmayı bırakalım"** — stop working from memory. Undocumented, verbal-only work is not acceptable.

## Roadmap board format (standard)
Horizontal timeline, **X-axis = sprints** left→right. Each sprint card = name + start–end date. Color = status:
- 🟢 **green** = done (Tamamlandı)
- 🔵 **blue** = in progress (Devam ediyor) — BUGÜN marker sits here
- ⚪ **grey** = not started (Başlanmadı)

Build with the `/excalidraw` skill. Reference implementation + regenerable generator (edit the sprint JSON → rerun): the **ouromedia** brain at `knowledge/roadmap/`.

## Apply here
Owner: **Mehmet**. Bring this product's roadmap board (and user/work-flow boards) to every review, and keep the roadmap current at each sprint boundary.

## Update — native roadmap board shipped (2026-07-02)
dreamcontext now ships its own PO-authored OKR roadmap natively — `dreamcontext roadmap` renders the objective board and writes the auto-generated `knowledge/roadmap/board.md`. See `core/features/okr-roadmap.md` for the full capability doc (objectives store, task↔objective many-to-many, dependency-cascade forecasting, target vs. forecast slip detection). This ritual's board-first *principle* still applies; the *mechanism* for this project's own roadmap board no longer requires hand-building it in Excalidraw — the CLI/dashboard board is the current source.

## Last verified
2026-07-02
