import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureGitignoreEntries } from '../gitignore.js';

/**
 * Automation-output consumption for sleep — the deterministic half of Change C
 * (sleep reads automation output, but never executes or owns automations). This
 * module does NOT read `automations/<slug>.md` manifests and does NOT import
 * from `./types.js`, `./store.js` or `./registry.js`: it is a wave-2 sibling of
 * those modules and must stay import-free of them so no same-wave cross-import
 * can form (see the dependency map's collision audit). Consequences of that
 * boundary, both deliberate:
 *
 *  - `PendingOutput` carries no `shared` flag. The caller (sleep's CLI layer,
 *    landing in a later wave once the manifest store exists) attaches `shared`
 *    itself by cross-referencing `listAutomations()`.
 *  - The scan covers only the DEFAULT output location,
 *    `automations/output/<slug>/<date>[-N].md` (the layout documented at the
 *    top of `types.ts`). A manifest's `outputDir` override is invisible here,
 *    because resolving it requires reading the manifest. If per-automation
 *    output-dir overrides need to be honored for consumption, that is a
 *    decision for whichever wave first has both a manifest reader and this
 *    scanner in scope — flagged, not silently worked around.
 *
 * `PendingOutput` is METADATA ONLY (path/mtime/size) — it does not embed file
 * content. `OUTPUT_CONSUMPTION_PER_FILE_CAP` documents the truncation a
 * CONSUMER (the sleep-product agent, reading a listed path with its own Read
 * tool) should apply to an individual large file; this scanner never reads
 * file bytes itself, only stats them, which is what keeps the two capacity
 * caps below (file count, cumulative bytes) cheap and side-effect-free.
 */

export interface PendingOutput {
  slug: string;
  path: string;
  /** The output file's own basename without extension — normally `YYYY-MM-DD`
   *  or `YYYY-MM-DD-N` for a same-day re-run. */
  date: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface PendingOutputs {
  /** Newest first, bounded by the file and byte caps below. */
  outputs: PendingOutput[];
  /** Every file dropped for a capacity reason or a stat failure — "no silent
   *  caps": anything excluded is named here, never just absent. A file whose
   *  mtime predates the boundary is NOT reported here — that is ordinary
   *  already-consumed material, not something a cap cut. */
  skipped: { slug: string; path: string; reason: 'file-cap' | 'byte-cap' | 'unreadable' }[];
  /** Sum of `sizeBytes` across `outputs` only. */
  totalBytes: number;
}

export const OUTPUT_CONSUMPTION_FILE_CAP = 20;
export const OUTPUT_CONSUMPTION_BYTE_CAP = 200_000;
/** Guidance for a CONSUMER reading an individual output file's content: truncate
 *  to head+tail with an explicit elision marker past this many bytes. Not
 *  applied by this module, which never reads file content. */
export const OUTPUT_CONSUMPTION_PER_FILE_CAP = 50_000;

/**
 * Outputs written since `lastConsolidatedAtISO`, newest first, bounded by
 * {@link OUTPUT_CONSUMPTION_FILE_CAP} and {@link OUTPUT_CONSUMPTION_BYTE_CAP}.
 * Never throws. `null` (no cycle has ever completed — see `SleepState.
 * last_consolidated_at`) or an unparseable boundary both mean "consume
 * nothing" — the same fail-toward-empty direction, so a corrupt persisted
 * timestamp can never accidentally re-surface an unbounded backlog.
 *
 * A file whose own size alone would exceed the byte cap is skipped wholesale
 * (`reason: 'byte-cap'`), never partially included — a half-read output is a
 * half-truth. Once {@link OUTPUT_CONSUMPTION_FILE_CAP} outputs are included,
 * every remaining newer-to-older candidate is skipped `'file-cap'` even if it
 * would individually fit the byte budget; when a candidate would exceed both
 * caps simultaneously it is recorded as `'file-cap'` (checked first) — the
 * skip reason is diagnostic, not a promise that only one cap applied. A file
 * skipped for `'byte-cap'` does not consume budget, so a smaller candidate
 * later in the newest-first order can still fit.
 */
export function pendingOutputsSince(contextRoot: string, lastConsolidatedAtISO: string | null): PendingOutputs {
  const outputs: PendingOutput[] = [];
  const skipped: PendingOutputs['skipped'] = [];
  let totalBytes = 0;

  if (lastConsolidatedAtISO === null) {
    return { outputs, skipped, totalBytes };
  }
  const boundaryMs = Date.parse(lastConsolidatedAtISO);
  if (!Number.isFinite(boundaryMs)) {
    return { outputs, skipped, totalBytes };
  }

  const outputRoot = join(contextRoot, 'automations', 'output');
  if (!existsSync(outputRoot)) {
    return { outputs, skipped, totalBytes };
  }

  // Plain readdirSync (not fast-glob, used elsewhere in this subsystem for
  // single-level directories) deliberately: readdir lists directory entries by
  // NAME only, with no implicit stat — so a broken symlink or a file that
  // vanishes between the list and the stat below still shows up as a
  // candidate and reaches the try/catch, landing in `skipped` as intended.
  // fast-glob's own internal stat-to-classify-entries step silently DROPS an
  // entry it cannot itself stat, which would make the 'unreadable' path
  // unreachable through no fault of the code here.
  let slugDirs: string[];
  try {
    slugDirs = readdirSync(outputRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { outputs, skipped, totalBytes };
  }

  interface Candidate { slug: string; path: string; date: string; mtimeMs: number; sizeBytes: number }
  const candidates: Candidate[] = [];
  for (const slug of slugDirs) {
    const slugDir = join(outputRoot, slug);
    let names: string[];
    try {
      names = readdirSync(slugDir).filter((n) => n.endsWith('.md'));
    } catch {
      continue; // whole slug directory vanished/unreadable — nothing per-file to report
    }
    for (const name of names) {
      const absPath = join(slugDir, name);
      const date = name.slice(0, -'.md'.length);
      try {
        const st = statSync(absPath);
        if (st.mtimeMs < boundaryMs) continue; // already-consumed material, not a cap drop
        candidates.push({ slug, path: absPath, date, mtimeMs: st.mtimeMs, sizeBytes: st.size });
      } catch {
        skipped.push({ slug, path: absPath, reason: 'unreadable' });
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const c of candidates) {
    if (outputs.length >= OUTPUT_CONSUMPTION_FILE_CAP) {
      skipped.push({ slug: c.slug, path: c.path, reason: 'file-cap' });
      continue;
    }
    if (totalBytes + c.sizeBytes > OUTPUT_CONSUMPTION_BYTE_CAP) {
      skipped.push({ slug: c.slug, path: c.path, reason: 'byte-cap' });
      continue;
    }
    outputs.push({ slug: c.slug, path: c.path, date: c.date, mtimeMs: c.mtimeMs, sizeBytes: c.sizeBytes });
    totalBytes += c.sizeBytes;
  }

  return { outputs, skipped, totalBytes };
}

// ─── Private-derivation marker ───────────────────────────────────────────────
//
// Written by sleep-product whenever it derives knowledge from a PRIVATE
// automation's output (knowledge files are brain-synced, so that derivation
// republishes private material through a different door). `sleep done` must
// refuse to proceed while this marker exists, until the operator passes
// `--ack-private-derivation`. Lives at `state/.sleep-private-derivation.json`
// — the same directory as `.sleep.json`, deliberately NOT under `tmp/`: that
// directory already hosts a TTL unlinker (agent-drop.ts's DROP_TTL_MS sweep),
// and a gate that fails OPEN when someone widens a cleanup sweep is badly
// sited. Machine-local by nature (a disclosure decision is not a teammate's),
// so it carries its own gitignore entry, ensured before first write — the
// `secrets.ts` ordering guarantee: this file must never be committable, even
// transiently.

export interface PrivateDerivationMarker {
  derivedFrom: { slug: string; outputPath: string }[];
  knowledgePaths: string[];
  writtenAt: string;
}

/** Brain-relative gitignore entry covering the marker. */
export const PRIVATE_DERIVATION_GITIGNORE_ENTRY = 'state/.sleep-private-derivation.json';
/** Project-root-relative variant, for in-tree brain-sync mode. */
export const PRIVATE_DERIVATION_GITIGNORE_ENTRY_ROOT = '_dream_context/state/.sleep-private-derivation.json';

export function privateDerivationMarkerPath(contextRoot: string): string {
  return join(contextRoot, 'state', '.sleep-private-derivation.json');
}

/** Lenient — malformed or missing reads as `null`, never throws. */
export function readPrivateDerivationMarker(contextRoot: string): PrivateDerivationMarker | null {
  const path = privateDerivationMarkerPath(contextRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Partial<PrivateDerivationMarker>;
    if (!Array.isArray(p.derivedFrom) || !Array.isArray(p.knowledgePaths) || typeof p.writtenAt !== 'string') return null;
    const derivedFrom = (p.derivedFrom as unknown[]).filter(
      (d): d is { slug: string; outputPath: string } =>
        !!d && typeof d === 'object' && typeof (d as Record<string, unknown>).slug === 'string' && typeof (d as Record<string, unknown>).outputPath === 'string',
    );
    const knowledgePaths = (p.knowledgePaths as unknown[]).filter((k): k is string => typeof k === 'string');
    return { derivedFrom, knowledgePaths, writtenAt: p.writtenAt };
  } catch {
    return null;
  }
}

/**
 * Ensures the governing `.gitignore` entries (contextRoot- and
 * projectRoot-relative) BEFORE the marker is written — throws if either
 * cannot be ensured, aborting the write, rather than letting a disclosure
 * record ever exist on disk without its ignore entry, even transiently.
 */
export function writePrivateDerivationMarker(contextRoot: string, marker: PrivateDerivationMarker): void {
  const projectRoot = dirname(contextRoot);
  ensureGitignoreEntries(contextRoot, [PRIVATE_DERIVATION_GITIGNORE_ENTRY], {
    comment: 'dreamcontext sleep — pending private-automation-derivation disclosure (machine-local, never commit)',
  });
  ensureGitignoreEntries(projectRoot, [PRIVATE_DERIVATION_GITIGNORE_ENTRY_ROOT], {
    comment: 'dreamcontext sleep — pending private-automation-derivation disclosure (machine-local, never commit)',
  });
  const path = privateDerivationMarkerPath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2) + '\n', 'utf-8');
}

/** Idempotent — safe to call whether or not a marker exists. */
export function clearPrivateDerivationMarker(contextRoot: string): void {
  try {
    unlinkSync(privateDerivationMarkerPath(contextRoot));
  } catch {
    /* already gone */
  }
}
