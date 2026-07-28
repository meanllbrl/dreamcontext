import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { APPROVAL_PAYLOAD_VERSION, type ApprovalPayloadFields, type AutomationManifest } from './types.js';

/**
 * Automations registry — the machine-local approval tripwire + project
 * registry, plus the dispatcher heartbeat. Mirrors `src/lib/linked-repos.ts`
 * EXACTLY for file mechanics: injectable `home` (defaults to `homedir()`),
 * atomic temp(pid+nonce)+rename writes, never-throw sanitizing reads.
 *
 * TYPES-ONLY import from `./types.js` — never `./store.js`. That keeps this
 * module home-injectable and layout-independent, testable against a literal
 * `AutomationManifest` object with no filesystem manifest required.
 *
 * Two files, deliberately separate:
 *  - `~/.dreamcontext/automations.json` — { projects: { <projectRoot>: { approvals } } }.
 *    Machine-local, never synced. Mutated only by explicit human actions
 *    (create/approve/revoke/register), so a lock-free read→mutate→rename is
 *    safe here exactly as it is in linked-repos.json.
 *  - `~/.dreamcontext/automations-tick.json` — the dispatcher heartbeat.
 *    Written automatically every ~5 minutes by `tick`. Putting that on the
 *    SAME file as `approvals` would let a lost update (tick reads {A}, a user
 *    approves B and writes {A,B}, tick writes back its stale {A}) silently
 *    revert an approval the user just made — a worse instance of the exact
 *    reflexive-approval failure the tripwire exists to prevent. A separate
 *    file removes that race BY CONSTRUCTION: the two writers never share a
 *    rewrite unit, so no lock protocol is needed.
 */

// ─── Registry types ─────────────────────────────────────────────────────────

/** One slug's approval record. `payloadVersion` lets a future hash-format
 *  change force clean re-approval (`payload-format-changed`) instead of
 *  comparing two incomparable hashes. */
export interface ApprovalEntry {
  manifestSha256: string;
  approvedAt: string;
  payloadVersion: string;
}

/** One project's approvals, keyed by automation slug. */
export interface ProjectRegistryEntry {
  approvals: Record<string, ApprovalEntry>;
}

/** On-disk shape of `~/.dreamcontext/automations.json`. Keyed by absolute
 *  project root (the directory containing `_dream_context/`). */
export interface AutomationsRegistry {
  projects: Record<string, ProjectRegistryEntry>;
}

/** On-disk shape of `~/.dreamcontext/automations-tick.json`. All-null when the
 *  dispatcher has never ticked (or the file is missing/malformed). */
export interface DispatcherHeartbeat {
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickDurationMs: number | null;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/** Path to the machine-global automations registry. Injectable `home` for testability. */
export function automationsRegistryPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'automations.json');
}

/** Path to the machine-global dispatcher heartbeat — a SEPARATE file from the
 *  registry (see the module doc for why). Injectable `home` for testability. */
export function dispatcherHeartbeatPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'automations-tick.json');
}

// ─── Atomic write helper (shared shape, pid+nonce temp name) ────────────────

/** Serialise `data` to a sibling temp file (pid + random nonce in the name so
 *  two writers never pick the same scratch path), then `rename` it over
 *  `filePath`. A reader never observes a half-written file. */
function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
}

// ─── Registry read (never throws, sanitizes) ────────────────────────────────

function isValidApprovalEntry(v: unknown): v is ApprovalEntry {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.manifestSha256 === 'string' &&
    e.manifestSha256.length > 0 &&
    typeof e.approvedAt === 'string' &&
    typeof e.payloadVersion === 'string'
  );
}

/**
 * Read the automations registry. Missing file ⇒ `{ projects: {} }`; malformed
 * JSON ⇒ `{ projects: {} }` + a logged notice; a project entry whose
 * `approvals` isn't a plain object is dropped; within a project, an approval
 * entry that doesn't match {@link ApprovalEntry}'s shape is dropped — sibling
 * valid entries are kept. NEVER throws (a corrupt machine-global file must
 * never break a tick or a session-start glance).
 */
export function readAutomationsRegistry(home?: string): AutomationsRegistry {
  const filePath = automationsRegistryPath(home);
  if (!existsSync(filePath)) return { projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<AutomationsRegistry>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.projects === null ||
      typeof parsed.projects !== 'object' ||
      Array.isArray(parsed.projects)
    ) {
      return { projects: {} };
    }
    const projects: Record<string, ProjectRegistryEntry> = {};
    for (const [projectRoot, entry] of Object.entries(parsed.projects as Record<string, unknown>)) {
      if (typeof projectRoot !== 'string' || projectRoot.length === 0) continue;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rawApprovals = (entry as Record<string, unknown>).approvals;
      if (!rawApprovals || typeof rawApprovals !== 'object' || Array.isArray(rawApprovals)) continue;
      const approvals: Record<string, ApprovalEntry> = {};
      for (const [slug, approval] of Object.entries(rawApprovals as Record<string, unknown>)) {
        if (typeof slug === 'string' && slug.length > 0 && isValidApprovalEntry(approval)) {
          approvals[slug] = approval;
        }
      }
      projects[projectRoot] = { approvals };
    }
    return { projects };
  } catch {
    console.error('[dreamcontext] automations.json is malformed — treating registry as empty.');
    return { projects: {} };
  }
}

/** Persist the registry atomically (temp+rename, pid+nonce). */
export function writeAutomationsRegistry(registry: AutomationsRegistry, home?: string): void {
  writeJsonAtomic(automationsRegistryPath(home), registry);
}

// ─── Project registration ───────────────────────────────────────────────────

/** Idempotently register a project (create an empty approvals bucket if one
 *  doesn't already exist). Never clobbers an existing project's approvals. */
export function registerProject(projectRoot: string, home?: string): void {
  const registry = readAutomationsRegistry(home);
  if (registry.projects[projectRoot]) return;
  registry.projects[projectRoot] = { approvals: {} };
  writeAutomationsRegistry(registry, home);
}

/** Remove a project's entire registry entry (its approvals bucket included).
 *  Returns true iff a project entry was actually removed. */
export function unregisterProject(projectRoot: string, home?: string): boolean {
  const registry = readAutomationsRegistry(home);
  if (!(projectRoot in registry.projects)) return false;
  delete registry.projects[projectRoot];
  writeAutomationsRegistry(registry, home);
  return true;
}

/** Every project root currently registered on this machine. */
export function listRegisteredProjects(home?: string): string[] {
  return Object.keys(readAutomationsRegistry(home).projects);
}

// ─── Approval payload (the tripwire's whole correctness claim) ──────────────

/** CRLF→LF, trim. `trim()` alone also collapses trailing blank lines (they
 *  are trailing whitespace), so no separate step is needed. */
function normalizeText(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

/**
 * The fields the approval hash is computed over, in FIXED key order
 * (object-literal insertion order for string keys is guaranteed by the JS
 * spec, so `JSON.stringify` never reorders them). Everything else on the
 * manifest — title, enabled, schedule, catchup_hours, id, timestamps, body,
 * `shared` — is deliberately excluded: hashing the whole file would
 * false-block on a cosmetic edit (an `updated_at` bump, a YAML re-order, a
 * Changelog append), training reflexive approval, which destroys the
 * tripwire. `shared` specifically is a visibility flag, not an execution
 * lever — two machines may legitimately disagree about local publishing
 * intent, and hashing it would false-block for exactly the same reason.
 *
 * `effort` is OMITTED from the JSON literal entirely when null, rather than
 * serialized as `"effort":null` — so a manifest that never sets it hashes
 * BYTE-IDENTICAL to how it hashed before this field existed: the null case is
 * never gratuitously invalidated. Every non-null value DOES appear, in the
 * literal between `model` and `timeoutMinutes` (both execution-envelope
 * levers), so any change between two non-null levels — or between null and
 * any level — always changes the hash.
 */
export function canonicalApprovalPayload(m: AutomationManifest): string {
  const fields = {
    prompt: normalizeText(m.prompt),
    outputInstructions: normalizeText(m.outputInstructions),
    model: m.model,
    ...(m.effort !== null ? { effort: m.effort } : {}),
    timeoutMinutes: m.timeoutMinutes,
    outputDir: m.outputDir,
    // OMITTED when off, for the same byte-identity reason as `effort`: every
    // manifest written before this field existed reads `learning: false`, so
    // its already-approved hash must stay exactly what it was. An upgrade that
    // re-blocked every working automation would be a silent outage — blocked
    // runs notify nobody, by design (the blocked path passes notify: false, or
    // a still-due automation would alarm every 5 minutes).
    //
    // When it IS on, the hash changes and approval is required. That is the
    // point: turning it on lets the run read a file that rewrites itself, and
    // the run's own recorded lessons are never re-reviewed afterwards.
    ...(m.learning ? { learning: true } : {}),
  };
  return `${APPROVAL_PAYLOAD_VERSION}\n${JSON.stringify(fields)}`;
}

/** sha256 hex of {@link canonicalApprovalPayload}. */
export function manifestHash(m: AutomationManifest): string {
  return createHash('sha256').update(canonicalApprovalPayload(m), 'utf8').digest('hex');
}

/** The raw (non-normalized) values of the hashed fields, for the CLI's
 *  `approve` diff. Reviewing only the prompt would let a `timeoutMinutes`,
 *  `effort`, or `outputDir` change sail through a "prompt unchanged" glance —
 *  `approve` MUST diff every one of these, never a subset. Unlike
 *  {@link canonicalApprovalPayload}, `effort` is always present here (as
 *  `null` when unset) — this shape is for DISPLAY, not hashing, so there is
 *  no byte-identity constraint to preserve. */
export function approvalFields(m: AutomationManifest): ApprovalPayloadFields {
  return {
    prompt: m.prompt,
    outputInstructions: m.outputInstructions,
    model: m.model,
    effort: m.effort,
    timeoutMinutes: m.timeoutMinutes,
    outputDir: m.outputDir,
    // Always present here (unlike the hash payload, which omits it when off):
    // this shape is for DISPLAY, and a reviewer must be able to see that
    // learning is on — that a run will read notes it wrote itself is the most
    // consequential thing on this list to approve knowingly.
    learning: m.learning,
  };
}

// ─── The gate itself ─────────────────────────────────────────────────────────

export type ApprovalVerdict =
  | { approved: true; entry: ApprovalEntry }
  | {
      approved: false;
      reason: 'never-approved' | 'manifest-changed' | 'payload-format-changed';
      expected: string | null;
      actual: string;
    };

/**
 * THE gate. `tick` and `run` both call this before ever spawning. Order
 * matters: a stored `payloadVersion` mismatch is reported BEFORE any hash
 * comparison, since two different payload formats are not meaningfully
 * comparable by hash at all — a future format change must force a full
 * re-review, never a silent hash mismatch masquerading as a normal edit.
 */
export function checkApproval(projectRoot: string, m: AutomationManifest, home?: string): ApprovalVerdict {
  const entry = getApproval(projectRoot, m.slug, home);
  const actual = manifestHash(m);
  if (!entry) return { approved: false, reason: 'never-approved', expected: null, actual };
  if (entry.payloadVersion !== APPROVAL_PAYLOAD_VERSION) {
    return { approved: false, reason: 'payload-format-changed', expected: entry.manifestSha256, actual };
  }
  if (entry.manifestSha256 !== actual) {
    return { approved: false, reason: 'manifest-changed', expected: entry.manifestSha256, actual };
  }
  return { approved: true, entry };
}

/** Record approval of `m` as it stands right now. Called by `create` (the
 *  local human just authored it — auto-approve) and by `approve` (after the
 *  human reviews every hashed field). `now` is injected for determinism. */
export function approveAutomation(projectRoot: string, m: AutomationManifest, now: Date, home?: string): ApprovalEntry {
  const entry: ApprovalEntry = {
    manifestSha256: manifestHash(m),
    approvedAt: now.toISOString(),
    payloadVersion: APPROVAL_PAYLOAD_VERSION,
  };
  const registry = readAutomationsRegistry(home);
  const project = registry.projects[projectRoot] ?? { approvals: {} };
  project.approvals[m.slug] = entry;
  registry.projects[projectRoot] = project;
  writeAutomationsRegistry(registry, home);
  return entry;
}

/** Remove one slug's approval (leaves the project's other approvals and its
 *  registration intact). Returns true iff an entry was actually removed. */
export function revokeApproval(projectRoot: string, slug: string, home?: string): boolean {
  const registry = readAutomationsRegistry(home);
  const project = registry.projects[projectRoot];
  if (!project || !(slug in project.approvals)) return false;
  delete project.approvals[slug];
  writeAutomationsRegistry(registry, home);
  return true;
}

/** The raw stored approval entry for `slug`, or null if never approved. */
export function getApproval(projectRoot: string, slug: string, home?: string): ApprovalEntry | null {
  const registry = readAutomationsRegistry(home);
  return registry.projects[projectRoot]?.approvals[slug] ?? null;
}

// ─── Dispatcher heartbeat (own file — see module doc) ───────────────────────

const EMPTY_HEARTBEAT: DispatcherHeartbeat = {
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  lastTickDurationMs: null,
};

function sanitizeTimestamp(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function sanitizeDurationMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Read the dispatcher heartbeat. Missing file or unparseable JSON ⇒ all-null.
 * A structurally-present-but-wrong-typed field degrades to null for just that
 * field (mirrors the registry's per-entry sanitization) — NEVER throws.
 */
export function readDispatcherHeartbeat(home?: string): DispatcherHeartbeat {
  const filePath = dispatcherHeartbeatPath(home);
  if (!existsSync(filePath)) return { ...EMPTY_HEARTBEAT };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<DispatcherHeartbeat> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_HEARTBEAT };
    return {
      lastTickStartedAt: sanitizeTimestamp(parsed.lastTickStartedAt),
      lastTickCompletedAt: sanitizeTimestamp(parsed.lastTickCompletedAt),
      lastTickDurationMs: sanitizeDurationMs(parsed.lastTickDurationMs),
    };
  } catch {
    console.error('[dreamcontext] automations-tick.json is malformed — treating heartbeat as empty.');
    return { ...EMPTY_HEARTBEAT };
  }
}

/** Writes ONLY `automations-tick.json` — never touches `automations.json`.
 *  This is the whole point of the separate-file design (see module doc). */
function writeDispatcherHeartbeat(hb: DispatcherHeartbeat, home?: string): void {
  writeJsonAtomic(dispatcherHeartbeatPath(home), hb);
}

/** Called by `tick` at the start of every tick, due or not — so a hung
 *  dispatcher's raw `lastTickStartedAt` still shows in `install --check` even
 *  though there is no automatic staleness verdict (see the tick task). */
export function recordTickStarted(now: Date, home?: string): void {
  const hb = readDispatcherHeartbeat(home);
  writeDispatcherHeartbeat({ ...hb, lastTickStartedAt: now.toISOString() }, home);
}

/** Called by `tick` once every due automation across every project has run. */
export function recordTickCompleted(now: Date, durationMs: number, home?: string): void {
  const hb = readDispatcherHeartbeat(home);
  writeDispatcherHeartbeat({ ...hb, lastTickCompletedAt: now.toISOString(), lastTickDurationMs: durationMs }, home);
}
