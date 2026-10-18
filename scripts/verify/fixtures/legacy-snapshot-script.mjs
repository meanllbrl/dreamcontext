/**
 * The funnel explorer's PRE-v2.0 script: it reads only the snapshot
 * `lab/data/<slug>.json` (no network, no keys). `lab create --preset
 * funnel-explorer` no longer writes it (a new explorer pulls live through the
 * KB MCP with KB_MCP_KEY), but vaults still carry it, and `lab data write|check`
 * (the deprecated fallback) still serve it. Tests and the verify scripts install
 * it over a fresh preset script to exercise that fallback end to end.
 * Byte-identical to the template the preset shipped until neonbi-data-api v2.0.
 */
export function legacySnapshotScript(slug) {
  return `/**
 * Funnel explorer adapter for the "${slug}" insight.
 *
 * Reads ONLY the snapshot lab/data/${slug}.json, shaped { source, data }: no
 * network, no keys. \`data\` is a funnel-set/v1; \`source\` carries the applied
 * filters and the freshness of the pull. The agent fills the snapshot with the
 * KB MCP queries in the dreamcontext skill (tasks-and-features.md § Funnel
 * explorer) and writes it with:
 *
 *   dreamcontext lab data write ${slug} --file <path>
 *
 * which validates the snapshot before it replaces the old one. The window the
 * explorer shows comes from the snapshot, never from a range control.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { sep } from 'node:path';

const FILE = new URL('../data/${slug}.json', import.meta.url);
const DIR = new URL('../data/', import.meta.url);
const NAME = 'lab/data/${slug}.json';
const MISSING = 'No snapshot yet at ' + NAME + '. Fill it (skill: tasks-and-features.md § Funnel explorer), then run dreamcontext lab data write ${slug} --file <path>.';

/** Read the snapshot: never through a link, never outside lab/data, never echoing its content in an error. */
async function load() {
  let st;
  try {
    st = await lstat(FILE);
  } catch {
    throw new Error(MISSING);
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(NAME + ' is a symlink or not a regular file: refusing to read it.');
  }
  const dir = await realpath(DIR);
  if (!dir.endsWith(sep + 'lab' + sep + 'data')) {
    throw new Error('lab/data/ resolves outside the vault: refusing to read ' + NAME + '.');
  }
  let text;
  try {
    text = await readFile(FILE, 'utf8');
  } catch {
    throw new Error(MISSING);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(NAME + ' is not valid JSON. Write it again with dreamcontext lab data write ${slug} --file <path>.');
  }
}

/** The applied filters as display strings ("field op value"), deduplicated, at most 8. */
function filtersOf(source) {
  const lists = [source.applied_filters].concat(
    Array.isArray(source.queries) ? source.queries.map((q) => q && q.applied_filters) : [],
  );
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (!f || typeof f.field !== 'string') continue;
      const value = Array.isArray(f.values)
        ? f.values.join(f.op === 'between' ? '..' : ', ')
        : f.value !== undefined ? String(f.value) : '';
      const line = [f.field, f.op || '', value].join(' ').replace(/\\s+/g, ' ').trim().slice(0, 120);
      if (out.indexOf(line) === -1) out.push(line);
    }
  }
  return out.slice(0, 8);
}

/** Where the numbers came from, for the explorer header (when the data names none). */
function provenanceOf(source) {
  if (!source || typeof source !== 'object') return undefined;
  const names = [source.chart_name]
    .concat(Array.isArray(source.queries) ? source.queries.map((q) => q && q.chart_name) : [])
    .filter((n, i, all) => typeof n === 'string' && n !== '' && all.indexOf(n) === i);
  const via = typeof source.via === 'string' && source.via ? source.via : 'snapshot';
  const out = { source: ((names.length > 0 ? names.join(' + ') : 'snapshot') + ' via ' + via).slice(0, 120) };
  if (typeof source.pulled_at === 'string') out.pulled_at = source.pulled_at;
  if (typeof source.freshness === 'string') out.freshness = source.freshness.slice(0, 64);
  const filters = filtersOf(source);
  if (filters.length > 0) out.filters = filters;
  return out;
}

export default async function readExplorer() {
  const snapshot = await load();
  const data = snapshot.data;
  if (!data || data.kind !== 'funnel-set/v1') {
    throw new Error(NAME + ': \`data\` must be a funnel-set/v1.');
  }
  return data.provenance ? data : Object.assign({}, data, { provenance: provenanceOf(snapshot.source) });
}

export async function freshness() {
  const { source } = await load();
  const names = provenanceOf(source);
  return {
    marker: source.pulled_at,
    asOf: source.pulled_at,
    note: names ? names.source + (source.freshness ? ' · ' + source.freshness : '') : null,
  };
}
`;
}
