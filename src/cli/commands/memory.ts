import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import chalk from 'chalk';
import { confirm, input } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header, info, success, error } from '../../lib/format.js';
import { resolveAuthors } from '../../lib/people-resolve.js';
import {
  buildCorpus,
  bm25Search,
  docLevel,
  CORPUS_TYPES,
  type CorpusType,
  type RecallHit,
} from '../../lib/recall.js';
import { hybridSearch, hybridReady } from '../../lib/embeddings/hybrid.js';
import { resolveRecallMode } from './sleep.js';
import {
  crossVaultRecall,
  currentVaultTarget,
  resolveConnectedVaults,
  resolveAllShareableVaults,
  type CrossVaultTarget,
} from '../../lib/federation-recall.js';
import { loadProjectVocabulary, aliasGroups } from '../../lib/taxonomy.js';
import { readFrontmatter, writeFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { today } from '../../lib/id.js';

export const TYPE_LABELS: Record<CorpusType, string> = {
  knowledge: 'knowledge',
  feature: 'feature',
  task: 'task',
  memory: 'memory',
  changelog: 'changelog',
  objective: 'objective',
  insight: 'insight',
  thesis: 'thesis',
  automation: 'automation',
  skill: 'skill', // never produced by buildCorpus; present only to satisfy the Record type
};

/**
 * Parse `--level <n>` into a minimum importance level (see DocLevel). Anything
 * outside 1–3 is ignored rather than clamped: `--level 9` most likely means the
 * caller misunderstood the scale, and silently treating it as `--level 3` would
 * return results they didn't ask for. Undefined = no level filter.
 */
export function parseLevel(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return n === 1 || n === 2 || n === 3 ? n : undefined;
}

/** `★★★` / `★★` / `★` badge for a doc's derived importance level. */
export function levelBadge(level: number): string {
  return '★'.repeat(Math.max(1, Math.min(3, level)));
}

/** Commander accumulator for a repeatable `--vault <name>` option. */
function collectVault(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseTypes(value: string | undefined): CorpusType[] | undefined {
  if (!value) return undefined;
  const valid = CORPUS_TYPES;
  const parts = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as CorpusType[];
  const filtered = parts.filter((p) => valid.includes(p));
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Cross-vault recall output (P1.2/P1.3). Builds the target vault set from the
 * flags — current vault always included — then renders vault-tagged hits in
 * plain / JSON / pretty form, with a trailing dim note for any stale-skipped
 * peers. Kept out of the action closure for readability; the no-flag path never
 * reaches here.
 */
function recallFederated(
  contextRoot: string,
  query: string,
  topK: number,
  types: CorpusType[] | undefined,
  minLevel: number | undefined,
  opts: { json?: boolean; plain?: boolean; vault?: string[]; connected?: boolean; allVaults?: boolean },
): void {
  const projectRoot = dirname(contextRoot);
  const { target: currentTarget } = currentVaultTarget(projectRoot);

  // Compose the target set: current vault + (connected ∪ all-vaults ∪ explicit).
  const byName = new Map<string, CrossVaultTarget>();
  const add = (t: CrossVaultTarget): void => {
    // current always wins; otherwise first-seen wins (de-dupe by resolution key).
    const existing = byName.get(t.name);
    if (!existing || (t.current && !existing.current)) byName.set(t.name, t);
  };
  add(currentTarget);
  if (opts.connected) for (const t of resolveConnectedVaults(currentTarget, contextRoot)) add(t);
  if (opts.allVaults) for (const t of resolveAllShareableVaults(currentTarget)) add(t);
  for (const name of opts.vault ?? []) add({ name });

  const { hits, skipped } = crossVaultRecall(query, {
    vaults: Array.from(byName.values()),
    topK,
    types,
    minLevel,
  });

  if (opts.json) {
    const payload = hits.map((h) => ({
      vault: h.vault,
      key: h.key,
      type: h.doc.type,
      slug: h.doc.slug,
      path: h.doc.relPath,
      title: h.doc.title,
      description: h.doc.description,
      tags: h.doc.tags,
      // Path-derived product (single source of truth): present for per-product
      // knowledge and features nested under features/<product>/; omitted otherwise.
      product: h.doc.product,
      // Derived importance 1-3 (see DocLevel) — what `--level` filters on.
      level: docLevel(h.doc),
      score: Number(h.score.toFixed(4)),
      snippet: h.snippet,
    }));
    console.log(JSON.stringify({
      query,
      hits: payload,
      skipped: skipped.map((s) => ({ vault: s.vault, reason: s.reason })),
    }, null, 2));
    return;
  }

  const staleNote = skipped.length > 0
    ? `(skipped ${skipped.length} stale vault${skipped.length === 1 ? '' : 's'}: ${skipped.map((s) => s.vault).join(', ')})`
    : '';

  if (opts.plain) {
    if (hits.length === 0) {
      console.log(`No hits for "${query}".`);
    }
    for (const h of hits) {
      console.log(`[${h.vault}::${TYPE_LABELS[h.doc.type]}] ${levelBadge(docLevel(h.doc))} ${h.doc.slug}  (score ${h.score.toFixed(3)})`);
      console.log(`  ${h.doc.relPath}`);
      if (h.doc.description) console.log(`  ${h.doc.description}`);
      if (h.snippet) {
        for (const line of h.snippet.split('\n')) console.log(`    ${line}`);
      }
      console.log('');
    }
    if (staleNote) console.log(staleNote);
    return;
  }

  console.log(header(`Federated recall: "${query}"`));
  if (hits.length === 0) {
    info(`No hits for "${query}".`);
  }
  for (const h of hits) {
    const vaultBadge = chalk.yellow(`${h.vault}::`);
    const typeBadge = chalk.cyan(`[${TYPE_LABELS[h.doc.type]}]`);
    const slug = chalk.magentaBright(h.doc.slug);
    const score = chalk.dim(`score ${h.score.toFixed(3)}`);
    const level = chalk.dim(levelBadge(docLevel(h.doc)));
    console.log(`  ${vaultBadge}${typeBadge} ${level} ${slug}  ${score}`);
    console.log(`    ${chalk.dim(h.doc.relPath)}`);
    if (h.doc.description) console.log(`    ${h.doc.description}`);
    if (h.doc.tags.length > 0) {
      console.log(`    ${chalk.dim('tags: ' + h.doc.tags.join(', '))}`);
    }
    if (h.snippet) {
      const snipLines = h.snippet.split('\n').map((l) => `      ${chalk.gray('│')} ${l}`);
      console.log(snipLines.join('\n'));
    }
    console.log('');
  }
  if (staleNote) console.log(chalk.dim(staleNote));
}

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command('memory')
    .description('Search and explore the project corpus (knowledge, features, tasks, memory)');

  // recall
  memory
    .command('recall')
    .argument('<query...>', 'Search query (multiple words OK)')
    .description('Search every corpus channel: knowledge, features, tasks, memory, changelog, objectives, insights, theses, automations')
    .option('-t, --top <n>', 'Number of hits to return', '10')
    .option('--types <types>', `Comma-separated subset: ${CORPUS_TYPES.join(',')}`)
    .option('--level <n>', 'Only hits at importance level n or above (1=all, 2=curated, 3=starred/pinned/high-priority)')
    .option('--json', 'Emit JSON for piping into other tools')
    .option('--plain', 'Plain text output without colors')
    .option('--vault <name>', 'Also search this vault (repeatable; registered name or path)', collectVault, [])
    .option('--connected', 'Span the current vault + its out/both connections (shareable peers only)')
    .option('--all-vaults', 'Span the current vault + every shareable registered vault')
    .action(
      async (
        queryParts: string[],
        opts: {
          top?: string;
          types?: string;
          level?: string;
          json?: boolean;
          plain?: boolean;
          vault?: string[];
          connected?: boolean;
          allVaults?: boolean;
        },
      ) => {
        const root = ensureContextRoot();
        const query = queryParts.join(' ');
        const topK = Math.max(1, Math.min(50, Number.parseInt(opts.top ?? '10', 10) || 10));
        const types = parseTypes(opts.types);
        const minLevel = parseLevel(opts.level);

        // ── Federation branch (P1.2/P1.3) ──────────────────────────────────────
        // ANY of --vault / --connected / --all-vaults routes through cross-vault
        // recall.
        const explicitVaults = opts.vault ?? [];
        if (explicitVaults.length > 0 || opts.connected || opts.allVaults) {
          recallFederated(root, query, topK, types, minLevel, opts);
          return;
        }

        // ── DEFAULT-SPAN (cross-project read by default) ───────────────────────
        // With NO federation flag, the interactive `memory recall` CLI spans the
        // current vault's eligible peers BY DEFAULT — same target set as
        // `--connected` (out/both, non-stale, shareable peers). This is the
        // explicit agent/Explore path; the always-on hook does NOT come through
        // here (it calls bm25Search on a local-only corpus directly), so the
        // SessionStart/generateSnapshot hot-path stays local-only (P1.6 LOCKED).
        //
        // GATE: only span when at least one eligible peer exists. With no
        // eligible connections `resolveConnectedVaults` returns just the current
        // vault, and we fall through to the byte-identical legacy local-only
        // recall below (regression-guarded). Provenance stays visible because
        // recallFederated namespaces every hit `<vault>::<type>/<slug>`.
        const projectRoot = dirname(root);
        const { target: currentTarget } = currentVaultTarget(projectRoot);
        const connectedTargets = resolveConnectedVaults(currentTarget, root);
        if (connectedTargets.length > 1) {
          recallFederated(root, query, topK, types, minLevel, { ...opts, connected: true });
          return;
        }

        const corpus = buildCorpus(root, {
          ...(types ? { types } : {}),
          ...(minLevel ? { minLevel } : {}),
        });
        const vocab = loadProjectVocabulary(root);
        // Honour the vault's recall mode (the SAME source of truth the hook and
        // the dashboard read): hybrid BM25+dense fusion when it's selected AND
        // already warm, else plain BM25. `hybridReady` guarantees the explicit
        // `memory recall` never blocks on a first-time download or index build.
        const mode = resolveRecallMode(root);
        const useHybrid = hybridReady(root, mode);
        // Hybrid selected but not warm yet → we searched with BM25. Nudge (on
        // stderr, so --json / --plain stdout stays clean) toward the one-time warm-up.
        if (mode === 'hybrid' && !useHybrid) {
          console.error(chalk.dim('  (hybrid recall selected but not warmed — using BM25. Run `dreamcontext embed refresh` to enable it.)'));
        }
        const hits = useHybrid
          ? await hybridSearch(query, corpus, root, topK, { aliasGroups: aliasGroups(vocab) })
          : bm25Search(query, corpus, topK, { aliasGroups: aliasGroups(vocab) });

        if (opts.json) {
          const payload = hits.map((h) => ({
            type: h.doc.type,
            slug: h.doc.slug,
            path: h.doc.relPath,
            title: h.doc.title,
            description: h.doc.description,
            tags: h.doc.tags,
            // Path-derived product (single source of truth); omitted when unscoped.
            product: h.doc.product,
            // Derived importance 1-3 (see DocLevel) — what `--level` filters on.
            level: docLevel(h.doc),
            score: Number(h.score.toFixed(4)),
            snippet: h.snippet,
          }));
          console.log(JSON.stringify({ query, corpusSize: corpus.length, hits: payload }, null, 2));
          return;
        }

        if (hits.length === 0) {
          const msg = `No hits for "${query}" (searched ${corpus.length} docs).`;
          if (opts.plain) console.log(msg);
          else info(msg);
          return;
        }

        if (opts.plain) {
          for (const h of hits) {
            console.log(`[${TYPE_LABELS[h.doc.type]}] ${levelBadge(docLevel(h.doc))} ${h.doc.slug}  (score ${h.score.toFixed(3)})`);
            console.log(`  ${h.doc.relPath}`);
            if (h.doc.description) console.log(`  ${h.doc.description}`);
            if (h.snippet) {
              for (const line of h.snippet.split('\n')) console.log(`    ${line}`);
            }
            console.log('');
          }
          return;
        }

        const scope = minLevel ? chalk.dim(` · level >= ${minLevel}`) : '';
        console.log(header(`Recall: "${query}"  ${chalk.dim(`(${corpus.length} docs scanned)`)}${scope}`));
        for (const h of hits) {
          const typeBadge = chalk.cyan(`[${TYPE_LABELS[h.doc.type]}]`);
          const slug = chalk.magentaBright(h.doc.slug);
          const score = chalk.dim(`score ${h.score.toFixed(3)}`);
          const level = chalk.dim(levelBadge(docLevel(h.doc)));
          console.log(`  ${typeBadge} ${level} ${slug}  ${score}`);
          console.log(`    ${chalk.dim(h.doc.relPath)}`);
          if (h.doc.description) console.log(`    ${h.doc.description}`);
          if (h.doc.tags.length > 0) {
            console.log(`    ${chalk.dim('tags: ' + h.doc.tags.join(', '))}`);
          }
          if (h.snippet) {
            const snipLines = h.snippet.split('\n').map((l) => `      ${chalk.gray('│')} ${l}`);
            console.log(snipLines.join('\n'));
          }
          console.log('');
        }
      },
    );

  // remember — quick CHANGELOG entry capture (post-Option-E, 2026-05-23).
  // Previously appended a LIFO entry to 2.memory.md; that section is gone.
  // Ship events now live exclusively in CHANGELOG.json — `memory remember`
  // is a fast path to that file with sensible defaults.
  memory
    .command('remember')
    .argument('<text...>', 'The memory text to record (multiple words OK)')
    .option('--summary <summary>', 'Optional ≤200 char one-liner (defaults to first 200 chars of text)')
    .option('--type <type>', 'Changelog type (default: note)', 'note')
    .option('--scope <scope>', 'Changelog scope (default: quick)', 'quick')
    .option('--references <refs>', 'Optional comma-separated references (commit:<sha>, file:<path>, knowledge:<slug>, feature:<slug>, task:<slug>, url:<href>)')
    .option('--person <list>', 'Comma-separated people to attribute this memory to (e.g. "mehmet,ada") — defaults to the active person')
    .description('Quick-append a CHANGELOG entry. Fast path; for full control use `dreamcontext core changelog add`.')
    .action(async (
      textParts: string[],
      opts: { summary?: string; type?: string; scope?: string; references?: string; person?: string },
    ) => {
      const root = ensureContextRoot();
      const text = textParts.join(' ').trim();
      if (!text) {
        error('Cannot remember empty text.');
        return;
      }
      const summary = opts.summary
        ?? (text.length > 200 ? text.slice(0, 197) + '...' : text);
      const references = opts.references
        ? opts.references.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      // Person attribution uses the UNIFIED `authors` carrier (the same field as
      // `core changelog add --authors`), NOT references. recall.ts indexes
      // `authors` into the doc tags so the person name is searchable.
      // An explicit --person wins verbatim; otherwise the active person is
      // stamped, and a vault with no people/people.json stamps nothing (D18).
      const explicitPeople = opts.person
        ? opts.person.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const authors = resolveAuthors(root, explicitPeople);
      const changelogPath = join(root, 'core', 'CHANGELOG.json');
      const entry: Record<string, unknown> = {
        date: today(),
        type: opts.type ?? 'note',
        scope: opts.scope ?? 'quick',
        summary,
        description: text,
        breaking: false,
      };
      if (references && references.length > 0) entry.references = references;
      if (authors && authors.length > 0) entry.authors = authors;
      // insertToJsonArray is the canonical writer (LIFO via top-insert).
      const { insertToJsonArray } = await import('../../lib/json-file.js');
      insertToJsonArray(changelogPath, entry);
      success(`Remembered (CHANGELOG): ${summary}`);
    });

  // update — edit a knowledge file's frontmatter or body
  memory
    .command('update')
    .argument('<slug>', 'Knowledge file slug (without .md)')
    .option('-d, --description <desc>', 'New description (replaces existing)')
    .option('-t, --tags <tags>', 'New tags (comma-separated, replaces existing)')
    .option('-c, --content <content>', 'New body content (replaces existing)')
    .option('--append <text>', 'Append text to body (preserves existing content)')
    .option('--pin', 'Set pinned: true')
    .option('--unpin', 'Set pinned: false')
    .description('Update a knowledge file (frontmatter and/or body)')
    .action(
      async (
        slug: string,
        opts: {
          description?: string;
          tags?: string;
          content?: string;
          append?: string;
          pin?: boolean;
          unpin?: boolean;
        },
      ) => {
        const root = ensureContextRoot();
        const filePath = join(root, 'knowledge', `${slug}.md`);
        if (!existsSync(filePath)) {
          error(`Knowledge file not found: ${slug}.md`);
          return;
        }
        const { data, content } = readFrontmatter(filePath);
        const updates: Record<string, unknown> = { ...data };
        let nextContent = content;
        let changed = false;

        if (opts.description !== undefined) {
          updates.description = opts.description;
          changed = true;
        }
        if (opts.tags !== undefined) {
          updates.tags = opts.tags.split(',').map((s) => s.trim()).filter(Boolean);
          changed = true;
        }
        if (opts.pin) {
          updates.pinned = true;
          changed = true;
        }
        if (opts.unpin) {
          updates.pinned = false;
          changed = true;
        }
        if (opts.content !== undefined) {
          nextContent = `\n${opts.content}\n`;
          changed = true;
        } else if (opts.append !== undefined) {
          nextContent = `${content.trimEnd()}\n\n${opts.append}\n`;
          changed = true;
        }

        if (!changed) {
          info('No update flags provided. Use --description, --tags, --content, --append, --pin, or --unpin.');
          return;
        }

        updates.updated = today();
        writeFrontmatter(filePath, updates, nextContent);
        success(`Updated: knowledge/${slug}.md`);
      },
    );

  // delete — remove a knowledge file (with confirmation)
  memory
    .command('delete')
    .argument('<slug>', 'Knowledge file slug to delete (without .md)')
    .option('-f, --force', 'Skip confirmation prompt')
    .description('Delete a knowledge file (irreversible; use git to recover)')
    .action(async (slug: string, opts: { force?: boolean }) => {
      const root = ensureContextRoot();
      const filePath = join(root, 'knowledge', `${slug}.md`);
      if (!existsSync(filePath)) {
        error(`Knowledge file not found: ${slug}.md`);
        return;
      }
      if (!opts.force) {
        const ok = await confirm({
          message: `Delete knowledge/${slug}.md? (use git to recover if mistaken)`,
          default: false,
        });
        if (!ok) {
          info('Cancelled.');
          return;
        }
      }
      unlinkSync(filePath);
      success(`Deleted: knowledge/${slug}.md`);
    });

  // list — list all corpus docs, optionally filtered
  memory
    .command('list')
    .description('List all docs in the memory corpus (every channel, or a --types subset)')
    .option('--types <types>', `Comma-separated subset: ${CORPUS_TYPES.join(',')}`)
    .option('--level <n>', 'Only docs at importance level n or above (1-3)')
    .option('--plain', 'Plain text (no colors)')
    .action((opts: { types?: string; level?: string; plain?: boolean }) => {
      const root = ensureContextRoot();
      const types = parseTypes(opts.types);
      const minLevel = parseLevel(opts.level);
      const corpus = buildCorpus(root, { ...(types ? { types } : {}), ...(minLevel ? { minLevel } : {}) });
      if (corpus.length === 0) {
        const msg = 'No docs in corpus.';
        if (opts.plain) console.log(msg);
        else info(msg);
        return;
      }

      if (opts.plain) {
        for (const doc of corpus) {
          console.log(`[${TYPE_LABELS[doc.type]}] ${levelBadge(docLevel(doc))} ${doc.slug}  ${doc.relPath}`);
        }
        return;
      }

      // Grouped from CORPUS_TYPES rather than a hand-written Record: a new
      // channel then appears here automatically instead of being silently
      // omitted from the listing.
      const byType = new Map<CorpusType, typeof corpus>();
      for (const doc of corpus) {
        const bucket = byType.get(doc.type);
        if (bucket) bucket.push(doc);
        else byType.set(doc.type, [doc]);
      }
      console.log(header(`Memory Corpus (${corpus.length} docs)`));
      for (const t of CORPUS_TYPES) {
        const docs = byType.get(t);
        if (!docs || docs.length === 0) continue;
        console.log(`\n  ${chalk.cyan(TYPE_LABELS[t])} (${docs.length}):`);
        for (const doc of docs) {
          const desc = doc.description ? `  ${chalk.dim('— ' + doc.description)}` : '';
          console.log(`    ${chalk.dim(levelBadge(docLevel(doc)))} ${chalk.magentaBright(doc.slug)}${desc}`);
        }
      }
    });

  // status
  memory
    .command('status')
    .description('Show corpus size and breakdown by type and importance level')
    .action(() => {
      const root = ensureContextRoot();
      const corpus = buildCorpus(root);
      const counts = new Map<CorpusType, number>();
      const levels = new Map<number, number>();
      let totalTokens = 0;
      for (const doc of corpus) {
        counts.set(doc.type, (counts.get(doc.type) ?? 0) + 1);
        const lvl = docLevel(doc);
        levels.set(lvl, (levels.get(lvl) ?? 0) + 1);
        totalTokens += doc.tokens.length;
      }
      // Unit noun per channel — cosmetic, and defaulting keeps a new channel from
      // needing an entry here before it can be counted.
      const UNITS: Partial<Record<CorpusType, string>> = {
        knowledge: 'files', feature: 'PRDs', task: 'task files',
        memory: 'LIFO entries', changelog: 'entries', objective: 'objectives',
        insight: 'insights', thesis: 'theses', automation: 'manifests + runs',
      };
      const width = Math.max(...CORPUS_TYPES.map((t) => TYPE_LABELS[t].length));
      console.log(header('Memory Corpus'));
      for (const t of CORPUS_TYPES) {
        const label = TYPE_LABELS[t].padEnd(width);
        console.log(`  ${chalk.magentaBright(label)}  ${counts.get(t) ?? 0} ${UNITS[t] ?? 'docs'}`);
      }
      console.log('');
      const levelLine = [3, 2, 1]
        .map((l) => `${levelBadge(l)} ${levels.get(l) ?? 0}`)
        .join('   ');
      console.log(`  ${chalk.dim('importance:')} ${levelLine}   ${chalk.dim('(filter with --level <n>)')}`);
      console.log('');
      console.log(`  ${chalk.dim(`${corpus.length} docs · ${totalTokens.toLocaleString()} tokens indexed (in-memory, ephemeral)`)}`);
    });
}
