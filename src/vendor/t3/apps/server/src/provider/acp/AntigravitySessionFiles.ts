/*! @license MIT — vendored from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc. See src/vendor/t3/LICENSE. */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const decodeSessionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

/** Call after the process closes. The unique temporary cwd proves which session we own. */
export const removeAntigravitySessionFiles = Effect.fn("removeAntigravitySessionFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const base = path.join(acpDirectory, "conversations", input.sessionId);
    if (!(yield* fs.exists(`${base}.meta`))) {
      return;
    }
    const metadata = yield* fs
      .readFileString(`${base}.meta`)
      .pipe(Effect.flatMap(decodeSessionMetadata));
    if (metadata.cwd !== input.cwd) {
      return;
    }
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(acpDirectory, "brain", input.sessionId), {
      recursive: true,
      force: true,
    });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);

/** Sweep only private runtimes before launch; Windows does not protect live extracted data files from deletion. */
// Each dreamcontext pane is its own process on one account's profile: only a stale run folder goes.
const STALE_RUN_MS = 7 * 24 * 60 * 60 * 1000;

export const removeAntigravityRuntimeTempDirs = Effect.fn("removeAntigravityRuntimeTempDirs")(
  function* (tempDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(tempDirectory))) return;
    const names = yield* fs.readDirectory(tempDirectory);
    const cutoff = Date.now() - STALE_RUN_MS;
    for (const name of names) {
      const entry = `${tempDirectory}/${name}`;
      const info = yield* fs.stat(entry);
      const modified = info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0;
      if (modified < cutoff) yield* fs.remove(entry, { recursive: true, force: true });
    }
  },
  Effect.catch(() =>
    Effect.logWarning("Could not remove leftover Antigravity runtime temp files."),
  ),
);
