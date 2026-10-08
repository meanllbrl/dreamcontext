#!/usr/bin/env node
/**
 * Hands-free END-TO-END ROUND TRIP — the integration proof named in the task's Validation
 * method (AC2, AC5, AC7-AC14, AC19's refusal of dreamcontext credential files, AC20, AC24
 * where a fake can reach).
 *
 *   npm run build:cli && node scripts/verify/handsfree-roundtrip.mjs
 *   (HFRT_ONLY=t1,t2 runs a subset of trips; HFRT_KEEP=1 keeps the scratch dir)
 *
 * WHAT RUNS FOR REAL
 *  - the LAPTOP: the real orchestration (`src/lib/handsfree/orchestrator.ts`: setup, go,
 *    returnTrip, resumeTrip, rollbackTrip, abandonTrip, readReceipt), one `npx tsx` process
 *    per call (scripts/verify/handsfree-roundtrip/driver.ts), in a scratch laptop HOME;
 *  - the CLOUD: the real built CLI `dreamcontext cloud serve --same-uid-worker
 *    --mirror-prefix <dir> --port <n>` as a second process in its own scratch HOME, started
 *    and stopped by the FakeCloudProvider's onStart/onStop hooks (a "machine" boot/stop);
 *  - the PHONE: a device session signed in with the passphrase setup produced
 *    (POST /api/handsfree/login), the cloud's own roster/accounts routes, and the real mobile
 *    chat in Playwright's iPhone profile (case 15), with a stub `claude` on the cloud's PATH;
 *  - work the phone's claude did that no route expresses (git commits, stashes, files) is
 *    made directly inside the mirror, exactly where the cloud keeps it.
 *
 * SEAM LIMITS (said out loud, not hidden): no uid split (same-uid worker), no root
 * supervisor (so no build-fingerprint parity, AC18), no real Codespaces (FakeCloudProvider).
 * The Mac seam maps paths only for the transfer routes: the cloud's device routes resolve a
 * vault through the mirror's vaults.json, which holds LAPTOP paths; the harness rewrites the
 * mirror's copy (a one-way global-set file, never returned) to the mirror paths so the
 * phone writes into the cloud copy, as it would in production where the paths are equal.
 *
 * Every case prints PASS/FAIL with its evidence; the script exits non-zero on any FAIL and
 * ends with `handsfree-roundtrip: N passed, M failed`. Never touches the real ~/.dreamcontext
 * or ~/.claude (asserted at the end).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLI, CLOUD, LH, M, Phone, REPO, SCRATCH, diffMaps, diffState, driver, driverAsync, exists, git, gitState, nonGitSet, put, read, sha, treeShas,
} from './handsfree-roundtrip/lib.mjs';
import { ATLAS, CTX, NFC, NFD, NOTES, PAY, PROJECTS, SPAWN_LOG, VAULT, VAULT_TRANSCRIPTS, buildFixtures, enc, freezePackage } from './handsfree-roundtrip/fixtures.mjs';

// ─── reporting ──────────────────────────────────────────────────────────────────────────

const results = [];
const defects = [];
let currentCase = '';
function section(title) { currentCase = title; console.log(`\n── ${title}`); }
function check(name, ok, evidence) {
  results.push({ case: currentCase, name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `\n        ${String(evidence).split('\n').join('\n        ')}` : ''}`);
  return !!ok;
}
const short = (o, n = 600) => { const s = typeof o === 'string' ? o : (JSON.stringify(o) ?? String(o)); return s.length > n ? s.slice(0, n) + '…' : s; };
const errOf = (r) => (r.ok ? null : r.error ? `${r.error.code ?? r.error.name}: ${r.error.message}` : `killed=${r.killed} signal=${r.signal} status=${r.status} ${r.stderr}`);

// ─── the real home must not change ──────────────────────────────────────────────────────

const REAL_HOME = homedir();
function realHomeSnapshot() {
  const out = {};
  const note = (p) => { try { const s = lstatSync(p); out[p] = `${s.mtimeMs}:${s.size}`; } catch { out[p] = 'absent'; } };
  const walk = (d) => { let n = []; try { n = readdirSync(d); } catch { note(d); return; } note(d); for (const x of n) { const p = join(d, x); try { lstatSync(p).isDirectory() ? walk(p) : note(p); } catch { /* raced */ } } };
  walk(join(REAL_HOME, '.dreamcontext', 'handsfree'));
  for (const f of ['linked-repos.json', 'agent-ui.json', 'claude-accounts.json', '.secrets.json']) note(join(REAL_HOME, '.dreamcontext', f));
  // vaults.json by CONTENT minus lastOpenedAt: the owner's running app bumps that field when a
  // real project window opens; any vault this script could add, move or remove still shows.
  try {
    const reg = JSON.parse(readFileSync(join(REAL_HOME, '.dreamcontext', 'vaults.json'), 'utf8'));
    out['vaults.json (minus lastOpenedAt)'] = JSON.stringify((reg.vaults ?? []).map(({ lastOpenedAt: _l, ...v }) => v));
  } catch { out['vaults.json (minus lastOpenedAt)'] = 'absent'; }
  for (const f of ['settings.json', 'CLAUDE.md']) note(join(REAL_HOME, '.claude', f));
  // (~/.claude.json is left out: the Claude Code session running this script rewrites it.)
  // No transcript dir of any scratch path may appear in the real ~/.claude/projects.
  let leaked = [];
  try { leaked = readdirSync(join(REAL_HOME, '.claude', 'projects')).filter((n) => n.includes('dreamcontext-verify-handsfree-roundtrip')); } catch { /* none */ }
  out.__leaked = leaked.join(',');
  return out;
}

// ─── harness plumbing ───────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

let PORT = 0;
let ORIGIN = '';
let PASSPHRASE = '';

function call(cmd, args, o) {
  const r = driver(cmd, args, o);
  console.log(`      · ${cmd} ${r.ok ? 'ok' : 'ERR'} (${(r.ms / 1000).toFixed(1)}s)${r.ok ? '' : ` ${short(errOf(r), 400)}`}`);
  return r;
}
const goTrip = () => call('go', { contextRoot: CTX });
const state = () => call('state').value;

/**
 * The phone writes into the cloud copy (see SEAM LIMITS): the mirror's one-way global-set
 * registries hold LAPTOP paths (vaults.json, claude-accounts.json configDir); in production
 * those equal the cloud's, on the Mac seam they are rewritten to the mirror paths.
 */
function pointMirrorVaultsAtMirror() {
  const p = M(join(LH, '.dreamcontext', 'vaults.json'));
  if (!existsSync(p)) return false;
  const reg = JSON.parse(readFileSync(p, 'utf8'));
  for (const v of reg.vaults) if (!v.path.startsWith(CLOUD.mirror)) v.path = M(v.path);
  writeFileSync(p, JSON.stringify(reg, null, 2) + '\n');
  const a = M(join(LH, '.dreamcontext', 'claude-accounts.json'));
  if (existsSync(a)) {
    const acc = JSON.parse(readFileSync(a, 'utf8'));
    for (const x of acc.accounts) if (x.configDir && !x.configDir.startsWith(CLOUD.mirror)) x.configDir = M(x.configDir);
    writeFileSync(a, JSON.stringify(acc, null, 2) + '\n');
  }
  return true;
}

async function signInPhone() {
  const phone = new Phone(ORIGIN);
  const r = await phone.login(PASSPHRASE);
  return { phone, r };
}

const tripDir = (trip) => join(LH, '.dreamcontext', 'handsfree', 'trips', trip);
function filesIn(dir) { return Object.keys(treeShas(dir)); }

// ─── trips ──────────────────────────────────────────────────────────────────────────────

const ONLY = (process.env.HFRT_ONLY ?? '').split(',').filter(Boolean);
const want = (t) => !ONLY.length || ONLY.includes(t);
const finalizations = [];

function recordFinalization(label, receipt) {
  finalizations.push({ label, fin: receipt?.finalization ?? null });
}

/**
 * Trip 1: cases 1, 2, 4, 5, 7, 9, 13, 14 (+ the unborn repo of case 1) in one go/return.
 */
async function trip1() {
  section('Trip 1 · go');
  const before = { vault: gitState(VAULT), pay: gitState(PAY), atlas: gitState(ATLAS), notes: gitState(NOTES) };
  const beforeNonGit = nonGitSet(VAULT);
  const g = goTrip();
  if (!check('go succeeds and the laptop is away', g.ok && state().trip.phase === 'away', errOf(g) ?? `trip ${g.value?.tripId}`)) return;
  const trip = g.value.tripId;

  // ── Case 1 (AC2): equality after go ────────────────────────────────────────────────
  section('Case 1 · staged + unstaged + untracked + multi-stash + branch + unborn (AC2/AC7)');
  for (const [name, repo] of [['acme-storefront', VAULT], ['acme-payments', PAY], ['atlas-mobile', ATLAS], ['field-notes (unborn)', NOTES]]) {
    const d = diffState(gitState(repo), gitState(M(repo)));
    check(`after go, ${name}: HEAD, refs, stash list (sha + message), indexTree, worktreeTree and status --porcelain=v2 equal on both sides`, d.length === 0, d.join('\n') || `head ${gitState(repo).head}`);
  }
  const vs = gitState(VAULT);
  check('the laptop really carries 2 stash entries with distinct messages, a staged, an unstaged and an untracked change',
    vs.stash.split('\n').filter(Boolean).length === 2 && /^M\./m.test(vs.status.replace(/^1 /gm, '')) && /^\.M/m.test(vs.status.replace(/^1 /gm, '')) && /^\? src\/untracked-draft\.ts$/m.test(vs.status),
    `stash=${JSON.stringify(vs.stash)} status=${JSON.stringify(vs.status)}`);
  const cloudNonGit = nonGitSet(M(VAULT));
  const stays = new Set(g.value.staysHome.map((x) => x.path));
  const dn = diffMaps(Object.fromEntries(Object.entries(beforeNonGit).filter(([p]) => !stays.has(p))), cloudNonGit);
  check('after go, every allow-listed non-git file of the vault is sha256-equal in the cloud (minus the D19 stays-home link)', dn.length === 0, dn.join('\n') || `${Object.keys(cloudNonGit).length} files`);
  const absent = ['_dream_context/marketing/hero.bin', '_dream_context/tmp/scratch.txt', '_dream_context/state/.secrets.json', '_dream_context/lab/credentials.json']
    .filter((r) => exists(join(M(VAULT), ...r.split('/'))));
  check('marketing/, tmp/ and dreamcontext\'s own credential files (.secrets.json, lab credentials) are absent on the cloud (AC2, AC19)', absent.length === 0, absent.length ? `present in the cloud: ${absent.join(', ')}` : 'all four absent');
  check('a laptop link that escapes the root stays on the laptop: listed in go\'s staysHome, absent in the cloud (D19)',
    g.value.staysHome.some((s) => s.path === '_dream_context/state/escape-link') && !exists(join(M(VAULT), '_dream_context', 'state', 'escape-link')),
    `staysHome=${short(g.value.staysHome)}`);

  // ── the phone works (edits made AS the cloud would) ────────────────────────────────
  section('Trip 1 · the phone works');
  const { phone, r: login } = await signInPhone();
  check('the phone signs in with the passphrase setup produced (POST /api/handsfree/login -> 200 + device cookie)', login.status === 200 && !!login.cookie, `status ${login.status}`);
  check('the mirror\'s vaults.json was rewritten to the mirror paths (seam, see header)', pointMirrorVaultsAtMirror());

  // Case 1 phone: a commit on main, a new branch, a third stash, staged/unstaged/untracked.
  const mv = M(VAULT);
  put(mv, 'src/phone-coupon.ts', 'export const coupon = "PHONE10";\n');
  git(mv, ['add', 'src/phone-coupon.ts']);
  git(mv, ['commit', '-qm', 'phone: coupon code']);
  git(mv, ['branch', 'phone/hotfix']);
  put(mv, 'README.md', '# acme-storefront\n\nPhone stash.\n');
  git(mv, ['stash', 'push', '-q', '-m', 'phone: readme stash']);
  // Case 14: auto-executing config changed in the cloud (tracked) + an ignored .claude file.
  put(mv, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(npm test)', 'Bash(curl *)'] } }, null, 2) + '\n');
  put(mv, '.mcp.json', JSON.stringify({ mcpServers: { phone: { command: 'npx', args: ['phone-mcp'] } } }, null, 2) + '\n');
  put(mv, '.husky/pre-commit', '#!/bin/sh\nnpm test\nnpm run phone-lint\n', 0o755);
  git(mv, ['add', '.claude/settings.json', '.mcp.json']);
  put(mv, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(rm -rf *)'] } }, null, 2) + '\n');
  put(mv, 'src/phone-untracked.ts', 'export const fromPhone = 1;\n');
  // Case 2: the ignored task file edited on BOTH sides.
  put(mv, '_dream_context/state/rework-the-checkout-flow.md', '---\nstatus: in_progress\n---\n# Rework the checkout flow\n\n- step one\n- PHONE: step two\n');
  put(VAULT, '_dream_context/state/rework-the-checkout-flow.md', '---\nstatus: in_progress\n---\n# Rework the checkout flow\n\n- step one\n- LAPTOP: step two\n');
  const laptopTask = read(VAULT, '_dream_context/state/rework-the-checkout-flow.md');
  const cloudTask = read(mv, '_dream_context/state/rework-the-checkout-flow.md');
  // Case 13: secret class edited on both sides (D16); dreamcontext credentials planted by the cloud.
  put(mv, '.env', 'STRIPE_KEY=sk_test_cloud_rotated\n');
  put(VAULT, '.env', 'STRIPE_KEY=sk_test_laptop_edited_while_away\n');
  const laptopEnvEdited = read(VAULT, '.env');
  put(mv, '_dream_context/state/.secrets.json', JSON.stringify({ github: { token: 'gho_PLANTED_BY_CLOUD' } }) + '\n');
  put(mv, '_dream_context/lab/credentials.json', JSON.stringify({ posthog: 'phx_PLANTED_BY_CLOUD' }) + '\n');
  const laptopSecrets = read(VAULT, '_dream_context/state/.secrets.json');
  const laptopLab = read(VAULT, '_dream_context/lab/credentials.json');
  // Case 7: links the cloud adds: two escaping (refused), one inside (lands).
  symlinkSync('/etc/hosts', join(mv, '_dream_context', 'state', 'phone-abs-link'));
  symlinkSync('../../../../../../../../../../etc/hosts', join(mv, '_dream_context', 'state', 'phone-climb-link'));
  symlinkSync('rework-the-checkout-flow.md', join(mv, '_dream_context', 'state', 'phone-good-link'));
  // Case 4: the cloud's roster PUT carries chatPermissionMode=bypass and a cloud-only bypass:true tab.
  const S4 = '44444444-4444-4444-8444-444444444444';
  const got = await phone.req('GET', '/api/agent/sessions', undefined, { vault: 'acme-storefront' });
  const gen = got.json?.generation ?? 0;
  const put4 = await phone.req('PUT', '/api/agent/sessions', {
    baseGeneration: gen,
    sessions: [
      ...(got.json?.sessions ?? []).map(({ bound: _b, ...s }) => s),
      { title: 'Phone bypass tab', bypass: true, minimized: false, size: 1, sessionId: S4, kind: 'chat' },
    ],
    chatPermissionMode: 'bypass',
  }, { vault: 'acme-storefront' });
  check('the phone\'s roster PUT through the cloud route lands (chatPermissionMode=bypass + a bypass:true tab)', put4.status === 200, `GET ${got.status} gen=${gen}; PUT ${put4.status} ${short(put4.text, 300)}`);
  const cloudRoster = JSON.parse(read(mv, '_dream_context/state/.agent-sessions.json'));
  check('the cloud copy of the roster now holds bypass (precondition for case 4)', cloudRoster.chatPermissionMode === 'bypass' && cloudRoster.sessions.some((s) => s.sessionId === S4 && s.bypass === true), short(cloudRoster));

  // Case 9a: divergence: the laptop moves a ref of acme-payments while away; the phone commits too.
  put(M(PAY), 'ledger.ts', 'export const ledger = ["phone"];\n');
  git(M(PAY), ['commit', '-qam', 'payments: phone entry']);
  git(M(PAY), ['branch', 'phone/refund']);
  put(PAY, 'ledger.ts', 'export const ledger = ["laptop"];\n');
  git(PAY, ['commit', '-qam', 'payments: laptop entry while away']);
  const payBefore = gitState(PAY);
  const payFilesBefore = treeShas(PAY);
  const payCloudMain = git(M(PAY), ['rev-parse', 'refs/heads/main']).trim();
  // Case 9b: per-path working-tree conflict in atlas-mobile.
  put(M(ATLAS), 'src/app.ts', 'export const app = "cloud";\n');
  put(M(ATLAS), 'src/other.ts', 'export const other = "cloud";\n');
  git(M(ATLAS), ['commit', '-qam', 'atlas: phone edits']);
  put(ATLAS, 'src/app.ts', 'export const app = "laptop-unsaved";\n');
  // Case 5: case-only rename + case/NFC-NFD collisions (index-only entries, as a hostile or
  // case-sensitive cloud would produce them).
  git(M(ATLAS), ['mv', 'docs/Changelog.md', 'docs/changelog-tmp.md']);
  git(M(ATLAS), ['mv', 'docs/changelog-tmp.md', 'docs/CHANGELOG.md']);
  const blobA = git(M(ATLAS), ['hash-object', '-w', '--stdin'], { input: 'LOGO upper\n' }).trim();
  const blobB = git(M(ATLAS), ['hash-object', '-w', '--stdin'], { input: 'logo lower\n' }).trim();
  const indexed = git(ATLAS, ['ls-files', 'notes']).trim(); // the spelling git stored at go
  const otherSpelling = indexed.normalize('NFC') === indexed ? NFD : NFC;
  const blobC = git(M(ATLAS), ['hash-object', '-w', '--stdin'], { input: 'cloud other-normalization spelling\n' }).trim();
  git(M(ATLAS), ['update-index', '--add', '--cacheinfo', `100644,${blobA},assets/Logo.svg`]);
  git(M(ATLAS), ['update-index', '--add', '--cacheinfo', `100644,${blobB},assets/logo.svg`]);
  git(M(ATLAS), ['update-index', '--add', '--cacheinfo', `100644,${blobC},${otherSpelling}`]);
  git(M(ATLAS), ['commit', '-qm', 'atlas: phone rename + colliding names']);
  git(M(ATLAS), ['checkout', '-q', '--', '.'], { allowFail: true });
  const atlasNfBytes = read(ATLAS, indexed);
  // Unborn repo: the phone makes its first commit.
  git(M(NOTES), ['add', 'idea.md']);
  git(M(NOTES), ['commit', '-qm', 'notes: first commit on the phone']);

  // ── Return ─────────────────────────────────────────────────────────────────────────
  section('Trip 1 · return');
  const cloudAtQuiesce = { vault: gitState(mv), notes: gitState(M(NOTES)), atlas: gitState(M(ATLAS)) };
  const cloudVaultNonGit = nonGitSet(mv, { noSession: true });
  const r = call('return');
  if (!check('return succeeds and the laptop is home', r.ok && r.value.outcome === 'home' && state().trip.phase === 'home', errOf(r) ?? r.value.outcome)) return;
  const rc = r.value.receipt;
  recordFinalization('trip 1', rc);
  writeFileSync(join(SCRATCH, 'trip1-receipt.json'), JSON.stringify(rc, null, 2));

  section('Case 1 · after return (AC7)');
  for (const [name, repo, cloud] of [['acme-storefront', VAULT, cloudAtQuiesce.vault], ['field-notes (was unborn)', NOTES, cloudAtQuiesce.notes]]) {
    const d = diffState(gitState(repo), cloud);
    check(`after return, ${name}: HEAD, refs, stash list (sha + message), indexTree, worktreeTree and status equal the cloud's at quiesce`, d.length === 0, d.join('\n') || gitState(repo).head);
  }
  const st = gitState(VAULT).stash.split('\n').filter(Boolean);
  check('the stash list came home with 3 entries, newest = the phone\'s, messages intact', st.length === 3 && / phone: readme stash$/.test(st[0]) && st.some((l) => / wip: checkout returns two$/.test(l)), st.join(' | '));
  check('the branch created on the phone exists on the laptop at the cloud\'s sha', git(VAULT, ['rev-parse', 'refs/heads/phone/hotfix']).trim() === git(mv, ['rev-parse', 'refs/heads/phone/hotfix']).trim());
  check('laptop refs were backed up under refs/handsfree/backup/<trip>/* before the update (AC9)', git(VAULT, ['for-each-ref', '--format=%(refname)', `refs/handsfree/backup/${trip}/`]).includes(`refs/handsfree/backup/${trip}/heads/main`), git(VAULT, ['for-each-ref', '--format=%(refname)', `refs/handsfree/backup/${trip}/`]).split('\n').slice(0, 4).join(' '));

  section('Case 2 · an ignored task file edited on both sides');
  const fr = rc.files.find((f) => f.path === VAULT);
  const conflictCopy = filesIn(join(tripDir(trip), 'conflicts')).find((p) => p.endsWith('rework-the-checkout-flow.md'));
  check('the laptop keeps its own copy', read(VAULT, '_dream_context/state/rework-the-checkout-flow.md').equals(laptopTask));
  check('the cloud copy is in trips/<trip>/conflicts/', !!conflictCopy && readFileSync(join(tripDir(trip), 'conflicts', conflictCopy)).equals(cloudTask), conflictCopy ?? `conflicts dir: ${filesIn(join(tripDir(trip), 'conflicts')).join(', ')}`);
  check('the receipt lists it', !!fr?.conflicts.some((c) => c.path === '_dream_context/state/rework-the-checkout-flow.md'), short(fr?.conflicts));

  section('Case 4 · bypass never comes home (AC8)');
  const lr = JSON.parse(read(VAULT, '_dream_context/state/.agent-sessions.json'));
  check('the laptop keeps its own chatPermissionMode (auto), not the cloud\'s bypass', lr.chatPermissionMode === 'auto', `laptop roster chatPermissionMode=${lr.chatPermissionMode}`);
  const s4 = lr.sessions.find((s) => s.sessionId === S4);
  check('the cloud-only roster entry lands with bypass:false', !!s4 && s4.bypass === false, short(s4 ?? lr.sessions));

  section('Case 5 · case-only rename + NFC/NFD on APFS');
  const docs = readdirSync(join(ATLAS, 'docs'));
  check('the case-only rename landed as the new spelling (one file, CHANGELOG.md, same content)', docs.length === 1 && docs[0] === 'CHANGELOG.md' && read(ATLAS, 'docs/CHANGELOG.md').toString() === '# Changelog\n- first\n', `docs/: ${docs.join(', ')}`);
  const ar = rc.repos.find((x) => x.path === ATLAS);
  const listed = [...(ar?.conflicts ?? []), ...(ar?.refused ?? [])].map((c) => c.path);
  check('the case collision (assets/Logo.svg vs assets/logo.svg) goes to conflicts, nothing overwritten', listed.some((p) => /assets\/logo\.svg/i.test(p)) && (!exists(join(ATLAS, 'assets')) || readdirSync(join(ATLAS, 'assets')).length <= 1),
    `listed=${short(listed)} assets/=${exists(join(ATLAS, 'assets')) ? readdirSync(join(ATLAS, 'assets')).join(',') : '(none)'}`);
  check('the NFC/NFD collision goes to conflicts and the laptop\'s file keeps its bytes', listed.some((p) => p.normalize('NFC') === NFC.normalize('NFC')) && read(ATLAS, indexed).equals(atlasNfBytes),
    `listed=${short(listed)} laptop bytes=${JSON.stringify(read(ATLAS, indexed).toString())}`);

  section('Case 7 · links (D18/D19/D20)');
  check('the laptop\'s escaping link was never deleted (same target)', exists(join(VAULT, '_dream_context/state/escape-link')) && readlinkSync(join(VAULT, '_dream_context/state/escape-link')) === '../../../../../../outside-target.txt');
  check('links the cloud added that escape the root are never written on the laptop', !exists(join(VAULT, '_dream_context/state/phone-abs-link')) && !exists(join(VAULT, '_dream_context/state/phone-climb-link')),
    `abs=${exists(join(VAULT, '_dream_context/state/phone-abs-link'))} climb=${exists(join(VAULT, '_dream_context/state/phone-climb-link'))} refused=${short(fr?.refused)}`);
  check('the refused links are listed in the receipt', ['phone-abs-link', 'phone-climb-link'].every((n) => (fr?.refused ?? []).some((c) => c.path.endsWith(n)) || rc.links.some((l) => [...l.undone, ...l.escaping].some((p) => p.endsWith(n)))), short({ refused: fr?.refused, links: rc.links }));
  check('a link inside the root lands', exists(join(VAULT, '_dream_context/state/phone-good-link')) && readlinkSync(join(VAULT, '_dream_context/state/phone-good-link')) === 'rework-the-checkout-flow.md');

  section('Case 9 · divergence and per-path conflicts (AC8)');
  const pr = rc.repos.find((x) => x.path === PAY);
  const payAfter = gitState(PAY);
  check('acme-payments (laptop moved main while away) is parked', pr?.outcome === 'parked', short({ outcome: pr?.outcome, reasons: pr?.parkReasons }));
  check('the parked repo is untouched: refs, HEAD, stash, trees, status and every file equal what the laptop had', diffState(payAfter, payBefore).length === 0 && diffMaps(treeShas(PAY), payFilesBefore).filter((l) => !l.startsWith('.git/')).length === 0, diffState(payAfter, payBefore).join('\n'));
  const parked = git(PAY, ['for-each-ref', '--format=%(objectname) %(refname)', `refs/handsfree/${trip}/`]);
  check('the cloud\'s refs are parked under refs/handsfree/<trip>/* (cloud main + the phone\'s branch)', parked.includes(`${payCloudMain} refs/handsfree/${trip}/heads/main`) && parked.includes(`refs/handsfree/${trip}/heads/phone/refund`), parked.trim().split('\n').slice(0, 6).join(' | '));
  check('atlas-mobile: the laptop keeps its unsaved src/app.ts', read(ATLAS, 'src/app.ts').toString() === 'export const app = "laptop-unsaved";\n', read(ATLAS, 'src/app.ts').toString());
  const appCopy = filesIn(join(tripDir(trip), 'conflicts')).find((p) => p.endsWith('src/app.ts') || p.endsWith('app.ts'));
  check('atlas-mobile: the cloud\'s src/app.ts is in conflicts, listed in the receipt', !!appCopy && readFileSync(join(tripDir(trip), 'conflicts', appCopy)).toString() === 'export const app = "cloud";\n' && (ar?.conflicts ?? []).some((c) => c.path === 'src/app.ts'), `${appCopy} ${short(ar?.conflicts)}`);
  check('atlas-mobile: a path only the cloud changed lands, and HEAD moved to the cloud\'s', read(ATLAS, 'src/other.ts').toString() === 'export const other = "cloud";\n' && gitState(ATLAS).head === cloudAtQuiesce.atlas.head, `${gitState(ATLAS).head} vs ${cloudAtQuiesce.atlas.head}`);

  section('Case 13 · secrets (AC19, D16, D21a)');
  check('.secrets.json and lab credentials the cloud planted never land: the laptop\'s bytes are unchanged', read(VAULT, '_dream_context/state/.secrets.json').equals(laptopSecrets) && read(VAULT, '_dream_context/lab/credentials.json').equals(laptopLab));
  check('a secret-class file edited in the cloud lands over the laptop\'s (D16)', read(VAULT, '.env').toString() === 'STRIPE_KEY=sk_test_cloud_rotated\n', JSON.stringify(read(VAULT, '.env').toString()));
  const envBackup = Object.entries(treeShas(join(tripDir(trip), 'backup'))).find(([p, h]) => p.endsWith('.env') && h === sha(laptopEnvEdited));
  check('... after the laptop\'s copy was backed up to trips/<trip>/backup/', !!envBackup, envBackup?.[0] ?? filesIn(join(tripDir(trip), 'backup')).filter((p) => p.includes('env')).join(', '));
  const rcText = JSON.stringify(rc);
  check('the receipt lists .env by name and never carries a secret value', (fr?.secrets ?? []).includes('.env') && !/sk_test_|gho_PLANTED|phx_PLANTED|gho_fixture|phx_fixture/.test(rcText), `secrets=${short(fr?.secrets)}`);
  const cloudSecretsLeft = Object.keys(nonGitSet(mv)).filter((p) => /(^|\/)\.env/.test(p));
  check('the secret class is wiped from the cloud before the seal (D21a)', cloudSecretsLeft.length === 0 && !exists(join(mv, '.env')), cloudSecretsLeft.join(', ') || 'no .env in the cloud copy');
  // Every path not already asserted above (case 2 conflict, case 7 links, the secret class).
  const other = (m) => Object.fromEntries(Object.entries(m).filter(([p]) => !/(^|\/)\.env/.test(p) && !/^_dream_context\/state\/(phone-|escape-link$|rework-the-checkout-flow\.md$)/.test(p)));
  const nonGitBack = diffMaps(other(nonGitSet(VAULT, { noSession: true, noSecrets: true })), other(cloudVaultNonGit));
  check('every other non-git file of the vault is sha256-equal to the cloud\'s at quiesce', nonGitBack.length === 0, nonGitBack.join('\n'));

  section('Case 14 · auto-executing config in the receipt (AC20)');
  for (const p of ['.claude/settings.json', '.mcp.json', '.husky/pre-commit', '.claude/settings.local.json']) {
    const e = rc.autoExec.find((a) => a.path === p);
    const needle = { '.claude/settings.json': 'Bash(curl *)', '.mcp.json': 'phone-mcp', '.husky/pre-commit': 'phone-lint', '.claude/settings.local.json': 'rm -rf' }[p];
    check(`the receipt lists ${p} with a plain-text diff`, !!e && e.diff.includes(needle) && !/\x1b\[/.test(e.diff), e ? short(e.diff, 200) : `autoExec paths: ${rc.autoExec.map((a) => a.path).join(', ')}`);
  }
  check('the auto-executing config was applied (D11)', read(VAULT, '.husky/pre-commit').toString().includes('phone-lint') && read(VAULT, '.mcp.json').toString().includes('phone-mcp'));

  // The owner resolves the receipt's case-5 conflicts on the laptop (drops the colliding
  // duplicates the phone's commit brought), so later trips do not inherit a tree that APFS
  // cannot hold (see the report: such a tree can break a later go's equality).
  git(ATLAS, ['rm', '-q', '-r', '--cached', '--ignore-unmatch', 'assets', 'notes']);
  rmSync(join(ATLAS, 'assets'), { recursive: true, force: true });
  rmSync(join(ATLAS, 'notes'), { recursive: true, force: true });
  put(ATLAS, NFC, atlasNfBytes);
  git(ATLAS, ['add', 'notes']);
  git(ATLAS, ['commit', '-qm', 'atlas: resolve the colliding names from the phone']);
  check('(harness) the owner\'s resolution leaves atlas-mobile clean apart from the unsaved src/app.ts', git(ATLAS, ['status', '--porcelain']).trim() === 'M src/app.ts', git(ATLAS, ['status', '--porcelain']));

  section('Trip 1 · finalization');
  check('wipe-secrets, seal and stop all ran', rc.finalization.secretsWiped && rc.finalization.sealed && rc.finalization.stopped, short(rc.finalization));
  check('the fake machine is stopped and its server is down', state().machines.every((m) => m.state === 'stopped') && !existsSync(CLOUD.pidFile), short(state().machines.map((m) => m.state)));
  void before;
}

// ─── trip 2: the phone (cases 3, 10, 15) ────────────────────────────────────────────────

/** `cloud/entrypoint.sh claude-login <id>` minus setpriv: the worker's ensure-sandbox op as the
 *  cloud user with HOME = the mirror root, then the CLI's own login (the stub's is a no-op). */
function cloudClaudeLogin(id) {
  const mirrorHome = M(LH);
  const cd = join(mirrorHome, '.dreamcontext', 'claude-accounts', id);
  const h = Buffer.from(JSON.stringify({ op: 'ensure-sandbox', params: { configDir: cd } }));
  const len = Buffer.alloc(4); len.writeUInt32BE(h.length);
  const devnull = openSync('/dev/null', 'w');
  const r = spawnSync(process.execPath, [CLI, 'cloud', 'worker', 'ensure-sandbox'], {
    input: Buffer.concat([len, h]), stdio: ['pipe', 'pipe', 'pipe', devnull],
    env: { HOME: mirrorHome, USER: 'dcuser', LOGNAME: 'dcuser', SHELL: '/bin/bash', LANG: 'C.UTF-8', PATH: [CLOUD.stubBin, '/usr/bin', '/bin', dirname(process.execPath)].join(':'), DREAMCONTEXT_CLOUD: '1' },
  });
  closeSync(devnull);
  return { status: r.status, stderr: String(r.stderr ?? '').slice(-400), configDir: cd };
}

async function startLaptopDashboard() {
  const port = await freePort();
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: VAULT,
    // Never this session's own DREAMCONTEXT_*/CLAUDE* env: the parent pid is THIS script, and
    // the orphan sweep stays off so the scratch server can never signal anyone's processes.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DREAMCONTEXT_|CLAUDE|GIT_)/.test(k))),
      HOME: LH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: String(process.pid), DREAMCONTEXT_ORPHAN_SWEEP: '0',
      GIT_CONFIG_GLOBAL: join(SCRATCH, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':'),
    },
    stdio: ['ignore', openSync(join(SCRATCH, 'laptop-dashboard.log'), 'a'), openSync(join(SCRATCH, 'laptop-dashboard.log'), 'a')],
    detached: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return { srv, base }; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  try { process.kill(-srv.pid, 'SIGKILL'); } catch { /* gone */ }
  throw new Error('the laptop dashboard did not come up');
}

async function laptopRoster(base) {
  const r = await fetch(`${base}/api/agent/sessions`);
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function laptopRosterPut(base, body) {
  const r = await fetch(`${base}/api/agent/sessions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}

async function trip2() {
  section('Trip 2 · go (the laptop dashboard stays open)');
  const dash = await startLaptopDashboard();
  let browser = null;
  // Smoke #6 (AC5): acme-payments was never opened in Claude on this laptop, so it has NO
  // transcript dir at go; a session the phone starts there must still come home (case 3b).
  const PAY_TRANSCRIPTS = join(PROJECTS, enc(PAY));
  const PAY_SESSION = '6b0f3c2e-7d1a-4e5b-9c8d-0a1b2c3d4e5f';
  const payDirAtGo = existsSync(PAY_TRANSCRIPTS);
  try {
    const g = goTrip();
    if (!check('go succeeds', g.ok, errOf(g))) return;
    const trip = g.value.tripId;
    pointMirrorVaultsAtMirror();
    for (const id of ['kerem-main', 'kerem-work']) {
      const l = cloudClaudeLogin(id);
      check(`cloud claude-login for ${id} (the entrypoint's ensure-sandbox through the worker) succeeds`, l.status === 0, l.stderr || l.configDir);
    }

    // ── Case 10: a laptop tab click while away ──────────────────────────────────────
    section('Case 10 · a laptop tab click while away (AC5) — through the laptop dashboard server in the scratch HOME');
    const rosterFileBefore = read(VAULT, '_dream_context/state/.agent-sessions.json');
    const lr0 = await laptopRoster(dash.base);
    const click = await laptopRosterPut(dash.base, { baseGeneration: lr0.json?.generation, sessions: [...(lr0.json?.sessions ?? []).map(({ bound: _b, ...s }) => s), { title: 'Laptop click while away', bypass: false, minimized: false, size: 1, kind: 'chat' }], chatPermissionMode: 'auto' });
    check('a roster PUT to the laptop server while away is refused', click.status >= 400 && click.status !== 404, `PUT ${click.status} ${short(click.text, 300)}`);
    check('... and the laptop roster file is untouched', read(VAULT, '_dream_context/state/.agent-sessions.json').equals(rosterFileBefore));

    // ── Case 15: the REAL mobile chat against the fake cloud ────────────────────────
    section('Case 15 · the real mobile chat (iPhone viewport) against the cloud');
    const { chromium, devices } = await import('playwright');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    const apiHits = [];
    const bad = [];
    page.on('response', async (resp) => {
      let u;
      try { u = new URL(resp.url()); } catch { return; }
      if (!u.pathname.startsWith('/api/')) return;
      const hit = { method: resp.request().method(), path: u.pathname, status: resp.status() };
      apiHits.push(hit);
      if (hit.status >= 400) {
        let body = '';
        try { body = (await resp.text()).slice(0, 200); } catch { /* gone */ }
        bad.push({ ...hit, body });
      }
    });
    const sockets = [];
    page.on('websocket', (ws) => {
      const rec = { url: new URL(ws.url()).pathname, closed: false, frames: 0 };
      sockets.push(rec);
      ws.on('framereceived', () => { rec.frames++; });
      ws.on('close', () => { rec.closed = true; });
    });
    await page.goto(`${ORIGIN}/api/health`);
    const loginStatus = await page.evaluate(async (pp) => (await fetch('/api/handsfree/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: pp }) })).status, PASSPHRASE);
    const cookie = (await ctx.cookies()).find((c) => c.name === '__Host-dc_hf_session');
    check('the phone browser signs a device in (POST /api/handsfree/login from the page -> 200, device cookie stored)', loginStatus === 200 && !!cookie, `status=${loginStatus} cookie=${cookie ? `${cookie.name} httpOnly=${cookie.httpOnly} secure=${cookie.secure} sameSite=${cookie.sameSite}` : 'NOT STORED'}`);
    // Case 3: new sessions start on the NON-default account (through the phone's own API).
    const pref = await page.evaluate(async () => { const r = await fetch('/api/agent/accounts/preferred', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'kerem-work' }) }); return { status: r.status, text: await r.text() }; });
    check('the phone makes kerem-work (account B) the preferred account (POST /api/agent/accounts/preferred)', pref.status === 200, `status ${pref.status} ${short(pref.text, 300)}`);
    await page.goto(`${ORIGIN}/?vault=acme-storefront`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const gotIt = page.getByRole('button', { name: /^Got it$/ });
    if (await gotIt.count()) { await gotIt.first().click({ force: true }).catch(() => {}); await page.waitForTimeout(500); }
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };
    const mobile = await page.evaluate(() => matchMedia('(max-width: 768px)').matches && matchMedia('(pointer: coarse)').matches);
    check('the page is genuinely the phone layout (narrow AND coarse pointer)', mobile);
    // A NEW chat for this message, so it is a session started on the phone under account B.
    const burger = page.locator('.mchat-head-btn[aria-label="Sessions"]:visible').first();
    if (await burger.count()) {
      await burger.tap().catch(() => {});
      await page.waitForTimeout(500);
      const newChat = page.locator('.mchat-new:visible').first();
      if (await newChat.count()) await newChat.tap().catch(() => {});
      await page.waitForTimeout(1500);
    }
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).first().click().catch(() => {});
    const live = await until(async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 25000);
    check('a chat pane is live on the phone', live);
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click().catch(() => {});
    await input.fill('Price test: is the coupon live?').catch(() => {});
    await input.press('Enter').catch(() => {});
    const replied = await until(async () => (await page.getByText('Roundtrip stub reply: the cloud heard you.').count()) > 0, 30000);
    await page.screenshot({ path: join(SCRATCH, 'phone-chat.png') }).catch(() => {});
    check('sending a message gets the stub claude\'s reply on the phone', replied, `screenshot ${join(SCRATCH, 'phone-chat.png')}`);
    await page.waitForTimeout(2500); // the client's debounced roster PUT
    // The chat's claude spawns when the pane opens (before the send): find the one whose
    // transcript holds this message.
    const spawns = existsSync(SPAWN_LOG) ? readFileSync(SPAWN_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const turn = spawns.find((s) => s.session && existsSync(join(M(VAULT_TRANSCRIPTS), `${s.session}.jsonl`)) && readFileSync(join(M(VAULT_TRANSCRIPTS), `${s.session}.jsonl`), 'utf8').includes('Price test'));
    check('the phone\'s turn ran under account B (CLAUDE_CONFIG_DIR = kerem-work\'s cloud sandbox) and wrote its transcript into the shared transcripts dir',
      !!turn && turn.configDir === join(M(LH), '.dreamcontext', 'claude-accounts', 'kerem-work'),
      `spawns=${short(spawns.map((s) => ({ configDir: s.configDir?.replace(CLOUD.mirror, '<mirror>'), session: s.session, err: s.transcriptError })), 500)}`);
    const sid = turn?.session ?? null;
    // The phone owner renames the tab (the title AC5 wants on the laptop).
    const phone = new Phone(ORIGIN);
    phone.cookie = cookie?.value ?? null;
    const cur = await phone.req('GET', '/api/agent/sessions', undefined, { vault: 'acme-storefront' });
    const inRoster = (cur.json?.sessions ?? []).some((s) => s.sessionId === sid);
    check('the real mobile client put the new session into the cloud roster', inRoster, `GET ${cur.status} sessions=${short((cur.json?.sessions ?? []).map((s) => `${s.title}:${s.sessionId}`))}`);
    const renamed = await phone.req('PUT', '/api/agent/sessions', {
      baseGeneration: cur.json?.generation ?? 0,
      sessions: (cur.json?.sessions ?? []).map(({ bound: _b, ...s }) => (s.sessionId === sid ? { ...s, title: 'Phone: price test' } : s)),
      chatPermissionMode: cur.json?.chatPermissionMode ?? 'auto',
    }, { vault: 'acme-storefront' });
    check('the phone renames that tab through the roster route', renamed.status === 200, `PUT ${renamed.status} ${short(renamed.text, 200)}`);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
    const ws = sockets.filter((s) => s.url === '/api/agent/chat');
    check('the chat WebSocket opened and streamed frames', ws.length > 0 && ws.some((s) => s.frames > 0), short(sockets));
    const distinct = (list) => {
      const m = new Map();
      for (const b of list) {
        const code = (() => { try { return JSON.parse(b.body).error; } catch { return b.body.slice(0, 60); } })();
        const k = `${b.method} ${b.path} -> ${b.status} ${code}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m].map(([k, n]) => `${k}${n > 1 ? ` (x${n})` : ''}`).sort();
    };
    const forbidden = bad.filter((b) => b.status === 403);
    check('the mobile chat hit NO 403 (cloud_unavailable or otherwise) on any /api route', forbidden.length === 0,
      forbidden.length ? `${distinct(forbidden).length} distinct 403 routes:\n${distinct(forbidden).join('\n')}` : `${apiHits.length} API responses, distinct paths: ${[...new Set(apiHits.map((h) => `${h.method} ${h.path}`))].join(', ')}`);
    check('the mobile chat hit no other non-2xx API response', bad.filter((b) => b.status !== 403).length === 0, distinct(bad.filter((b) => b.status !== 403)).join('\n') || 'none');
    writeFileSync(join(SCRATCH, 'phone-api-hits.json'), JSON.stringify({ apiHits, bad, sockets }, null, 2));
    await browser.close();
    browser = null;

    // ── Return ───────────────────────────────────────────────────────────────────────
    // Case 3b: the phone's claude starts a session in acme-payments (written into the cloud copy,
    // see SEAM LIMITS); its cwd names another folder, which must never choose the destination.
    put(M(PAY_TRANSCRIPTS), `${PAY_SESSION}.jsonl`, JSON.stringify({ type: 'user', cwd: join(LH, 'projects', 'not-in-trip'), sessionId: PAY_SESSION, message: { role: 'user', content: 'Ledger on the phone' } }) + '\n');
    const payCloudTranscript = read(M(PAY_TRANSCRIPTS), `${PAY_SESSION}.jsonl`);

    section('Trip 2 · return');
    const cloudTranscript = sid ? read(M(VAULT_TRANSCRIPTS), `${sid}.jsonl`) : null;
    const r = call('return');
    if (!check('return succeeds and the laptop is home', r.ok && r.value.outcome === 'home', errOf(r) ?? r.value.outcome)) return;
    recordFinalization('trip 2', r.value.receipt);

    section('Case 3 · a phone session under account B comes home with history and title (AC5)');
    const lt = sid ? join(VAULT_TRANSCRIPTS, `${sid}.jsonl`) : null;
    check('its transcript is on the laptop, byte-equal to the cloud\'s (history)', !!lt && existsSync(lt) && readFileSync(lt).equals(cloudTranscript) && readFileSync(lt, 'utf8').includes('Price test'), lt ?? 'no session id');
    const lroster = JSON.parse(read(VAULT, '_dream_context/state/.agent-sessions.json'));
    const ent = lroster.sessions.find((s) => s.sessionId === sid);
    check('the laptop roster has the session with its phone title', ent?.title === 'Phone: price test', short(ent ?? lroster.sessions.map((s) => s.title)));
    const titles = existsSync(join(CTX, 'state', '.session-titles.json')) ? readFileSync(join(CTX, 'state', '.session-titles.json'), 'utf8') : '';
    check('the title store (.session-titles.json) carries it', !!sid && titles.includes(sid) && titles.includes('Phone: price test'), short(titles, 300));
    const sess = r.value.receipt?.sessions?.find((x) => x.rootId && x.roster);
    check('the receipt lists the session opened on the phone', !!sess?.roster?.openedOnPhone?.includes('Phone: price test'), short(r.value.receipt?.sessions));

    section('Case 3b · a phone session in a root with NO laptop transcript dir at go comes home (smoke #6, AC5)');
    check('precondition: acme-payments had no transcript dir on the laptop at go', !payDirAtGo, PAY_TRANSCRIPTS);
    const payLt = join(PAY_TRANSCRIPTS, `${PAY_SESSION}.jsonl`);
    check('Return created the dir and the transcript is on the laptop, byte-equal to the cloud\'s', existsSync(payLt) && readFileSync(payLt).equals(payCloudTranscript), payLt);
    const payRec = r.value.receipt?.files?.find((f) => f.path === PAY_TRANSCRIPTS);
    check('the receipt lists it under that dir', !!payRec?.written?.includes(`${PAY_SESSION}.jsonl`), short(payRec ?? r.value.receipt?.files?.map((f) => f.path)));
    check('its cwd (another folder) chose nothing: no dir for it was created', !existsSync(join(PROJECTS, enc(join(LH, 'projects', 'not-in-trip')))));

    section('Case 10 · after Return the laptop server serves the phone\'s sessions (AC5)');
    const lr1 = await laptopRoster(dash.base);
    check('GET /api/agent/sessions on the laptop server holds the phone\'s session', (lr1.json?.sessions ?? []).some((s) => s.sessionId === sid && s.title === 'Phone: price test'), short((lr1.json?.sessions ?? []).map((s) => s.title)));
    const stale = await laptopRosterPut(dash.base, { baseGeneration: lr0.json?.generation, sessions: (lr0.json?.sessions ?? []).map(({ bound: _b, ...s }) => s), chatPermissionMode: 'auto' });
    check('a tab that still holds the pre-trip roster gets 409 (it must re-hydrate, never overwrite the phone\'s sessions)', stale.status === 409, `PUT ${stale.status} with base ${lr0.json?.generation}; now ${lr1.json?.generation}`);
    check('... and the phone\'s session is still in the roster file', JSON.parse(read(VAULT, '_dream_context/state/.agent-sessions.json')).sessions.some((s) => s.sessionId === sid));
    void trip;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { process.kill(-dash.srv.pid, 'SIGTERM'); } catch { /* gone */ }
  }
}

// ─── trips 3-4: crash-resume, run lock, roll back (case 8, AC11) ────────────────────────

const REPOS = () => [['acme-storefront', VAULT], ['acme-payments', PAY], ['atlas-mobile', ATLAS], ['field-notes', NOTES]];

/** Everything Roll back must restore, byte for byte: every ref (refs/handsfree/* aside, the
 *  Return's own bookkeeping), HEAD, stash, both trees, status, every working-tree file, the
 *  full non-git set (secrets and session state included) and the transcripts. */
function laptopSnapshot() {
  const out = {};
  for (const [name, repo] of REPOS()) {
    const st = gitState(repo);
    const allRefs = git(repo, ['for-each-ref', '--format=%(objectname) %(refname)']).split('\n').filter((l) => l && !l.includes(' refs/handsfree/')).join('\n');
    const files = Object.fromEntries(Object.entries(treeShas(repo)).filter(([p]) => !p.startsWith('.git/') && p !== '.git'));
    out[name] = { ...st, allRefs, files };
  }
  out.transcripts = treeShas(VAULT_TRANSCRIPTS);
  return out;
}
function diffSnapshots(a, b) {
  const out = [];
  for (const k of Object.keys(a)) {
    if (k === 'transcripts') { out.push(...diffMaps(a[k], b[k]).map((l) => `transcripts ${l}`)); continue; }
    out.push(...diffState(a[k], b[k], ['head', 'allRefs', 'stash', 'indexTree', 'worktreeTree', 'status']).map((l) => `${k} ${l}`));
    out.push(...diffMaps(a[k].files, b[k].files).map((l) => `${k} file ${l}`));
  }
  return out;
}

/** Phone work for trips 3/4: git (commit, branch, stash, staged, untracked) and non-git files. */
function phoneWorks(tag) {
  const mv = M(VAULT);
  put(mv, `src/${tag}.ts`, `export const ${tag.replace(/-/g, '_')} = 1;\n`);
  git(mv, ['add', `src/${tag}.ts`]);
  git(mv, ['commit', '-qm', `phone: ${tag}`]);
  git(mv, ['branch', `phone/${tag}`]);
  put(mv, 'src/checkout.ts', `export function checkout() { return "${tag}"; }\n`);
  git(mv, ['stash', 'push', '-q', '-m', `phone: ${tag} stash`]);
  put(mv, 'src/cart.ts', `export const cart = ["${tag}"];\n`);
  git(mv, ['add', 'src/cart.ts']);
  put(mv, `src/${tag}-untracked.ts`, 'export {};\n');
  put(mv, `_dream_context/state/${tag}-notes.md`, `# notes written on the phone (${tag})\n`);
  put(mv, '_dream_context/state/rework-the-checkout-flow.md', `---\nstatus: in_progress\n---\n# Rework the checkout flow\n\n- ${tag} from the phone\n`);
  put(mv, '.env', `STRIPE_KEY=sk_test_${tag.replace(/-/g, '_')}\n`);
  put(M(PAY), 'ledger.ts', `export const ledger = ["${tag}"];\n`);
  git(M(PAY), ['commit', '-qam', `payments: ${tag}`]);
}

async function trip3() {
  section('Case 8a · crash mid-Return, then Resume (AC11)');
  const g = goTrip();
  if (!check('go succeeds', g.ok, errOf(g))) return;
  phoneWorks('crash-resume');
  const cloud = { vault: gitState(M(VAULT)), pay: gitState(M(PAY)) };
  const cloudNon = nonGitSet(M(VAULT), { noSession: true });
  rmSync(join(SCRATCH, 'kill-count-files.apply'), { force: true });
  rmSync(join(SCRATCH, 'killed-at.json'), { force: true });
  const killed = call('return', {}, { killAt: 'files.apply#1' });
  const at = existsSync(join(SCRATCH, 'killed-at.json')) ? JSON.parse(readFileSync(join(SCRATCH, 'killed-at.json'), 'utf8')) : null;
  check('the laptop process is SIGKILLed mid-journal (before the first files.apply, after the git writes)', !killed.ok && (killed.killed || killed.status === 137) && at?.kind === 'files.apply', `exit=${killed.status ?? killed.signal} at=${short(at)}`);
  const st = call('status');
  check('after the crash the laptop is returning and offers ONLY Resume or Roll back', st.ok && st.value.phase === 'returning' && JSON.stringify(st.value.offers) === JSON.stringify(['resume', 'rollback']), short({ phase: st.value?.phase, offers: st.value?.offers, journal: st.value?.journal }));
  // Run lock: a Resume holds the lock (paused inside its journal); a second Return and a Go are refused.
  rmSync(join(SCRATCH, 'paused.json'), { force: true });
  rmSync(join(SCRATCH, 'release'), { force: true });
  const resuming = driverAsync('resume', {}, { pauseAt: 'files.apply' });
  const end = Date.now() + 120_000;
  while (!existsSync(join(SCRATCH, 'paused.json')) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  const second = call('return');
  check('a second concurrent Return is refused by the per-trip run lock', !second.ok && second.error?.code === 'busy', errOf(second) ?? 'it ran');
  const secondGo = call('go', { contextRoot: CTX });
  check('a concurrent Go is refused too', !secondGo.ok && ['busy', 'not_home'].includes(secondGo.error?.code), errOf(secondGo) ?? 'it ran');
  writeFileSync(join(SCRATCH, 'release'), '1');
  const res = await resuming;
  rmSync(join(SCRATCH, 'paused.json'), { force: true });
  rmSync(join(SCRATCH, 'release'), { force: true });
  check('Resume completes the Return from the journal: home', res.ok && res.value.outcome === 'home' && state().trip.phase === 'home', errOf(res) ?? res.value.outcome);
  if (!res.ok) return;
  recordFinalization('trip 3 (resumed)', res.value.receipt);
  for (const [name, repo, c] of [['acme-storefront', VAULT, cloud.vault]]) {
    const d = diffState(gitState(repo), c);
    check(`nothing lost: ${name} equals the cloud at quiesce (HEAD, refs, stash, trees, status)`, d.length === 0, d.join('\n'));
  }
  const back = diffMaps(
    Object.fromEntries(Object.entries(nonGitSet(VAULT, { noSession: true })).filter(([p]) => p !== '_dream_context/state/rework-the-checkout-flow.md' && !p.startsWith('_dream_context/state/escape-link') && !p.startsWith('_dream_context/state/phone-'))),
    Object.fromEntries(Object.entries(cloudNon).filter(([p]) => p !== '_dream_context/state/rework-the-checkout-flow.md' && !/(^|\/)\.env$/.test(p) && !p.startsWith('_dream_context/state/phone-'))),
  ).filter((l) => !l.startsWith('.env:'));
  check('nothing lost: the non-git files the phone wrote are sha256-equal on the laptop', back.length === 0 && read(VAULT, '.env').toString() === 'STRIPE_KEY=sk_test_crash_resume\n', back.join('\n') || 'equal');
  check('acme-payments (no laptop change this trip) fast-forwards to the cloud\'s main', git(PAY, ['rev-parse', 'HEAD']).trim() === cloud.pay.head.split(' @ ')[1], `${git(PAY, ['rev-parse', 'HEAD']).trim()} vs ${cloud.pay.head}`);
}

async function trip4() {
  section('Case 8b · Roll back restores refs, trees and backed-up non-git files byte for byte (AC11)');
  const g = goTrip();
  if (!check('go succeeds', g.ok, errOf(g))) return;
  phoneWorks('rolled-back');
  const pre = laptopSnapshot();
  const preNonGit = nonGitSet(VAULT);
  rmSync(join(SCRATCH, 'kill-count-git.base'), { force: true });
  rmSync(join(SCRATCH, 'killed-at.json'), { force: true });
  // git.base is the last op of every Return pass: every write before it is done.
  const killed = call('return', {}, { killAt: 'git.base#1' });
  const at = existsSync(join(SCRATCH, 'killed-at.json')) ? JSON.parse(readFileSync(join(SCRATCH, 'killed-at.json'), 'utf8')) : null;
  const mid = laptopSnapshot();
  check('the Return is killed after it wrote refs, trees and non-git files', !killed.ok && at?.kind === 'git.base' && diffSnapshots(pre, mid).length > 0, `${diffSnapshots(pre, mid).length} differences mid-return; killed at ${short(at)}`);
  const rb = call('rollback');
  check('Roll back succeeds and the laptop is away again (lock held)', rb.ok && state().trip.phase === 'away', errOf(rb) ?? `undone ${rb.value.undone.length} ops, kept ${short(rb.value.kept)}`);
  const after = laptopSnapshot();
  const d = diffSnapshots(pre, after);
  check('every ref, HEAD, stash entry, index/worktree tree, status and working-tree file is back byte for byte', d.length === 0, d.slice(0, 20).join('\n'));
  const dn = diffMaps(preNonGit, nonGitSet(VAULT));
  check('every non-git file (secret class and session state included) is back byte for byte', dn.length === 0, dn.join('\n'));
  check('the cloud was sent quiescing -> active', rb.ok && rb.value.cloudUnquiesced === true, short(rb.value));
  const h = call('cloud-health');
  check('... and reports active, so the phone can continue', h.ok && h.value.phase === 'active', short(h.value ?? errOf(h)));
  const cloud = gitState(M(VAULT));
  const r = call('return');
  check('a Return after the Roll back completes', r.ok && r.value.outcome === 'home', errOf(r) ?? r.value.outcome);
  if (r.ok) recordFinalization('trip 4 (after roll back)', r.value.receipt);
  const d2 = diffState(gitState(VAULT), cloud);
  check('... and the vault then equals the cloud at quiesce', d2.length === 0, d2.join('\n'));
}

// ─── trip 5: a cloud merge in progress / a stale lock at Return (case 12a, AC13) ────────

async function trip5() {
  section('Case 12a · a cloud merge in progress at Return cancels back to active (AC13)');
  const g = goTrip();
  if (!check('go succeeds', g.ok, errOf(g))) return;
  const mv = M(VAULT);
  const base = git(mv, ['symbolic-ref', '--short', 'HEAD']).trim();
  git(mv, ['stash', 'push', '-q', '-m', 'phone: park local edits before the merge']);
  git(mv, ['checkout', '-q', '-b', 'phone/conflict']);
  put(mv, 'README.md', '# acme-storefront\n\nbranch side\n');
  git(mv, ['commit', '-qam', 'phone: branch side']);
  git(mv, ['checkout', '-q', base]);
  put(mv, 'README.md', '# acme-storefront\n\nmain side\n');
  git(mv, ['commit', '-qam', 'phone: main side']);
  git(mv, ['merge', 'phone/conflict'], { allowFail: true });
  check('precondition: the cloud copy has a merge in progress', existsSync(join(mv, '.git', 'MERGE_HEAD')));
  const laptopBefore = laptopSnapshot();
  const r = call('return');
  check('the Return is refused with a message to resolve it on the phone', !r.ok && r.error?.code === 'cloud_preflight' && /resolve it on the phone/.test(r.error.message), errOf(r) ?? 'it returned');
  check('the laptop is back to away and untouched', state().trip.phase === 'away' && diffSnapshots(laptopBefore, laptopSnapshot()).length === 0, `${state().trip.phase}; ${diffSnapshots(laptopBefore, laptopSnapshot()).slice(0, 5).join(' | ')}`);
  const h = call('cloud-health');
  check('the cloud is active again (the phone can resolve it)', h.ok && h.value.phase === 'active', short(h.value ?? errOf(h)));
  // The phone resolves the merge; then a stale index.lock blocks the next Return.
  git(mv, ['merge', '--abort']);
  writeFileSync(join(mv, '.git', 'index.lock'), '');
  const r2 = call('return');
  check('a stale .git/index.lock in the cloud also cancels the Return back to active', !r2.ok && r2.error?.code === 'cloud_preflight' && state().trip.phase === 'away', errOf(r2) ?? 'it returned');
  rmSync(join(mv, '.git', 'index.lock'), { force: true });
  const cloud = gitState(mv);
  const r3 = call('return');
  check('once resolved on the phone, the Return completes', r3.ok && r3.value.outcome === 'home', errOf(r3) ?? r3.value.outcome);
  if (r3.ok) recordFinalization('trip 5', r3.value.receipt);
  const d = diffState(gitState(VAULT), cloud);
  check('... and the vault equals the cloud at quiesce', d.length === 0, d.join('\n'));
}

// ─── trips 6-7: abandon, then recovery before the next trip (cases 11, 12b; AC14) ───────

async function trip6and7() {
  section('Case 11 · abandon never deletes cloud work; the next go recovers it first (AC14)');
  const g = goTrip();
  if (!check('go succeeds', g.ok, errOf(g))) return;
  const old = g.value.tripId;
  const mv = M(VAULT);
  put(mv, 'src/abandoned.ts', 'export const abandoned = "phone work";\n');
  git(mv, ['add', 'src/abandoned.ts']);
  git(mv, ['commit', '-qm', 'phone: work that was abandoned']);
  const phoneMain = git(mv, ['rev-parse', 'HEAD']).trim();
  put(mv, '_dream_context/state/abandoned-notes.md', '# written on the phone before the abandon\n');
  // Case 12b: a merge in progress in atlas-mobile at the abandon (tolerant recovery).
  const ma = M(ATLAS);
  const abase = git(ma, ['symbolic-ref', '--short', 'HEAD']).trim();
  git(ma, ['stash', 'push', '-q', '-m', 'phone: atlas wip']);
  git(ma, ['checkout', '-q', '-b', 'phone/atlas-side']);
  put(ma, 'src/other.ts', 'export const other = "atlas side";\n');
  git(ma, ['commit', '-qam', 'phone: atlas side']);
  git(ma, ['checkout', '-q', abase]);
  put(ma, 'src/other.ts', 'export const other = "atlas main";\n');
  git(ma, ['commit', '-qam', 'phone: atlas main']);
  git(ma, ['merge', 'phone/atlas-side'], { allowFail: true });
  const mergeHead = existsSync(join(ma, '.git', 'MERGE_HEAD')) ? readFileSync(join(ma, '.git', 'MERGE_HEAD'), 'utf8').trim() : null;
  check('precondition: atlas-mobile\'s cloud copy has a merge in progress with conflict markers', !!mergeHead && read(ma, 'src/other.ts').toString().includes('<<<<<<<'));
  const laptopBefore = laptopSnapshot();
  const ab = call('abandon');
  check('abandon unlocks the laptop at once (home) and seals the cloud without touching its content', ab.ok && state().trip.phase === 'home' && ab.value.cloudSealed === true && git(mv, ['rev-parse', 'HEAD']).trim() === phoneMain && existsSync(join(mv, '_dream_context/state/abandoned-notes.md')),
    errOf(ab) ?? short(ab.value));
  check('the laptop is untouched by the abandon', diffSnapshots(laptopBefore, laptopSnapshot()).length === 0, diffSnapshots(laptopBefore, laptopSnapshot()).slice(0, 5).join('\n'));
  // "edit in the cloud" after the abandon (a phone that woke the machine).
  put(mv, '_dream_context/state/after-abandon.md', '# edited in the cloud after the abandon\n');

  section('Case 11 · the next go');
  const g2 = goTrip();
  if (!check('the next go succeeds', g2.ok, errOf(g2))) return;
  const rec = g2.value.recovery;
  check('it ran the recovery of the abandoned trip first', rec?.oldTrip === old && !rec.lost, short(rec));
  const parked = git(VAULT, ['for-each-ref', '--format=%(objectname) %(refname)', `refs/handsfree/${old}/`]);
  check('the abandoned trip\'s cloud refs are in refs/handsfree/<old>/* (the phone\'s commit is reachable)', parked.includes(`${phoneMain} refs/handsfree/${old}/heads/main`), parked.split('\n').slice(0, 5).join(' | '));
  const orphan = join(tripDir(old), 'orphaned');
  const of = filesIn(orphan);
  check('its files are in trips/<old>/orphaned/ (before and after the abandon)', of.some((p) => p.endsWith('_dream_context/state/abandoned-notes.md')) && of.some((p) => p.endsWith('_dream_context/state/after-abandon.md')), of.filter((p) => p.includes('_dream_context/state/')).slice(0, 8).join(', '));
  check('the laptop\'s own branch was not moved by the recovery', git(VAULT, ['rev-parse', 'HEAD']).trim() === laptopBefore['acme-storefront'].head.split(' @ ')[1]);

  section('Case 12b · tolerant recovery snapshot of a merge in progress (AC14)');
  const ap = git(ATLAS, ['for-each-ref', '--format=%(objectname) %(refname)', `refs/handsfree/${old}/`]);
  check('MERGE_HEAD is saved as a ref, never refused', ap.includes(mergeHead ?? '<none>') && /inprogress/i.test(ap), ap.split('\n').filter((l) => /inprogress|MERGE/i.test(l)).join(' | ') || ap.split('\n').slice(0, 6).join(' | '));
  const wtRef = ap.split('\n').map((l) => l.split(' ')[1]).find((r) => r && /\/worktree$/.test(r));
  const marker = wtRef ? git(ATLAS, ['show', `${wtRef}:src/other.ts`], { allowFail: true }) : '';
  check('the conflicted file is kept with its conflict markers as content', marker.includes('<<<<<<<'), wtRef ? short(marker, 200) : 'no worktree snapshot ref');
  check('a tolerant snapshot is never applied to the laptop working tree', diffSnapshots(laptopBefore, laptopSnapshot()).filter((l) => !l.startsWith('transcripts')).length === 0, diffSnapshots(laptopBefore, laptopSnapshot()).slice(0, 6).join('\n'));

  section('Trip 7 · the new trip after the recovery returns cleanly');
  const d0 = diffState(gitState(ATLAS), gitState(ma));
  check('after the new go, atlas-mobile\'s cloud copy equals the laptop again (no leftover merge)', d0.length === 0 && !existsSync(join(ma, '.git', 'MERGE_HEAD')), d0.join('\n') + (existsSync(join(ma, '.git', 'MERGE_HEAD')) ? '\nMERGE_HEAD still present in the cloud' : ''));
  const cloud = gitState(mv);
  const r = call('return');
  check('return succeeds', r.ok && r.value.outcome === 'home', errOf(r) ?? r.value.outcome);
  if (r.ok) recordFinalization('trip 7', r.value.receipt);
  const d = diffState(gitState(VAULT), cloud);
  check('... and the vault equals the cloud at quiesce', d.length === 0, d.join('\n'));
}

// ─── trip 8: .git paths and gitlinks are never written on either side (case 6, AC9) ─────

async function trip8() {
  section('Case 6 · go side: a gitlink or a .GIT path in the laptop index is refused before anything travels');
  const sub = git(ATLAS, ['rev-parse', 'HEAD']).trim();
  git(ATLAS, ['update-index', '--add', '--cacheinfo', `160000,${sub},vendor/lib`]);
  const g0 = call('go', { contextRoot: CTX });
  const probs = g0.error?.detail?.problems ?? [];
  check('a mode-160000 entry refuses the go before anything travels; the laptop stays home', !g0.ok && g0.error?.code === 'preflight' && probs.some((p) => p.path === 'vendor/lib') && state().trip.phase === 'home', errOf(g0) ?? 'go ran');
  check('the refusal the owner reads names the nested clone and suggests ignoring it (AC9 re-checks)', !g0.ok && /vendor\/lib/.test(g0.error?.message ?? '') && /ignor/i.test(g0.error?.message ?? ''), short(g0.error?.message));
  git(ATLAS, ['rm', '-q', '--cached', 'vendor/lib']);
  // (A .GIT/ or nested .git path cannot even enter a laptop index: git's own verify_path refuses
  // it on every platform, so the go side is covered by git; the return side is tested below.)

  section('Case 6 · return side: the cloud commits .GIT/config, a nested .git and a gitlink');
  const g = goTrip();
  if (!check('go succeeds', g.ok, errOf(g))) return;
  const ma = M(ATLAS);
  const goodHead = git(ma, ['rev-parse', 'HEAD']).trim();
  const evil = git(ma, ['hash-object', '-w', '--stdin'], { input: '[core]\n\thooksPath = /tmp/planted-by-cloud\n' }).trim();
  const hook = git(ma, ['hash-object', '-w', '--stdin'], { input: '#!/bin/sh\necho planted\n' }).trim();
  // No index accepts these paths, so a hostile cloud ships them as TREE objects: a commit whose
  // tree holds .GIT/config, sub/.git/hooks/post-checkout and a mode-160000 vendor/lib.
  const mk = (entries) => git(ma, ['mktree'], { input: entries.join('\n') + '\n' }).trim();
  const gitDir = mk([`100644 blob ${evil}\tconfig`]);
  const hooksDir = mk([`100755 blob ${hook}\tpost-checkout`]);
  const nestedGit = mk([`040000 tree ${hooksDir}\thooks`]);
  const subDir = mk([`040000 tree ${nestedGit}\t.git`]);
  const vendorDir = mk([`160000 commit ${goodHead}\tlib`]);
  const base = git(ma, ['ls-tree', 'HEAD']).trim().split('\n');
  const root = mk([...base, `040000 tree ${gitDir}\t.GIT`, `040000 tree ${subDir}\tsub`, `040000 tree ${vendorDir}\tvendor`]);
  const hostile = git(ma, ['commit-tree', root, '-p', goodHead, '-m', 'phone: hostile paths'], { allowFail: true, full: true });
  const commitR = hostile;
  if (hostile.status === 0) git(ma, ['update-ref', 'refs/heads/main', hostile.stdout.trim()]);
  console.log(`      (cloud main -> ${hostile.status === 0 ? hostile.stdout.trim().slice(0, 12) : 'commit-tree refused'}; tree: ${git(ma, ['ls-tree', '-r', '--full-tree', 'refs/heads/main']).split('\n').filter((l) => /\.GIT|\.git\/|160000/.test(l)).map((l) => l.split('\t')[1]).join(', ')})`);
  const gitConfigBefore = readFileSync(join(ATLAS, '.git', 'config'));
  const hooksBefore = treeShas(join(ATLAS, '.git', 'hooks'));
  const r = call('return');
  const receipt = r.ok ? r.value.receipt : null;
  const ar = receipt?.repos.find((x) => x.path === ATLAS);
  check('the laptop\'s .git/config is byte-identical (nothing wrote through .GIT/)', readFileSync(join(ATLAS, '.git', 'config')).equals(gitConfigBefore));
  check('no hook was planted in the laptop\'s .git/hooks', diffMaps(hooksBefore, treeShas(join(ATLAS, '.git', 'hooks'))).length === 0);
  check('no sub/.git path exists on the laptop', !exists(join(ATLAS, 'sub', '.git')));
  const idx = git(ATLAS, ['ls-files', '-s']);
  check('no mode-160000 entry and no .git path landed in the laptop index', !/^160000 /m.test(idx) && !/(^|\/)\.git\//im.test(idx.split('\n').map((l) => l.split('\t')[1] ?? '').join('\n')), idx.split('\n').filter((l) => /160000|\.git\//i.test(l)).join(' | ') || 'clean');
  check('the Return refused or parked the hostile repo (it did not apply it silently)',
    !r.ok || ar?.outcome !== 'applied' || (ar?.refused ?? []).some((c) => /\.GIT|\.git|vendor\/lib/i.test(c.path)),
    r.ok ? short({ outcome: ar?.outcome, reasons: ar?.parkReasons, refused: ar?.refused }) : errOf(r));
  console.log(`      (cloud commit: ${commitR.status === 0 ? 'made' : `refused by git: ${String(commitR.stderr).trim()}`}; return: ${r.ok ? r.value.outcome : errOf(r)})`);
  const ph = state().trip.phase;
  if (!r.ok) {
    // A refused incoming bundle is the cloud's problem, not a laptop write: AC13's rule (cancel
    // back to away/active with a message to fix it on the phone) is the only exit that does not
    // strand the owner (while the cloud stays quiescing the phone cannot fix anything).
    check('the refused Return cancels back to away (no laptop write happened)', ph === 'away', `laptop phase=${ph}; error=${short(errOf(r), 300)}`);
    const h = call('cloud-health');
    check('... and the cloud back to active, so the phone can remove the bad commit', h.ok && h.value.phase === 'active', short(h.value ?? errOf(h)));
    check('... with a message that names the repository and says to fix it on the phone', /atlas-mobile/.test(r.error?.message ?? '') && /phone/i.test(r.error?.message ?? ''), short(r.error?.message, 300));
  }
  // Leave the machine clean for the end-of-run checks.
  if (ph === 'returning') {
    const ab = call('abandon');
    console.log(`      (the laptop was stuck returning; Abandon is the only exit: ${ab.ok ? 'ok' : errOf(ab)})`);
    // D12/AC14: the next go recovers the abandoned trip first. A hostile commit must be parked
    // or refused by name there, never wedge every future trip.
    const next = call('go', { contextRoot: CTX });
    check('the next go is not wedged by the hostile commit (the recovery refuses it by name and goes on)', next.ok, errOf(next) ?? 'go ok');
    if (!next.ok) {
      if (state().trip.phase !== 'home') call('abandon');
      // Harness cleanup (not the product): drop the hostile commit from the cloud copy so the
      // trips after this one are not wedged by the same defect.
      const bad = hostile.stdout.trim();
      for (const ref of git(ma, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean)) {
        if (git(ma, ['merge-base', '--is-ancestor', bad, ref], { allowFail: true, full: true }).status !== 0) continue;
        if (ref === 'refs/heads/main') git(ma, ['update-ref', ref, goodHead]);
        else git(ma, ['update-ref', '-d', ref]);
      }
      const retry = call('go', { contextRoot: CTX });
      console.log(`      (after the harness removed the hostile commit from the cloud: go ${retry.ok ? 'ok' : errOf(retry)})`);
      if (retry.ok) { const fin = call('return'); if (fin.ok) recordFinalization('trip 8 follow-up', fin.value.receipt); }
      else if (state().trip.phase !== 'home') call('abandon');
    } else {
      const fin = call('return');
      if (fin.ok) recordFinalization('trip 8 follow-up', fin.value.receipt);
    }
  } else if (ph === 'away') {
    git(ma, ['update-ref', 'refs/heads/main', goodHead]);
    const fin = call('return');
    check('after the phone drops the bad commit, the Return completes', fin.ok && fin.value.outcome === 'home', errOf(fin) ?? fin.value.outcome);
    if (fin.ok) recordFinalization('trip 8 (after the phone reverted)', fin.value.receipt);
  } else if (receipt) recordFinalization('trip 8', receipt);
}

// ─── trip 9: the mirror lost its trip marker (AC24, where the fake reaches) ─────────────

/** The machine after a trip_lost: stopped by the product, or its stop queued (AC24). */
function stoppedOrQueued() {
  const st = state();
  const m = st.machines[0];
  const queued = st.config.queued?.steps?.includes('stop') ?? false;
  return { ok: m?.state === 'stopped' || queued, evidence: short({ machine: m?.state, queued: st.config.queued, serverUp: existsSync(CLOUD.pidFile), calls: st.calls.slice(-3) }) };
}

async function trip9() {
  section('AC24 · a mirror without its trip marker: the phone\'s work is recovered (D12), never lost');
  const g = goTrip();
  if (!check('go succeeds', g.ok, errOf(g))) return;
  const old = g.value.tripId;
  const marker = join(M(LH), '.dreamcontext-handsfree-trip.json');
  check('precondition: the mirror root carries the trip marker', existsSync(marker) && readFileSync(marker, 'utf8').includes(old));
  put(M(VAULT), 'src/lost.ts', 'export const lost = 1;\n');
  git(M(VAULT), ['add', 'src/lost.ts']);
  git(M(VAULT), ['commit', '-qm', 'phone: work on a machine that loses its marker']);
  const phoneCommit = git(M(VAULT), ['rev-parse', 'HEAD']).trim();
  const lostNote = '# written on the phone before the marker went missing\n';
  put(M(VAULT), '_dream_context/state/lost-marker-notes.md', lostNote);
  rmSync(marker, { force: true });
  const pre = laptopSnapshot();
  const preNon = nonGitSet(VAULT);
  const r = call('return');
  check('the Return ends as lost and the laptop is home (trip treated as abandoned)', r.ok && r.value.outcome === 'lost' && state().trip.phase === 'home', errOf(r) ?? short({ outcome: r.value.outcome, message: r.value.message, lastTrip: state().config.lastTrip }));
  // The phone's work is PARKED on the laptop, never destroyed by a snapshot-less seal.
  const parkedMain = git(VAULT, ['rev-parse', '-q', '--verify', `refs/handsfree/${old}/heads/main`], { allowFail: true }).trim();
  const reachable = !!parkedMain && git(VAULT, ['merge-base', '--is-ancestor', phoneCommit, parkedMain], { allowFail: true, full: true }).status === 0;
  check('the phone commit is reachable from refs/handsfree/<old-trip>/heads/main on the laptop', reachable, `phone commit ${phoneCommit.slice(0, 12)}; parked main ${parkedMain ? parkedMain.slice(0, 12) : '(absent)'}; parked refs: ${git(VAULT, ['for-each-ref', '--format=%(refname)', `refs/handsfree/${old}/`]).split('\n').filter(Boolean).slice(0, 4).join(', ') || 'none'}`);
  const orphanFile = Object.entries(treeShas(join(tripDir(old), 'orphaned'))).find(([p]) => p.endsWith('_dream_context/state/lost-marker-notes.md'));
  check('the phone\'s non-git file change is in trips/<old>/orphaned/, byte-equal', !!orphanFile && orphanFile[1] === sha(Buffer.from(lostNote)), orphanFile?.[0] ?? `orphaned/: ${filesIn(join(tripDir(old), 'orphaned')).slice(0, 6).join(', ') || '(empty)'}`);
  const rep = existsSync(join(tripDir(old), 'recovery-report.json')) ? JSON.parse(readFileSync(join(tripDir(old), 'recovery-report.json'), 'utf8')) : null;
  check('trips/<old>/recovery-report.json records lost:true', rep?.lost === true, short(rep));
  check('the recovered trip is recorded as lost + recovered', state().config.lastTrip?.tripId === old && state().config.lastTrip?.status === 'lost' && state().config.lastTrip?.recovered === true, short(state().config.lastTrip));
  const d = diffSnapshots(pre, laptopSnapshot());
  check('the laptop\'s own refs, trees and files are untouched (the work is only parked)', d.length === 0 && diffMaps(preNon, nonGitSet(VAULT)).length === 0, d.slice(0, 6).join('\n'));
  const sq = stoppedOrQueued();
  check('the product stopped the machine (or queued the stop) after trip_lost (AC24)', sq.ok, sq.evidence);
  // "treats the trip as abandoned": the next go starts a new trip, nothing left to recover.
  const next = call('go', { contextRoot: CTX });
  check('the next go after the recovered trip_lost starts a new trip', next.ok && !next.value.recovery, errOf(next) ?? `trip ${next.value?.tripId}, recovery ${short(next.value?.recovery)}`);
  if (next.ok) { const fin = call('return'); if (fin.ok) recordFinalization('after trip_lost', fin.value.receipt); }
  else if (state().trip.phase !== 'home') call('abandon');
}

async function trip9b() {
  section('AC24 · marker missing AND the trip\'s folders absent: refuse with the teardown message, seal nothing');
  const g = goTrip();
  if (!check('go succeeds', g.ok, errOf(g))) return;
  const old = g.value.tripId;
  put(M(VAULT), 'src/unmounted.ts', 'export const unmounted = 1;\n');
  git(M(VAULT), ['add', 'src/unmounted.ts']);
  git(M(VAULT), ['commit', '-qm', 'phone: work on a mirror that goes missing']);
  const phoneCommit = git(M(VAULT), ['rev-parse', 'HEAD']).trim();
  rmSync(join(M(LH), '.dreamcontext-handsfree-trip.json'), { force: true });
  // An unmounted mirror: every non-transcript root is gone from where the cloud looks. The
  // folders are kept aside (their bytes are the cloud's files this case must never touch).
  const aside = join(SCRATCH, 'cloud', 'unmounted');
  const roots = [VAULT, PAY, ATLAS, NOTES];
  for (const r of roots) { mkdirSync(join(aside, r, '..'), { recursive: true }); renameSync(M(r), join(aside, r)); }
  const cloudBefore = Object.fromEntries(roots.map((r) => [r, treeShas(join(aside, r))]));
  const homeBefore = treeShas(M(LH));
  const pre = laptopSnapshot();
  const preNon = nonGitSet(VAULT);
  const tdMsg = /teardown --discard-abandoned-work/;
  const r = call('return');
  const rText = r.ok ? (r.value.message ?? '') : errOf(r);
  check('the Return refuses to recover with the teardown message (nothing recoverable on the cloud)', tdMsg.test(rText) && state().trip.phase === 'home', `${r.ok ? `outcome=${r.value.outcome}` : 'error'}; phase=${state().trip.phase}; ${short(rText, 400)}`);
  check('the trip stays abandoned + unrecovered (the next go must retry the recovery)', state().config.lastTrip?.tripId === old && state().config.lastTrip?.status === 'abandoned' && state().config.lastTrip?.recovered === false, short(state().config.lastTrip));
  check('nothing was parked on the laptop for that trip', git(VAULT, ['for-each-ref', '--format=%(refname)', `refs/handsfree/${old}/`]).trim() === '' && !existsSync(join(tripDir(old), 'orphaned')));
  const next = call('go', { contextRoot: CTX });
  check('the next go refuses with the teardown message and the laptop stays home', !next.ok && tdMsg.test(next.error?.message ?? '') && state().trip.phase === 'home', `${errOf(next) ?? `go ok: trip ${next.value?.tripId}`}; phase=${state().trip.phase}`);
  // The machine is still up here when the refusal came from a running cloud: read its phase.
  if (state().machines[0]?.state !== 'available') call('start-cloud');
  const h = call('cloud-health');
  check('nothing was sealed (the cloud still holds the trip, unsealed)', h.ok && h.value.tripId === old && h.value.phase !== 'sealed' && h.value.sealedEpoch == null, short(h.value ?? errOf(h)));
  const cloudDiff = roots.flatMap((rt) => diffMaps(cloudBefore[rt], treeShas(join(aside, rt))).map((l) => `${rt.replace(LH, '~')}: ${l}`));
  const homeDiff = diffMaps(homeBefore, treeShas(M(LH))).filter((l) => !l.startsWith('.dreamcontext/handsfree') && !/^\.claude\//.test(l));
  check('the cloud\'s files are untouched (no wipe, no snapshot write)', cloudDiff.length === 0 && homeDiff.length === 0, [...cloudDiff, ...homeDiff].slice(0, 8).join('\n'));
  const d = diffSnapshots(pre, laptopSnapshot());
  check('the laptop is untouched', d.length === 0 && diffMaps(preNon, nonGitSet(VAULT)).length === 0, d.slice(0, 6).join('\n'));

  section('AC24 · the folders come back: the next go recovers that trip first');
  for (const r of roots) renameSync(join(aside, r), M(r));
  const g2 = goTrip();
  check('with the folders back, the next go recovers the trip and starts a new one', g2.ok && g2.value.recovery?.oldTrip === old, errOf(g2) ?? short(g2.value.recovery));
  const pm = git(VAULT, ['rev-parse', '-q', '--verify', `refs/handsfree/${old}/heads/main`], { allowFail: true }).trim();
  check('... and the phone commit is parked under refs/handsfree/<old>/*', !!pm && git(VAULT, ['merge-base', '--is-ancestor', phoneCommit, pm], { allowFail: true, full: true }).status === 0, pm || '(absent)');
  if (g2.ok) { const fin = call('return'); if (fin.ok) recordFinalization('after the folders came back', fin.value.receipt); }
  else if (state().trip.phase !== 'home') call('abandon');
  if (state().machines[0]?.state === 'available') call('stop-cloud');
}

// ─── main ───────────────────────────────────────────────────────────────────────────────

const realBefore = realHomeSnapshot();
let exitCode = 1;
try {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  PORT = await freePort();
  ORIGIN = `http://127.0.0.1:${PORT}`;
  if (!existsSync(join(REPO, 'dist', 'index.js'))) throw new Error('dist/index.js is missing: run `npm run build:cli` first');
  freezePackage();
  buildFixtures(PORT);

  section('Setup');
  const sc = call('scope', { contextRoot: CTX });
  const kinds = sc.ok ? sc.value.roots.map((r) => `${r.kind}:${r.absPath.replace(LH, '~')}`) : [];
  check('the trip scope is the vault + its 3 present linked repos + the vault transcripts', sc.ok && sc.value.roots.filter((r) => r.kind === 'repo').length === 4 && sc.value.roots.some((r) => r.kind === 'transcripts'), kinds.join(', ') || errOf(sc));
  const s = call('setup');
  PASSPHRASE = s.value?.passphrase ?? '';
  check('setup signs in, writes the template repo, creates the fake machine, pushes the verifiers and leaves it stopped',
    s.ok && !!PASSPHRASE && state().machines.length === 1 && state().machines[0].state === 'stopped' && !existsSync(CLOUD.pidFile), errOf(s) ?? `machine ${s.value.codespace?.name}`);

  if (want('t1')) await trip1();
  if (want('t2')) await trip2();
  if (want('t3')) await trip3();
  if (want('t4')) await trip4();
  if (want('t5')) await trip5();
  if (want('t6')) await trip6and7();
  if (want('t8')) await trip8();
  if (want('t9')) await trip9();
  if (want('t9b')) await trip9b();

  section('Finalization of every trip');
  for (const f of finalizations) {
    check(`${f.label}: secretsWiped + sealed + stopped (via the fake)`, !!f.fin && f.fin.secretsWiped && f.fin.sealed && f.fin.stopped, short(f.fin));
  }
  const endState = state();
  check('the laptop is home, nothing queued, and the fake machine is stopped with its server down',
    endState.trip.phase === 'home' && !endState.config.queued && endState.machines.every((m) => m.state === 'stopped') && !existsSync(CLOUD.pidFile),
    short({ phase: endState.trip.phase, queued: endState.config.queued, machines: endState.machines.map((m) => m.state), calls: endState.calls.slice(-6) }));
  exitCode = 0;
} catch (err) {
  check('the harness ran to the end', false, err.stack);
} finally {
  // Never leave a cloud server behind.
  try { const pid = Number(readFileSync(CLOUD.pidFile, 'utf8')); process.kill(-pid, 'SIGKILL'); } catch { /* not running */ }
}

section('After all trips');
const realAfter = realHomeSnapshot();
const realDiff = Object.keys({ ...realBefore, ...realAfter }).filter((k) => realBefore[k] !== realAfter[k]);
check('nothing under the real ~/.dreamcontext/handsfree, its registries, ~/.claude settings or ~/.claude/projects changed', realDiff.length === 0, realDiff.map((k) => `${k}: ${realBefore[k]} -> ${realAfter[k]}`).join('\n') || `${Object.keys(realAfter).length} paths unchanged`);
if (!process.env.HFRT_KEEP && results.every((r) => r.ok)) rmSync(SCRATCH, { recursive: true, force: true });
else console.log(`\n(scratch kept at ${SCRATCH})`);

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nhandsfree-roundtrip: ${passed} passed, ${failed} failed`);
process.exit(failed || exitCode ? 1 : 0);
