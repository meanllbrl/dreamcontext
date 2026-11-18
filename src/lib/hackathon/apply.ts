/**
 * After the owner's pick (plan C6 "After the pick", `pr`, criterion 12):
 *
 *  1. the conductor's snapshot repo (every `team/<team>` branch) is bundled into the run's local
 *     folder and `git bundle verify` runs on the copy;
 *  2. a team's workspace is removed only when its final snapshot is in that verified bundle;
 *  3. the winner's branch is fetched from the conductor's repo (never a team directory) into the
 *     target as `hackathon/<run>/<team>`; nothing is checked out;
 *  4. `pr` scans the diff (pattern redactor + every known secret value), lists every changed path
 *     that runs elsewhere and refuses without the owner's confirm hash over those hunks, then
 *     pushes and opens the PR.
 *
 * `result.json` is written once, here, at pick or stop, from structured fields only.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../telegram/format.js';
import type { Design } from './designer.js';
import { juryPath } from './phases.js';
import { designHash, readJson, resultPath, runDir, runWorkspace, teamWorkspace, writeJsonAtomic, type RunRecord } from './run-store.js';
import { isKeyFilePath, knownSecretValues, type SecretSources } from './secrets.js';
import { git, snapPaths, snapshotHead } from './snapshot.js';
import type { ResultRecord, TeamResult } from './stats.js';
import type { JuryResult } from './jury.js';

export function bundlePath(contextRoot: string, runId: string): string {
  return join(runDir(contextRoot, runId), 'kept', 'teams.bundle');
}

export interface KeepResult { bundle: string | null; verified: boolean; removed: string[]; kept: { team: string; reason: string }[] }

/** Bundle every team branch, verify the copy, remove only the workspaces safely kept. */
export function keepAndClean(contextRoot: string, run: RunRecord, design: Design, o: { wsHome?: string; keepWinner?: string | null } = {}): KeepResult {
  const kept: KeepResult['kept'] = [];
  const removed: string[] = [];
  const out = bundlePath(contextRoot, run.id);
  mkdirSync(join(out, '..'), { recursive: true });
  const gitDir = snapPaths(run.id, design.teams[0]!.id, o.wsHome).gitDir;
  let verified = false;
  try {
    git(['--git-dir', gitDir, 'bundle', 'create', out, '--branches']);
    // Verify against the snapshot repo itself: the brain folder need not be a git repo.
    git(['--git-dir', gitDir, 'bundle', 'verify', out]);
    verified = true;
  } catch (e) {
    for (const t of design.teams) kept.push({ team: t.id, reason: `paket doğrulanamadı: ${(e as Error).message.split('\n')[0]!.slice(0, 120)}` });
    return { bundle: existsSync(out) ? out : null, verified, removed, kept };
  }
  const refs = git(['bundle', 'list-heads', out]).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2);
  for (const t of design.teams) {
    const head = snapshotHead(run.id, t.id, o.wsHome);
    const inBundle = !!head && refs.some(([sha, ref]) => sha === head && ref === `refs/heads/team/${t.id}`);
    if (!inBundle) { kept.push({ team: t.id, reason: 'son kopyası pakette yok: klasörü duruyor' }); continue; }
    const root = teamWorkspace(run.id, t.id, o.wsHome).root;
    // Contained: the path is the run workspace's own child, and never a link.
    const parent = runWorkspace(run.id, o.wsHome);
    try {
      if (!root.startsWith(`${parent}/`) || lstatSync(root).isSymbolicLink()) { kept.push({ team: t.id, reason: 'klasör beklenen yerde değil' }); continue; }
      rmSync(root, { recursive: true, force: true });
      removed.push(t.id);
    } catch {
      kept.push({ team: t.id, reason: 'klasör silinemedi' });
    }
  }
  return { bundle: out, verified, removed, kept };
}

export function winnerBranch(runId: string, team: string): string {
  return `hackathon/${runId}/${team}`;
}

/** Fetch the winner's snapshot branch from the conductor's repo into the target. No checkout. */
export function fetchWinner(run: RunRecord, design: Design, team: string, wsHome?: string): string {
  const src = snapPaths(run.id, team, wsHome).gitDir;
  const branch = winnerBranch(run.id, team);
  git(['-C', design.target, 'fetch', '--no-tags', '--quiet', src, `+refs/heads/team/${team}:refs/heads/${branch}`]);
  return branch;
}

// ─── The PR gate ────────────────────────────────────────────────────────────

/** Paths that run on another machine or in the owner's next session. */
export const RUNS_ELSEWHERE: readonly RegExp[] = [
  /^\.github\//, /^\.gitlab-ci\.yml$/, /^\.circleci\//, /^\.buildkite\//, /^azure-pipelines\.yml$/, /^Jenkinsfile$/, /^bitbucket-pipelines\.yml$/, /^\.travis\.yml$/,
  /(^|\/)\.claude\//, /(^|\/)\.mcp\.json$/, /(^|\/)\.codex\//, /(^|\/)\.husky\//, /(^|\/)\.githooks\//, /(^|\/)\.git-hooks\//, /(^|\/)lefthook\.ya?ml$/, /(^|\/)\.pre-commit-config\.yaml$/,
  /(^|\/)CLAUDE\.md$/, /(^|\/)AGENTS\.md$/, /(^|\/)GEMINI\.md$/, /(^|\/)\.cursor\//, /(^|\/)\.agents\//, /(^|\/)\.vscode\//, /(^|\/)\.envrc$/, /(^|\/)\.npmrc$/, /(^|\/)\.gitattributes$/,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/,
];

const PKG_KEYS = ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'overrides', 'resolutions', 'workspaces', 'bin', 'main', 'exports'] as const;

function pkgRunsElsewhere(before: string | null, after: string | null): boolean {
  let a: Record<string, unknown> = {};
  let b: Record<string, unknown> = {};
  try { a = before ? JSON.parse(before) : {}; } catch { return true; }
  try { b = after ? JSON.parse(after) : {}; } catch { return true; }
  return PKG_KEYS.some((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}

export interface DiffFile { path: string; status: string; hunks: string }

export function diffFiles(target: string, base: string, branch: string): DiffFile[] {
  const names = git(['-C', target, 'diff', '--name-status', '--no-renames', '-z', base, branch]).split('\0').filter(Boolean);
  const files: DiffFile[] = [];
  for (let i = 0; i + 1 < names.length; i += 2) {
    const path = names[i + 1]!;
    const hunks = git(['-C', target, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', base, branch, '--', path]);
    files.push({ path, status: names[i]!, hunks });
  }
  return files;
}

export interface SecretHit { path: string; line: number; kind: 'pattern' | 'known' | 'key-file' }

/** Added lines that carry a secret, with file:line. */
export function scanSecrets(files: readonly DiffFile[], known: readonly string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const f of files) {
    if (f.status !== 'D' && isKeyFilePath(f.path)) hits.push({ path: f.path, line: 0, kind: 'key-file' });
    let line = 0;
    for (const l of f.hunks.split('\n')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (h) { line = Number(h[1]) - 1; continue; }
      if (l.startsWith('+++') || l.startsWith('---')) continue;
      if (l.startsWith('+')) {
        line++;
        const body = l.slice(1);
        if (redactSecrets(body) !== body) hits.push({ path: f.path, line, kind: 'pattern' });
        else if (known.some((k) => body.includes(k))) hits.push({ path: f.path, line, kind: 'known' });
      } else if (!l.startsWith('-')) line++;
    }
  }
  return hits;
}

export interface ElsewhereFile { path: string; hunks: string }

export function runsElsewhere(target: string, base: string, branch: string, files: readonly DiffFile[]): ElsewhereFile[] {
  const out: ElsewhereFile[] = [];
  for (const f of files) {
    const base0 = f.path.split('/').pop();
    if (RUNS_ELSEWHERE.some((re) => re.test(f.path))) { out.push({ path: f.path, hunks: f.hunks }); continue; }
    if (base0 === 'package.json') {
      const show = (rev: string) => { try { return git(['-C', target, 'show', `${rev}:${f.path}`]); } catch { return null; } };
      if (pkgRunsElsewhere(show(base), show(branch))) out.push({ path: f.path, hunks: f.hunks });
    }
  }
  return out;
}

/** The owner's confirm hash: sha256 over those paths and their hunks, in path order. */
export function confirmHash(files: readonly ElsewhereFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) h.update(`${f.path}\0${f.hunks}\0`);
  return h.digest('hex');
}

export interface PrCheck {
  branch: string;
  secretHits: SecretHit[];
  elsewhere: ElsewhereFile[];
  confirmHash: string | null;
  diffstat: string;
  codexWinner: boolean;
}

export function checkPr(run: RunRecord, design: Design, team: string, sources: SecretSources): PrCheck {
  const branch = winnerBranch(run.id, team);
  const base = design.baseSha!;
  const files = diffFiles(design.target, base, branch);
  const secretHits = scanSecrets(files, knownSecretValues(sources));
  const elsewhere = runsElsewhere(design.target, base, branch, files);
  return {
    branch,
    secretHits,
    elsewhere,
    confirmHash: elsewhere.length ? confirmHash(elsewhere) : null,
    diffstat: git(['-C', design.target, 'diff', '--stat', base, branch]),
    codexWinner: design.teams.find((t) => t.id === team)?.tool === 'codex',
  };
}

export type PrOutcome = { ok: true; url: string } | { ok: false; reason: string; check?: PrCheck };

/** Push and open the PR, or refuse with the reason. `confirm` = the hash the owner confirmed. */
export function openPr(run: RunRecord, design: Design, team: string, confirm: string | null, sources: SecretSources, o: { push?: (cwd: string, branch: string) => void; create?: (cwd: string, branch: string, title: string, body: string) => string } = {}): PrOutcome {
  const check = checkPr(run, design, team, sources);
  if (check.secretHits.length) {
    return { ok: false, reason: `sır bulundu, gönderilmedi: ${check.secretHits.map((h) => `${h.path}:${h.line}`).join(', ')}`, check };
  }
  if (check.confirmHash && confirm !== check.confirmHash) {
    return { ok: false, reason: 'başka yerde çalışan dosyalar değişti: önce satırları onayla', check };
  }
  const push = o.push ?? ((cwd, branch) => { execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', '-u', 'origin', branch], { cwd, stdio: 'pipe' }); });
  const create = o.create ?? ((cwd, branch, title, body) => execFileSync('gh', ['pr', 'create', '--head', branch, '--title', title, '--body', body], { cwd, encoding: 'utf-8' }).trim());
  push(design.target, check.branch);
  const name = design.teams.find((t) => t.id === team)?.name ?? team;
  const url = create(design.target, check.branch, `Hackathon: ${design.problem.slice(0, 60)} (${name})`, `Hackathon ${run.id}: ${name} ekibinin çözümü, sahibin seçimiyle.\n\n${check.diffstat}`);
  return { ok: true, url };
}

// ─── result.json, written once ──────────────────────────────────────────────

export function writeResult(contextRoot: string, run: RunRecord, design: Design, pick: string | null, extra: { usedShare?: number | null; stoppedReason?: string } = {}): ResultRecord | null {
  const p = resultPath(contextRoot, run.id);
  if (existsSync(p)) return null;
  const jury = readJson<JuryResult>(juryPath(contextRoot, run.id));
  const hours = run.startedAt ? Math.max(0, (Date.now() - Date.parse(run.startedAt)) / 3600_000) : null;
  const perTeam = extra.usedShare != null ? extra.usedShare / design.teams.length : null;
  const control = design.controlTeam;
  const teams: TeamResult[] = design.teams.map((t) => ({
    id: t.id, tool: t.tool, model: t.model, inner: t.inner, persona: t.persona || t.name, control: t.id === control,
    juryScore: jury?.scores?.[t.id] ?? null,
    originality: jury?.originality?.[t.id] ?? null,
    similarity: null,
    borrowed: false,
    firstOutputMinute: null,
    usageShare: perTeam,
    hours,
    readIsolated: t.tool === 'claude',
  }));
  const peers = teams.filter((t) => !t.control && t.juryScore != null);
  const ctl = teams.find((t) => t.control && t.juryScore != null);
  const rec: ResultRecord = {
    version: 1, run: run.id, kind: design.kind, designHash: designHash({ design }), design,
    teams, pick, juryRanking: jury?.ranking ?? [],
    juryOwnerAgree: pick && jury?.ranking?.length ? jury.ranking[0] === pick : null,
    controlDelta: ctl && peers.length ? peers.reduce((a, t) => a + t.juryScore!, 0) / peers.length - ctl.juryScore! : null,
    sameVendorJury: jury?.sameVendor ?? false,
    pr: 'none',
    writtenAt: new Date().toISOString(),
    ...(extra.stoppedReason ? { stoppedReason: extra.stoppedReason } : {}),
  };
  writeJsonAtomic(p, rec);
  return rec;
}

/** `hackathon outcome --pr merged|closed`: the only later change to a result. */
export function setOutcome(contextRoot: string, runId: string, pr: ResultRecord['pr']): ResultRecord {
  const p = resultPath(contextRoot, runId);
  const r = readJson<ResultRecord>(p);
  if (!r) throw new Error(`no result for ${runId}`);
  const next = { ...r, pr };
  writeJsonAtomic(p, next);
  return next;
}
