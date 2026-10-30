/*! @license MIT — stub at a T3 Code (https://github.com/pingdotgg/t3code) seam, Copyright (c) 2026 T3 Tools Inc. and dreamcontext. See src/vendor/t3/LICENSE. */
// T3 STUB: test-only. T3's orchestrator replay harness needs T3's whole server (every driver, git, terminal, SQLite, native modules); the T3 adapter tests that drive it are excluded by name in vitest.t3.config.ts.
import * as Effect from "effect/Effect";

export type OrchestratorV2ScenarioStep = any;
export interface OrchestratorV2Scenario {
  readonly name: string;
  readonly commands: ReadonlyArray<any>;
  readonly steps?: ReadonlyArray<OrchestratorV2ScenarioStep>;
  readonly projectionThreadIds?: ReadonlyArray<any>;
}
export type OrchestratorV2ScenarioResult = any;
export type OrchestratorV2ScenarioStepError = never;

export function runOrchestratorV2Scenario(_scenario: OrchestratorV2Scenario, _options?: unknown): Effect.Effect<any> {
  return Effect.die(new Error("T3's orchestrator is not vendored into dreamcontext"));
}
