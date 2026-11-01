/*! @license MIT — stub at a T3 Code (https://github.com/pingdotgg/t3code) seam, Copyright (c) 2026 T3 Tools Inc. and dreamcontext. See src/vendor/t3/LICENSE. */
// T3 STUB: test-only. T3's orchestrator replay harness needs T3's whole server (every driver, git, terminal, SQLite, native modules); the T3 adapter tests that drive it are excluded by name in vitest.t3.config.ts.
import * as Context from "effect/Context";

export class OrchestratorV2 extends Context.Service<OrchestratorV2, any>()(
  "t3/orchestration-v2/Orchestrator/OrchestratorV2",
) {}

export type OrchestratorV2Error = never;
