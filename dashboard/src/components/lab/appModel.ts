/**
 * App (`app/v1` + `dataset/v1`) client model — types mirroring the backend
 * contract (src/lib/lab/app.ts, src/lib/lab/dataset.ts — T1/T2, not yet
 * landed as of this file) plus the PURE lookups the bridge needs: which page
 * a pageId resolves to, and which dataset a key resolves to.
 *
 * No React, no fetch — the dashboard cannot import from `src/` (separate
 * tsconfig, separate bundle), so this is a HAND MIRROR, the same idiom
 * `matrixModel.ts` and `funnelModel.ts` already use. `Dataset` reuses the
 * matrix row grammar verbatim (constraint: dimensions never smuggled into
 * series names) by importing `MatrixDim`/`MatrixRow`/`MatrixTotal` rather
 * than re-declaring them.
 */
import type { MatrixDim, MatrixRow, MatrixTotal } from './matrixModel';

// ─── Types (mirror src/lib/lab/types.ts once T1 lands) ──────────────────────

export interface AppPage {
  id: string;
  title: string;
  html: string;
  /** The dataset key this page's own view is built from — the default
   *  `lab.data()` resolves to when the script omits a key. */
  dataset?: string;
}

export interface AppShell {
  /** CSS appended after the `lk-*` kit — "later wins", same override
   *  mechanism the kit's brand override uses. */
  style?: string;
  /** JS appended after the runtime shim, inside the SAME script tag. */
  script?: string;
}

export interface AppSpec {
  kind: 'app/v1';
  /** The page a bare `/lab/<slug>` (or a card click) opens. */
  entry: string;
  /** The page the board card previews — defaults to `entry` when absent. */
  card?: string;
  pages: AppPage[];
  shell?: AppShell;
}

export interface AppCacheEntry {
  spec: AppSpec;
  notices: string[];
  range: { fromISO: string; toISO: string };
}

export interface Dataset {
  key: string;
  label?: string;
  unit?: string | null;
  dims: MatrixDim[];
  rows: MatrixRow[];
  total?: MatrixTotal;
}

export interface DatasetBundle {
  kind: 'dataset/v1';
  /** The key a keyless `lab.data()` / `lab query` resolves to, before the
   *  `'series'` fallback (see {@link findDataset}). */
  primary?: string;
  datasets: Dataset[];
}

export interface DatasetCacheEntry {
  bundle: DatasetBundle;
  notices: string[];
  range: { fromISO: string; toISO: string };
}

// ─── Pure lookups (the bridge's only route to spec/data — nothing else) ─────

/**
 * Resolve a page id to its page. `pageId` absent/unmatched falls back to
 * `spec.entry`, then the first declared page — mirroring `chartEntry`'s
 * unknown-render fallback (degrade, never blank).
 */
export function findAppPage(spec: AppSpec, pageId: string | null | undefined): AppPage | null {
  if (spec.pages.length === 0) return null;
  const wantId = pageId ?? spec.entry;
  return (
    spec.pages.find((p) => p.id === wantId)
    ?? spec.pages.find((p) => p.id === spec.entry)
    ?? spec.pages[0]
  );
}

/** Every declared page id, in author order — used to validate an in-frame
 *  `lab.navigate()` request before it is allowed to reach the host's router. */
export function appPageIds(spec: AppSpec): string[] {
  return spec.pages.map((p) => p.id);
}

/**
 * Resolve a dataset key to its dataset. `key` absent falls back to
 * `bundle.primary`, then the literal `'series'` (what `seriesToDatasetBundle`
 * — the legacy-cache synthesis, T1/T3 — always names its one dataset), then
 * the first dataset. THE ONLY INPUT is `bundle` — this is what makes
 * `lab.data()` provably scoped to the datasets prop and nothing else.
 */
export function findDataset(
  bundle: DatasetBundle | null | undefined,
  key: string | null | undefined,
): Dataset | null {
  if (!bundle || bundle.datasets.length === 0) return null;
  const wantKey = key ?? bundle.primary ?? 'series';
  return bundle.datasets.find((d) => d.key === wantKey) ?? bundle.datasets[0];
}
