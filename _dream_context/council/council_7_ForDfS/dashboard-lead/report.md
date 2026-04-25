---
persona: dashboard-lead
rounds_completed: 1
---

## Round 1 — 2026-04-25

# dashboard-lead — round 1

### Executive Summary
Adopt the meta-marketing plan, but cut dashboard scope hard for v0: 3 tabs not 6, drop the recharts dep, ship clipboard-based "Discuss in chat", lock down asset static serving, and make marketing nodes a filterable Brain layer that defaults OFF.

### Position
**Conditional yes.** Plan is architecturally sound (JSON-first, read-only UI, council-pattern reuse). Dashboard surface as written is over-built and adds an avoidable 100KB+ dep. Ship a 3-tab v0; defer the rest.

### Reasoning

**Tab restructure (6 → 3 + drawer + sidebar route).** Daily-driver tabs are Overview, Performance, Creatives. Cohorts collapses into a slide-in drawer (mirrors `CouncilDetail` already in `dashboard/src/components/council/`). Learnings collapses into the existing `KnowledgePage` since the file lives under `knowledge/` and council debates already promote into it — surfacing it twice fragments the mental model. Competitors becomes a "Sources" segmented control inside Creatives (Ours / Inspired / Competitors) with pattern tags as filter chips. Net: 3 tabs + 1 drawer + 1 sidebar entry. Cohort-as-drawer is the highest-leverage win; users think in cohorts but read in campaigns.

**recharts vs alternatives — pick uPlot.** recharts ships ~95KB gz minimum (130–160KB once `Tooltip`/`Legend` defeat tree-shake), pulls d3-shape, and stresses an already-heavy bundle (react-force-graph-2d + d3-force-3d + marked + RQ + React 19). Use **uPlot (~40KB gz, no deps)** for Performance time-series. Ugly out of the box, but SleepPage proves we can hand-roll polished SVG; uPlot handles 100k points where recharts dies at ~5k. For Overview sparklines, hand-rolled SVG (SleepPage pattern). Visx is the next pick if a "pretty by default" lib becomes mandatory in v1; recharts is the React-tutorial default, not the right call here.

**"Discuss in chat" — clipboard wins.** `claude://` deep links require a registered URL handler we don't ship and break across OSes. In-page chat violates read-only-by-design. **Clipboard** works everywhere, zero infra, matches the council UX pattern users already accept. The twist: prefix the copied prompt with the literal slash command `/marketing discuss <creative_id>` so paste-into-Claude-Code routes cleanly to the skill. Also write `~/.dreamcontext/last-prompt` so a follow-up `dreamcontext marketing chat` prints what to paste — covers cross-machine users.

**Asset static-serving security model.** Six rules, non-negotiable: (1) extension allowlist `.jpg|.jpeg|.png|.webp|.mp4|.mov`, 404 everything else; (2) `path.resolve` + `startsWith(assetsDir)` + `fs.realpath` symlink check, blocks `..` and absolute paths; (3) filename whitelist — only serve assets referenced by a `creatives/*.json` record, kills enumeration; (4) localhost-bind only (current default); (5) no directory listing ever; (6) competitor `_media/` not exposed in v0 — render server-side cached thumbnails only. Applies in dev AND bundled-prod serving.

**Brain graph: filterable layer, default OFF.** 14 node types past the readability cliff for force-graph-2d at typical node counts; marketing graph blows up fast (N campaigns × M creatives × K competitor posts). Add a layer toggle in `BrainSettings` ("Show marketing nodes"). When on, render with lower link strength + higher collision radius so marketing nodes form a visible cluster, not noise. Extend `DEFAULT_GROUP_COLORS_DARK/LIGHT` in `BrainPage.tsx` with the 4 new types using the proposed palette (desaturate competitor to `#94a3b8`, fine).

**Empty states (v0, all pages).** Overview: no cohorts → CTA with exact CLI + `Copy command` button. Performance: no insights → "Pull insights" command + greyed chart skeleton. Creatives: none → describe (read-only) chat-creation flow, no upload affordance. Cohort drawer: 0 campaigns → hypothesis preview + next-step command. Learnings: file missing → stub "rem-sleep populates after first insights pull". Competitors sub-tab: none → CLI hint. Brain layer: toggled on, no data → ghost legend chip.

**Live data freshness.** TanStack Query `staleTime: 60_000`, `refetchOnWindowFocus: true` (matches App.tsx today). Insights endpoint returns `last_synced_at`; page shows "Updated 2h ago" badge; >24h turns amber and surfaces a copy-prompt button "Ask agent to refresh insights" — no auto-trigger (that's a mutation-equivalent, violates read-only). Add SSE on run-log appends so newly generated creatives show up live during a session — cheap with existing server.

**v0 vs v1.** **v0 ships:** Overview, Performance (uPlot), Creatives (clipboard "Discuss in chat"), Brain layer toggle (default off), all empty states, hardened asset serving, freshness badge, sidebar nav entry. **v1 defers:** cohort drawer polish, Competitors sub-tab UI (ingestion lands v0, just no UI), SSE live updates, mobile responsive (operators do check on phone — explicitly out of scope, flagged), Learnings as standalone route (v0 deep-links into KnowledgePage).

### Reactions to peers
None yet — round 1.

### Open questions
1. Is the dashboard ever served bundled-prod over a non-localhost interface? If yes, asset rules need auth, not just bind-host.
2. Do we need to support multiple ad accounts per project in v0? Affects Overview KPI roll-ups and cohort scoping.
3. SSE vs polling for run-log: do we already have an SSE endpoint pattern, or would this be the first?
4. Should the Brain layer toggle persist per-user (localStorage) or per-project (`_dream_context/state/`)?
5. uPlot has no React wrapper we currently use — accept the imperative ref-based integration, or wrap once in `dashboard/src/components/charts/`?
