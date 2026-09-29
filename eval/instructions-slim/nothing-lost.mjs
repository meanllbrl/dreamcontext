#!/usr/bin/env node
/**
 * nothing-lost.mjs: prove every rule and fact removed from an instruction file
 * still exists in a file the reader can reach.
 *
 *   node eval/instructions-slim/nothing-lost.mjs --target skill|sleep-agents [--strict] [--root <dir>]
 *
 * Units are sentences (25+ normalized chars) taken from the headings, list
 * items, table cells, paragraphs and code lines of the BASELINE file. Each unit
 * must pass one of three checks against its home set:
 *   1. exact  : its normalized text is a substring of a home file;
 *   2. fuzzy  : (not under --strict) with 5+ distinct 4+ char words, at least
 *               80% of them sit inside ONE window of a home file (a paragraph
 *               of at most 1,500 chars, or two adjacent sentences); with fewer
 *               words, all of them must;
 *   3. ledger : an entry in ledger.<target>.json explains it, either as
 *               `deleted` (with a reason) or `corrected-stale-fact` (with a
 *               home file and an anchor that resolves there).
 *
 * Exit 0 when nothing is missing; exit 1 on a missing unit, an unresolved
 * anchor or a ledger entry that matches nothing; exit 2 on bad input or a
 * baseline that moved since capture.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BaselineError, DEFAULT_ROOT, MIN_UNIT_CHARS, UsageError, extractBlocks, normalize,
  readBaseline, resolveInsideRoot, splitSentences, tokenize, verifyBaseline,
} from './lib.mjs';

const FUZZY_THRESHOLD = 0.8;
const FUZZY_MIN_WORDS = 5;
const WINDOW_MAX_CHARS = 1_500;
const WEAKEST_SHOWN = 20;
const MIN_LEDGER_MATCH_CHARS = 20;
const DISPOSITIONS = new Set(['deleted', 'corrected-stale-fact']);
const LEDGER_DIR = dirname(fileURLToPath(import.meta.url));

const SLEEP_SHARED_HOMES = [
  'skill/references/sleep-specialists.md',
  'skill/references/sleep.md',
  '_dream_context/knowledge/features/sleep-fanout-architecture.md',
  '_dream_context/knowledge/features/sleep-consolidation.md',
];

/** What each target compares: baseline file → home files (repo-relative). */
function targetGroups(target, root) {
  if (target === 'skill') {
    const refsDir = join(root, 'skill', 'references');
    const refs = existsSync(refsDir)
      ? readdirSync(refsDir).filter((f) => f.endsWith('.md')).sort().map((f) => `skill/references/${f}`)
      : [];
    return [{ baseline: 'SKILL.md', homes: ['skill/SKILL.md', ...refs, 'skill-agent-core/SKILL.md'] }];
  }
  if (target === 'sleep-agents') {
    return ['sleep-tasks', 'sleep-product', 'sleep-state'].map((name) => ({
      baseline: `${name}.md`,
      homes: [`agents/${name}.md`, ...SLEEP_SHARED_HOMES],
    }));
  }
  throw new UsageError('--target must be `skill` or `sleep-agents`');
}

function parseArgs(argv) {
  const opts = { target: null, strict: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict') opts.strict = true;
    else if (arg === '--target') opts.target = argv[++i] ?? null;
    else if (arg === '--root') {
      const value = argv[++i];
      if (!value) throw new UsageError('--root needs a directory');
      opts.root = resolve(value);
    } else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (opts.target !== 'skill' && opts.target !== 'sleep-agents') {
    throw new UsageError('--target must be `skill` or `sleep-agents`');
  }
  return opts;
}

/** Sentence units of a baseline file; table rows contribute their cells, not the row. */
function extractUnits(text, label) {
  const units = [];
  const seen = new Set();
  for (const block of extractBlocks(text)) {
    const pieces = block.kind === 'row' ? block.cells : [block.text];
    for (const piece of pieces) {
      for (const sentence of splitSentences(piece)) {
        const norm = normalize(sentence);
        if (norm.length < MIN_UNIT_CHARS || seen.has(norm)) continue;
        seen.add(norm);
        units.push({ label, line: block.line, raw: sentence.replace(/\s+/g, ' ').trim(), norm, words: tokenize(norm) });
      }
    }
  }
  return units;
}

/** A home file as exact-match text plus fuzzy windows. */
function loadHome(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  const text = readFileSync(abs, 'utf8');
  const windows = [];
  for (const block of extractBlocks(text)) {
    const blockNorm = normalize(block.text);
    if (blockNorm.length <= WINDOW_MAX_CHARS) windows.push({ file: rel, line: block.line, words: tokenize(blockNorm) });
    const sentences = splitSentences(block.text).map(normalize);
    if (sentences.length === 1 && blockNorm.length > WINDOW_MAX_CHARS) {
      windows.push({ file: rel, line: block.line, words: tokenize(sentences[0]) });
    }
    for (let i = 0; i + 1 < sentences.length; i++) {
      windows.push({ file: rel, line: block.line, words: tokenize(`${sentences[i]} ${sentences[i + 1]}`) });
    }
  }
  return { rel, norm: normalize(text), windows };
}

/** Inverted index word → window ids, so a unit only scores windows it shares words with. */
function indexWindows(homes) {
  const windows = homes.flatMap((h) => h.windows);
  const index = new Map();
  windows.forEach((w, id) => {
    for (const word of w.words) {
      const list = index.get(word);
      if (list) list.push(id);
      else index.set(word, [id]);
    }
  });
  return { windows, index };
}

function bestWindow(unit, windows, index) {
  const hits = new Map();
  for (const word of unit.words) {
    for (const id of index.get(word) ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
  }
  let best = null;
  for (const [id, count] of hits) {
    if (!best || count > best.count) best = { id, count };
  }
  if (!best) return { coverage: 0, window: null };
  return { coverage: best.count / unit.words.length, window: windows[best.id] };
}

function fuzzyPasses(unit, coverage) {
  if (unit.words.length === 0) return false;
  const needed = unit.words.length >= FUZZY_MIN_WORDS ? FUZZY_THRESHOLD : 1;
  return coverage >= needed;
}

function loadLedger(target) {
  const path = join(LEDGER_DIR, `ledger.${target}.json`);
  if (!existsSync(path)) throw new UsageError(`Missing ledger ${relative(DEFAULT_ROOT, path)} (start it as []).`);
  let entries;
  try {
    entries = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`Ledger ${path} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(entries)) throw new UsageError(`Ledger ${path} must be a JSON array`);
  return entries.map((entry, i) => {
    const where = `ledger.${target}.json[${i}]`;
    if (!entry || typeof entry !== 'object') throw new UsageError(`${where} is not an object`);
    const { match, disposition, reason, home, anchor } = entry;
    if (typeof match !== 'string' || normalize(match).length < MIN_LEDGER_MATCH_CHARS) {
      throw new UsageError(`${where}.match must be a string of at least ${MIN_LEDGER_MATCH_CHARS} normalized chars`);
    }
    if (!DISPOSITIONS.has(disposition)) throw new UsageError(`${where}.disposition must be deleted or corrected-stale-fact`);
    if (typeof reason !== 'string' || reason.trim() === '') throw new UsageError(`${where}.reason is required`);
    if (disposition === 'corrected-stale-fact' && (typeof home !== 'string' || typeof anchor !== 'string' || anchor.trim() === '')) {
      throw new UsageError(`${where}: corrected-stale-fact needs home and anchor`);
    }
    return { where, match: normalize(match), disposition, reason, home, anchor, used: 0 };
  });
}

/** Anchor check for corrected-stale-fact entries: the corrected truth must exist where the entry says. */
function unresolvedAnchors(root, ledger) {
  const problems = [];
  for (const entry of ledger) {
    if (entry.disposition !== 'corrected-stale-fact') continue;
    const abs = resolveInsideRoot(root, entry.home);
    if (!existsSync(abs)) {
      problems.push(`${entry.where}: home ${entry.home} does not exist`);
    } else if (!normalize(readFileSync(abs, 'utf8')).includes(normalize(entry.anchor))) {
      problems.push(`${entry.where}: anchor not found in ${entry.home}`);
    }
  }
  return problems;
}

function run(opts) {
  const verified = verifyBaseline(opts.root);
  const ledger = loadLedger(opts.target);
  const results = [];
  const skippedHomes = new Set();

  for (const group of targetGroups(opts.target, opts.root)) {
    const units = extractUnits(readBaseline(opts.root, verified, group.baseline), group.baseline);
    const homes = [];
    for (const rel of group.homes) {
      const home = loadHome(opts.root, rel);
      if (home) homes.push(home);
      else skippedHomes.add(rel);
    }
    const exactText = homes.map((h) => h.norm).join('\u0000');
    const { windows, index } = indexWindows(homes);

    for (const unit of units) {
      if (exactText.includes(unit.norm)) {
        results.push({ unit, verdict: 'exact' });
        continue;
      }
      const best = bestWindow(unit, windows, index);
      if (!opts.strict && fuzzyPasses(unit, best.coverage)) {
        results.push({ unit, verdict: 'fuzzy', coverage: best.coverage, window: best.window });
        continue;
      }
      const entry = ledger.find((e) => unit.norm.includes(e.match));
      if (entry) {
        entry.used++;
        results.push({ unit, verdict: entry.disposition, entry });
        continue;
      }
      results.push({ unit, verdict: 'missing', coverage: best.coverage, window: best.window });
    }
  }

  return {
    results,
    skippedHomes: [...skippedHomes],
    anchorProblems: unresolvedAnchors(opts.root, ledger),
    unmatchedLedger: ledger.filter((e) => e.used === 0).map((e) => e.where),
  };
}

function short(text, max = 160) {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function report(opts, outcome) {
  const count = (verdict) => outcome.results.filter((r) => r.verdict === verdict).length;
  const missing = outcome.results.filter((r) => r.verdict === 'missing');
  console.log(`nothing-lost --target ${opts.target}${opts.strict ? ' --strict' : ''}`);
  console.log(`units ${outcome.results.length} | exact ${count('exact')} | fuzzy ${count('fuzzy')} | ` +
    `ledger deleted ${count('deleted')} | ledger corrected ${count('corrected-stale-fact')} | missing ${missing.length}`);
  if (outcome.skippedHomes.length > 0) console.log(`home files not present (skipped): ${outcome.skippedHomes.join(', ')}`);

  const weakest = outcome.results
    .filter((r) => r.verdict === 'fuzzy')
    .sort((a, b) => a.coverage - b.coverage)
    .slice(0, WEAKEST_SHOWN);
  if (weakest.length > 0) {
    console.log(`\nWeakest ${weakest.length} fuzzy passes (spot-check these):`);
    for (const r of weakest) {
      console.log(`  ${(r.coverage * 100).toFixed(0)}%  ${r.unit.label}:${r.unit.line} -> ${r.window.file}:${r.window.line}`);
      console.log(`       ${short(r.unit.raw)}`);
    }
  }
  if (missing.length > 0) {
    console.log(`\nMISSING (${missing.length}): not found exactly, not fuzzy, not in the ledger:`);
    for (const r of missing) {
      const near = r.window ? ` (closest ${(r.coverage * 100).toFixed(0)}% at ${r.window.file}:${r.window.line})` : '';
      console.log(`  ${r.unit.label}:${r.unit.line}${near}`);
      console.log(`       ${short(r.unit.raw)}`);
    }
  }
  for (const p of outcome.anchorProblems) console.log(`UNRESOLVED ANCHOR: ${p}`);
  for (const w of outcome.unmatchedLedger) console.log(`UNMATCHED LEDGER ENTRY: ${w} matches no failing unit`);
  return missing.length === 0 && outcome.anchorProblems.length === 0 && outcome.unmatchedLedger.length === 0;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const ok = report(opts, run(opts));
  process.exit(ok ? 0 : 1);
} catch (err) {
  if (err instanceof BaselineError || err instanceof UsageError) {
    console.error(`nothing-lost: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
