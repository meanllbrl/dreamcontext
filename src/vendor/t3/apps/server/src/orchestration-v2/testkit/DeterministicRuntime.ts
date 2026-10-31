/*! @license MIT — vendored from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc. See src/vendor/t3/LICENSE. */
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { TestClock } from "effect/testing";

export function provideDeterministicTestRuntime<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: { readonly randomSeed?: number } = {},
) {
  return effect.pipe(
    Effect.provide(TestClock.layer()),
    Random.withSeed(options.randomSeed ?? 0x1234_5678),
  );
}
