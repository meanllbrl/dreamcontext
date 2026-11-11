import { stopAgentTaskJobs } from './task-starter.js';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { removeMemberGrants } from '../grants/store.js';
import { basename, dirname, join } from 'node:path';
import { lockHolderPid, withFileLockSync } from '../file-lock.js';
import fg from '../glob.js';
import matter from 'gray-matter';
import { ensureGitignoreEntries } from '../gitignore.js';
import { generateId } from '../id.js';
import {
  AutomationError,
  DEFAULT_AGENT_AUTONOMY,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  PATTERN_HEADING,
  REVIEW_MODES,
  SOUL_HEADING,
  type ApprovalBinding,
  type AutomationJob,
  type AutomationManifest,
  parseAutonomy,
  type ReviewMode,
  type RunKind,
} from '../automations/types.js';
import { parseFace } from './figure.js';
import { nextFreeFace } from './faces.js';
import { forgetAgentLocal } from '../local-store.js';
import { GLOBAL_REGISTRY_KEY, globalAgentExists, globalAgentHome, globalAgentPath, globalAgentsDir, hasProjectMember, isGlobalAgentHere, listGlobalAgentSlugs } from './scope.js';
import { appendGlobalJournal, consolidateGlobalMemory, readGlobalPattern } from './global-memory.js';
import {
  APP_TOOL_REF_RE,
  appToolsOf,
  assertRegularFile,
  automationFileTarget,
  automationPath,
  createManifestText,
  extractSection,
  getRunTarget,
  listManifestFiles,
  listRunSlots,
  lockPathFor,
  memberMutexPath,
  numberOrDefault,
  parseEffort,
  parseFlowSection,
  patchManifestFrontmatter,
  stampOwnerWrite,
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
import { approvalFields, approveAutomation, checkApproval, listRegisteredProjects, manifestHash, revokeAgent } from '../automations/registry.js';
import { readWhiteboard, listWhiteboards } from '../whiteboards/store.js';
import { liveElements } from '../whiteboards/ops.js';
import { widgetPayloadOf } from '../whiteboards/widgets.js';
import { classifyAutomationSlot, isSafeAutomationSlug, parseManifestFrontmatter, readManifestFrontmatter } from './slot.js';
import { assertOwned, currentLogin, parseOwner } from './owner.js';
import { adoptPattern, agentSyncSwitchOn, effectivePattern, recordCreatedLocally } from './agent-sync.js';
import { composeRun, legacyPair } from './compose.js';
import { readToolsOf } from './read-tools.js';
import { toolFieldsOf } from '../automations/store.js';
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
  type AgentScope,
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
export function readAgentFile(filePath: string, scope: AgentScope = 'project'): AgentManifest {
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
    // Only when set and non-empty: every member file without it keeps its hash.
    ...(call && appToolsOf(call.app_tools).length ? { appTools: appToolsOf(call.app_tools) } : {}),
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
    // `scope: board` only, and only beside a home board: anything else reads as unset. It is hashed,
    // so a hand edit that drops or mangles it blocks the agent until it is approved again.
    ...(isBoardScopeValue(data.scope) && typeof data.whiteboard === 'string' && data.whiteboard.trim() ? { boardOnly: true } : {}),
    shared: data.shared === true,
    reportsTo: typeof data.reports_to === 'string' && isSafeAutomationSlug(data.reports_to.trim()) ? data.reports_to.trim() : null,
    team: readTeamLabel(data.team),
    call: callSettings,
    autonomy: parseAutonomy(data.autonomy),
    ...(readToolsOf(data.read_tools).length ? { readTools: readToolsOf(data.read_tools) } : {}),
    ...toolFieldsOf(data),
    face: parseFace(data.face),
    owner: parseOwner(data.owner),
    updated: strOrNull(data.updated),
    migratedFrom: strOrNull(data.migrated_from),
    implicit: false,
    scope,
    path: filePath,
    body: content.trim(),
  };
}

/**
 * One GLOBAL agent (D1, `scope.ts`), or null when it is missing or unreadable. Its pattern is its
 * memory (`global-memory.ts`: the folded memory plus the journal not yet folded), never a
 * `## Pattern` section, and it reports to the owner in every project (no place in a team).
 */
export function readGlobalAgent(slug: string, home?: string): AgentManifest | null {
  if (!globalAgentExists(slug, home)) return null;
  try {
    const agent = readAgentFile(globalAgentPath(slug, home), 'global');
    return { ...agent, pattern: readGlobalPattern(slug, home), reportsTo: null, team: null, shared: false };
  } catch {
    return null;
  }
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
    autonomy: DEFAULT_AGENT_AUTONOMY,
    face: null,
    owner: null,
    updated: null,
    migratedFrom: null,
    implicit: false,
    scope: 'project',
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

function resolveAgents(contextRoot: string, files: readonly SlotFile[], home?: string): AgentManifest[] {
  const agents = new Map<string, AgentManifest>();
  for (const f of files) {
    if (f.parts.kind === 'legacy' && f.parts.legacy.target !== 'super') agents.set(f.slug, legacyPair(f.parts.legacy).agent);
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
  // This machine's global agents (D1), each unless a project member of its name shadows it here.
  for (const slug of listGlobalAgentSlugs(home)) {
    if (agents.has(slug) || hasProjectMember(contextRoot, slug)) continue;
    const agent = readGlobalAgent(slug, home);
    if (agent) agents.set(slug, agent);
  }
  return [...agents.values()].sort(bySlug);
}

function callTargetFrom(contextRoot: string, agent: AgentManifest, files: readonly SlotFile[]): AutomationManifest {
  const bindings: ApprovalBinding[] = [];
  for (const f of files) {
    const job = boundJobOf(f, agent.slug);
    if (job) bindings.push({ slug: job.slug, sha256: manifestHash(composeRun(agent, job)) });
  }
  // A global agent has no legacy record anywhere: its approval is its `global` grant alone.
  if (agent.scope === 'global') return composeRun(agent, null, bindings, false);
  const slot = classifyAutomationSlot(contextRoot, agent.slug);
  return composeRun(agent, null, bindings, slot === 'absent' || slot === 'legacy-call');
}

/** Every agent, sorted by slug: each unsplit legacy manifest's agent (on-call
 *  ones included) and each readable `agents/*.md` it does not shadow. `home`
 *  is the machine home the global agents are read from (default: the real one). */
export function listAgents(contextRoot: string, home?: string): AgentManifest[] {
  return resolveAgents(contextRoot, readSlotFiles(contextRoot), home);
}

/** One agent, by the same precedence as {@link listAgents}, or null. */
export function getAgent(contextRoot: string, slug: string, home?: string): AgentManifest | null {
  if (!isSafeAutomationSlug(slug)) return null;
  const slotPath = automationPath(contextRoot, slug);
  if (pathOccupied(slotPath)) {
    try {
      const parts = readManifestParts(slotPath);
      // A Super automation is the Super's own turn, never a member (super-rutin C2).
      if (parts.kind === 'legacy') return parts.legacy.target === 'super' ? null : legacyPair(parts.legacy).agent;
    } catch {
      // an unreadable slot shadows nothing; fall through to the agent file
    }
  }
  const path = agentPath(contextRoot, slug);
  // No member of this name here: this machine's global agent of that name, if there is one (D1).
  if (!pathOccupied(path)) return isGlobalAgentHere(contextRoot, slug, home) ? readGlobalAgent(slug, home) : null;
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
export function listAgentTargets(contextRoot: string, home?: string): AutomationManifest[] {
  const files = readSlotFiles(contextRoot);
  return resolveAgents(contextRoot, files, home).map((agent) => callTargetFrom(contextRoot, agent, files));
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

const IDENTITY_PATCH_KEYS: ReadonlySet<string> = new Set(['title', 'prompt', 'soul', 'model', 'effort', 'learning', 'whiteboard', 'boardOnly', 'photo', 'autonomy', 'tool', 'account']);

/** The frontmatter value that limits a home-board agent to its board: `scope: board`. */
export function isBoardScopeValue(v: unknown): boolean {
  return typeof v === 'string' && v.trim().toLowerCase() === 'board';
}

/** An identity patch at runtime too: a caller passing call settings (or anything
 *  else) through an untyped surface is refused, never silently dropped. */
function assertIdentityPatch(patch: AgentIdentityPatch): void {
  for (const key of Object.keys(patch)) {
    if (!IDENTITY_PATCH_KEYS.has(key)) {
      throw new AutomationError(`An agent edit cannot change "${key}": only its name, prompt, soul, model, effort, learning, home board, board limit, photo, autonomy, tool and account.`);
    }
  }
}

/** `agent` with `patch` applied in memory, values normalised as a write stores them. */
function applyIdentityPatch(agent: AgentManifest, patch: AgentIdentityPatch): AgentManifest {
  const tool = patch.tool === undefined ? agent.tool : patch.tool ?? undefined;
  const account = patch.account === undefined ? agent.account : patch.account ?? undefined;
  const { tool: _t, account: _a, boardOnly: _b, ...rest } = agent;
  const whiteboard = patch.whiteboard === undefined ? agent.whiteboard : patch.whiteboard;
  // Limited to a board only while it has one: removing the board removes the limit with it.
  const boardOnly = !!whiteboard && (patch.boardOnly === undefined ? agent.boardOnly === true : patch.boardOnly === true);
  return {
    ...rest,
    ...(boardOnly ? { boardOnly: true } : {}),
    ...(tool ? { tool } : {}),
    ...(tool && account ? { account } : {}),
    title: patch.title === undefined ? agent.title : patch.title.trim(),
    prompt: patch.prompt === undefined ? agent.prompt : patch.prompt.trim(),
    // The same normalisation the write applies, so `withRestamp`'s expected hash
    // equals the hash of the bytes written (a NUL or a CRLF would differ otherwise).
    soul: patch.soul === undefined ? agent.soul : normalizeSoul(patch.soul),
    model: patch.model === undefined ? agent.model : patch.model,
    effort: patch.effort === undefined ? agent.effort : patch.effort,
    learning: patch.learning === undefined ? agent.learning : patch.learning,
    whiteboard,
    photo: patch.photo === undefined ? agent.photo : patch.photo,
    autonomy: patch.autonomy === undefined ? agent.autonomy : parseAutonomy(patch.autonomy),
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
    // Only when set (and only beside a board), so every other agent's file is unchanged.
    ...(a.whiteboard && a.boardOnly ? { scope: 'board' } : {}),
    // Only a level other than the default is written, so an ordinary agent's file is unchanged.
    ...(a.autonomy !== DEFAULT_AGENT_AUTONOMY ? { autonomy: a.autonomy } : {}),
    // Only off Claude, so an ordinary agent's file is unchanged.
    ...(a.tool ? { tool: a.tool } : {}),
    ...(a.tool && a.account ? { account: a.account } : {}),
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
    ...(input.whiteboard && input.boardOnly ? { boardOnly: true } : {}),
    photo: input.photo ?? null,
    shared: input.shared === true,
    autonomy: parseAutonomy(input.autonomy),
  };
  if (input.boardOnly && !input.whiteboard) throw new AutomationError('Only an agent with a home board can be limited to it: give it --whiteboard <board> too.');
  validateIdentity(contextRoot, draft);
  const path = agentPath(contextRoot, slug);
  if (globalAgentExists(slug)) throw new AutomationError(`"${slug}" is already the name of one of your global agents.`);
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
    // Stamped once, here: the next free face in this vault (agents + automations), so adding a
    // member never moves anyone else's face.
    face: nextFreeFace(contextRoot, slug),
    // Its creator, unhashed: everyone else reads it, read-only (`agents/owner.ts`).
    owner: currentLogin(),
    updated: new Date().toISOString(),
  };
  const soul = draft.soul ? `\n## Soul\n\n${draft.soul}\n` : '';
  createManifestText(path, matter.stringify(`## Prompt\n\n${draft.prompt}\n${soul}`, frontmatter));
  // Created HERE: once agents sync, this is what tells this machine's own from what arrived.
  if (agentSyncSwitchOn(contextRoot)) recordCreatedLocally(contextRoot, `agents/${slug}.md`);
  const agent = readAgentFile(path);
  if (opts.approve) {
    const target = getRunTarget(contextRoot, slug, 'agent');
    if (target) approveAutomation(dirname(contextRoot), target, opts.approve.now, opts.approve.home);
  }
  return agent;
}

/**
 * Create a GLOBAL agent (D1): `~/.dreamcontext/agents/<slug>.md` on this machine, listed in every
 * project, never in a brain. No photo and no home board (both are a project's); its memory is its
 * own journal (`global-memory.ts`). `approve` grants it in the registry's `global` bucket, so one
 * approval covers every project.
 */
export function createGlobalAgent(input: AgentInput, opts: CreateAgentOptions = {}): AgentManifest {
  const slug = input.slug.trim();
  if (input.photo || input.whiteboard) throw new AutomationError('A global agent has no photo and no home board: both belong to one project.');
  const draft: AgentManifest = {
    ...placeholderAgent(slug),
    scope: 'global',
    title: input.title?.trim() ?? '',
    prompt: input.prompt?.trim() ?? '',
    soul: normalizeSoul(input.soul ?? ''),
    model: input.model ?? null,
    effort: input.effort ?? null,
    learning: input.learning ?? true,
    autonomy: parseAutonomy(input.autonomy),
  };
  validateAutomationForWrite({ slug, title: draft.title, mode: 'call', model: draft.model, effort: draft.effort, photo: null, whiteboard: null });
  if (!draft.prompt.trim()) throw new AutomationError('An agent needs a prompt: it is who the agent is.');
  validateSoul(draft.soul);
  const path = globalAgentPath(slug);
  if (pathOccupied(path)) throw new AutomationError(`"${slug}" is already the name of one of your global agents.`);
  // A folder with no agent file is what a deleted one left (a late run write): never inherited.
  if (pathOccupied(globalAgentHome(slug))) rmSync(globalAgentHome(slug), { recursive: true, force: true });
  mkdirSync(globalAgentsDir(), { recursive: true, mode: 0o700 });
  try { chmodSync(globalAgentsDir(), 0o700); } catch { /* best effort */ }
  const frontmatter = {
    id: generateId('agt'),
    title: draft.title,
    ...identityFrontmatter(draft),
    owner: currentLogin(),
    updated: new Date().toISOString(),
  };
  const soul = draft.soul ? `\n## Soul\n\n${draft.soul}\n` : '';
  createManifestText(path, matter.stringify(`## Prompt\n\n${draft.prompt}\n${soul}`, frontmatter));
  const agent = readGlobalAgent(slug);
  if (!agent) throw new AutomationError(`The global agent "${slug}" could not be read back.`);
  if (opts.approve) approveAutomation(GLOBAL_REGISTRY_KEY, composeRun(agent, null, [], false), opts.approve.now, opts.approve.home);
  return agent;
}

/** Every global agent of this machine, sorted (the launcher's list). */
export function listGlobalAgents(): AgentManifest[] {
  return listGlobalAgentSlugs().flatMap((slug) => {
    const a = readGlobalAgent(slug);
    return a ? [a] : [];
  });
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
  assertOwned({ owner: agent.owner }, agent.title || slug);
  if (patch.boardOnly === true && !(patch.whiteboard === undefined ? agent.whiteboard : patch.whiteboard)) {
    throw new AutomationError(`"${slug}" has no home board to be limited to: give it one with --whiteboard <board> first.`);
  }
  if (agent.scope === 'global' && (patch.photo || patch.whiteboard)) {
    throw new AutomationError('A global agent has no photo and no home board: both belong to one project.');
  }
  const next = applyIdentityPatch(agent, patch);
  validateIdentity(contextRoot, next);
  if (agent.implicit && patch.autonomy !== undefined && next.autonomy !== agent.autonomy) {
    throw new AutomationError(`"${slug}" still lives in its old automation file, which cannot hold an autonomy level: run \`dreamcontext update\` (it splits old files into an agent and its routine), then try again.`);
  }

  if (next.tool && next.whiteboard) {
    throw new AutomationError('An agent with a home board stays on Claude: Codex cannot keep it out of credential folders.');
  }

  if (agent.implicit) {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = next.title;
    if (patch.model !== undefined) fields.model = next.model;
    if (patch.effort !== undefined) fields.effort = next.effort;
    if (patch.learning !== undefined) fields.learning = next.learning;
    if (patch.whiteboard !== undefined) fields.whiteboard = next.whiteboard;
    if (patch.whiteboard !== undefined || patch.boardOnly !== undefined) fields.scope = next.boardOnly ? 'board' : null;
    if (patch.photo !== undefined) fields.photo = next.photo;
    if (patch.tool !== undefined) fields.tool = next.tool ?? null;
    if (patch.tool !== undefined || patch.account !== undefined) fields.account = next.account ?? null;
    if (Object.keys(fields).length > 0) patchManifestFrontmatter(agent.path, fields);
  } else {
    assertRegularFile(agent.path);
    const { data, content } = parseManifestFrontmatter(readFileSync(agent.path, 'utf-8'));
    const nextData: Record<string, unknown> = { ...data, title: next.title };
    for (const key of ['photo', 'model', 'effort', 'learning', 'whiteboard', 'scope', 'autonomy', 'tool', 'account']) delete nextData[key];
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
  stampOwnerWrite(agent.path);
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

/** The automations (by slug) that run as `slug` in this project: what `removeAgent` refuses on
 *  (plan r4 F4: the member delete names and removes exactly these). Its own unsplit scheduled
 *  manifest included. */
export function routinesBoundTo(contextRoot: string, slug: string): string[] {
  return readSlotFiles(contextRoot).filter((f) => boundJobOf(f, slug) !== null).map((f) => f.slug);
}

/**
 * Delete an agent. Refused (nothing written) while an automation runs as it —
 * its own unsplit scheduled manifest included. An unsplit on-call agent IS its
 * legacy manifest, so that file goes (with its cache and photo). Then the
 * registry's revoke rule: `agentApprovals[slug]` always goes, and the legacy
 * `approvals[slug]` survives only as the current record of a scheduled
 * automation now in that slot.
 */
export function removeAgent(contextRoot: string, slug: string, opts: { home?: string; ownSchedule?: boolean } = {}): RemoveAgentResult {
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No agent named "${slug}" in this project.`);
  assertOwned({ owner: agent.owner }, agent.title || slug);
  // `ownSchedule`: the member delete removes the agent WITH its own unsplit scheduled manifest
  // (that manifest is the agent), so it does not count as a routine still running as it.
  const usedBy = readSlotFiles(contextRoot)
    .filter((f) => boundJobOf(f, slug) !== null)
    .map((f) => f.slug)
    .filter((s) => !(opts.ownSchedule && s === slug && agent.implicit));
  if (usedBy.length > 0) return { removed: false, usedBy };
  if (agent.scope === 'global') return removeGlobalAgent(slug, opts);

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
  // Its machine-local entries die with it (the stage's home session).
  forgetAgentLocal(dirname(contextRoot), slug, opts.home);
  // Its task jobs: queued steps stop ("agent gone"), its sessions are forgotten (C1-5).
  stopAgentTaskJobs(contextRoot, slug, opts.home);
  reparentReports(contextRoot, slug, agent.reportsTo);
  dropMemberRules(slug, contextRoot, opts.home);
  return { removed: true };
}

/**
 * Delete a GLOBAL agent everywhere: its file, its folder (memory, every project's threads and
 * outputs), its `global` grant, and in every registered project where it was the agent of that
 * name, its machine-local entries and its task jobs (each key's death, D1).
 */
export function removeGlobalAgent(slug: string, opts: { home?: string } = {}): RemoveAgentResult {
  const path = globalAgentPath(slug);
  assertRegularFile(path);
  const projects = listRegisteredProjects(opts.home).filter((root) => isGlobalAgentHere(join(root, '_dream_context'), slug));
  // A routine in ANY project still runs as it: refused, as a project agent's delete is.
  const usedBy = projects.flatMap((root) => readSlotFiles(join(root, '_dream_context'))
    .filter((f) => boundJobOf(f, slug) !== null)
    .map((f) => `${basename(root)}/${f.slug}`));
  if (usedBy.length > 0) return { removed: false, usedBy };
  // A run of it in any project still holds its lock (in its folder, which the delete removes).
  for (const root of projects) {
    const ctx = join(root, '_dream_context');
    const pid = lockHolderPid(lockPathFor(ctx, slug)) ?? listRunSlots(ctx, slug)[0]?.pid ?? null;
    if (pid !== null && pidAlive(pid)) throw new AutomationError(`"${slug}" is running in ${basename(root)}: delete it once that run ends.`);
  }
  // Every key's death BEFORE the file goes, while its paths still resolve to its own folder.
  for (const root of projects) {
    try {
      stopAgentTaskJobs(join(root, '_dream_context'), slug, opts.home);
      forgetAgentLocal(root, slug, opts.home);
    } catch {
      // that project's reconciler closes what is left
    }
  }
  unlinkSync(path);
  try { rmSync(globalAgentHome(slug), { recursive: true, force: true }); } catch { /* left for a later delete */ }
  revokeAgent(GLOBAL_REGISTRY_KEY, slug, null, opts.home);
  dropMemberRules(slug, null, opts.home);
  return { removed: true };
}

/** A deleted member's "Always allowed" rules die with it (K3 "Scopes and their deaths"): in its
 *  project, or everywhere for a global member. Here, so every delete path (route, CLI, the
 *  automations route, the member delete) takes them. Best effort: a rule left behind names a
 *  member that no session can be until the slug is reused. */
function dropMemberRules(slug: string, contextRoot: string | null, home?: string): void {
  try {
    const opts = home ? { home } : undefined;
    if (contextRoot === null) { removeMemberGrants(slug, undefined, opts); return; }
    let project = dirname(contextRoot);
    try { project = realpathSync.native(project); } catch { /* as written */ }
    removeMemberGrants(slug, project, opts);
  } catch { /* see above */ }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
  assertOwned({ owner: agent.owner }, agent.title || slug);
  if (agent.implicit) {
    throw new AutomationError(`"${slug}" still lives in its old automation file, which cannot hold a place in the team: run \`dreamcontext update\` (it splits old files into an agent and its routine), then try again.`);
  }
  if (agent.scope === 'global') throw new AutomationError(`"${slug}" is a global agent: it reports to you in every project.`);
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
  assertOwned({ owner: agent.owner }, agent.title || slug);
  if (agent.scope === 'global') throw new AutomationError(`"${slug}" is a global agent: it stays on this machine and is never shared.`);
  patchManifestFrontmatter(agent.path, { shared });
  return getAgent(contextRoot, slug) as AgentManifest;
}

/** Record a lesson (or a playbook) in the agent's `## Pattern`: every automation
 *  of one agent teaches the same agent. Unhashed, so it never blocks anything. */
export function recordAgentLesson(contextRoot: string, slug: string, input: RecordLessonInput): AgentManifest {
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No agent named "${slug}" in this project.`);
  assertOwned({ owner: agent.owner }, agent.title || slug);
  if (agent.scope === 'global') {
    // Its own journal file, then a fold: runs in other projects never lose this lesson (D1).
    appendGlobalJournal(slug, dirname(contextRoot), input, { runId: process.env.DREAMCONTEXT_RUN_ID });
    consolidateGlobalMemory(slug);
    return readGlobalAgent(slug) as AgentManifest;
  }
  // The lesson lands on the pattern as THIS machine adopted it (B1-6), and the result is adopted.
  // Read inside the lock: two parallel turns of this agent can each learn something.
  return withFileLockSync(memberMutexPath(contextRoot, slug, 'lesson'), () => {
    const now = getAgent(contextRoot, slug) as AgentManifest;
    writeLessonToFile(now.path, effectivePattern(contextRoot, slug, now.pattern), input);
    const after = getAgent(contextRoot, slug) as AgentManifest;
    adoptIfSyncing(contextRoot, slug, after.pattern);
    return after;
  });
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
  opts: RestampOptions = {},
): AgentManifest {
  assertIdentityPatch(patch);
  const agent = getAgent(contextRoot, agentSlug);
  if (!agent) throw new AutomationError(`No agent named "${agentSlug}" in this project.`);
  const next = applyIdentityPatch(agent, patch);
  // The change waits for the one approval card (plan-r10 1e): written, never stamped.
  if (opts.stamp === false) return updateAgent(contextRoot, agentSlug, patch);
  // Another tool means another vendor reads the prompt: only the owner's own save stamps it
  // (Track T W4). His save on the dashboard IS that approval (`consent`, set only by an owner-page
  // route); no other caller changes a tool, and one that did would wait for the card.
  if ((next.tool ?? '') !== (agent.tool ?? '') && !opts.consent) return updateAgent(contextRoot, agentSlug, patch);

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

/** How `withRestamp` stamps. Both absent = today's rule (re-stamp what was directly approved
 *  before and is exactly what the edit produced; never across a tool change). */
export interface RestampOptions {
  /** false: write only. The change waits for the one approval card (a background process's risky
   *  text, `localWriteStamps`). */
  stamp?: boolean;
  /** The owner's own save on an owner-page route: a tool change stamps too. Set ONLY by such a
   *  route. The "approved as it stood before" precondition still holds. */
  consent?: boolean;
}

/** The agent's call target as it would read once `patch` is written: what the approval rule
 *  judges a change by (`widensAuthority`), computed in memory, nothing written. */
export function previewCallTarget(contextRoot: string, agentSlug: string, patch: AgentIdentityPatch): { before: AutomationManifest; after: AutomationManifest } | null {
  assertIdentityPatch(patch);
  const agent = getAgent(contextRoot, agentSlug);
  const before = getRunTarget(contextRoot, agentSlug, 'agent');
  if (!agent || !before) return null;
  return { before, after: withIdentity(before, applyIdentityPatch(agent, patch)) };
}

/** A run target as `widensAuthority` reads it: its review fields, `mode`, `enabled`, where it lives. */
export function widenViewOf(m: AutomationManifest): Record<string, unknown> & { scope: 'project' | 'global' } {
  return {
    ...(approvalFields(m) as unknown as Record<string, unknown>),
    mode: m.mode ?? 'call',
    enabled: m.enabled !== false,
    ...(m.fallbackTools?.length ? { fallbackTools: [...m.fallbackTools] } : {}),
    scope: m.agentScope === 'global' ? 'global' : 'project',
  };
}

/**
 * Turn a member's calls on or off: `call.enabled` in its file and nothing else (unhashed, so the
 * member stays exactly as approved). A global member's file is the global manifest (off in every
 * project). The ONE write path behind the Ekip list's switch (`POST /api/agents/:slug/enabled`,
 * owner page only, plan-r10 1d); an agent never reaches it.
 */
export function setAgentCallEnabled(contextRoot: string, slug: string, enabled: boolean): AgentManifest {
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No agent named "${slug}" in this project.`);
  assertOwned({ owner: agent.owner }, agent.title || slug);
  if (agent.implicit) {
    // An unsplit on-call agent IS its legacy manifest: its own `enabled` is the call's.
    patchManifestFrontmatter(agent.path, { enabled });
  } else {
    assertRegularFile(agent.path);
    const { data, content } = parseManifestFrontmatter(readFileSync(agent.path, 'utf-8'));
    const call = data.call && typeof data.call === 'object' && !Array.isArray(data.call) ? { ...(data.call as Record<string, unknown>) } : {};
    if (enabled) delete call.enabled; else call.enabled = false;
    const nextData: Record<string, unknown> = { ...data };
    if (Object.keys(call).length > 0) nextData.call = call; else delete nextData.call;
    rewriteManifestText(agent.path, matter.stringify(content, nextData));
  }
  const after = getAgent(contextRoot, slug);
  if (!after) throw new AutomationError(`Agent "${slug}" could not be read back after the switch.`);
  return after;
}

/**
 * Set the app tools a job or a member may run to CHANGE something (`automations edit --app-tools`,
 * app-arac-izin). An automation file (scheduled, on-call or a job bound to a member) holds them as
 * `app_tools:`; a member's own file as `call.app_tools:` (what a call of it, `dc.team.ask` or
 * `super team ask`, may run). An empty list removes the field. Every entry is `<app>/<tool>`, at
 * most 20. Nothing is approved here: the field is hashed, so the owner's card asks again.
 */
export function setAppTools(contextRoot: string, slug: string, refs: readonly string[]): { kind: 'automation' | 'member'; path: string; appTools: string[] } {
  const list = [...new Set(refs.map((x) => x.trim()).filter(Boolean))];
  for (const t of list) if (!APP_TOOL_REF_RE.test(t)) throw new AutomationError(`Invalid app tool "${t}": write it as <app>/<tool>, e.g. yuk-izleme/notify-test.`);
  if (list.length > 20) throw new AutomationError('At most 20 app tools.');
  if (!isSafeAutomationSlug(slug)) throw new AutomationError(`Invalid slug "${slug}".`);
  const file = automationPath(contextRoot, slug);
  if (pathOccupied(file)) {
    const parts = readManifestParts(file);
    const m = parts.kind === 'legacy' ? parts.legacy : parts.job;
    if (parts.kind === 'legacy' && parts.legacy.target === 'super' && list.length) {
      throw new AutomationError('A Super automation is a turn of the Super itself: it takes no app tools (the Super runs them as the owner does).');
    }
    assertOwned({ owner: m.owner ?? null }, m.title || slug);
    assertRegularFile(file);
    const { data, content } = parseManifestFrontmatter(readFileSync(file, 'utf-8'));
    const next: Record<string, unknown> = { ...data };
    if (list.length) next.app_tools = list; else delete next.app_tools;
    rewriteManifestText(file, matter.stringify(content, next));
    return { kind: 'automation', path: file, appTools: list };
  }
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No automation or AI Team member named "${slug}" in this project.`);
  if (agent.scope === 'global') throw new AutomationError(`${agent.title || slug} is a member of every project: give the app tools to a job of it here instead (automations create --agent ${slug} --app-tools ...).`);
  assertOwned({ owner: agent.owner }, agent.title || slug);
  assertRegularFile(agent.path);
  const { data, content } = parseManifestFrontmatter(readFileSync(agent.path, 'utf-8'));
  const call = data.call && typeof data.call === 'object' && !Array.isArray(data.call) ? { ...(data.call as Record<string, unknown>) } : {};
  if (list.length) call.app_tools = list; else delete call.app_tools;
  const nextData: Record<string, unknown> = { ...data };
  if (Object.keys(call).length > 0) nextData.call = call; else delete nextData.call;
  rewriteManifestText(agent.path, matter.stringify(content, nextData));
  return { kind: 'member', path: agent.path, appTools: list };
}

/** The agent's call target first, then every automation file that runs as it
 *  (its own unsplit manifest included, on-call or scheduled). */
export function restampTargets(contextRoot: string, agentSlug: string): { kind: RunKind; target: AutomationManifest }[] {
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
  // The board limit is identity too: carried only when set, dropped when the agent no longer has it.
  const { boardOnly: _limit, ...rest } = target;
  return {
    ...rest,
    ...(agent.whiteboard && agent.boardOnly ? { boardOnly: true } : {}),
    prompt: agent.prompt,
    soul: agent.soul,
    model: agent.model,
    effort: agent.effort,
    learning: agent.learning,
    whiteboard: agent.whiteboard,
    autonomy: agent.autonomy,
    ...(agent.readTools?.length ? { readTools: agent.readTools } : {}),
    ...(agent.tool ? { tool: agent.tool } : {}),
    ...(agent.tool && agent.account ? { account: agent.account } : {}),
  };
}

/** After a local pattern write: adopt the new text, so this machine's own lessons never read as a
 *  change from elsewhere. A no-op while the agent-sync switch is off. */
export function adoptIfSyncing(contextRoot: string, slug: string, pattern: string): void {
  if (!agentSyncSwitchOn(contextRoot)) return;
  try { adoptPattern(contextRoot, slug, pattern); } catch { /* adopted at the next run */ }
}
