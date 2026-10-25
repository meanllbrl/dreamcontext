import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import {
  APPROVAL_DIFF_FIELDS,
  APPROVAL_PAYLOAD_VERSION,
  AutomationError,
  DEFAULT_AGENT_AUTONOMY,
  type ApprovalPayloadFields,
  type ApprovalUse,
  type AutomationManifest,
  type AutomationSlot,
  type FlowGraph,
  type RunKind,
} from './types.js';
import { classifyAutomationSlot, contextRootOf } from '../agents/slot.js';
import { assertOwned, currentLogin, foreignOwner } from '../agents/owner.js';
import { GLOBAL_REGISTRY_KEY } from '../agents/scope.js';

/**
 * Automations registry — the machine-local approval tripwire + project
 * registry, plus the dispatcher heartbeat. Mirrors `src/lib/linked-repos.ts`
 * EXACTLY for file mechanics: injectable `home` (defaults to `homedir()`),
 * atomic temp(pid+nonce)+rename writes, never-throw sanitizing reads.
 *
 * TYPES-ONLY import from `./types.js` — never `./store.js`. That keeps this
 * module home-injectable and layout-independent, testable against a literal
 * `AutomationManifest` object with no filesystem manifest required. The other
 * imports are `../agents/owner.js` (the `not_owner` verdict; it reads the
 * signed-in login through the injected home, no store) and `../agents/slot.js`, which imports no store either: the agent
 * approval writes re-classify the automation slot INSIDE their own registry
 * write, so they never trust a classification made earlier by a caller.
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
  /** The home board the approved manifest named, when it named one. Recorded
   *  so the spawn path can refuse a manifest whose board disagrees with what a
   *  human here approved, even if the hash were somehow made to match. Absent
   *  for an ordinary agent and on every entry written before this field. */
  whiteboard?: string;
}

/** One project's approvals, keyed by automation slug. */
export interface ProjectRegistryEntry {
  approvals: Record<string, ApprovalEntry>;
  /**
   * Direct approvals of agents' CALL TARGETS, keyed by agent slug. A separate
   * map, never `approvals`: an agent and an automation may share a slug (a
   * migrated pair), and approving the agent must never overwrite the
   * automation's record. Absent on every registry written before agents existed.
   */
  agentApprovals?: Record<string, ApprovalEntry>;
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
    typeof e.payloadVersion === 'string' &&
    // Optional, but when present it must be a non-empty string. A malformed
    // value drops the entry (reads as never-approved): failing closed costs a
    // re-approval, failing open could unscope a board agent.
    (e.whiteboard === undefined || (typeof e.whiteboard === 'string' && e.whiteboard.length > 0))
  );
}

/** Keep only well-formed entries; a malformed sibling never costs the others. */
function sanitizeApprovalMap(raw: object): Record<string, ApprovalEntry> {
  const out: Record<string, ApprovalEntry> = {};
  for (const [slug, approval] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof slug === 'string' && slug.length > 0 && isValidApprovalEntry(approval)) out[slug] = approval;
  }
  return out;
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
      const approvals = sanitizeApprovalMap(rawApprovals);
      const rawAgent = (entry as Record<string, unknown>).agentApprovals;
      const agentApprovals =
        rawAgent && typeof rawAgent === 'object' && !Array.isArray(rawAgent) ? sanitizeApprovalMap(rawAgent) : {};
      projects[projectRoot] =
        Object.keys(agentApprovals).length > 0 ? { approvals, agentApprovals } : { approvals };
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

/**
 * Resolve a project path to the key its approvals are ACTUALLY stored under.
 *
 * WHY THIS EXISTS. Approvals are keyed by project path, and two code paths
 * arrive at that path differently: the CLI derives it from `process.cwd()`,
 * which Node reports PHYSICALLY (symlinks already resolved), while a registered
 * vault stores whatever `resolve()` produced, which is lexical and leaves
 * symlinks intact. On macOS `/tmp` is a symlink to `/private/tmp`, and a project
 * behind ANY symlinked parent — a Dropbox or iCloud alias, a linked home, an
 * external volume — hits the same split. The symptom is silent and bad: the
 * dashboard reports every automation as "blocked — needs approval" while the
 * CLI, run from inside the project, says approved.
 *
 * LOOKUP-ONLY, and deliberately so. Canonicalising on WRITE would be tidier but
 * is a migration hazard pointing the other way: every approval already on disk
 * was keyed by whatever its writer passed, so rewriting the lookup to a
 * canonical form would orphan them all at once — the same silent
 * mass-unapproval, just triggered by an upgrade instead of a symlink. So writes
 * keep their existing key, and reads try, in order: the exact path, its
 * realpath, then any stored key that resolves to the same physical directory.
 * Strictly additive — nothing that resolved before stops resolving.
 */
function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Not resolvable (does not exist yet, or unreadable): fall back to the
    // input. A lookup that throws would be worse than one that misses.
    return p;
  }
}

/** The stored key for this project, or null when it has none yet. */
function findProjectKey(registry: AutomationsRegistry, projectRoot: string): string | null {
  if (registry.projects[projectRoot]) return projectRoot;
  // The global agents' bucket is a name, never a path to resolve (D1).
  if (projectRoot === GLOBAL_REGISTRY_KEY) return null;
  const canonical = tryRealpath(projectRoot);
  if (canonical !== projectRoot && registry.projects[canonical]) return canonical;
  for (const stored of Object.keys(registry.projects)) {
    // Only a stored absolute path is an alias: the `global` bucket (D1) is a name, and resolving
    // it would read `<cwd>/global`, which a project folder (or a committed link) could be.
    if (stored === GLOBAL_REGISTRY_KEY || !isAbsolute(stored)) continue;
    if (stored !== projectRoot && tryRealpath(stored) === canonical) return stored;
  }
  return null;
}

/** Idempotently register a project (create an empty approvals bucket if one
 *  doesn't already exist). Never clobbers an existing project's approvals. */
export function registerProject(projectRoot: string, home?: string): void {
  const registry = readAutomationsRegistry(home);
  if (findProjectKey(registry, projectRoot)) return;
  registry.projects[projectRoot] = { approvals: {} };
  writeAutomationsRegistry(registry, home);
}

/** Remove a project's entire registry entry (its approvals bucket included).
 *  Returns true iff a project entry was actually removed. */
export function unregisterProject(projectRoot: string, home?: string): boolean {
  const registry = readAutomationsRegistry(home);
  const key = findProjectKey(registry, projectRoot);
  if (key === null) return false;
  delete registry.projects[key];
  writeAutomationsRegistry(registry, home);
  return true;
}

/** Every project root currently registered on this machine. */
export function listRegisteredProjects(home?: string): string[] {
  return Object.keys(readAutomationsRegistry(home).projects).filter((k) => k !== GLOBAL_REGISTRY_KEY);
}

// ─── Approval payload (the tripwire's whole correctness claim) ──────────────

/** CRLF→LF, trim. `trim()` alone also collapses trailing blank lines (they
 *  are trailing whitespace), so no separate step is needed. */
function normalizeText(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

/**
 * A flow graph as ONE canonical string, so the hash tracks what the graph MEANS
 * rather than how its JSON happened to be typed.
 *
 * Key order is fixed by construction here rather than inherited from the parsed
 * object, and `label`/`config` are omitted when empty — so re-saving a manifest
 * through a formatter, or an editor that reorders JSON keys, does NOT re-block
 * an approved automation. Node and edge ORDER is preserved and significant: the
 * order is the wiring, and reordering nodes genuinely changes the graph.
 *
 * The reverse also has to hold, and is the point: any edit that changes what the
 * run does — a node added or removed, a kind changed, a `config` value edited, a
 * wire repointed — MUST change this string.
 */
export function canonicalFlowJson(graph: FlowGraph): string {
  return JSON.stringify({
    version: graph.version,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      ...(n.label ? { label: n.label } : {}),
      ...(n.config && Object.keys(n.config).length > 0 ? { config: n.config } : {}),
    })),
    edges: graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.label ? { label: e.label } : {}),
    })),
  });
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
    // OMITTED when 'off', same byte-identity reason as `effort` and `learning`:
    // every manifest written before review existed reads 'off', so its already
    // approved hash stays exactly what it was and an upgrade blocks nobody.
    //
    // Included otherwise, and the direction that earns the hash is REMOVAL. A
    // synced manifest whose `review` a teammate edits back to 'off' has had a
    // human gate deleted from it — the most consequential edit possible short
    // of rewriting the prompt — and it must block until someone here approves
    // that. Turning review ON costs a re-approval too (a hash is a pure
    // function of the manifest and cannot know the previous mode), which is
    // harmless: a local write verb re-approves on the spot, and a teammate
    // ADDING a gate that then blocks is failing in the safe direction.
    ...(m.review !== 'off' ? { review: m.review } : {}),
    // OMITTED when 'sched', included when 'call' — the same byte-identity
    // trick as `effort`/`learning`/`review`, and the same asymmetry of
    // DIRECTION as `review`'s.
    //
    // It was tempting to leave `mode` out entirely on the grounds that it is
    // the same class as `schedule` and `enabled`, which this payload already
    // excludes. That reasoning is wrong in ONE direction and it is the
    // direction that matters. `schedule` and `enabled` only ever change WHEN
    // an already-autonomous job fires; `call → sched` changes whether it may
    // fire unattended AT ALL. An agent the owner approved as "runs only when
    // I ask" could otherwise have a schedule bolted on by a teammate's synced
    // edit and start running headless on a timer with a byte-identical hash,
    // so `checkApproval` would keep saying yes and no human would ever see a
    // diff. That is precisely the manifest-changed-under-you case the
    // tripwire exists for.
    //
    // Omitting at 'sched' keeps every manifest written before this field
    // existed byte-identical (they all read 'sched'), so this can never block
    // anything on upgrade. The `sched → call` direction costs a re-approval
    // too, which is free: an on-call agent is not firing on a schedule, so a
    // block there stops nothing.
    ...(m.mode === 'call' ? { mode: m.mode } : {}),
    // OMITTED when absent, and LAST in the literal — the same byte-identity
    // reason as `effort`, `learning` and `review`, and the highest-stakes
    // instance of it. Every automation that exists today predates `## Flow`, so
    // every one of them reads `flow: null`; serializing a `"flow":null` key
    // would change all of their hashes at once and block every automation on the
    // machine on upgrade — and a blocked run notifies nobody, by design, so the
    // symptom would be the whole subsystem going silent.
    //
    // LAST specifically so that adding it cannot perturb the serialization of
    // any field before it. Appending is the only position that keeps a
    // flow-less manifest's payload byte-for-byte what it was.
    //
    // When a flow IS present the hash changes and approval is required, which is
    // the point: the graph decides what the prompt says and whether the run must
    // stop and ask, so a teammate's synced edit deleting a `hitl` node has
    // removed a human gate and must block until someone here re-approves.
    //
    // `undefined` is treated as absent alongside `null`, deliberately. Every
    // read path states `flow: null` explicitly, so an `undefined` here means a
    // hand-built manifest object (a test fixture, a future caller) — and the two
    // ways to be wrong are not symmetric. Treating it as ABSENT reproduces the
    // flow-less hash, which is the safe, byte-identical answer; treating it as
    // present would call `canonicalFlowJson(undefined)` and THROW, on the
    // runner's approval path, where a throw is an automation that stops running
    // and tells nobody. A hash function on that path has to be total.
    ...(m.flow !== null && m.flow !== undefined ? { flow: canonicalFlowJson(m.flow) } : {}),
    // OMITTED when absent, and after `flow` for the same append-only reason:
    // every manifest that exists today has no home board, so its payload stays
    // byte-for-byte what it was. Present, it decides the run's whole permission
    // envelope (scoped to one board vs unscoped), so adding, removing or
    // re-pointing it must block until someone here re-approves. `undefined` is
    // treated as absent for the same totality reason as `flow`.
    ...(m.whiteboard ? { whiteboard: m.whiteboard } : {}),
    // OMITTED when empty, and after `whiteboard` for the same append-only
    // reason: every manifest that exists today, and every agent's call target,
    // has no `## Job`, so its payload stays byte-for-byte what it was — the
    // property that lets a manifest split into agent + automation keep its
    // approval on every machine with no registry write. Present, it is part of
    // what the run is told to do, so editing it must block. Normalized BEFORE
    // the emptiness check, so a whitespace-only section reads as absent rather
    // than as a `"job":""` key that would change the hash for nothing.
    ...(jobText(m) ? { job: jobText(m) } : {}),
    // OMITTED when empty, and after `job` for the same append-only reason: no
    // manifest or agent that exists today has a `## Soul`, so its payload stays
    // byte-for-byte what it was and an upgrade re-blocks nobody (golden hashes in
    // tests/unit/agents-soul-hash.test.ts, P1). Present, it shapes how every run
    // and conversation behaves, so a synced edit must block until someone here
    // re-approves. Normalized before the emptiness check, like `job`.
    ...(soulText(m) ? { soul: soulText(m) } : {}),
    // OMITTED at the default `balanced` (and when absent), and LAST, for the same append-only
    // reason as `soul`: every agent that exists today reads `balanced`, so its payload stays
    // byte-for-byte what it was and an upgrade re-blocks nobody. `ask` or `free` decides the
    // permission mode of every session the agent runs in, so moving to either, or a synced edit
    // between them, must block until someone here re-approves.
    ...(m.autonomy && m.autonomy !== DEFAULT_AGENT_AUTONOMY ? { autonomy: m.autonomy } : {}),
  };
  return `${APPROVAL_PAYLOAD_VERSION}\n${JSON.stringify(fields)}`;
}

/** The normalized `## Job` text, `''` when absent. Total: a hand-built manifest
 *  without the field (a test fixture, an older caller) reads as no job. */
function jobText(m: AutomationManifest): string {
  return typeof m.job === 'string' ? normalizeText(m.job) : '';
}

/** The normalized `## Soul` text, `''` when absent. Total, like {@link jobText}. */
function soulText(m: AutomationManifest): string {
  return typeof m.soul === 'string' ? normalizeText(m.soul) : '';
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
    // Always present here too, for the mirror-image reason: the reviewer must
    // be able to see that a gate they were relying on is GONE. A removed
    // review mode renders as `agent → off` in the diff, which is exactly the
    // line this whole surface exists to make impossible to miss.
    review: m.review,
    // Always present (as null when absent), for the same DISPLAY reason: a
    // reviewer must be able to see that a graph exists and what it wires, since
    // the graph is what decides whether the run stops to ask.
    flow: m.flow,
    // Always present (as null when absent): a reviewer must see that the agent
    // is confined to a board, and that a confinement they relied on is gone.
    whiteboard: m.whiteboard ?? null,
    // Always present (as '' when absent): the reviewer reads what this job adds
    // to its agent's prompt.
    job: typeof m.job === 'string' ? m.job : '',
    // Always present (as '' when absent): the reviewer reads how the agent is
    // told to behave, beside what it is told to do.
    soul: typeof m.soul === 'string' ? m.soul : '',
    // Always present (as the default when absent): the reviewer sees how much it may decide alone.
    autonomy: m.autonomy ?? DEFAULT_AGENT_AUTONOMY,
  };
}

// ─── The diff a human actually reviews ──────────────────────────────────────

/** One hashed field, rendered for review. `null` prints as the word, never as an
 *  empty string — "nothing set" and "set to empty" are different approvals. */
function renderApprovalValue(value: ApprovalPayloadFields[keyof ApprovalPayloadFields]): string {
  // `undefined` too: a stored-fields object written before a field existed
  // (`soul`) must render, not fall through to `canonicalFlowJson` and throw.
  if (value === undefined || value === null) return '(none)';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  // The only remaining member is `flow`, whose canonical form is what the hash
  // covers — so the diff shows exactly the bytes that decided it.
  return canonicalFlowJson(value as FlowGraph);
}

/**
 * A field-by-field diff of two approval payloads, for a human to read before
 * granting `bypassPermissions` again.
 *
 * Walks {@link APPROVAL_DIFF_FIELDS} rather than `Object.keys`, so the order is
 * the declared one and — more importantly — a field ADDED to the hash but not to
 * that list can never silently drop out of the review. Returns only what
 * CHANGED: a reviewer looking for the edit should not have to find it inside a
 * wall of identical lines.
 *
 * Empty string ⇒ nothing among the hashed fields differs. That is a real state
 * worth rendering honestly (the hash can also differ because the payload FORMAT
 * changed, which is `payload-format-changed`, not an edit).
 */
/**
 * Every hashed field, rendered for a human to read.
 *
 * A FULL REVIEW, not an old-vs-new diff, and that is forced rather than chosen:
 * the registry stores a sha256 and nothing else — no prior field values — so
 * there is no "before" to diff against. The hash can prove that SOMETHING
 * changed; it cannot say what. Surfaces must therefore show every field every
 * time (the CLI's `approve` and the dashboard's review panel both do), and any
 * copy describing this as a diff is lying to the reviewer about what they are
 * being shown.
 */
export function renderApprovalReview(fields: ApprovalPayloadFields): string {
  return APPROVAL_DIFF_FIELDS.map((field) => {
    const value = renderApprovalValue(fields[field]);
    return value.includes('\n') ? `${field}:\n  ${value.replace(/\n/g, '\n  ')}` : `${field}: ${value}`;
  }).join('\n');
}

export function approvalDiff(stored: ApprovalPayloadFields, current: ApprovalPayloadFields): string {
  const lines: string[] = [];
  for (const field of APPROVAL_DIFF_FIELDS) {
    const before = renderApprovalValue(stored[field]);
    const after = renderApprovalValue(current[field]);
    if (before === after) continue;
    lines.push(`${field}:`, `  - ${before.replace(/\n/g, '\n    ')}`, `  + ${after.replace(/\n/g, '\n    ')}`);
  }
  return lines.join('\n');
}

// ─── The gate itself ─────────────────────────────────────────────────────────

/** How an approved verdict was reached: the target's own record (`'self'`),
 *  an agent's legacy record (`'legacy-key'`, rule (b)), or a bound automation's
 *  approval lent for a conversation (rule (c)). */
export type ApprovalVia = 'self' | 'legacy-key' | { binding: string };

export type ApprovalVerdict =
  | { approved: true; entry: ApprovalEntry; via: ApprovalVia }
  | {
      approved: false;
      reason: 'never-approved' | 'manifest-changed' | 'payload-format-changed';
      expected: string | null;
      actual: string;
    }
  /**
   * Someone else's agent or automation: read-only here, never "needs approval". Returned FIRST,
   * before any own-entry or binding rule, so every run and chat path that asks this gate refuses
   * it, and an approval this machine held from before (a formerly `shared: true` slug) lends it
   * nothing. `owner` names who it belongs to.
   */
  | { approved: false; reason: 'not_owner'; owner: string; expected: null; actual: string };

/** One stored entry judged against the target's current hash. Order matters: a
 *  stored `payloadVersion` mismatch is reported BEFORE any hash comparison,
 *  since two different payload formats are not meaningfully comparable by hash
 *  at all — a future format change must force a full re-review, never a silent
 *  hash mismatch masquerading as a normal edit. */
function judgeEntry(entry: ApprovalEntry | null | undefined, actual: string): ApprovalVerdict {
  if (!entry) return { approved: false, reason: 'never-approved', expected: null, actual };
  if (entry.payloadVersion !== APPROVAL_PAYLOAD_VERSION) {
    return { approved: false, reason: 'payload-format-changed', expected: entry.manifestSha256, actual };
  }
  if (entry.manifestSha256 !== actual) {
    return { approved: false, reason: 'manifest-changed', expected: entry.manifestSha256, actual };
  }
  return { approved: true, entry, via: 'self' };
}

/** This project's bucket, found through any path alias, or undefined. */
function projectEntry(registry: AutomationsRegistry, projectRoot: string): ProjectRegistryEntry | undefined {
  const key = findProjectKey(registry, projectRoot);
  return key === null ? undefined : registry.projects[key];
}

/**
 * THE gate — the ONLY approval predicate. Every spawn path, every surface that
 * shows "approved", and every conversation with an agent asks this.
 *
 * An AUTOMATION (`runKind !== 'agent'`, which includes every hand-built or
 * legacy manifest) is approved exactly as it always was: `approvals[slug]`
 * against its current hash. `use` does not apply.
 *
 * An agent's CALL TARGET (`runKind: 'agent'`) is judged by three rules:
 *  (a) `agentApprovals[slug]` matches the full call-target hash — a direct grant.
 *  (b) ONLY while `agentApprovals[slug]` is absent and `m.legacyKey` is true (the
 *      automation slot is absent or an unsplit on-call file): the legacy record
 *      `approvals[slug]` matches. This is how an on-call agent approved before
 *      the split stays approved, with no registry write, on every machine.
 *  (c) ONLY for `use === 'identity'`: some bound automation is approved as it
 *      stands (`approvals[b.slug]` equals the hash the store computed for it).
 *      Its hash covers the agent's whole identity, which is all a conversation
 *      reads; a conversation is built from `identityOnly` and never reads call
 *      settings. The returned entry is the binding's, `whiteboard` included.
 *
 * The invariant: anything that EXECUTES an agent's call target needs this Mac's
 * direct approval of that exact hash; a bound automation's approval only lends
 * the agent its identity for conversations. `use` defaults to the strict `'run'`.
 *
 * Before all of that: a target whose owner (its agent's, or its routine's) is not
 * this machine's `login` is `not_owner`, read-only (AI Team v2 B1-4). `login`
 * defaults to the signed-in GitHub login of `home` (`agents/owner.ts`).
 */
export function checkApproval(
  projectRoot: string,
  m: AutomationManifest,
  home?: string,
  use: ApprovalUse = 'run',
  login: string = currentLogin(),
): ApprovalVerdict {
  const actual = manifestHash(m);
  const owner = foreignOwner(m, login);
  if (owner) return { approved: false, reason: 'not_owner', owner, expected: null, actual };
  // A global agent's grant lives in the machine's `global` bucket: one approval, every project (D1).
  const project = projectEntry(readAutomationsRegistry(home), m.agentScope === 'global' ? GLOBAL_REGISTRY_KEY : projectRoot);
  if (m.runKind !== 'agent') return judgeEntry(project?.approvals[m.slug], actual);

  const direct = project?.agentApprovals?.[m.slug];
  let own: ApprovalVerdict;
  if (direct) {
    own = judgeEntry(direct, actual);
  } else if (m.legacyKey === true) {
    const legacy = judgeEntry(project?.approvals[m.slug], actual);
    own = legacy.approved ? { ...legacy, via: 'legacy-key' } : legacy;
  } else {
    own = { approved: false, reason: 'never-approved', expected: null, actual };
  }
  if (own.approved || use !== 'identity') return own;

  for (const binding of m.bindings ?? []) {
    const entry = project?.approvals[binding.slug];
    if (entry && entry.payloadVersion === APPROVAL_PAYLOAD_VERSION && entry.manifestSha256 === binding.sha256) {
      return { approved: true, entry, via: { binding: binding.slug } };
    }
  }
  return own;
}

/** A fresh approval entry for `m` as it stands right now. */
function approvalEntryFor(m: AutomationManifest, now: Date): ApprovalEntry {
  return {
    manifestSha256: manifestHash(m),
    approvedAt: now.toISOString(),
    payloadVersion: APPROVAL_PAYLOAD_VERSION,
    ...(m.whiteboard ? { whiteboard: m.whiteboard } : {}),
  };
}

/** Slots in which `approvals[<slug>]` can only be the AGENT's own legacy record,
 *  never an automation's: nothing is there, an unsplit on-call file is there, or
 *  something unreadable is there (revoking is the fail-safe direction). */
const AGENT_OWNED_SLOTS: ReadonlySet<AutomationSlot> = new Set<AutomationSlot>(['absent', 'legacy-call', 'unreadable']);

/** Read the registry, run `mutate` on this project's bucket (created if
 *  missing), write it back. One read, one atomic write. */
function mutateProject<T>(projectRoot: string, home: string | undefined, mutate: (p: ProjectRegistryEntry) => T): T {
  const registry = readAutomationsRegistry(home);
  // Write under the key this project ALREADY has, so approving through an alias
  // lands beside its siblings instead of forking a second bucket.
  const key = findProjectKey(registry, projectRoot) ?? projectRoot;
  const project = registry.projects[key] ?? { approvals: {} };
  const result = mutate(project);
  if (project.agentApprovals && Object.keys(project.agentApprovals).length === 0) delete project.agentApprovals;
  registry.projects[key] = project;
  writeAutomationsRegistry(registry, home);
  return result;
}

/**
 * Record approval of `m` as it stands right now. Called by `create` (the local
 * human just authored it — auto-approve) and by `approve` (after the human
 * reviews every hashed field). `now` is injected for determinism.
 *
 * For an agent's call target it writes `agentApprovals[slug]`, and — in the SAME
 * registry write, with the automation slot re-classified right here rather than
 * trusted from the caller — deletes the legacy `approvals[slug]` whenever that
 * slot is absent, an unsplit on-call file, or unreadable. That record was the
 * agent's own, and leaving it would let a teammate resurrect the superseded
 * legacy file and run it on a stale approval (rule (b) is also skipped from now
 * on, because `agentApprovals[slug]` exists). A pair's automation record (slot
 * `'automation'`) is never touched.
 */
export function approveAutomation(projectRoot: string, m: AutomationManifest, now: Date, home?: string): ApprovalEntry {
  // Someone else's member is read-only here: approving it would be running it by another door.
  assertOwned(m, m.agentTitle || m.title || m.slug);
  const entry = approvalEntryFor(m, now);
  if (m.agentScope === 'global') {
    return mutateProject(GLOBAL_REGISTRY_KEY, home, (project) => {
      project.agentApprovals = { ...(project.agentApprovals ?? {}), [m.slug]: entry };
      return entry;
    });
  }
  return mutateProject(projectRoot, home, (project) => {
    if (m.runKind === 'agent') {
      project.agentApprovals = { ...(project.agentApprovals ?? {}), [m.slug]: entry };
      if (AGENT_OWNED_SLOTS.has(classifyAutomationSlot(contextRootOf(projectRoot), m.slug))) {
        delete project.approvals[m.slug];
      }
    } else {
      project.approvals[m.slug] = entry;
    }
    return entry;
  });
}

/**
 * Approve a SAME-SLUG pair's automation without costing its agent its run
 * approval. Called by one caller only: the store's `createAutomation`, when the
 * new automation takes its agent's slug.
 *
 * Writing `approvals[slug]` for the automation would overwrite the agent's
 * legacy record, so in the same write — when `agentApprovals[slug]` is absent and
 * `approvals[slug]` matches the agent's call target hash exactly (hash equality,
 * no slot check: the automation file already exists by now) — that record is
 * first copied into `agentApprovals[slug]`.
 */
export function approvePair(
  projectRoot: string,
  automation: AutomationManifest,
  agentTarget: AutomationManifest,
  now: Date,
  home?: string,
): ApprovalEntry {
  assertOwned(automation, automation.title || automation.slug);
  assertOwned(agentTarget, agentTarget.agentTitle || agentTarget.slug);
  if (
    automation.runKind === 'agent' ||
    agentTarget.runKind !== 'agent' ||
    automation.slug !== agentTarget.slug ||
    automation.agent !== agentTarget.slug
  ) {
    throw new AutomationError('approvePair needs an automation and the call target of the same-slug agent it runs as');
  }
  const entry = approvalEntryFor(automation, now);
  const agentHash = manifestHash(agentTarget);
  return mutateProject(projectRoot, home, (project) => {
    const slug = automation.slug;
    const legacy = project.approvals[slug];
    if (
      !project.agentApprovals?.[slug] &&
      legacy &&
      legacy.payloadVersion === APPROVAL_PAYLOAD_VERSION &&
      legacy.manifestSha256 === agentHash
    ) {
      project.agentApprovals = { ...(project.agentApprovals ?? {}), [slug]: { ...legacy } };
    }
    project.approvals[slug] = entry;
    return entry;
  });
}

/**
 * Revoke an agent's approvals when the agent is deleted. Always drops
 * `agentApprovals[slug]`. Drops `approvals[slug]` too UNLESS it is provably the
 * record of the automation now in that slot: the slot (re-classified here) is
 * `'automation'`, `currentAutomation` is that automation, it is NOT `mode: call`,
 * and the record matches its current composed hash. Anything else — absent,
 * unsplit on-call, unreadable, bound to another agent with a stale record —
 * revokes, because a surviving record is what would let a restored legacy file
 * run after its agent was deleted. Returns true iff anything was removed.
 */
export function revokeAgent(
  projectRoot: string,
  slug: string,
  currentAutomation: AutomationManifest | null,
  home?: string,
): boolean {
  const registry = readAutomationsRegistry(home);
  const project = projectEntry(registry, projectRoot);
  if (!project) return false;
  let changed = false;
  if (project.agentApprovals && slug in project.agentApprovals) {
    delete project.agentApprovals[slug];
    if (Object.keys(project.agentApprovals).length === 0) delete project.agentApprovals;
    changed = true;
  }
  const record = project.approvals[slug];
  if (record) {
    const keep =
      classifyAutomationSlot(contextRootOf(projectRoot), slug) === 'automation' &&
      currentAutomation !== null &&
      currentAutomation.slug === slug &&
      currentAutomation.runKind !== 'agent' &&
      currentAutomation.mode !== 'call' &&
      judgeEntry(record, manifestHash(currentAutomation)).approved;
    if (!keep) {
      delete project.approvals[slug];
      changed = true;
    }
  }
  if (changed) writeAutomationsRegistry(registry, home);
  return changed;
}

/** Remove one slug's approval (leaves the project's other approvals and its
 *  registration intact). `kind: 'agent'` removes the agent's direct grant from
 *  `agentApprovals` instead. Returns true iff an entry was actually removed. */
export function revokeApproval(projectRoot: string, slug: string, home?: string, kind: RunKind = 'automation'): boolean {
  const registry = readAutomationsRegistry(home);
  const project = projectEntry(registry, projectRoot);
  if (!project) return false;
  if (kind === 'agent') {
    if (!project.agentApprovals || !(slug in project.agentApprovals)) return false;
    delete project.agentApprovals[slug];
    if (Object.keys(project.agentApprovals).length === 0) delete project.agentApprovals;
  } else {
    if (!(slug in project.approvals)) return false;
    delete project.approvals[slug];
  }
  writeAutomationsRegistry(registry, home);
  return true;
}

/**
 * The raw stored approval entry for `slug`, or null if never approved.
 *
 * `kind: 'agent'` reads ONLY the agent's direct grant (`agentApprovals`), never
 * `approvals[slug]`: for a pair that is the automation's record, and a run
 * deciding whether to ask about an edit must not mistake it for a prior grant of
 * the agent's call target. The legacy fallback (rule (b)) lives in
 * {@link checkApproval} alone.
 */
export function getApproval(projectRoot: string, slug: string, home?: string, kind: RunKind = 'automation'): ApprovalEntry | null {
  const project = projectEntry(readAutomationsRegistry(home), projectRoot);
  if (!project) return null;
  return (kind === 'agent' ? project.agentApprovals?.[slug] : project.approvals[slug]) ?? null;
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

/**
 * Move a slug's approval records to a new slug (`renameAgentLocal`, B1-8). The hash covers no
 * slug, so an approved member stays approved under its new name; `which` picks the agent's
 * record, the automation's, or both. No-op when there is nothing under `from`.
 */
export function renameApprovals(projectRoot: string, from: string, to: string, which: 'agent' | 'automation' | 'both', home?: string): void {
  const registry = readAutomationsRegistry(home);
  const key = findProjectKey(registry, projectRoot);
  if (key === null) return;
  const project = registry.projects[key];
  let changed = false;
  if ((which === 'agent' || which === 'both') && project.agentApprovals?.[from]) {
    project.agentApprovals[to] = project.agentApprovals[from];
    delete project.agentApprovals[from];
    changed = true;
  }
  if ((which === 'automation' || which === 'both') && project.approvals[from]) {
    project.approvals[to] = project.approvals[from];
    delete project.approvals[from];
    changed = true;
  }
  if (changed) writeAutomationsRegistry(registry, home);
}
