import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scrubContent } from './git-sync/scrub.js';
import { resolveLinkedRepos } from './linked-repos.js';
import { readJournal } from './task-journal.js';

/**
 * Evidence-gated criteria — the code half of "evidence changes status".
 *
 * A criterion is a `- [ ] <text>` line of Acceptance Criteria. It is ticked
 * ONLY with a reference to its proof: `- [x] <text> (evidence: <ref>)`, where
 *   cmd:<je_id>     an `evidence` journal entry (a command run by `tasks check --run`)
 *   commit:<sha>    a commit reachable from a linked repo's current branch
 *   shot:<path>     a project-relative screenshot that exists
 *   owner:<je_id>   an `approval` journal entry (the owner, from the dashboard or `tasks approve`)
 *   legacy          ticked before evidence existed (migration): enough for review, never for done
 * Refs are validated when the box is ticked. The status gate then reads only
 * their presence and kind — evidence entries are machine-local (they never
 * sync), so a card pulled from another machine is not re-resolved.
 * A criterion that says `(observed)` is about what the owner sees: it can only
 * close through review and the owner's approval.
 */

export type EvidenceKind = 'cmd' | 'commit' | 'shot' | 'owner' | 'legacy';

export interface Criterion {
  /** 1-based position among the section's criteria. */
  n: number;
  /** Line index inside the section text. */
  line: number;
  checked: boolean;
  /** Text without the checkbox and without the evidence suffix. */
  text: string;
  evidence: string | null;
  observed: boolean;
}

const CRIT_RE = /^(\s*[-*+]\s+)\[( |x|X)\](\s+)(.*?)\s*$/;
const EVIDENCE_SUFFIX_RE = /\s*\(evidence:\s*([^)]+)\)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

export function parseCriteria(section: string): Criterion[] {
  const out: Criterion[] = [];
  let inFence = false;
  section.split('\n').forEach((raw, line) => {
    if (FENCE_RE.test(raw)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = CRIT_RE.exec(raw);
    if (!m) return;
    const ev = EVIDENCE_SUFFIX_RE.exec(m[4]);
    const text = ev ? m[4].slice(0, ev.index).trim() : m[4].trim();
    out.push({
      n: out.length + 1,
      line,
      checked: m[2] !== ' ',
      text,
      evidence: ev ? ev[1].trim() : null,
      observed: /\(observed\)/i.test(text),
    });
  });
  return out;
}

export function evidenceKind(ref: string | null): EvidenceKind | null {
  if (!ref) return null;
  if (ref === 'legacy') return 'legacy';
  const m = /^(cmd|commit|shot|owner):\S+$/.exec(ref);
  return m ? (m[1] as EvidenceKind) : null;
}

/** A typed `owner:<date>` is not an approval: it proves nothing (E6). */
export function isTypedOwnerDate(ref: string | null): boolean {
  return !!ref && /^owner:\d{4}-\d{2}-\d{2}$/.test(ref);
}

/** The kind of a ref that counts as proof, or null (missing, malformed, typed owner date). */
function provenKind(ref: string | null): EvidenceKind | null {
  return isTypedOwnerDate(ref) ? null : evidenceKind(ref);
}

// ─── Locating the Acceptance Criteria section in a card body ────────────────

interface SectionSpan { start: number; end: number }

/** The line span (exclusive end) of `## Acceptance Criteria`'s body inside `body`. */
function criteriaSpan(lines: string[]): SectionSpan | null {
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (!h) continue;
    if (start >= 0) return { start, end: i };
    if (h[1].toLowerCase().replace(/[^a-z]/g, '') === 'acceptancecriteria') start = i + 1;
  }
  return start >= 0 ? { start, end: lines.length } : null;
}

export function criteriaOfBody(body: string): Criterion[] {
  const lines = body.split('\n');
  const span = criteriaSpan(lines);
  return span ? parseCriteria(lines.slice(span.start, span.end).join('\n')) : [];
}

export type PickResult =
  | { ok: true; criterion: Criterion }
  | { ok: false; reason: string; candidates: Criterion[] };

/** Pick a criterion by 1-based number or by text (case-insensitive substring; exactly one must match). */
export function pickCriterion(criteria: Criterion[], which: string): PickResult {
  if (/^\d+$/.test(which.trim())) {
    const c = criteria.find((x) => x.n === Number(which.trim()));
    return c ? { ok: true, criterion: c } : { ok: false, reason: `No criterion #${which} (there are ${criteria.length}).`, candidates: criteria };
  }
  const needle = which.trim().toLowerCase();
  const hits = criteria.filter((c) => c.text.toLowerCase().includes(needle));
  if (hits.length === 1) return { ok: true, criterion: hits[0] };
  return {
    ok: false,
    reason: hits.length === 0 ? `No criterion matches "${which}".` : `"${which}" matches ${hits.length} criteria — name one by number or a longer phrase.`,
    candidates: hits.length === 0 ? criteria : hits,
  };
}

/** Set one criterion's box (and its evidence ref) in a card body. */
export function setCriterion(body: string, n: number, checked: boolean, ref: string | null): string {
  const lines = body.split('\n');
  const span = criteriaSpan(lines);
  if (!span) return body;
  const crit = parseCriteria(lines.slice(span.start, span.end).join('\n')).find((c) => c.n === n);
  if (!crit) return body;
  const at = span.start + crit.line;
  const m = CRIT_RE.exec(lines[at])!;
  const suffix = checked && ref ? ` (evidence: ${ref})` : '';
  lines[at] = `${m[1]}[${checked ? 'x' : ' '}]${m[3]}${crit.text}${suffix}`;
  return lines.join('\n');
}

// ─── Validating a ref at tick time ──────────────────────────────────────────

export interface RefContext {
  stateDir: string;
  slug: string;
  /** Project root (the dir that holds `_dream_context/`). */
  projectRoot: string;
}

export type RefCheck = { ok: true } | { ok: false; reason: string };

function insideReal(root: string, target: string): boolean {
  try {
    const r = realpathSync(root);
    const t = realpathSync(target);
    return t === r || t.startsWith(r + sep);
  } catch {
    return false;
  }
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function candidateRepos(projectRoot: string): string[] {
  const repos = [projectRoot];
  try {
    for (const r of resolveLinkedRepos(projectRoot)) if (r.present && r.path) repos.push(r.path);
  } catch { /* no linked repos */ }
  return repos;
}

/**
 * Prove a ref names something real. `owner:` is accepted only from the owner
 * paths (approve, the dashboard), which pass `allowOwner`.
 */
export function validateRef(ref: string, ctx: RefContext, opts: { allowOwner?: boolean; repos?: string[] } = {}): RefCheck {
  const kind = evidenceKind(ref);
  if (!kind) return { ok: false, reason: `"${ref}" is not an evidence ref (cmd:<je_id> | commit:<sha> | shot:<path>).` };
  const value = ref.slice(ref.indexOf(':') + 1);
  switch (kind) {
    case 'legacy':
      return { ok: false, reason: '"legacy" is what the migration wrote on old ticks; new ticks name real evidence.' };
    case 'cmd': {
      const e = readJournal(ctx.stateDir, ctx.slug).find((x) => x.id === value);
      if (!e) return { ok: false, reason: `cmd:${value} names no journal entry of ${ctx.slug}.` };
      if (e.kind !== 'evidence') return { ok: false, reason: `cmd:${value} is a ${e.kind} entry, not evidence (record it with tasks check --run).` };
      return { ok: true };
    }
    case 'owner': {
      if (!opts.allowOwner) return { ok: false, reason: 'owner: refs are written only by the owner (tasks approve, or a tick in the dashboard).' };
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, reason: `owner:${value} is a typed date; an owner ref names its approval entry.` };
      const e = readJournal(ctx.stateDir, ctx.slug).find((x) => x.id === value);
      if (!e || e.kind !== 'approval') return { ok: false, reason: `owner:${value} names no approval entry of ${ctx.slug}.` };
      return { ok: true };
    }
    case 'commit': {
      if (!/^[0-9a-f]{7,40}$/i.test(value)) return { ok: false, reason: `commit:${value} is not a commit sha.` };
      for (const repo of opts.repos ?? candidateRepos(ctx.projectRoot)) {
        if (!existsSync(repo)) continue;
        if (gitOk(repo, ['cat-file', '-e', `${value}^{commit}`]) && gitOk(repo, ['merge-base', '--is-ancestor', value, 'HEAD'])) {
          return { ok: true };
        }
      }
      return { ok: false, reason: `commit:${value} is not reachable from the current branch of this project or a linked repo.` };
    }
    case 'shot': {
      if (!value || isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        return { ok: false, reason: `shot:${value} must be a project-relative path.` };
      }
      const abs = resolve(ctx.projectRoot, value);
      if (!existsSync(abs)) return { ok: false, reason: `shot:${value} does not exist.` };
      try {
        if (lstatSync(abs).isSymbolicLink()) return { ok: false, reason: `shot:${value} is a symlink.` };
      } catch { /* existsSync said yes */ }
      if (!insideReal(ctx.projectRoot, abs)) return { ok: false, reason: `shot:${value} resolves outside the project.` };
      return { ok: true };
    }
  }
}

// ─── The status gate ────────────────────────────────────────────────────────

export interface GateResult {
  ok: boolean;
  /** Criteria not ticked, or ticked with no evidence ref. */
  unproven: Criterion[];
  /** Set when everything is proven but only review may close it (shot/legacy/observed). */
  reviewOnly: Criterion[];
  /** A done move on a task with no criteria at all: nothing proves it. */
  noCriteria?: boolean;
}

/**
 * May the task move to a review-kind (`review`) or done-kind (`done`) status?
 * Review: every criterion ticked with a ref (a typed owner date is no ref).
 * Done directly: additionally every ref is cmd:/commit: and nothing is
 * (observed) — anything else goes through review and the owner's approval.
 */
export function gateStatus(body: string, target: 'review' | 'done'): GateResult {
  const criteria = criteriaOfBody(body);
  const unproven = criteria.filter((c) => !c.checked || !provenKind(c.evidence));
  const reviewOnly = target === 'done'
    ? criteria.filter((c) => c.checked && provenKind(c.evidence) && (c.observed || !['cmd', 'commit'].includes(provenKind(c.evidence)!)))
    : [];
  // Nothing to prove is not proof: a task with no criteria never closes on its
  // own word (it can still reach review, where the owner decides; or --force).
  const noCriteria = target === 'done' && criteria.length === 0;
  return { ok: unproven.length === 0 && reviewOnly.length === 0 && !noCriteria, unproven, reviewOnly, noCriteria };
}

export function describeGate(slug: string, statusName: string, g: GateResult): string {
  const lines: string[] = [];
  if (g.noCriteria) {
    lines.push(`${slug} cannot close: it has no acceptance criteria, so nothing proves it is done.`);
    lines.push(`Add one (dreamcontext tasks insert ${slug} acceptance_criteria "…") and prove it, or move it to review for the owner's approval.`);
  }
  if (g.unproven.length > 0) {
    lines.push(`${slug} cannot move to ${statusName}: ${g.unproven.length} criterion(s) have no evidence:`);
    for (const c of g.unproven) lines.push(`  ${c.n}. ${c.checked ? '[x] (no evidence ref) ' : '[ ] '}${c.text}`);
    lines.push(`Prove each: dreamcontext tasks check ${slug} <n> --run "<command>"   (or --evidence commit:<sha> | shot:<path>)`);
  }
  if (g.reviewOnly.length > 0) {
    lines.push(`${slug} cannot close directly: these need the owner's eye (observed, screenshot or legacy evidence):`);
    for (const c of g.reviewOnly) lines.push(`  ${c.n}. ${c.text} (evidence: ${c.evidence})`);
    lines.push(`Move it to review instead; the owner approves it from the dashboard (or \`dreamcontext tasks approve ${slug}\`).`);
  }
  return lines.join('\n');
}

// ─── Evidence text: scrubbed and capped ─────────────────────────────────────

export const EVIDENCE_TAIL_CAP = 2_000;

function knownSecretValues(projectRoot: string): string[] {
  const values: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, '_dream_context', 'state', '.secrets.json'), 'utf-8'));
    const walk = (v: unknown) => {
      if (typeof v === 'string' && v.length >= 8) values.push(v);
      else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(raw);
  } catch { /* no secrets file */ }
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL)/i.test(k)) values.push(v);
  }
  return values;
}

/**
 * The output tail an evidence entry keeps: lines the secret scrubber blocks are
 * replaced, known secret values (the task backend's tokens, secret-named env
 * vars) are masked, and only the last {@link EVIDENCE_TAIL_CAP} chars remain.
 */
export function redactEvidenceTail(output: string, projectRoot: string): string {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  for (const hit of scrubContent('evidence', output)) {
    if (hit.severity === 'block' && lines[hit.line - 1] !== undefined) lines[hit.line - 1] = `[redacted: ${hit.rule}]`;
  }
  let text = lines.join('\n');
  for (const s of knownSecretValues(projectRoot)) text = text.split(s).join('***');
  text = text.trimEnd();
  return text.length > EVIDENCE_TAIL_CAP ? `…${text.slice(text.length - EVIDENCE_TAIL_CAP)}` : text;
}

/** The body of an `evidence` journal entry. Fenced so the tail can never forge entry structure. */
export function evidenceEntryBody(input: { criterion: Criterion; command?: string; exit?: number; tail?: string; ref?: string }): string {
  const lines = [`- criterion ${input.criterion.n}: ${input.criterion.text}`];
  // One line: a newline in the command could open a `### ` heading (a forged
  // entry, shared to the remote) or a fence.
  if (input.command !== undefined) lines.push(`- cmd: \`${input.command.replace(/`/g, "'").replace(/\s*[\r\n]+\s*/g, ' ⏎ ')}\``, `- exit: ${input.exit ?? 0}`);
  if (input.ref) lines.push(`- ref: ${input.ref}`);
  if (input.tail) {
    // A tail line can never open/close a fence or start a journal heading.
    const safe = input.tail.split('\n').map((l) => (/^\s*(```|~~~)|^#{1,6}\s/.test(l) ? `\\${l}` : l)).join('\n');
    lines.push('', '```', safe, '```');
  }
  return lines.join('\n');
}

/** Run an evidence command through the shell; output is stdout then stderr. */
export function runEvidenceCommand(command: string, cwd: string): { output: string; exit: number } {
  const r = spawnSync(command, { shell: true, cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { output: `${r.stdout ?? ''}${r.stderr ?? ''}`, exit: typeof r.status === 'number' ? r.status : 1 };
}

/** The output of a command the caller already ran (`--output-file`), or null when unreadable. */
export function readEvidenceOutput(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** A relative path for display. */
export function projectRelative(projectRoot: string, abs: string): string {
  return relative(projectRoot, abs).split(sep).join('/');
}
