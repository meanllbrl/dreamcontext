/*! @license MIT — vendored from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc. See src/vendor/t3/LICENSE. */
import { type CliReleaseChannel, cliReleaseChannelOf } from "./cliRelease.ts";

export type ReleaseChannel = "dev" | CliReleaseChannel;

// Desktop PR preview builds are stamped `X.Y.Z-pr.<number>.<run>`; the CLI updater must not see them as preview.
export const releaseChannelOf = (version: string): ReleaseChannel =>
  /-pr\.\d+\.\d+$/.test(version) ? "preview" : cliReleaseChannelOf(version);

// Effect lets code attributes beat OTEL_RESOURCE_ATTRIBUTES, so the operator value is applied here.
export const releaseResourceAttributes = (
  channel: ReleaseChannel,
  operatorAttributes: Readonly<Record<string, unknown>> = {},
) => {
  const operatorValue = (key: string) => {
    const value = operatorAttributes[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return {
    "t3code.release.channel": operatorValue("t3code.release.channel") ?? channel,
    "deployment.environment.name":
      operatorValue("deployment.environment.name") ??
      (channel === "dev" ? "development" : channel === "preview" ? "staging" : "production"),
  };
};
