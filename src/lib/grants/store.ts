/**
 * The grant store (plan uye-bildirim K3 "Store"): ONE machine-local directory,
 * `~/.dreamcontext/grants/`, never in the brain and never synced.
 *
 *   rules/<id>.json      member rules (end only by removal)
 *   jobs/<id>.json       job grants (die with their session, their requests, or after a day)
 *   once/<id>.json       one-shot grants, consumed by rename: whoever renames it is the one user
 *   bindings/<pid>.json  who a spawned process is (written by the server, read by whoAmI)
 *
 * Directories 0700, files 0600, every write a temp file renamed into place. Every reader is total:
 * a corrupt, unreadable or hand-shaped file is "no grant", never a throw, because an enforcer that
 * throws must not be read as allowing anything.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  GRANT_FORMS, GRANT_SCOPES, type Binding, type CrewKind, type Grant, type GrantScope, type ScriptPin,
} from './types.js';
import { grantExpiry } from './match.js';

export interface StoreOpts { home?: string }

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_INPUT = 64 * 1024;
const MAX_REQUESTS = 32;
const MAX_CONVERSATIONS = 16;
const SUBDIR: Record<GrantScope, string> = { once: 'once', job: 'jobs', member: 'rules' };
const CREWS: readonly CrewKind[] = ['main', 'member', 'child'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  // A directory made before (or by someone else's umask) is tightened, not trusted.
  try { chmodSync(p, 0o700); } catch { /* best effort */ }
  return p;
}

/** `<home>/.dreamcontext/grants`, created 0700. */
export function grantsDir(home: string = homedir()): string {
  return ensureDir(join(home, '.dreamcontext', 'grants'));
}

/** The same path, without creating anything (readers never write). */
function baseDir(opts?: StoreOpts): string {
  return join(opts?.home ?? homedir(), '.dreamcontext', 'grants');
}

function sub(name: string, opts?: StoreOpts): string {
  return ensureDir(join(grantsDir(opts?.home ?? homedir()), name));
}

function atomicWrite(dir: string, name: string, body: unknown): void {
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
  try { renameSync(tmp, join(dir, name)); } catch (err) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw err;
  }
}

function readJson(p: string): unknown {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; }
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch { return []; }
}

/** A fresh grant id (the route writes it; nothing derives meaning from it). */
export function newGrantId(scope: GrantScope): string {
  return `${scope}-${randomBytes(12).toString('base64url')}`;
}

function cleanPin(v: unknown): ScriptPin | undefined {
  if (!isRecord(v)) return undefined;
  if (!str(v.interpreter, 32) || !str(v.interpreterPath) || !str(v.scriptPath) || !str(v.sha256, 128)) return undefined;
  return {
    interpreter: v.interpreter, interpreterPath: v.interpreterPath, scriptPath: v.scriptPath, sha256: v.sha256,
    ...(str(v.interpreterSha, 128) ? { interpreterSha: v.interpreterSha } : {}),
  };
}

/** A grant re-validated whole; anything off-shape is null (never half a grant). */
export function cleanGrant(v: unknown): Grant | null {
  if (!isRecord(v)) return null;
  if (!str(v.id, 80) || !ID_RE.test(v.id)) return null;
  if (!(GRANT_SCOPES as readonly unknown[]).includes(v.scope) || !(GRANT_FORMS as readonly unknown[]).includes(v.form)) return null;
  const scope = v.scope as GrantScope;
  const form = v.form as Grant['form'];
  if (!str(v.project) || !str(v.tool, 200) || typeof v.input !== 'string' || v.input.length > MAX_INPUT) return null;
  if (!num(v.createdAt) || !num(v.expiresAt)) return null;
  const pin = str(v.pin, 200) ? v.pin : undefined;
  const member = str(v.member, 100) ? v.member : undefined;
  if (scope === 'member' ? !member : !pin) return null;
  const script = form === 'script' ? cleanPin(v.script) : undefined;
  if (form === 'script' && !script) return null;
  const requests = Array.isArray(v.requests)
    ? [...new Set(v.requests.filter((r): r is string => str(r, 120)))].slice(0, MAX_REQUESTS) : undefined;
  return {
    id: v.id, scope, project: v.project, tool: v.tool, input: v.input, form, createdAt: v.createdAt, expiresAt: v.expiresAt,
    ...(scope !== 'member' && pin ? { pin } : {}),
    ...(scope === 'member' && member ? { member } : {}),
    ...(script ? { script } : {}),
    ...(str(v.item, 120) ? { item: v.item } : {}),
    ...(requests?.length ? { requests } : {}),
  };
}

export function writeGrant(g: Grant, opts?: StoreOpts): void {
  const clean = cleanGrant(g);
  if (!clean) throw new Error('grant: refused an off-shape grant');
  atomicWrite(sub(SUBDIR[clean.scope], opts), `${clean.id}.json`, clean);
}

/** Every grant of one scope directory; a file whose scope is not its directory's is ignored. */
function readScope(scope: GrantScope, opts?: StoreOpts): Grant[] {
  const dir = join(baseDir(opts), SUBDIR[scope]);
  const out: Grant[] = [];
  for (const f of listJson(dir)) {
    const g = cleanGrant(readJson(join(dir, f)));
    if (g && g.scope === scope && `${g.id}.json` === f) out.push(g);
  }
  return out;
}

/** Every grant of a project (all of them when `project` is omitted). Never throws. */
export function listGrants(project?: string, opts?: StoreOpts): Grant[] {
  try {
    const all = GRANT_SCOPES.flatMap((s) => readScope(s, opts));
    return project === undefined ? all : all.filter((g) => g.project === project);
  } catch { return []; }
}

export function removeGrant(id: string, opts?: StoreOpts): boolean {
  if (!ID_RE.test(id)) return false;
  let removed = false;
  for (const s of GRANT_SCOPES) {
    try { unlinkSync(join(baseDir(opts), SUBDIR[s], `${id}.json`)); removed = true; } catch { /* not this one */ }
  }
  return removed;
}

/** Every rule of a member (in one project, or everywhere): the owner removed it, or the member is gone. */
export function removeMemberGrants(member: string, project?: string, opts?: StoreOpts): number {
  let n = 0;
  for (const g of readScope('member', opts)) {
    if (g.member !== member || (project !== undefined && g.project !== project)) continue;
    if (removeGrant(g.id, opts)) n += 1;
  }
  return n;
}

/**
 * Spend a one-shot. The rename is the lock: two enforcers racing on one id both try it, exactly
 * one succeeds, the other finds nothing. True only for the winner.
 */
export function consumeOnce(id: string, opts?: StoreOpts): boolean {
  if (!ID_RE.test(id)) return false;
  const dir = join(baseDir(opts), 'once');
  const spent = join(dir, `.spent-${id}.${process.pid}.${randomBytes(6).toString('hex')}`);
  try { renameSync(join(dir, `${id}.json`), spent); } catch { return false; }
  try { unlinkSync(spent); } catch { /* left as a dot-file; never read as a grant */ }
  return true;
}

export interface PruneFacts {
  now: number;
  /** Pins of the sessions still running. */
  livePins: Iterable<string>;
  /** Requests still open (a member Super's job grant lives while one it was given under is). */
  openRequests: Iterable<string>;
  /** Owner items still open; when given, a one-shot whose item closed dies. */
  openItems?: Iterable<string>;
}

/** The deaths (K3 "Scopes and their deaths"). Member rules are never pruned here. Returns the ids removed. */
export function pruneGrants(facts: PruneFacts, opts?: StoreOpts): string[] {
  const live = new Set(facts.livePins);
  const open = new Set(facts.openRequests);
  const items = facts.openItems === undefined ? null : new Set(facts.openItems);
  const gone: string[] = [];
  for (const g of [...readScope('once', opts), ...readScope('job', opts)]) {
    const expired = !(grantExpiry(g) > facts.now);
    const dead = g.scope === 'once'
      ? expired || (items !== null && !!g.item && !items.has(g.item))
      : expired || !live.has(g.pin ?? '') || (!!g.requests?.length && !g.requests.some((r) => open.has(r)));
    if (dead && removeGrant(g.id, opts)) gone.push(g.id);
  }
  return gone;
}

// ─── Bindings ──────────────────────────────────────────────────────────────────────────────

export function cleanBinding(v: unknown): Binding | null {
  if (!isRecord(v)) return null;
  if (typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 1) return null;
  if (!str(v.startedAt, 64) || !str(v.pin, 200) || !str(v.project) || !CREWS.includes(v.crew as CrewKind) || !num(v.writtenAt)) return null;
  if (!Array.isArray(v.conversationIds)) return null;
  const conversationIds = v.conversationIds.filter((c): c is string => str(c, 200)).slice(-MAX_CONVERSATIONS);
  return {
    pid: v.pid, startedAt: v.startedAt, pin: v.pin, project: v.project, crew: v.crew as CrewKind, conversationIds, writtenAt: v.writtenAt,
    ...(str(v.member, 100) ? { member: v.member } : {}),
  };
}

export function writeBinding(b: Binding, opts?: StoreOpts): void {
  const clean = cleanBinding(b);
  if (!clean) throw new Error('grant: refused an off-shape binding');
  atomicWrite(sub('bindings', opts), `${clean.pid}.json`, clean);
}

export function readBinding(pid: number, opts?: StoreOpts): Binding | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const b = cleanBinding(readJson(join(baseDir(opts), 'bindings', `${pid}.json`)));
  return b && b.pid === pid ? b : null;
}

/** The process reported a conversation at `init`: it becomes the current one (the id can change
 *  without a respawn). False when the process has no binding. */
export function addConversationId(pid: number, id: string, opts?: StoreOpts): boolean {
  const b = readBinding(pid, opts);
  if (!b || !str(id, 200)) return false;
  const ids = [...b.conversationIds.filter((c) => c !== id), id].slice(-MAX_CONVERSATIONS);
  writeBinding({ ...b, conversationIds: ids, writtenAt: Date.now() }, opts);
  return true;
}

export function removeBinding(pid: number, opts?: StoreOpts): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { unlinkSync(join(baseDir(opts), 'bindings', `${pid}.json`)); } catch { /* gone */ }
}

/** Every binding that has seen this conversation id, newest first (a dead process's binding may
 *  linger until the server removes it; whoAmI tells them apart by pid and start time). */
export function bindingsByConversation(id: string, opts?: StoreOpts): Binding[] {
  if (!str(id, 200)) return [];
  const dir = join(baseDir(opts), 'bindings');
  const out: Binding[] = [];
  for (const f of listJson(dir)) {
    const b = cleanBinding(readJson(join(dir, f)));
    if (b && `${b.pid}.json` === f && b.conversationIds.includes(id)) out.push(b);
  }
  return out.sort((a, b) => b.writtenAt - a.writtenAt);
}

export function bindingByConversation(id: string, opts?: StoreOpts): Binding | null {
  return bindingsByConversation(id, opts)[0] ?? null;
}
