import { IncomingMessage, ServerResponse } from 'node:http';
import { loadProjectVocabulary, auditCorpus, resolveAlias } from '../../lib/taxonomy.js';
import { buildCorpus } from '../../lib/recall.js';
import { sendJson } from '../middleware.js';

/**
 * GET /api/taxonomy
 *
 * Returns a merged vocabulary, per-tag usage counts (alias-resolved onto
 * canonical tags), and the full auditCorpus buckets.
 *
 * Read-only. No filesystem writes. No body parsing.
 */
export async function handleTaxonomyGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const vocabulary = loadProjectVocabulary(contextRoot);

  // Build usage counts: iterate corpus docs, resolve every tag through
  // the alias map, then tally onto the canonical form.
  const usage: Record<string, number> = {};

  const corpus = buildCorpus(contextRoot);
  for (const doc of corpus) {
    for (const tag of doc.tags) {
      const canonical = resolveAlias(tag, vocabulary);
      usage[canonical] = (usage[canonical] ?? 0) + 1;
    }
  }

  const audit = auditCorpus(
    corpus.map((d) => ({ slug: d.slug, tags: d.tags })),
    vocabulary,
  );

  sendJson(res, 200, { vocabulary, usage, audit });
}
