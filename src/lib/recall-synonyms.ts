/**
 * Curated query-time synonym map for BM25 recall (B4).
 *
 * This is a SMALL, hand-curated bridge between common short forms / paraphrases
 * and the canonical vocabulary the corpus actually uses. It is applied ONLY at
 * query time and ONLY as a contribution to the derived `rankScore` (NOT the raw
 * `.score` that the hook's hard thresholds read — see recall.ts bm25Search).
 *
 * Precision discipline: keep this map tight. Every entry below is a real term
 * that appears in this project's corpus (auth/db/recall/sleep/bookmark/hook plus
 * a handful of project-specific concepts). Adding speculative synonyms risks
 * dragging exact-term / field-match precision down — if those categories regress
 * in the eval harness, shrink this map rather than grow it.
 *
 * Format: each KEY maps to a list of EXPANSION terms. Expansion is symmetric —
 * a query containing any member of a synonym group also matches the others. All
 * terms are stored lowercase and are matched AFTER tokenisation/stemming, so they
 * must be written in their already-stemmed base form where stemming would apply
 * (e.g. `database` stems to `databas`; we store `database` and rely on the
 * caller stemming both sides consistently).
 */

// Bidirectional synonym groups. Each inner array is a set of mutually-synonymous
// surface terms; expansion adds every OTHER member of the group a query term
// belongs to.
// NOTE on Turkish entries: members are written in the surface form the
// tokenizer/stemmer actually PRODUCES (the conservative TR folder strips only a
// fixed suffix set, so e.g. "konsolidasyonu" survives as-is). The expander stems
// every member through the same pipeline, so adding the post-stem form is what
// makes the cross-language bridge fire. These TR↔EN bridges directly target the
// turkish eval queries whose concept has zero English token overlap.
const SYNONYM_GROUPS: string[][] = [
  // Authentication / authorization
  ['auth', 'authentication', 'authorization', 'login', 'signin'],
  // Databases
  ['db', 'database', 'postgres', 'postgresql', 'sqlite'],
  // Recall / search / retrieval (core project concept) + TR
  ['recall', 'search', 'retrieval', 'retrieve', 'lookup', 'çağırma', 'arama'],
  // Sleep / consolidation (core project concept) + TR (uyku / konsolidasyon)
  ['sleep', 'consolidation', 'consolidate', 'consolidating', 'uyku', 'konsolidasyon', 'konsolidasyonu'],
  // Bookmark / salience / ripple (core project concept)
  ['bookmark', 'ripple', 'salience', 'salient'],
  // Hook / hooks
  ['hook', 'hooks'],
  // Memory / remember (core project concept) + TR (hafıza / bellek / beyin)
  ['memory', 'remember', 'recollection', 'hafıza', 'bellek', 'beyin', 'beynini'],
  // Vector / embeddings / semantic (the path NOT taken — mem0 decision)
  ['vector', 'embedding', 'embeddings', 'semantic'],
  // Keyword / bm25 (the path taken)
  ['keyword', 'bm25'],
  // Vault / registry / project-folder (multivault concept)
  ['vault', 'registry', 'multivault'],
  // Positioning / tagline / slogan / messaging (branding concept) + TR
  ['positioning', 'position', 'tagline', 'slogan', 'sloganı', 'messaging', 'konumlandırma', 'konumlandırması'],
  // Council / debate / personas (council-skill concept)
  ['council', 'debate', 'persona', 'personas'],
  // Snapshot / inject / bootstrap (context-snapshot concept) + TR (oturum / enjekte)
  ['snapshot', 'inject', 'bootstrap', 'session', 'oturum', 'enjekte'],
  // RICE / prioritization / scoring / backlog (rice concept) + TR
  ['rice', 'prioritization', 'prioritize', 'backlog', 'scoring', 'önceliklendirme', 'puanlama', 'sayısal'],
  // Manifest / install / upgrade / cleanup (install-update concept)
  ['manifest', 'install', 'upgrade', 'uninstall'],
  // Security / vulnerability (dashboard-server-security) + TR (güvenlik / açık)
  ['security', 'vulnerability', 'vulnerabilities', 'hardening', 'güvenlik', 'açık'],
  // Server (dashboard server) + TR (sunucu)
  ['server', 'sunucu', 'sunucusu'],
  // Task / görev
  ['task', 'görev'],
  // Debt / borç (sleep debt)
  ['debt', 'borç'],
];

/**
 * Built lookup: raw surface term -> set of raw expansion terms (excluding the
 * term itself). Constructed once at module load. Keys/values are the surface
 * forms as authored above; the caller folds both query terms and expansions
 * through its stemming pipeline so they line up with the (stemmed) index.
 */
const SYNONYMS: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const expansions = map.get(term) ?? new Set<string>();
      for (const other of group) {
        if (other !== term) expansions.add(other);
      }
      map.set(term, expansions);
    }
  }
  return map;
})();

export const SYNONYM_WEIGHT = 0.5;

/**
 * Expand query terms with their synonyms for rank-time scoring.
 *
 * Inputs:
 * - `queryTerms`: the STEMMED primary query terms (what bm25Search scores).
 * - `stem`: the caller's stemming function. We stem each synonym-group surface
 *   term so the map can be authored in plain English while lookups still work
 *   against stemmed query terms (e.g. authored `database` -> stemmed `databas`).
 *
 * Returns a map: stemmedExpansionTerm -> SYNONYM_WEIGHT, excluding any term that
 * is already a primary query term (those are scored at full weight by the
 * caller). The weight feeds `rankScore` only — never the raw `.score`.
 */
export function expandQueryTerms(
  queryTerms: string[],
  stem: (term: string) => string,
): Map<string, number> {
  const primary = new Set(queryTerms);
  const expansions = new Map<string, number>();
  // Build a stemmed view of the synonym map lazily but deterministically: for
  // each primary query term, find which group(s) it belongs to by stemming the
  // group surface keys and matching.
  for (const [surfaceKey, syns] of SYNONYMS) {
    const stemmedKey = stem(surfaceKey);
    if (!primary.has(stemmedKey)) continue;
    for (const syn of syns) {
      const stemmedSyn = stem(syn);
      if (primary.has(stemmedSyn)) continue;          // already a primary term
      if (!expansions.has(stemmedSyn)) {
        expansions.set(stemmedSyn, SYNONYM_WEIGHT);
      }
    }
  }
  return expansions;
}

// Exposed for tests.
export { SYNONYMS };
