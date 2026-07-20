#!/usr/bin/env node
/**
 * CLI smoke test for the proactive learning layer (`dreamcontext theses`).
 *
 * REQUIRES a fresh build first: `npm run build:cli` (invokes the CLI via
 * `node dist/index.js`, not the TS source, so the compiled artifact is what
 * gets exercised — the same thing a real user runs).
 *
 * Runs the full lifecycle against a throwaway scratch vault (mkdtemp'd, never
 * touches the real repo's `_dream_context/`):
 *   enable -> create (draft) -> predict -> status open -> evidence x3
 *   -> show --json (assert derived confidence == the pinned formula)
 *   -> status validated --cite 0 -> promote --knowledge <path> -> retire
 *   -> disable (+ assert the disabled hint prints while the command still works)
 *   -> candidates <file> (assert theses/.candidates.json matches the SERVER
 *      contract — server/routes/theses.ts readCandidates requires each staged
 *      item to be an OBJECT with a non-empty string `claim` field; a bare
 *      string is silently dropped there, so the CLI writer must normalize)
 *
 * Exit code is non-zero on any assertion failure or non-zero CLI exit where
 * one wasn't expected. Usage: `node scripts/smoke-theses.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distIndex = resolve(__dirname, '..', 'dist', 'index.js');

if (!existsSync(distIndex)) {
  console.error(`✗ ${distIndex} not found — run \`npm run build:cli\` first.`);
  process.exit(1);
}

const scratchRoot = mkdtempSync(join(tmpdir(), 'dc-smoke-theses-'));
const vaultDir = join(scratchRoot, '_dream_context');
mkdirSync(vaultDir, { recursive: true });

let failures = 0;

function fail(msg) {
  failures += 1;
  console.error(`✗ ${msg}`);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

/** Run one `dreamcontext theses ...` invocation against the scratch vault. */
function run(args) {
  const result = spawnSync('node', [distIndex, ...args], {
    cwd: scratchRoot,
    encoding: 'utf-8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Run and assert a clean (exit 0) result; fails loudly + prints output otherwise. */
function runExpectOk(args, label) {
  const r = run(args);
  if (r.status !== 0) {
    fail(`${label}: expected exit 0, got ${r.status}\n  stdout: ${r.stdout}\n  stderr: ${r.stderr}`);
  } else {
    ok(label);
  }
  return r;
}

/** Reimplementation of the pinned derived-confidence formula (src/lib/theses/confidence.ts),
 *  kept independent on purpose — a real regression in the store's arithmetic must not be
 *  masked by importing the very code under test. */
function expectedConfidence(events) {
  const L = events.length;
  let ws = 0;
  let wc = 0;
  events.forEach((e, i) => {
    const weight = L <= 1 ? 1 : 0.55 + 0.45 * (i / (L - 1));
    if (e === 'supports') ws += weight;
    else if (e === 'contradicts') wc += weight;
  });
  return (ws + 0.4) / (ws + wc + 0.8);
}

const SLUG = 'test-thesis';
const CLAIM = 'Compressing stale memories during sleep improves recall precision';

console.log(`Scratch vault: ${scratchRoot}\n`);

// 1. enable
{
  const r = runExpectOk(['theses', 'enable'], 'theses enable');
  if (!/enabled/i.test(r.stdout)) fail('theses enable: stdout did not confirm enablement');
}

// 2. create (draft, no predictions yet)
{
  const r = runExpectOk(
    ['theses', 'create', '--slug', SLUG, CLAIM],
    'theses create (draft)',
  );
  if (!/draft/i.test(r.stdout)) fail('theses create: expected status draft in output');
}

// 3. predict
{
  runExpectOk(
    [
      'theses',
      'predict',
      SLUG,
      'Recall precision on held-out queries improves by at least 5 points within 2 sleep cycles',
    ],
    'theses predict',
  );
}

// 4. status open (requires >=1 prediction — set in step 3)
{
  const r = runExpectOk(['theses', 'status', SLUG, 'open'], 'theses status open');
  if (!/open/i.test(r.stdout)) fail('theses status open: expected confirmation of the open status');
}

// 4b. sanity: draft->open WITHOUT a prediction must be rejected (hard gate).
{
  const r = run(['theses', 'create', '--slug', 'no-prediction-thesis', '--open', 'A claim with no predictions']);
  if (r.status === 0) fail('theses create --open with zero predictions should have failed the hard gate, but exited 0');
  else ok('theses create --open with zero predictions correctly rejected');
}

// 5-7. three evidence events: supports, supports, contradicts (oldest -> newest)
const verdicts = ['supports', 'supports', 'contradicts'];
const sources = ['insight', 'insight', 'task'];
const notes = ['cycle 1: +3pts', 'cycle 2: +6pts', 'cycle 3: regression on TR queries'];
verdicts.forEach((verdict, i) => {
  runExpectOk(
    [
      'theses',
      'evidence',
      SLUG,
      '--verdict',
      verdict,
      '--source',
      sources[i],
      '--ref',
      'recall-precision',
      '--note',
      notes[i],
      ...(verdict !== 'contradicts' ? ['--quantitative'] : []),
    ],
    `theses evidence #${i} (${verdict})`,
  );
});

// 8. show --json — assert derived confidence matches the pinned formula
{
  const r = runExpectOk(['theses', 'show', SLUG, '--json'], 'theses show --json');
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    fail(`theses show --json: could not parse JSON output: ${err.message}`);
    parsed = null;
  }
  if (parsed) {
    if (parsed.evidence.length !== 3) {
      fail(`theses show --json: expected 3 evidence events, got ${parsed.evidence.length}`);
    }
    const expected = expectedConfidence(verdicts);
    const actual = parsed.confidence;
    const delta = Math.abs(actual - expected);
    if (delta > 1e-9) {
      fail(`theses show --json: confidence mismatch — expected ${expected}, got ${actual} (delta ${delta})`);
    } else {
      ok(`derived confidence matches the pinned formula (${actual.toFixed(6)})`);
    }
  }
}

// 9. status validated --cite 0 (manual flip, citation-gated)
{
  const r = runExpectOk(['theses', 'status', SLUG, 'validated', '--cite', '0'], 'theses status validated --cite 0');
  if (!/validated/i.test(r.stdout)) fail('theses status validated: expected confirmation of the validated status');
}

// 9b. sanity: a manual flip WITHOUT --cite must be rejected (citation gate).
{
  const r = run(['theses', 'status', SLUG, 'invalidated']);
  if (r.status === 0) fail('theses status invalidated without --cite should have failed the citation gate, but exited 0');
  else ok('manual flip without --cite correctly rejected');
}

// 10. promote --knowledge <path>
const knowledgePath = 'knowledge/decisions/test-thesis.md';
{
  const r = runExpectOk(
    ['theses', 'promote', SLUG, '--knowledge', knowledgePath],
    'theses promote --knowledge',
  );
  if (!r.stdout.includes(knowledgePath)) fail('theses promote: expected the knowledge path to be echoed back');
}

// 11. retire
{
  const r = runExpectOk(['theses', 'retire', SLUG], 'theses retire');
  if (!/retired/i.test(r.stdout)) fail('theses retire: expected confirmation of the retired status');
}

// 12. disable — command still works, but prints the disabled hint
{
  runExpectOk(['theses', 'disable'], 'theses disable');
  const r = runExpectOk(['theses', 'list', '--all'], 'theses list --all (after disable)');
  if (!/layer is off/i.test(r.stdout)) {
    fail('theses list after disable: expected the disabled hint to print');
  } else {
    ok('disabled hint printed while the command still returned data');
  }
  if (!r.stdout.includes(SLUG)) {
    fail('theses list --all after disable: expected the retired test thesis to still be listed');
  }
}

// 13. candidates <file> — input mixes bare strings and { claim } objects; the
// CLI must normalize both to { claim } on disk, matching the server's
// readCandidates contract (server/routes/theses.ts:76-100 drops non-object items).
{
  const candidatesInput = join(scratchRoot, 'candidates-input.json');
  writeFileSync(
    candidatesInput,
    JSON.stringify({
      note: 'Weekly sync notes',
      items: [
        'A bare-string candidate claim extracted from the notes',
        { claim: 'An already-object candidate claim' },
        { claim: '  Padded claim with extra whitespace  ' },
      ],
    }),
    'utf-8',
  );

  runExpectOk(['theses', 'candidates', candidatesInput], 'theses candidates <file>');

  const stagedPath = join(vaultDir, 'theses', '.candidates.json');
  if (!existsSync(stagedPath)) {
    fail(`theses candidates: expected ${stagedPath} to exist`);
  } else {
    let staged;
    try {
      staged = JSON.parse(readFileSync(stagedPath, 'utf-8'));
    } catch (err) {
      fail(`theses candidates: could not parse staged file: ${err.message}`);
      staged = null;
    }
    if (staged) {
      if (!Array.isArray(staged.items) || staged.items.length !== 3) {
        fail(`theses candidates: expected 3 staged items, got ${JSON.stringify(staged.items)}`);
      } else {
        const allValid = staged.items.every(
          (item) => item && typeof item === 'object' && !Array.isArray(item)
            && typeof item.claim === 'string' && item.claim.trim().length > 0,
        );
        if (!allValid) {
          fail(`theses candidates: every staged item must be an object with a non-empty "claim" string (server contract) — got ${JSON.stringify(staged.items)}`);
        } else {
          ok('staged candidates match the server contract — every item is { claim: <non-empty string> }');
        }
      }
    }
  }
}

// 13b. candidates --clear
{
  runExpectOk(['theses', 'candidates', '--clear'], 'theses candidates --clear');
  const stagedPath = join(vaultDir, 'theses', '.candidates.json');
  const staged = JSON.parse(readFileSync(stagedPath, 'utf-8'));
  if (!Array.isArray(staged.items) || staged.items.length !== 0) {
    fail(`theses candidates --clear: expected an empty items array, got ${JSON.stringify(staged.items)}`);
  } else {
    ok('theses candidates --clear emptied the staged items');
  }
}

rmSync(scratchRoot, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} smoke assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('✓ All theses CLI smoke assertions passed.');
  process.exit(0);
}
