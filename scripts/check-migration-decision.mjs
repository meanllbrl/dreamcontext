#!/usr/bin/env node
// Every feature decides how existing installs follow it (plan oto-migration D6, C6).
//
// The decision is a line in the feature PR's body:
//   Migration: src/migrations/<file>.ts      (one per file; each in the PR's diff, and every
//                                             migration file the diff ADDS named)
//   Migration: none - <reason>               (reason of MIN_REASON_CHARS or more, and only when
//                                             the diff adds no migration file)
//
//   node scripts/check-migration-decision.mjs --pr
//       Feedback on one PR (workflow migration-decision.yml). Input from env ONLY: PR_BODY,
//       BASE_SHA, HEAD_SHA, HEAD_REF, HEAD_REPO, REPO. The diff comes from git.
//   node scripts/check-migration-decision.mjs --release [--since vX.Y.Z]
//       The gate: every PR merged into dev or main since the previous release tag (default: the
//       newest v* tag reachable from HEAD that does not point at HEAD) must carry a decision.
//       Exit 1 names each PR without one; exit 2 when gh is missing, signed out or offline, or no
//       previous tag is found (a loud error, never a pass).
//
// Every git and gh call goes through execFile with an argument array; the PR body is data and
// never reaches a shell. A process gate, not a security boundary.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** PRs merged before this instant predate the gate and are never checked. */
export const GATE_START = '2026-11-22T00:00:00Z';
export const MIN_REASON_CHARS = 10;
const BASES = ['dev', 'main'];
const RELEASE_HEAD = /^(beta|dev|main|release\/.+)$/;
const FILE_LINE = /^Migration:\s*(src\/migrations\/[\w.-]+\.ts)\s*$/;
const NONE_LINE = /^Migration:\s*none\s*[-:–—]\s*(.*)$/i;
/** A migration step file, as the registry names them (`0.23.0.ts`, `0.23.0-soul-split.ts`). */
const MIGRATION_FILE = /^src\/migrations\/\d+\.\d+\.\d+(?:-[a-z0-9-]+)?\.ts$/;
const TAG = /^v\d+\.\d+\.\d+$/;

/**
 * The PR body's `Migration:` lines, read; `bad` holds lines that start so but parse as neither.
 * Lines inside HTML comments are ignored.
 */
export function parseDecision(body) {
  const files = [];
  const nones = [];
  const bad = [];
  // HTML comments are the template's guidance, never a decision.
  const text = String(body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^Migration:/i.test(line)) continue;
    const f = FILE_LINE.exec(line);
    if (f) { files.push(f[1]); continue; }
    const n = NONE_LINE.exec(line);
    if (n) { nones.push(n[1].trim()); continue; }
    bad.push(line);
  }
  return { files, nones, bad };
}

/**
 * The verdict for one PR. `changedFiles` / `addedFiles` are the diff's lists; nothing is read
 * from the filesystem. A same-repo release PR (head beta, dev, main or release/*) is exempt; a
 * fork's is not.
 */
export function checkMigrationDecision({ body, changedFiles = [], addedFiles = [], headRef, headRepo, repo }) {
  if (headRepo && repo && headRepo === repo && RELEASE_HEAD.test(headRef ?? '')) {
    return { ok: true, reason: 'release PR, exempt' };
  }
  const { files, nones, bad } = parseDecision(body);
  if (bad.length) return { ok: false, reason: `unreadable Migration: line "${clean(bad[0]).slice(0, 80)}"` };
  if (!files.length && !nones.length) return { ok: false, reason: 'no Migration: line' };
  if (files.length && nones.length) return { ok: false, reason: 'both a Migration: none line and a file line' };
  if (nones.length > 1) return { ok: false, reason: 'more than one Migration: none line' };
  const addedMigrations = addedFiles.filter((f) => MIGRATION_FILE.test(f));
  if (nones.length) {
    if (nones[0].length < MIN_REASON_CHARS) {
      return { ok: false, reason: `Migration: none needs a reason of at least ${MIN_REASON_CHARS} characters` };
    }
    if (addedMigrations.length) {
      return { ok: false, reason: `Migration: none, but the diff adds ${addedMigrations.join(', ')}` };
    }
    return { ok: true, reason: 'none, with a reason' };
  }
  const changed = new Set(changedFiles);
  const missing = files.filter((f) => !changed.has(f));
  if (missing.length) return { ok: false, reason: `named but not in the diff: ${missing.join(', ')}` };
  const named = new Set(files);
  const unnamed = addedMigrations.filter((f) => !named.has(f));
  if (unnamed.length) return { ok: false, reason: `added but not named: ${unnamed.join(', ')}` };
  return { ok: true, reason: `migration ${files.join(', ')}` };
}

/** A title fit for one log line: no control characters, no leading workflow command. */
function clean(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/^\s*:+/, '').trim();
}

class GateError extends Error {}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new GateError(`${cmd} is not installed`);
    const detail = clean(String(err?.stderr || err?.message || '').split('\n')[0]);
    throw new GateError(`${cmd} ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}

/** The previous release tag: newest v* reachable from HEAD that does not point at HEAD. */
function previousTag() {
  const atHead = new Set(run('git', ['tag', '--points-at', 'HEAD']).split('\n').map((t) => t.trim()));
  const tags = run('git', ['tag', '--merged', 'HEAD', '--list', 'v[0-9]*', '--sort=-v:refname'])
    .split('\n').map((t) => t.trim()).filter((t) => TAG.test(t) && !atHead.has(t));
  if (!tags.length) throw new GateError('no previous release tag (v*) reachable from HEAD; pass --since vX.Y.Z');
  return tags[0];
}

function tagDate(tag) {
  const out = run('git', ['for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${tag}`]).trim();
  const ms = Date.parse(out);
  if (!out || Number.isNaN(ms)) throw new GateError(`tag ${tag} not found here (fetch tags first)`);
  return new Date(ms);
}

function mergedPrs(repo, since) {
  const day = since.toISOString().slice(0, 10);
  const byNumber = new Map();
  for (const base of BASES) {
    const out = run('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--base', base, '--limit', '1000',
      '--search', `merged:>=${day}`, '--json', 'number,title,body,headRefName,headRepository,headRepositoryOwner,mergedAt']);
    let list;
    try { list = JSON.parse(out); } catch { throw new GateError('gh pr list returned unreadable JSON'); }
    if (!Array.isArray(list)) throw new GateError('gh pr list returned no list');
    for (const pr of list) {
      if (Date.parse(pr.mergedAt) >= since.getTime()) byNumber.set(pr.number, pr);
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

function prFiles(repo, number) {
  const out = run('gh', ['api', `repos/${repo}/pulls/${number}/files`, '--paginate', '--jq', '.[] | .status + "\t" + .filename']);
  const changed = [];
  const added = [];
  for (const line of out.split('\n')) {
    const [status, file] = line.split('\t');
    if (!file) continue;
    changed.push(file);
    if (status === 'added') added.push(file);
  }
  return { changed, added };
}

/** Release mode. Returns the exit code; prints one line per failing PR. */
export function releaseCheck({ since } = {}) {
  try {
    if (since !== undefined && !TAG.test(since)) throw new GateError(`--since must be vX.Y.Z, got ${clean(since)}`);
    const tag = since ?? previousTag();
    const start = new Date(Math.max(tagDate(tag).getTime(), Date.parse(GATE_START)));
    const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new GateError('gh could not name this repository');
    const failures = [];
    let checked = 0;
    for (const pr of mergedPrs(repo, start)) {
      const headRepo = pr.headRepositoryOwner?.login && pr.headRepository?.name
        ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}` : '';
      const base = { body: pr.body, headRef: pr.headRefName, headRepo, repo };
      let verdict = checkMigrationDecision(base);
      if (verdict.reason !== 'release PR, exempt') {
        checked++;
        const { changed, added } = prFiles(repo, pr.number);
        verdict = checkMigrationDecision({ ...base, changedFiles: changed, addedFiles: added });
      }
      if (!verdict.ok) {
        failures.push(`#${pr.number} ${clean(pr.title).slice(0, 100)}: ${verdict.reason}. Fix: gh pr edit ${pr.number} --body-file <file> with a Migration: line, then run this again.`);
      }
    }
    if (failures.length) {
      console.error(`✗ ${failures.length} PR(s) merged since ${tag} carry no valid migration decision:`);
      for (const f of failures) console.error(`  ${f}`);
      return 1;
    }
    console.log(`✓ migration decision: ${checked} PR(s) merged since ${tag} (after ${start.toISOString()}) each carry one`);
    return 0;
  } catch (err) {
    if (err instanceof GateError) {
      console.error(`✗ check-migration-decision cannot run: ${err.message}. This is not a pass.`);
      return 2;
    }
    throw err;
  }
}

/** PR mode, from env only. */
export function prCheck(env = process.env) {
  const { PR_BODY, BASE_SHA, HEAD_SHA, HEAD_REF, HEAD_REPO, REPO } = env;
  const sha = /^[0-9a-f]{7,64}$/;
  if (!sha.test(BASE_SHA ?? '') || !sha.test(HEAD_SHA ?? '')) {
    console.error('✗ BASE_SHA and HEAD_SHA must be commit SHAs');
    return 2;
  }
  let changed;
  let added;
  try {
    const range = `${BASE_SHA}...${HEAD_SHA}`;
    changed = run('git', ['diff', '--name-only', range]).split('\n').filter(Boolean);
    added = run('git', ['diff', '--name-only', '--diff-filter=A', range]).split('\n').filter(Boolean);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 2;
  }
  const verdict = checkMigrationDecision({ body: PR_BODY, changedFiles: changed, addedFiles: added, headRef: HEAD_REF, headRepo: HEAD_REPO, repo: REPO });
  if (verdict.ok) {
    console.log(`✓ migration decision: ${verdict.reason}`);
    return 0;
  }
  console.log(`::error::Migration decision missing or wrong: ${verdict.reason}. Add to the PR body one line per migration file (Migration: src/migrations/<file>.ts) or one line Migration: none - <why existing installs need nothing>. Editing the body re-runs this check.`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = () => {
    console.error('usage: check-migration-decision.mjs --pr | --release [--since vX.Y.Z]');
    process.exit(2);
  };
  if (args.length === 1 && args[0] === '--pr') process.exit(prCheck());
  if (args[0] !== '--release') usage();
  if (args.length === 1) process.exit(releaseCheck());
  if (args.length === 3 && args[1] === '--since') process.exit(releaseCheck({ since: args[2] }));
  usage();
}
