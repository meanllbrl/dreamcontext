import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import fg from '../glob.js';
import matter from 'gray-matter';
import { ensureGitignoreEntries } from '../gitignore.js';
import { generateId } from '../id.js';
import {
  AutomationError,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  PATTERN_HEADING,
  REVIEW_MODES,
  SOUL_HEADING,
  type ApprovalBinding,
  type AutomationJob,
  type AutomationManifest,
  type ReviewMode,
  type RunKind,
} from '../automations/types.js';
import {
  assertRegularFile,
  automationFileTarget,
  automationPath,
  createManifestText,
  extractSection,
  getRunTarget,
  listManifestFiles,
  numberOrDefault,
  parseEffort,
  parseFlowSection,
  patchManifestFrontmatter,
  pathOccupied,
  readManifestParts,
  removeAutomation,
  removeSection,
  resolveAutomationPhoto,
  rewriteManifestText,
  strOrNull,
  upsertSection,
  validateAutomationForWrite,
  writeLessonToFile,
  type ManifestParts,
  type RecordLessonInput,
} from '../automations/store.js';
import { approveAutomation, checkApproval, manifestHash, revokeAgent } from '../automations/registry.js';
import { readWhiteboard, listWhiteboards } from '../whiteboards/store.js';
import { liveElements } from '../whiteboards/ops.js';
import { widgetPayloadOf } from '../whiteboards/widgets.js';
import { classifyAutomationSlot, isSafeAutomationSlug, parseManifestFrontmatter, readManifestFrontmatter } from './slot.js';
import { composeRun, legacyPair } from './compose.js';
import { normalizeSoul } from './soul-templates.js';
import { validateSoul } from './soul.js';
import { normalizeTeamLabel, readTeamLabel, wouldCycle } from './tree.js';
import {
  AGENTS_DIR,
  AGENTS_GITIGNORE_ENTRIES,
  AGENTS_GITIGNORE_ENTRIES_ROOT,
  DEFAULT_CALL_SETTINGS,
  type AgentCallSettings,
  type AgentIdentityPatch,
  type AgentInput,
  type AgentManifest,
  type AgentPlacementPatch,
} from './types.js';

/**
 * The agents store: an agent's IDENTITY, read from `agents/<slug>.md` or, for a
 * manifest not yet split, from the legacy `automations/<slug>.md` that still
 * holds it.
 *
 * THE RULE THIS MODULE EXISTS FOR: every agent approval check gets its run
 * target from {@link getRunTarget}`(root, slug, 'agent')` or
 * {@link listAgentTargets}. Both set `legacyKey` from the automation slot and fill
 * `bindings` with the current composed hash of every automation bound to the
 * agent, computed from the SAME resolved agent object the target is built from.
 * A target composed anywhere else carries `legacyKey: false` and no bindings,
 * and silently loses the approvals that depend on them.
 *
 * Reader precedence: while an UNSPLIT legacy file sits in the automation slot
 * of a slug, it IS that slug's agent and any `agents/<slug>.md` is ignored — the
 * window a crashed split leaves, and a foreign file of the same name.
 *
 * Imports `../automations/store.js`, which imports this module back: every use
 * of an import is inside a function body, never at module top level, so the
 * ESM cycle resolves.
 */

/** `<contextRoot>/agents`. */
export function agentsDir(contextRoot: string): string {
  return join(contextRoot, AGENTS_DIR);
}

/** `<contextRoot>/agents/<slug>.md`. Throws on a slug that is not path-safe:
 *  it becomes a path segment. */
export function agentPath(contextRoot: string, slug: string): string {
  if (!isSafeAutomationSlug(slug)) throw new AutomationError(`Invalid agent slug "${slug}".`);
  return join(agentsDir(contextRoot), `${slug}.md`);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseReview(v: unknown): ReviewMode {
  return (REVIEW_MODES as readonly unknown[]).includes(v) ? (v as ReviewMode) : 'off';
}

/**
 * Read one agent file. THROWS for a symlink, a non-file or unparseable YAML,
 * so a lister skips it the way it skips a broken manifest.
 *
 * Reads exactly as a legacy manifest's identity fields read (same lenient
 * rules), so an agent split from a manifest composes to the same hash. The
 * `## Output instructions` and `## Flow` sections are CALL settings: they are
 * read whether or not a `call:` block exists, because they change what a called
 * run does.
 */
export function readAgentFile(filePath: string): AgentManifest {
  assertRegularFile(filePath);
  const { data, content } = parseManifestFrontmatter(readFileSync(filePath, 'utf-8'));
  const slug = basename(filePath, '.md');
  const call = asRecord(data.call);
  const callSettings: AgentCallSettings = {
    timeoutMinutes: call
      ? numberOrDefault(call.timeout_minutes, DEFAULT_TIMEOUT_MINUTES, 1, MAX_TIMEOUT_MINUTES)
      : DEFAULT_CALL_SETTINGS.timeoutMinutes,
    outputDir: call ? strOrNull(call.output_dir) : null,
    review: call ? parseReview(call.review) : 'off',
    outputInstructions: extractSection(content, 'Output instructions'),
    // `null`, never `undefined`: the hash omits a flow only when it is null.
    flow: parseFlowSection(content),
    enabled: call ? call.enabled !== false : true,
    notify: call ? call.notify !== false : true,
  };
  return {
    slug,
    id: typeof data.id === 'string' && data.id.trim() ? data.id.trim() : '',
    title: typeof data.title === 'string' && data.title.trim() ? data.title : slug,
    photo: strOrNull(data.photo),
    prompt: extractSection(content, 'Prompt'),
    soul: extractSection(content, SOUL_HEADING),
    model: strOrNull(data.model),
    effort: parseEffort(data.effort),
    learning: data.learning === true,
    pattern: extractSection(content, PATTERN_HEADING),
    whiteboard: typeof data.whiteboard === 'string' && data.whiteboard.trim() ? data.whiteboard.trim() : null,
    shared: data.shared === true,
    reportsTo: typeof data.reports_to === 'string' && isSafeAutomationSlug(data.reports_to.trim()) ? data.reports_to.trim() : null,
    team: readTeamLabel(data.team),
    call: callSettings,
    migratedFrom: strOrNull(data.migrated_from),
    implicit: false,
    path: filePath,
    body: content.trim(),
  };
}

/** An empty identity for an agent missing on this machine (a shared automation
 *  whose private agent never arrived). Its composed hash matches no approval,
 *  so whatever runs as it is blocked rather than hidden. */
export function placeholderAgent(slug: string): AgentManifest {
  return {
    slug,
    id: '',
    title: slug,
    photo: null,
    prompt: '',
    soul: '',
    model: null,
    effort: null,
    learning: false,
    pattern: '',
    whiteboard: null,
    shared: false,
    reportsTo: null,
    team: null,
    call: { ...DEFAULT_CALL_SETTINGS },
    migratedFrom: null,
    implicit: false,
    path: '',
    body: '',
  };
}

// ─── One read of the automation slots, shared by every resolver below ───────

interface SlotFile {
  slug: string;
  parts: ManifestParts;
}

/** Every readable `automations/*.md`, parsed once. A symlinked, broken or
 *  unparseable manifest (or one naming an invalid agent) is skipped. */
function readSlotFiles(contextRoot: string): SlotFile[] {
  const out: SlotFile[] = [];
  for (const file of listManifestFiles(contextRoot)) {
    try {
      out.push({ slug: basename(file, '.md'), parts: readManifestParts(file) });
    } catch {
      // skipped, exactly as listAutomations skips it
    }
  }
  return out;
}

/** Absolute paths of `agents/*.md`, sorted. Missing folder ⇒ empty. */
function listAgentFiles(contextRoot: string): string[] {
  const dir = agentsDir(contextRoot);
  if (!pathOccupied(dir)) return [];
  return fg.sync('*.md', { cwd: dir, absolute: true }).sort();
}

/**
 * The job a slot file runs for `agentSlug`, or null: a split automation bound to
 * it, or the job half of the agent's OWN unsplit scheduled manifest. An unsplit
 * on-call manifest is the agent itself, never a binding.
 */
function boundJobOf(f: SlotFile, agentSlug: string): AutomationJob | null {
  if (f.parts.kind === 'bound') return f.parts.job.agent === agentSlug ? f.parts.job : null;
  if (f.slug !== agentSlug || f.parts.legacy.mode === 'call') return null;
  return legacyPair(f.parts.legacy).job;
}

function bySlug<T extends { slug: string }>(a: T, b: T): number {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

function resolveAgents(contextRoot: string, files: readonly SlotFile[]): AgentManifest[] {
  const agents = new Map<string, AgentManifest>();
  for (const f of files) {
    if (f.parts.kind === 'legacy') agents.set(f.slug, legacyPair(f.parts.legacy).agent);
  }
  for (const file of listAgentFiles(contextRoot)) {
    const slug = basename(file, '.md');
    // An unsplit legacy file of the same slug is the agent (see the module doc).
    if (!isSafeAutomationSlug(slug) || agents.has(slug)) continue;
    try {
      agents.set(slug, readAgentFile(file));
    } catch {
      // a symlinked or broken agent file is skipped, like a broken manifest
    }
  }
  return [...agents.values()].sort(bySlug);
}

function callTargetFrom(contextRoot: string, agent: AgentManifest, files: readonly SlotFile[]): AutomationManifest {
  const bindings: ApprovalBinding[] = [];
  for (const f of files) {
    const job = boundJobOf(f, agent.slug);
    if (job) bindings.push({ slug: job.slug, sha256: manifestHash(composeRun(agent, job)) });
  }
  const slot = classifyAutomationSlot(contextRoot, agent.slug);
  return composeRun(agent, null, bindings, slot === 'absent' || slot === 'legacy-call');
}

/** Every agent, sorted by slug: each unsplit legacy manifest's agent (on-call
 *  ones included) and each readable `agents/*.md` it does not shadow. */
export function listAgents(contextRoot: string): AgentManifest[] {
  return resolveAgents(contextRoot, readSlotFiles(contextRoot));
}

/** One agent, by the same precedence as {@link listAgents}, or null. */
export function getAgent(contextRoot: string, slug: string): AgentManifest | null {
  if (!isSafeAutomationSlug(slug)) return null;
  const slotPath = automationPath(contextRoot, slug);
  if (pathOccupied(slotPath)) {
    try {
      const parts = readManifestParts(slotPath);
      if (parts.kind === 'legacy') return legacyPair(parts.legacy).agent;
    } catch {
      // an unreadable slot shadows nothing; fall through to the agent file
    }
  }
  const path = agentPath(contextRoot, slug);
  if (!pathOccupied(path)) return null;
  try {
    return readAgentFile(path);
  } catch {
    return null;
  }
}

/** The call target of an already-resolved agent — `legacyKey` from the slot,
 *  `bindings` from the files, both from this very agent object. */
export function agentCallTarget(contextRoot: string, agent: AgentManifest): AutomationManifest {
  return callTargetFrom(contextRoot, agent, readSlotFiles(contextRoot));
}

/** The call target of EVERY agent (same-slug pairs' agents included). The only
 *  list an agent approval surface may iterate. */
export function listAgentTargets(contextRoot: string): AutomationManifest[] {
  const files = readSlotFiles(contextRoot);
  return resolveAgents(contextRoot, files).map((agent) => callTargetFrom(contextRoot, agent, files));
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Ensure the agents block in both governing `.gitignore` files BEFORE any agent
 *  file exists: an agent holds a prompt and is private until shared. Its own
 *  block, never appended to the automations base list (see AGENTS_GITIGNORE_ENTRIES). */
export function ensureAgentsGitignore(contextRoot: string): void {
  const comment = 'dreamcontext agents — private by default (shared ones are negated below)';
  try {
    ensureGitignoreEntries(contextRoot, [...AGENTS_GITIGNORE_ENTRIES], { comment });
    ensureGitignoreEntries(dirname(contextRoot), [...AGENTS_GITIGNORE_ENTRIES_ROOT], { comment });
  } catch (err) {
    throw new AutomationError(`An agent file cannot be written: a governing .gitignore could not be ensured (${(err as Error).message}).`);
  }
}

const IDENTITY_PATCH_KEYS: ReadonlySet<string> = new Set(['title', 'prompt', 'soul', 'model', 'effort', 'learning', 'whiteboard', 'photo']);

/** An identity patch at runtime too: a caller passing call settings (or anything
 *  else) through an untyped surface is refused, never silently dropped. */
function assertIdentityPatch(patch: AgentIdentityPatch): void {
  for (const key of Object.keys(patch)) {
    if (!IDENTITY_PATCH_KEYS.has(key)) {
      throw new AutomationError(`An agent edit cannot change "${key}": only its name, prompt, soul, model, effort, learning, home board and photo.`);
    }
  }
}

/** `agent` with `patch` applied in memory, values normalised as a write stores them. */
function applyIdentityPatch(agent: AgentManifest, patch: AgentIdentityPatch): AgentManifest {
  return {
    ...agent,
    title: patch.title === undefined ? agent.title : patch.title.trim(),
    prompt: patch.prompt === undefined ? agent.prompt : patch.prompt.trim(),
    // The same normalisation the write applies, so `withRestamp`'s expected hash
    // equals the hash of the bytes written (a NUL or a CRLF would differ otherwise).
    soul: patch.soul === undefined ? agent.soul : normalizeSoul(patch.soul),
    model: patch.model === undefined ? agent.model : patch.model,
    effort: patch.effort === undefined ? agent.effort : patch.effort,
    learning: patch.learning === undefined ? agent.learning : patch.learning,
    whiteboard: patch.whiteboard === undefined ? agent.whiteboard : patch.whiteboard,
    photo: patch.photo === undefined ? agent.photo : patch.photo,
  };
}

/** The identity checks a create and an edit share, on the full resulting agent. */
function validateIdentity(contextRoot: string, a: AgentManifest): void {
  validateAutomationForWrite({
    slug: a.slug,
    title: a.title,
    mode: 'call',
    model: a.model,
    effort: a.effort,
    photo: a.photo,
    whiteboard: a.whiteboard,
  });
  if (!a.prompt.trim()) throw new AutomationError('An agent needs a prompt: it is who the agent is.');
  validateSoul(a.soul);
  if (!a.whiteboard) return;
  // A home-board agent's only writable output folder is its default one, so no
  // automation it runs (nor its own call settings) may name another.
  const clash =
    a.call.outputDir !== null
      ? a.slug
      : readSlotFiles(contextRoot).find((f) => boundJobOf(f, a.slug)?.outputDir)?.slug;
  if (clash) {
    throw new AutomationError(`A whiteboard agent cannot also have an output dir, and "${clash}" sets one.`);
  }
}

/** Frontmatter for an identity write: optional keys are written only when set,
 *  so an ordinary agent's file carries no `effort`, `whiteboard` or `photo` key. */
function identityFrontmatter(a: AgentManifest): Record<string, unknown> {
  return {
    ...(a.photo ? { photo: a.photo } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    ...(a.learning ? { learning: true } : {}),
    ...(a.whiteboard ? { whiteboard: a.whiteboard } : {}),
  };
}

export interface CreateAgentOptions {
  /** Grant the new agent's call target directly on THIS machine (the local
   *  author is consenting). Omitted ⇒ no registry write. */
  approve?: { now: Date; home?: string };
}

/**
 * Create `agents/<slug>.md`. Refused when the slug is taken by any agent or by
 * anything at all in the automation slot. The agents `.gitignore` block is
 * ensured before the file exists; the file is created exclusively.
 */
export function createAgent(contextRoot: string, input: AgentInput, opts: CreateAgentOptions = {}): AgentManifest {
  const slug = input.slug.trim();
  const draft: AgentManifest = {
    ...placeholderAgent(slug),
    title: input.title?.trim() ?? '',
    prompt: input.prompt?.trim() ?? '',
    soul: normalizeSoul(input.soul ?? ''),
    model: input.model ?? null,
    effort: input.effort ?? null,
    // ON for anything created from now on, exactly as a new automation.
    learning: input.learning ?? true,
    whiteboard: input.whiteboard ?? null,
    photo: input.photo ?? null,
    shared: input.shared === true,
  };
  validateIdentity(contextRoot, draft);
  const path = agentPath(contextRoot, slug);
  if (getAgent(contextRoot, slug) || pathOccupied(automationPath(contextRoot, slug)) || pathOccupied(path)) {
    throw new AutomationError(`"${slug}" is already the name of an agent or an automation.`);
  }
  ensureAgentsGitignore(contextRoot);
  mkdirSync(agentsDir(contextRoot), { recursive: true });
  const frontmatter = {
    id: generateId('agt'),
    title: draft.title,
    ...identityFrontmatter(draft),
    shared: draft.shared,
  };
  const soul = draft.soul ? `\n## Soul\n\n${draft.soul}\n` : '';
  createManifestText(path, matter.stringify(`## Prompt\n\n${draft.prompt}\n${soul}`, frontmatter));
  const agent = readAgentFile(path);
  if (opts.approve) {
    const target = getRunTarget(contextRoot, slug, 'agent');
    if (target) approveAutomation(dirname(contextRoot), target, opts.approve.now, opts.approve.home);
  }
  return agent;
}

/**
 * Change an agent's identity. Does NOT approve: {@link withRestamp} is the local
 * write surface that re-approves. An unsplit agent is edited inside its legacy
 * manifest (exactly as `updateAutomation` always edited it); a split one in its
 * agent file, with optional keys removed rather than written as null.
 */
export function updateAgent(contextRoot: string, slug: string, patch: AgentIdentityPatch): AgentManifest {
  assertIdentityPatch(patch);
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No agent named "${slug}" in this project.`);
  const next = applyIdentityPatch(agent, patch);
  validateIdentity(contextRoot, next);

  if (agent.implicit) {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = next.title;
    if (patch.model !== undefined) fields.model = next.model;
    if (patch.effort !== undefined) fields.effort = next.effort;
    if (patch.learning !== undefined) fields.learning = next.learning;
    if (patch.whiteboard !== undefined) fields.whiteboard = next.whiteboard;
    if (patch.photo !== undefined) fields.photo = next.photo;
    if (Object.keys(fields).length > 0) patchManifestFrontmatter(agent.path, fields);
  } else {
    assertRegularFile(agent.path);
    const { data, content } = parseManifestFrontmatter(readFileSync(agent.path, 'utf-8'));
    const nextData: Record<string, unknown> = { ...data, title: next.title };
    for (const key of ['photo', 'model', 'effort', 'learning', 'whiteboard']) delete nextData[key];
    rewriteManifestText(agent.path, matter.stringify(content, { ...nextData, ...identityFrontmatter(next) }));
  }
  if (patch.prompt !== undefined) {
    rewriteManifestText(agent.path, upsertSection(readFileSync(agent.path, 'utf-8'), 'Prompt', next.prompt));
  }
  // Implicit and split agents alike, as the prompt: an empty soul is no section.
  if (patch.soul !== undefined) {
    const raw = readFileSync(agent.path, 'utf-8');
    rewriteManifestText(
      agent.path,
      next.soul ? upsertSectionAfter(raw, SOUL_HEADING, next.soul, 'Prompt') : removeSection(raw, SOUL_HEADING),
    );
  }
  const updated = getAgent(contextRoot, slug);
  if (!updated) throw new AutomationError(`Agent "${slug}" could not be read back after the edit.`);
  return updated;
}

/**
 * `upsertSection`, except a NEW section lands right after `## <after>` (before
 * the next `## ` heading that follows it) instead of at the end of the file, so
 * a soul sits beside the prompt and never after `## Pattern`. Appends when there
 * is no `## <after>`. Byte-surgical: nothing outside the inserted block moves.
 */
export function upsertSectionAfter(raw: string, heading: string, body: string, after: string): string {
  const lines = raw.split('\n');
  if (lines.some((l) => l.trim() === `## ${heading}`)) return upsertSection(raw, heading, body);
  const afterIdx = lines.findIndex((l) => l.trim() === `## ${after}`);
  const relNext = afterIdx === -1 ? -1 : lines.slice(afterIdx + 1).findIndex((l) => /^##\s/.test(l));
  if (relNext === -1) return upsertSection(raw, heading, body);
  const at = afterIdx + 1 + relNext;
  return [...lines.slice(0, at), `## ${heading}`, '', body.trim(), '', ...lines.slice(at)].join('\n');
}

export type RemoveAgentResult = { removed: true } | { removed: false; usedBy: string[] };

/**
 * Delete an agent. Refused (nothing written) while an automation runs as it —
 * its own unsplit scheduled manifest included. An unsplit on-call agent IS its
 * legacy manifest, so that file goes (with its cache and photo). Then the
 * registry's revoke rule: `agentApprovals[slug]` always goes, and the legacy
 * `approvals[slug]` survives only as the current record of a scheduled
 * automation now in that slot.
 */
export function removeAgent(contextRoot: string, slug: string, opts: { home?: string } = {}): RemoveAgentResult {
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No agent named "${slug}" in this project.`);
  const usedBy = readSlotFiles(contextRoot)
    .filter((f) => boundJobOf(f, slug) !== null)
    .map((f) => f.slug);
  if (usedBy.length > 0) return { removed: false, usedBy };

  if (agent.implicit) {
    removeAutomation(contextRoot, slug);
  } else {
    const photo = resolveAutomationPhoto(contextRoot, agent.photo);
    assertRegularFile(agent.path);
    unlinkSync(agent.path);
    if (photo) {
      try {
        unlinkSync(photo);
      } catch {
        // already gone
      }
    }
  }
  revokeAgent(dirname(contextRoot), slug, automationFileTarget(contextRoot, slug), opts.home);
  reparentReports(contextRoot, slug, agent.reportsTo);
  return { removed: true };
}

/**
 * Place an agent in the team: its manager (`reports_to`) and its team's name (`team`).
 * Frontmatter only, and UNHASHED: nothing is re-approved and nothing is blocked by it.
 *
 * Refused: an agent synthesised from an unsplit legacy file (it has no agent file to carry
 * the keys), a manager that is itself, unknown here, or below it (a cycle), and a team name
 * that is not one short line. `null` removes a key; the file never carries an empty one.
 */
export function setAgentPlacement(contextRoot: string, slug: string, patch: AgentPlacementPatch): AgentManifest {
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No agent named "${slug}" in this project.`);
  if (agent.implicit) {
    throw new AutomationError(`"${slug}" still lives in its old automation file, which cannot hold a place in the team: run \`dreamcontext update\` (it splits old files into an agent and its routine), then try again.`);
  }
  const fields: Record<string, unknown> = {};
  if (patch.reportsTo !== undefined) {
    const manager = patch.reportsTo === null ? null : patch.reportsTo.trim();
    if (manager === null || manager === '' || manager === 'none') {
      fields.reports_to = null;
    } else {
      if (!isSafeAutomationSlug(manager)) throw new AutomationError(`"${manager}" is not an agent name.`);
      if (manager === slug) throw new AutomationError('An agent cannot report to itself.');
      const all = listAgents(contextRoot);
      if (!all.some((a) => a.slug === manager)) throw new AutomationError(`No agent named "${manager}" in this project.`);
      if (wouldCycle(all, slug, manager)) {
        throw new AutomationError(`"${manager}" already reports to "${slug}" (directly or further down): that would make a loop.`);
      }
      fields.reports_to = manager;
    }
  }
  if (patch.team !== undefined) {
    try {
      fields.team = normalizeTeamLabel(patch.team);
    } catch (err) {
      throw new AutomationError((err as Error).message);
    }
  }
  if (Object.keys(fields).length === 0) return agent;
  writePlacement(agent.path, fields);
  return getAgent(contextRoot, slug) as AgentManifest;
}

/** Set or (with null) remove frontmatter keys of an agent file, every other byte kept as the
 *  frontmatter round-trip keeps it. */
function writePlacement(path: string, fields: Record<string, unknown>): void {
  assertRegularFile(path);
  const { data, content } = parseManifestFrontmatter(readFileSync(path, 'utf-8'));
  const next: Record<string, unknown> = { ...data };
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  rewriteManifestText(path, matter.stringify(content, next));
}

/** After `slug` is gone: whoever reported to it reports to its manager now (or to the owner),
 *  so a deleted lead never strands its reports at the top with a dangling link. */
function reparentReports(contextRoot: string, slug: string, manager: string | null): void {
  for (const a of listAgents(contextRoot)) {
    if (a.implicit || a.reportsTo !== slug) continue;
    try {
      writePlacement(a.path, { reports_to: manager && manager !== a.slug ? manager : null });
    } catch {
      // an unwritable file keeps its dangling link, which the reader draws as a root
    }
  }
}

/** Flip the agent's `shared` flag — frontmatter only. The `.gitignore`
 *  negations are `sharing.ts`'s (`shareAgent` / `unshareAgent`). */
export function setAgentShared(contextRoot: string, slug: string, shared: boolean): AgentManifest {
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No agent named "${slug}" in this project.`);
  patchManifestFrontmatter(agent.path, { shared });
  return getAgent(contextRoot, slug) as AgentManifest;
}

/** Record a lesson (or a playbook) in the agent's `## Pattern`: every automation
 *  of one agent teaches the same agent. Unhashed, so it never blocks anything. */
export function recordAgentLesson(contextRoot: string, slug: string, input: RecordLessonInput): AgentManifest {
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No agent named "${slug}" in this project.`);
  writeLessonToFile(agent.path, agent.pattern, input);
  return getAgent(contextRoot, slug) as AgentManifest;
}

export interface AgentUsage {
  /** Automations that run as this agent (its own unsplit scheduled manifest included). */
  automations: string[];
  /** Its home board, and every board carrying a live card of it. */
  boards: string[];
  /** Tasks assigned to it (`agent: <slug>` in the task frontmatter). */
  tasks: string[];
}

/** Where an agent is used. Reads only; a board or task that will not parse is skipped. */
export function agentUsage(contextRoot: string, slug: string): AgentUsage {
  const automations = readSlotFiles(contextRoot)
    .filter((f) => boundJobOf(f, slug) !== null)
    .map((f) => f.slug);

  const boards = new Set<string>();
  const home = getAgent(contextRoot, slug)?.whiteboard;
  if (home) boards.add(home);
  for (const wb of listWhiteboards(contextRoot)) {
    if (wb.corrupt) continue;
    try {
      const elements = liveElements(readWhiteboard(contextRoot, wb.slug).board.elements);
      if (elements.some((el) => {
        const dc = widgetPayloadOf(el);
        return dc?.kind === 'agent' && dc.ref === slug;
      })) boards.add(wb.slug);
    } catch {
      // an unreadable board carries no card we can see
    }
  }

  const tasks: string[] = [];
  const stateDir = join(contextRoot, 'state');
  if (pathOccupied(stateDir)) {
    for (const file of fg.sync('*.md', { cwd: stateDir, absolute: true }).sort()) {
      if (readManifestFrontmatter(file)?.data.agent === slug) tasks.push(basename(file, '.md'));
    }
  }
  return { automations, boards: [...boards].sort(), tasks };
}

/**
 * The LOCAL write surface for an agent's identity: edit, then re-approve on
 * this machine exactly what was approved before and is still what the edit
 * produced.
 *
 * A target is re-approved only when BOTH hold:
 *  - its verdict before the edit came from a DIRECT record (`self` — an
 *    automation's own record or an agent's direct grant — or `legacy-key`, rule
 *    (b)). A target approved only through a binding (rule (c)) is never written:
 *    it follows its bindings, which are re-stamped themselves.
 *  - its re-read hash equals the hash computed in memory from the pre-image plus
 *    the patch. A concurrent synced write between the edit and the re-read is
 *    therefore never stamped.
 *
 * The agent's call target is re-approved first: its approval deletes an
 * agent-owned legacy `approvals[slug]` (Invariant 2), which an unsplit on-call
 * manifest's own re-approval below then writes back at the new hash.
 */
export function withRestamp(
  contextRoot: string,
  projectRoot: string,
  agentSlug: string,
  patch: AgentIdentityPatch,
  home?: string,
  now: Date = new Date(),
): AgentManifest {
  assertIdentityPatch(patch);
  const agent = getAgent(contextRoot, agentSlug);
  if (!agent) throw new AutomationError(`No agent named "${agentSlug}" in this project.`);
  const next = applyIdentityPatch(agent, patch);

  const plan = restampTargets(contextRoot, agentSlug).map(({ kind, target }) => {
    const verdict = checkApproval(projectRoot, target, home, 'run');
    const direct = verdict.approved && (verdict.via === 'self' || verdict.via === 'legacy-key');
    return { kind, slug: target.slug, direct, expected: manifestHash(withIdentity(target, next)) };
  });

  const updated = updateAgent(contextRoot, agentSlug, patch);

  for (const p of plan) {
    if (!p.direct) continue;
    const reread = getRunTarget(contextRoot, p.slug, p.kind);
    if (reread && manifestHash(reread) === p.expected) approveAutomation(projectRoot, reread, now, home);
  }
  return updated;
}

/** The agent's call target first, then every automation file that runs as it
 *  (its own unsplit manifest included, on-call or scheduled). */
function restampTargets(contextRoot: string, agentSlug: string): { kind: RunKind; target: AutomationManifest }[] {
  const out: { kind: RunKind; target: AutomationManifest }[] = [];
  const call = getRunTarget(contextRoot, agentSlug, 'agent');
  if (call) out.push({ kind: 'agent', target: call });
  for (const f of readSlotFiles(contextRoot)) {
    const runsAsAgent = f.parts.kind === 'bound' ? f.parts.job.agent === agentSlug : f.slug === agentSlug;
    if (!runsAsAgent) continue;
    const target = getRunTarget(contextRoot, f.slug, 'automation');
    if (target) out.push({ kind: 'automation', target });
  }
  return out;
}

/** `target` with the identity fields of `agent` — what it hashes to once the
 *  agent edit lands. Every identity field the hash covers comes from the agent. */
function withIdentity(target: AutomationManifest, agent: AgentManifest): AutomationManifest {
  return {
    ...target,
    prompt: agent.prompt,
    soul: agent.soul,
    model: agent.model,
    effort: agent.effort,
    learning: agent.learning,
    whiteboard: agent.whiteboard,
  };
}
