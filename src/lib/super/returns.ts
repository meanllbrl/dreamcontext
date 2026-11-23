import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { GIT_SAFE_ARGS, git, resolveCommit } from './worktrees.js';
import { findPackageDir } from '../catalog.js';
import { validBase } from './types.js';

/**
 * Every piece of work a local cut carries comes home to dev, or is named (kesim-geri-donus K1).
 *
 * A cut (`super/<topic>`) is a first-parent chain of merges and, sometimes, commits written on it
 * directly. Membership comes from git, never from a merge message (D1): every first-parent merge
 * owns `M^@ ^M^1`; the message only names the group. Whether a commit is "home" is answered by ONE
 * question, `WorkIndex.has(commit, destination)` (D2): the destination's ancestor, or the same
 * patch-id, or the same cherry-pick origin. Destinations: remote dev, every PR into dev (one
 * listing, never a branch-name lookup), the candidate cut, local rescue branches.
 *
 * Read-only except `git fetch <remote> dev`, the PR-head fetch into `refs/dreamcontext/pr/*`, and
 * `markFit`'s note. Nothing here pushes, opens a PR, deletes or moves a branch: the report's
 * `commands` are for a child that was given the outward grant.
 */

export type ReturnState = 'represented' | 'inPr' | 'inRescue' | 'fit' | 'awaiting';
export interface Destination { kind: 'dev' | 'pr-open' | 'pr-merged' | 'candidate' | 'rescue'; sha: string; pr?: number; url?: string; mergeOid?: string; ref?: string }
export type HasHow = 'ancestor' | 'patch-id' | 'origin';
export interface WorkIndex { has(commit: string, d: Destination): Promise<false | HasHow>; destinations: Destination[]; notes: string[] }
export interface ReturnCommit { sha: string; subject: string; state: ReturnState; via?: { kind: Destination['kind']; how: HasHow; pr?: number; ref?: string }; note?: string }
export interface ReturnGroup {
  name: string; branchExists: boolean; tips: string[]; commits: ReturnCommit[]; foreign: number;
  action: 'none' | 'push' | 'push-pr' | 'rescue'; rescueBranch?: string; commands: string[];
}
export interface DropRow { installed: string; npm: string; source: 'stamp' | 'flag'; groups: ReturnGroup[] }
export interface ReturnsReport {
  key: string;
  from: { ref: string; sha: string };
  dev: { ref: string; sha: string; stale: boolean; why?: string } | null;
  localDevBehind: number | null;
  awaiting: ReturnGroup[]; inPr: ReturnGroup[]; inRescue: ReturnGroup[]; fit: ReturnCommit[];
  drops: { asked: Array<{ npm: string; installed: string }>; rows: DropRow[]; errors: Array<{ npm: string; error: string }> };
  notes: string[];
  error?: string;
}
export interface InstalledEntry { npm: string; sha: string; source: 'stamp' | 'flag' }

/** `gh` with argv; 30 s per call. A timeout is "unknown", never "no PRs". */
export type GhRunner = (args: readonly string[]) => Promise<{ code: number; stdout: string; timedOut?: boolean }>;
export const defaultGh: GhRunner = (args) => new Promise((done) => {
  execFile('gh', [...args], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
    done({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout ?? ''), timedOut: !!e && (e.killed === true || !!e.signal) });
  });
});

export const FIT_NOTES_REF = 'refs/notes/dreamcontext-cut-fit';
const SHA_RE = /^[0-9a-f]{40,64}$/;
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

// ─── git with stdin ─────────────────────────────────────────────────────────────

function gitEnv() { return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }; }

/** One git command fed `input` on stdin; never throws. */
function gitIn(cwd: string, args: readonly string[], input: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    const p = spawn('git', [...GIT_SAFE_ARGS, ...args], { cwd, env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.on('error', () => { clearTimeout(t); done({ code: 1, stdout: '' }); });
    p.on('close', (code) => { clearTimeout(t); done({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf-8') }); });
    p.stdin.on('error', () => undefined);
    p.stdin.end(input);
  });
}

/** `git log -p` of exactly `shas`, piped into `git patch-id --stable`: sha → patch-id. */
function patchIdsOf(cwd: string, shas: readonly string[]): Promise<Map<string, string>> {
  return new Promise((done) => {
    const out = new Map<string, string>();
    if (!shas.length) { done(out); return; }
    const log = spawn('git', [...GIT_SAFE_ARGS, 'log', '--no-walk=unsorted', '--stdin', '-p', '--no-color', '--no-ext-diff', '--no-renames', '--format=commit %H'], { cwd, env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const pid = spawn('git', [...GIT_SAFE_ARGS, 'patch-id', '--stable'], { cwd, env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const t = setTimeout(() => { log.kill('SIGKILL'); pid.kill('SIGKILL'); }, 300_000);
    log.stdout.pipe(pid.stdin);
    pid.stdin.on('error', () => undefined);
    log.stdin.on('error', () => undefined);
    let buf = '';
    pid.stdout.on('data', (c: Buffer) => { buf += c.toString('utf-8'); });
    const finish = () => {
      clearTimeout(t);
      for (const l of lines(buf)) { const [id, sha] = l.split(' '); if (id && sha) out.set(sha, id); }
      done(out);
    };
    pid.on('close', finish);
    pid.on('error', finish);
    log.on('error', () => pid.stdin.end());
    log.stdin.end(shas.join('\n') + '\n');
  });
}

interface CommitInfo { subject: string; cites: string[]; fit: boolean }

/** Subjects, `cherry picked from` citations and the cut-fit mark of `shas`, one batched call. */
async function commitInfo(cwd: string, shas: readonly string[]): Promise<Map<string, CommitInfo>> {
  const out = new Map<string, CommitInfo>();
  if (!shas.length) return out;
  const r = await gitIn(cwd, ['log', '--no-walk=unsorted', '--stdin', `--notes=${FIT_NOTES_REF}`, '--format=%H%x1f%s%x1f%B%x1f%N%x1e'], shas.join('\n') + '\n');
  for (const rec of r.stdout.split('\x1e')) {
    const [sha, subject, body, note] = rec.replace(/^\n+/, '').split('\x1f');
    if (!sha || !SHA_RE.test(sha.trim())) continue;
    const cites = [...(body ?? '').matchAll(/\(cherry picked from commit ([0-9a-f]{7,64})\)/g)].map((m) => m[1]);
    const fit = /^Cut-fit:\s*\S/m.test(body ?? '') || /\S/.test(note ?? '');
    out.set(sha.trim(), { subject: (subject ?? '').trim(), cites, fit });
  }
  return out;
}

// ─── Destinations ───────────────────────────────────────────────────────────────

/** The remote that has `dev`; several → the one with a HEAD, else `origin`, else first sorted. */
export async function pickRemote(repo: string): Promise<string | null> {
  const remotes = lines((await git(repo, ['remote'])).stdout).filter((r) => /^[A-Za-z0-9._-]{1,100}$/.test(r)).sort();
  const withDev: string[] = [];
  for (const r of remotes) if ((await git(repo, ['show-ref', '--verify', '--quiet', `refs/remotes/${r}/dev`])).code === 0) withDev.push(r);
  if (!withDev.length) return null;
  if (withDev.length === 1) return withDev[0];
  for (const r of withDev) if ((await git(repo, ['symbolic-ref', '-q', `refs/remotes/${r}/HEAD`])).code === 0) return r;
  return withDev.includes('origin') ? 'origin' : withDev[0];
}

export function githubSlug(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[:/]+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

interface PrRow { number: number; state: string; merged: boolean; head: string; headRef: string; mergeOid: string | null; url: string }

/** Every PR into dev, one paginated listing (never by branch name). null = unknown (gh missing,
 *  failed, timed out, not GitHub). */
async function listPrs(repo: string, remote: string, gh: GhRunner): Promise<{ prs: PrRow[] | null; note?: string }> {
  // The configured URL, before any insteadOf rewrite: the GitHub name is what it says.
  const url = (await git(repo, ['config', '--get', `remote.${remote}.url`])).stdout.trim();
  const slug = githubSlug(url);
  if (!slug) return { prs: null, note: `PR destinations skipped: ${remote} is not a GitHub remote` };
  const r = await gh(['api', '--paginate', `repos/${slug.owner}/${slug.repo}/pulls?base=dev&state=all&per_page=100`,
    '--jq', '.[] | {number, state, merged: (.merged_at != null), head: .head.sha, headRef: .head.ref, mergeOid: .merge_commit_sha, url: .html_url}']);
  if (r.code !== 0 || r.timedOut) return { prs: null, note: `PR destinations unknown: gh ${r.timedOut ? 'timed out' : 'failed'}; nothing is read as "no PR"` };
  const prs: PrRow[] = [];
  for (const l of lines(r.stdout)) {
    try {
      const p = JSON.parse(l) as Partial<PrRow>;
      if (typeof p.number !== 'number' || typeof p.head !== 'string' || !SHA_RE.test(p.head)) continue;
      prs.push({ number: p.number, state: String(p.state ?? ''), merged: p.merged === true, head: p.head, headRef: String(p.headRef ?? ''), mergeOid: typeof p.mergeOid === 'string' && SHA_RE.test(p.mergeOid) ? p.mergeOid : null, url: String(p.url ?? '') });
    } catch { /* a bad line */ }
  }
  return { prs };
}

async function hasObjects(repo: string, shas: readonly string[]): Promise<Set<string>> {
  const r = await gitIn(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], shas.join('\n') + '\n');
  const ok = new Set<string>();
  for (const l of lines(r.stdout)) { const [sha, type] = l.split(' '); if (type === 'commit') ok.add(sha); }
  return ok;
}

/** PR heads not in the repo yet, fetched in ONE call into `refs/dreamcontext/pr/<n>`. */
async function fetchPrHeads(repo: string, remote: string, prs: readonly PrRow[]): Promise<Set<string>> {
  let have = await hasObjects(repo, prs.map((p) => p.head));
  const missing = prs.filter((p) => !have.has(p.head));
  if (missing.length) {
    await git(repo, ['fetch', '--no-tags', '--quiet', remote, ...missing.map((p) => `+refs/pull/${p.number}/head:refs/dreamcontext/pr/${p.number}`)]);
    have = await hasObjects(repo, prs.map((p) => p.head));
  }
  return have;
}

// ─── The index ──────────────────────────────────────────────────────────────────

const isAncestor = async (repo: string, a: string, b: string) => (await git(repo, ['merge-base', '--is-ancestor', a, b])).code === 0;

/**
 * The work index (D2): for every destination, the commits it holds past `fromSha` (ancestor set,
 * patch-ids, cherry-pick origins), collected once. `stops`: the refs the tested commits were taken
 * past (no tested commit is an ancestor of a stop), so "ancestor of d" is "in `d ^stops`".
 */
export async function buildIndex(repo: string, fromSha: string, dests: readonly Destination[], stops: readonly string[] = []): Promise<WorkIndex & { prime(shas: readonly string[]): Promise<void>; info(sha: string): CommitInfo | undefined; origins(sha: string): Set<string> }> {
  const notes: string[] = [];
  const ancestors = new Map<string, Set<string>>();
  const range = new Map<string, string[]>();
  for (const d of dests) {
    ancestors.set(d.sha, new Set(lines((await git(repo, ['rev-list', d.sha, ...stops.map((s) => `^${s}`)])).stdout)));
    range.set(d.sha, lines((await git(repo, ['rev-list', '--no-merges', d.sha, `^${fromSha}`])).stdout));
  }
  const infos = new Map<string, CommitInfo>();
  const pids = new Map<string, string>();
  const prime = async (shas: readonly string[]) => {
    const need = [...new Set(shas)].filter((s) => !infos.has(s));
    if (!need.length) return;
    for (const [k, v] of await commitInfo(repo, need)) infos.set(k, v);
    for (const [k, v] of await patchIdsOf(repo, need)) pids.set(k, v);
  };
  await prime([...new Set([...range.values()].flat())]);
  // A cited sha may be short or an object we never listed: follow what we can, at most 8 hops.
  const chainCache = new Map<string, Set<string>>();
  const origins = (sha: string): Set<string> => {
    const hit = chainCache.get(sha);
    if (hit) return hit;
    const out = new Set<string>([sha]);
    let frontier = [sha];
    for (let hop = 0; hop < 8 && frontier.length; hop++) {
      const next: string[] = [];
      for (const s of frontier) for (const c of infos.get(s)?.cites ?? []) if (!out.has(c)) { out.add(c); next.push(c); }
      frontier = next;
    }
    chainCache.set(sha, out);
    return out;
  };
  const destPids = new Map<string, Set<string>>();
  const destOrigins = new Map<string, Set<string>>();
  for (const d of dests) {
    const r = range.get(d.sha) ?? [];
    destPids.set(d.sha, new Set(r.map((s) => pids.get(s)).filter((x): x is string => !!x)));
    const o = new Set<string>();
    for (const s of r) for (const x of origins(s)) o.add(x);
    destOrigins.set(d.sha, o);
  }
  const matchOrigin = (set: Set<string>, sha: string) => {
    for (const x of origins(sha)) {
      if (set.has(x)) return true;
      // A short citation: compare by prefix.
      for (const y of set) if ((y.length < 40 || x.length < 40) && (y.startsWith(x) || x.startsWith(y))) return true;
    }
    return false;
  };
  return {
    destinations: [...dests],
    notes,
    prime,
    info: (sha) => infos.get(sha),
    origins,
    async has(commit, d) {
      if (ancestors.get(d.sha)?.has(commit)) return 'ancestor';
      if (!infos.has(commit)) await prime([commit]);
      const pid = pids.get(commit);
      if (pid && destPids.get(d.sha)?.has(pid)) return 'patch-id';
      if (matchOrigin(destOrigins.get(d.sha) ?? new Set(), commit)) return 'origin';
      return false;
    },
  };
}

// ─── Membership (D1) ────────────────────────────────────────────────────────────

const NAME_RES = [
  /^Merge pull request #\d+ from [^/\s]+\/([A-Za-z0-9._/-]+)/,
  /^[Mm]erge (?:branch |remote-tracking branch )?'?([A-Za-z0-9._/-]+)'?/,
];

interface RawGroup { name: string; tips: string[]; commits: string[] }

/** The cut's groups: each first-parent merge's own commits (octopus included), named by its
 *  message, else the ref at its second parent, else its sha; first-parent non-merges are `direct`.
 *  No commit past `from ^stops` is left out of a group. */
export async function groupsOf(repo: string, fromSha: string, stopRefs: readonly string[]): Promise<RawGroup[]> {
  const stops = stopRefs.map((s) => `^${s}`);
  const chain = lines((await git(repo, ['rev-list', '--first-parent', '--parents', fromSha, ...stops])).stdout).map((l) => l.split(' '));
  const byName = new Map<string, RawGroup>();
  const add = (name: string, tips: string[], commits: string[]) => {
    const g = byName.get(name) ?? { name, tips: [], commits: [] };
    for (const t of tips) if (!g.tips.includes(t)) g.tips.push(t);
    for (const c of commits) if (!g.commits.includes(c)) g.commits.push(c);
    byName.set(name, g);
  };
  const direct: string[] = [];
  for (const [m, ...parents] of chain) {
    if (parents.length < 2) { direct.push(m); continue; }
    const [first, ...rest] = parents;
    const subject = (await git(repo, ['log', '-1', '--format=%s', m])).stdout.trim();
    // git's octopus message names each branch: one group per parent then.
    const quoted = /^Merge branches /.test(subject) ? [...subject.matchAll(/'([A-Za-z0-9._/-]+)'/g)].map((x) => x[1]) : [];
    const seen = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const owned = lines((await git(repo, ['rev-list', '--no-merges', rest[i], `^${first}`, ...rest.slice(0, i).map((p) => `^${p}`), ...stops])).stdout).filter((c) => !seen.has(c));
      for (const c of owned) seen.add(c);
      let name: string | null = quoted.length === rest.length ? quoted[i] : null;
      if (!name && rest.length === 1) {
        for (const re of NAME_RES) { const x = re.exec(subject); if (x && x[1] && !/^(pull|request|branches)$/.test(x[1])) { name = x[1].replace(/^refs\/heads\//, ''); break; } }
      }
      if (!name) {
        const at = lines((await git(repo, ['for-each-ref', '--points-at', rest[i], '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])).stdout);
        name = at[0] ?? `(merge ${m.slice(0, 7)})`;
      }
      add(name, [rest[i]], owned);
    }
  }
  const out = [...byName.values()];
  if (direct.length) out.push({ name: 'direct', tips: [], commits: direct });
  return out;
}

// ─── The report ─────────────────────────────────────────────────────────────────

const branchOk = (n: string) => validBase(n) && !n.startsWith('(');
const yymmdd = (d = new Date()) => `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

function reportKey(groups: readonly ReturnGroup[]): string {
  const rows = groups.map((g) => `${g.name}:${[...g.tips].sort().join(',')}:${g.commits.filter((c) => c.state === 'awaiting').map((c) => c.sha).sort().join(',')}`).sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

interface Ctx {
  repo: string; remote: string | null; topic: string; dev: Destination | null; prs: PrRow[] | null; unreadable: PrRow[];
  index: Awaited<ReturnType<typeof buildIndex>>; rescueDests: Destination[];
}

async function stateOf(ctx: Ctx, sha: string): Promise<{ state: ReturnState; via?: ReturnCommit['via'] }> {
  if (ctx.index.info(sha)?.fit) return { state: 'fit' };
  for (const d of ctx.index.destinations) {
    const home = d.kind === 'dev' || (d.kind === 'pr-merged' && d.mergeOid && ctx.dev && (await isAncestor(ctx.repo, d.mergeOid, ctx.dev.sha)));
    if (!home) continue;
    const how = await ctx.index.has(sha, d);
    if (how) return { state: 'represented', via: { kind: d.kind, how, ...(d.pr ? { pr: d.pr } : {}) } };
  }
  for (const d of ctx.index.destinations) {
    if (d.kind !== 'pr-open' && d.kind !== 'pr-merged') continue;
    const how = await ctx.index.has(sha, d);
    if (how) return { state: 'inPr', via: { kind: d.kind, how, ...(d.pr ? { pr: d.pr } : {}) } };
  }
  for (const d of ctx.rescueDests) {
    const how = await ctx.index.has(sha, d);
    if (how) return { state: 'inRescue', via: { kind: 'rescue', how, ...(d.ref ? { ref: d.ref } : {}) } };
  }
  return { state: 'awaiting' };
}

function commandsFor(ctx: Ctx, g: ReturnGroup, awaitingShas: string[]): string[] {
  const r = ctx.remote ?? '<remote>';
  const body = `Kesim ${ctx.topic}: dev'e dönüş (kesim-geri-donus)`;
  const pr = (b: string) => `gh pr create --draft --base dev --head ${b} --title "${b}" --body "${body}"`;
  if (g.action === 'push') return [`git push ${r} refs/heads/${g.name}:refs/heads/${g.name}`];
  if (g.action === 'push-pr') return [`git push ${r} refs/heads/${g.name}:refs/heads/${g.name}`, pr(g.name)];
  if (g.action === 'rescue' && g.rescueBranch) {
    const b = g.rescueBranch;
    const path = `~/.claude-worktrees/iade-${b.slice('super/'.length)}`;
    const local = ctx.rescueDests.some((d) => d.ref === b);
    return [
      `git fetch ${r} dev`,
      local ? `git worktree add ${path} ${b}` : `git worktree add -b ${b} ${path} ${r}/dev`,
      `git -C ${path} cherry-pick -x ${awaitingShas.slice().reverse().join(' ')}`,
      `git -C ${path} push ${r} refs/heads/${b}:refs/heads/${b}`,
      pr(b),
    ];
  }
  return [];
}

async function judgeGroups(ctx: Ctx, raw: readonly RawGroup[], stopsForForeign: readonly string[]): Promise<ReturnGroup[]> {
  const out: ReturnGroup[] = [];
  await ctx.index.prime(raw.flatMap((g) => g.commits));
  for (const g of raw) {
    const commits: ReturnCommit[] = [];
    for (const sha of g.commits) {
      const s = await stateOf(ctx, sha);
      const note = s.state === 'awaiting' && ctx.unreadable.some((p) => p.headRef === g.name) ? 'PR head okunamadı' : undefined;
      commits.push({ sha, subject: ctx.index.info(sha)?.subject ?? '', state: s.state, ...(s.via ? { via: s.via } : {}), ...(note ? { note } : {}) });
    }
    const isDirect = g.name === 'direct';
    const exists = !isDirect && branchOk(g.name) && (await git(ctx.repo, ['show-ref', '--verify', '--quiet', `refs/heads/${g.name}`])).code === 0;
    // Work the branch carries beyond this group that is not home (another branch merged into it).
    let foreign = 0;
    if (exists && stopsForForeign.length) {
      const own = new Set(g.commits);
      const extra = lines((await git(ctx.repo, ['rev-list', '--no-merges', `refs/heads/${g.name}`, ...stopsForForeign.map((s) => `^${s}`)])).stdout).filter((s) => !own.has(s));
      await ctx.index.prime(extra);
      for (const s of extra) {
        const st = await stateOf(ctx, s);
        if (st.state === 'awaiting' || st.state === 'inRescue') foreign++;
      }
    }
    const group: ReturnGroup = { name: g.name, branchExists: exists, tips: g.tips, commits, foreign, action: 'none', commands: [] };
    const awaiting = commits.filter((c) => c.state === 'awaiting').map((c) => c.sha);
    const inRescue = commits.some((c) => c.state === 'inRescue');
    const inPr = commits.some((c) => c.state === 'inPr');
    if (awaiting.length) {
      if (isDirect || !exists || foreign > 0) {
        group.action = 'rescue';
        group.rescueBranch = rescueName(ctx, isDirect ? `super/${ctx.topic}` : g.name);
      } else group.action = inPr ? 'push' : 'push-pr';
    } else if (inRescue) {
      group.action = 'push-pr';
    }
    if (group.action === 'push-pr' && !awaiting.length && inRescue) {
      // The rescue branch carries it: push that one, never write a new rescue.
      const ref = commits.find((c) => c.state === 'inRescue' && c.via?.ref)?.via?.ref;
      if (ref) { group.rescueBranch = ref; group.commands = commandsFor(ctx, { ...group, name: ref, action: 'push-pr' }, []); }
    } else group.commands = commandsFor(ctx, group, awaiting);
    out.push(group);
  }
  return out;
}

/** D11: `super/<x>-iade`; one whose PR is merged gets a dated sibling. */
function rescueName(ctx: Ctx, of: string): string {
  const base = `super/${of.replace(/^super\//, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase().slice(0, 50)}-iade`;
  const merged = (ctx.prs ?? []).some((p) => p.headRef === base && p.merged);
  const open = (ctx.prs ?? []).some((p) => p.headRef === base && p.state === 'open');
  return merged && !open ? `${base}-${yymmdd()}` : base;
}

/** The running CLI's build stamp (D7). */
export function runningStamp(): ReturnType<typeof readBuildStamp> {
  const pkg = findPackageDir('package.json');
  return pkg ? readBuildStamp(dirname(pkg)) : null;
}

/**
 * `super returns`: the cut at `fromRef` against remote dev (awaiting, in a PR, in a rescue branch,
 * fit), and what each installed CLI would lose if this cut replaced it (drops).
 */
export async function pendingReturns(repo: string, fromRef: string, o: { installed?: InstalledEntry[]; gh?: GhRunner; fetch?: boolean } = {}): Promise<ReturnsReport> {
  const gh = o.gh ?? defaultGh;
  const fromSha = await resolveCommit(repo, fromRef);
  if (!fromSha) throw new Error(`${fromRef} is not a commit in this repo`);
  const topic = fromRef.replace(/^refs\/heads\//, '').replace(/^super\//, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'kesim';
  const notes: string[] = [];
  const remote = await pickRemote(repo);
  let dev: ReturnsReport['dev'] = null;
  let error: string | undefined;
  if (remote) {
    let stale = false; let why: string | undefined;
    if (o.fetch !== false) {
      const f = await git(repo, ['fetch', '--no-tags', '--quiet', remote, 'dev']);
      if (f.code !== 0) { stale = true; why = `git fetch ${remote} dev failed: ${f.stderr.trim().slice(0, 200) || `exit ${f.code}`}`; }
    }
    const sha = await resolveCommit(repo, `refs/remotes/${remote}/dev`);
    if (sha) dev = { ref: `${remote}/dev`, sha, stale, ...(why ? { why } : {}) };
    else error = `no remote dev (${remote}/dev unreadable)`;
  } else error = 'no remote dev';
  let localDevBehind: number | null = null;
  if (dev && (await git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/dev'])).code === 0) {
    localDevBehind = Number((await git(repo, ['rev-list', '--count', `refs/heads/dev..${dev.sha}`])).stdout.trim()) || 0;
  }

  let prs: PrRow[] | null = null;
  let unreadable: PrRow[] = [];
  const dests: Destination[] = [];
  if (dev && remote) {
    dests.push({ kind: 'dev', sha: dev.sha, ref: dev.ref });
    const listed = await listPrs(repo, remote, gh);
    if (listed.note) notes.push(listed.note);
    if (listed.prs) {
      prs = listed.prs.filter((p) => p.merged || p.state === 'open');
      const have = await fetchPrHeads(repo, remote, prs);
      unreadable = prs.filter((p) => !have.has(p.head));
      if (unreadable.length) notes.push(`PR head okunamadı: #${unreadable.map((p) => p.number).join(', #')}`);
      for (const p of prs.filter((x) => have.has(x.head))) {
        dests.push({ kind: p.merged ? 'pr-merged' : 'pr-open', sha: p.head, pr: p.number, url: p.url, ...(p.mergeOid ? { mergeOid: p.mergeOid } : {}) });
      }
    }
  }
  const rescueDests: Destination[] = [];
  for (const l of lines((await git(repo, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads/super'])).stdout)) {
    const [sha, ref] = l.split(' ');
    if (ref && /-iade(-\d{6})?$/.test(ref) && SHA_RE.test(sha)) rescueDests.push({ kind: 'rescue', sha, ref });
  }

  const report: ReturnsReport = {
    key: '', from: { ref: fromRef, sha: fromSha }, dev, localDevBehind,
    awaiting: [], inPr: [], inRescue: [], fit: [],
    drops: { asked: [], rows: [], errors: [] }, notes,
    ...(error ? { error } : {}),
  };
  if (dev) {
    const stops = [dev.sha];
    const index = await buildIndex(repo, fromSha, [...dests, ...rescueDests], stops);
    const ctx: Ctx = { repo, remote, topic, dev: dests[0], prs, unreadable, index, rescueDests };
    // The index lists rescue destinations separately: `stateOf` walks its own list for them.
    (index.destinations as Destination[]).splice(0, index.destinations.length, ...dests);
    const groups = await judgeGroups(ctx, await groupsOf(repo, fromSha, stops), stops);
    for (const g of groups) {
      for (const c of g.commits) if (c.state === 'fit') report.fit.push(c);
      const states = new Set(g.commits.map((c) => c.state));
      if (states.has('awaiting')) report.awaiting.push(g);
      else if (states.has('inPr')) report.inPr.push(g);
      else if (states.has('inRescue')) report.inRescue.push(g);
    }
  }
  report.key = reportKey(report.awaiting);

  const installed = o.installed ?? (() => {
    const s = runningStamp();
    return s?.sha ? [{ npm: 'running', sha: s.sha, source: 'stamp' as const }] : [];
  })();
  for (const e of installed) {
    report.drops.asked.push({ npm: e.npm, installed: e.sha });
    try {
      const sha = await resolveCommit(repo, e.sha);
      if (!sha) throw new Error(`installed commit ${e.sha.slice(0, 12)} is not in this repo`);
      report.drops.rows.push({ installed: e.sha, npm: e.npm, source: e.source, groups: await droppedFrom(repo, fromSha, sha, gh, prs) });
    } catch (err) {
      report.drops.errors.push({ npm: e.npm, error: (err as Error).message });
    }
  }
  return report;
}

/**
 * D4: the work the installed build holds that the candidate cut does not. Destinations: the
 * candidate, and merged PR heads whose merge commit the candidate holds. No remote needed.
 */
export async function droppedFrom(repo: string, candidateSha: string, installedSha: string, gh?: GhRunner, prsIn?: PrRow[] | null): Promise<ReturnGroup[]> {
  void gh;
  const raw = await groupsOf(repo, installedSha, [candidateSha]);
  if (!raw.length) return [];
  const dests: Destination[] = [{ kind: 'candidate', sha: candidateSha }];
  for (const p of prsIn ?? []) {
    if (p.merged && p.mergeOid && (await isAncestor(repo, p.mergeOid, candidateSha)) && (await hasObjects(repo, [p.head])).has(p.head)) dests.push({ kind: 'pr-merged', sha: p.head, pr: p.number, mergeOid: p.mergeOid });
  }
  const index = await buildIndex(repo, installedSha, dests, [candidateSha]);
  await index.prime(raw.flatMap((g) => g.commits));
  const out: ReturnGroup[] = [];
  for (const g of raw) {
    const dropped: ReturnCommit[] = [];
    for (const sha of g.commits) {
      if (index.info(sha)?.fit) continue;
      let held = false;
      for (const d of dests) if (await index.has(sha, d)) { held = true; break; }
      if (!held) dropped.push({ sha, subject: index.info(sha)?.subject ?? '', state: 'awaiting' });
    }
    if (dropped.length) out.push({ name: g.name, branchExists: false, tips: g.tips, commits: dropped, foreign: 0, action: 'none', commands: [] });
  }
  return out;
}

/** D5: mark `shas` (each a `direct` commit of the cut at `from`) as cut-fit with a git note. */
export async function markFit(repo: string, shas: readonly string[], why: string, o: { from?: string } = {}): Promise<string[]> {
  const text = why.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
  if (!text) throw new Error('--why is required');
  const fromSha = await resolveCommit(repo, o.from ?? 'HEAD');
  if (!fromSha) throw new Error('the cut is not a commit');
  const remote = await pickRemote(repo);
  const devSha = remote ? await resolveCommit(repo, `refs/remotes/${remote}/dev`) : null;
  const direct = new Set((await groupsOf(repo, fromSha, devSha ? [devSha] : [])).find((g) => g.name === 'direct')?.commits ?? []);
  const marked: string[] = [];
  for (const s of shas) {
    const sha = await resolveCommit(repo, s);
    if (!sha || !direct.has(sha)) throw new Error(`${s} is not a commit written directly on the cut`);
    const r = await git(repo, ['notes', `--ref=${FIT_NOTES_REF}`, 'add', '-f', '-m', `Cut-fit: ${text}`, sha]);
    if (r.code !== 0) throw new Error(`git notes: ${r.stderr.trim().slice(0, 200)}`);
    marked.push(sha);
  }
  return marked;
}

/** K6: a package dir's `dist/build-commit.json`; a symlinked stamp, or one whose real path
 *  leaves the package, is no stamp. */
export function readBuildStamp(packageDir: string): { sha: string | null; branch: string | null; dirty: boolean; builtAt: string; acceptedDrops?: unknown } | null {
  try {
    const root = realpathSync(packageDir);
    const p = join(packageDir, 'dist', 'build-commit.json');
    if (lstatSync(p).isSymbolicLink() || lstatSync(join(packageDir, 'dist')).isSymbolicLink()) return null;
    const real = realpathSync(p);
    if (!real.startsWith(root + sep)) return null;
    const j = JSON.parse(readFileSync(real, 'utf-8')) as Record<string, unknown>;
    const sha = typeof j.sha === 'string' && SHA_RE.test(j.sha) ? j.sha : null;
    return {
      sha, branch: typeof j.branch === 'string' ? j.branch.slice(0, 200) : null, dirty: j.dirty === true,
      builtAt: typeof j.builtAt === 'string' ? j.builtAt.slice(0, 40) : '',
      ...(j.acceptedDrops !== undefined ? { acceptedDrops: j.acceptedDrops } : {}),
    };
  } catch { return null; }
}

/** The report as readable lines (`super returns` without --json). */
export function renderReturns(r: ReturnsReport): string {
  const out: string[] = [`super returns of ${r.from.ref} (${r.from.sha.slice(0, 9)})`];
  out.push(r.dev ? `dev: ${r.dev.ref} ${r.dev.sha.slice(0, 9)}${r.dev.stale ? ` (stale: ${r.dev.why})` : ''}` : `dev: none (${r.error})`);
  if (r.localDevBehind) out.push(`local dev is ${r.localDevBehind} commits behind ${r.dev?.ref} (left as it is)`);
  const show = (title: string, gs: readonly ReturnGroup[]) => {
    out.push('', `${title}: ${gs.length}`);
    gs.forEach((g, i) => {
      out.push(`  ${i + 1}. ${g.name}  action=${g.action}${g.rescueBranch ? ` rescue=${g.rescueBranch}` : ''}${g.foreign ? ` foreign=${g.foreign}` : ''}${g.branchExists ? '' : ' (no local branch)'}`);
      for (const c of g.commits) out.push(`       ${c.sha.slice(0, 9)} ${c.state.padEnd(11)} ${c.subject}${c.via ? `  [${c.via.kind}${c.via.pr ? ` #${c.via.pr}` : ''} by ${c.via.how}]` : ''}${c.note ? `  (${c.note})` : ''}`);
      for (const cmd of g.commands) out.push(`       $ ${cmd}`);
    });
  };
  show('awaiting (not home, no PR)', r.awaiting);
  show('in a PR into dev', r.inPr);
  show('in a local rescue branch', r.inRescue);
  out.push('', `cut-fit commits: ${r.fit.length}`, ...r.fit.map((c) => `  ${c.sha.slice(0, 9)} ${c.subject}`));
  out.push('', 'installed builds:');
  for (const row of r.drops.rows) {
    out.push(`  ${row.npm} @ ${row.installed.slice(0, 9)} (${row.source}): ${row.groups.length ? `${row.groups.reduce((n, g) => n + g.commits.length, 0)} commits this cut would DROP` : 'nothing dropped'}`);
    for (const g of row.groups) { out.push(`    ${g.name}`); for (const c of g.commits) out.push(`      ${c.sha.slice(0, 9)} ${c.subject}`); }
  }
  for (const e of r.drops.errors) out.push(`  ${e.npm}: ERROR ${e.error}`);
  if (r.notes.length) out.push('', 'notes:', ...r.notes.map((n) => `  ${n}`));
  out.push('', `key ${r.key}`);
  return out.join('\n');
}
