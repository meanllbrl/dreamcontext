import { readFileSync } from 'node:fs';
import matter from 'gray-matter';
import {
  automationPath,
  extractSection,
  pathOccupied,
  readAutomationFile,
  readManifestParts,
  rewriteManifestText,
  JOB_HEADING,
} from './store.js';
import { parseManifestFrontmatter } from '../agents/slot.js';
import { agentPath, agentUsage, getAgent } from '../agents/store.js';
import { assertOwned } from '../agents/owner.js';
import { AutomationError, DEFAULT_AGENT_AUTONOMY, FLOW_HEADING, PATTERN_HEADING, SOUL_HEADING, type AutomationManifest } from './types.js';
import { CONDITION_HEADING } from './condition.js';

/**
 * RE-ATTACHING A ROUTINE TO A MEMBER, AND DETACHING ONE (owner 2026-11-17).
 *
 * An automation file without `agent:` is its own AI Team member: an agent that forgot `--agent`
 * made a duplicate of a member the owner already had. `attachRoutine` turns that file into the
 * member's routine IN PLACE: same slug, id, face, schedule, enabled state, condition, flow, owner
 * and output folder, so its history, thread and cache (all keyed by slug) stay where they are. Its
 * prompt becomes the routine's `## Job`; the identity it carried (photo, model, effort, soul, pattern,
 * board, tool) is the member's from now on, and `dropped` names what was left behind.
 *
 * `detachRoutine` is the way back: a member's routine becomes its own member, its prompt the
 * member's prompt followed by the job, with the member's whole run envelope (model, effort, soul,
 * tool, home board and board limit; never its photo file); refused when the member holds what a file of its own
 * cannot (an autonomy level, read tools). Neither direction ever changes what is published.
 *
 * Neither APPROVES anything: the file's hash moves, so the routine waits for the owner's card until
 * the caller stamps it by the same rule a create follows (see `automations edit --agent`).
 */

/** The job-half frontmatter keys a routine file keeps through either direction. */
const JOB_KEYS = [
  'id', 'title', 'mode', 'face', 'owner', 'enabled', 'schedule', 'timeout_minutes', 'catchup_hours',
  'output', 'shared', 'notify', 'review', 'app', 'app_tools', 'condition_wake',
] as const;

/** Sections a re-attach rewrites itself; any other section of the old file is named as dropped. */
const KNOWN_SECTIONS = new Set(['Prompt', 'Output instructions', FLOW_HEADING, CONDITION_HEADING, SOUL_HEADING, PATTERN_HEADING, JOB_HEADING]);

/** Every heading of `content` that is not one a re-attach carries. */
function otherSections(content: string): string[] {
  return content.split('\n').map((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1]).filter((h): h is string => !!h && !KNOWN_SECTIONS.has(h));
}

/** The scaffold's placeholder prompt: never carried over as a job. */
const PLACEHOLDER_PROMPT = /^\(What should this automation do\?/;

export interface AttachResult {
  before: AutomationManifest;
  after: AutomationManifest;
  /** What the old file held that a routine does not keep (identity fields, soul, pattern lessons). */
  dropped: string[];
}

function sectionOrNull(content: string, heading: string): string | null {
  return content.split('\n').some((l) => l.trim() === `## ${heading}`) ? extractSection(content, heading) : null;
}

function pick(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k];
  return out;
}

function jobTail(content: string): string[] {
  const out: string[] = [];
  const outputInstructions = sectionOrNull(content, 'Output instructions');
  if (outputInstructions !== null) out.push('## Output instructions', '', outputInstructions, '');
  const flow = sectionOrNull(content, FLOW_HEADING);
  if (flow !== null) out.push(`## ${FLOW_HEADING}`, '', flow, '');
  const condition = sectionOrNull(content, CONDITION_HEADING);
  if (condition !== null) out.push(`## ${CONDITION_HEADING}`, '', condition, '');
  return out;
}

/** Make the member-of-its-own file `slug` a routine of the existing member `memberSlug`. */
export function attachRoutine(contextRoot: string, slug: string, memberSlug: string, now: Date = new Date()): AttachResult {
  const path = automationPath(contextRoot, slug);
  if (!pathOccupied(path)) throw new AutomationError(`No such automation: ${slug}`);
  const parts = readManifestParts(path);
  if (parts.kind === 'bound') {
    if (parts.job.agent === memberSlug) throw new AutomationError(`"${slug}" is already a routine of "${memberSlug}".`);
    throw new AutomationError(`"${slug}" is a routine of "${parts.job.agent}". Detach it first (\`automations edit ${slug} --no-agent\`), or leave it there.`);
  }
  const before = parts.legacy;
  if (before.target === 'super') throw new AutomationError(`"${slug}" is a turn of the Super itself: it runs as no member.`);
  if (memberSlug === slug) throw new AutomationError(`"${slug}" cannot be a routine of itself.`);
  const member = getAgent(contextRoot, memberSlug);
  if (!member) throw new AutomationError(`There is no member "${memberSlug}" in this project. See \`dreamcontext agents list\`.`);
  if (member.scope === 'global') throw new AutomationError(`"${memberSlug}" is a global agent: give it a routine with \`automations create --agent ${memberSlug}\`.`);
  assertOwned({ owner: before.owner ?? null }, before.title || slug);
  assertOwned({ owner: member.owner }, member.title || memberSlug);
  // The file stops being a member: nothing else may still lean on that member.
  const usage = agentUsage(contextRoot, slug);
  const others = usage.automations.filter((s) => s !== slug);
  const leaning = [
    ...others.map((s) => `routine ${s}`),
    ...usage.boards.map((b) => `board ${b}`),
    ...usage.tasks.map((t) => `task ${t}`),
  ];
  if (leaning.length > 0) {
    throw new AutomationError(`"${slug}" is still a member others use (${leaning.join(', ')}): move them to "${memberSlug}" first.`);
  }
  // A re-attach never changes what is published: a shared file would reach teammates with no member.
  if (before.shared && !member.shared) {
    throw new AutomationError(`"${slug}" is shared and "${memberSlug}" is not. Attaching never publishes a member: share "${memberSlug}" first (the owner's step), or unshare "${slug}".`);
  }
  // It must end in a state a create accepts (the store refuses this pair on every other write).
  if (before.condition !== undefined && member.boardOnly) {
    throw new AutomationError(`"${memberSlug}" is limited to its board, and a board-limited member's routine cannot have a condition: remove "${slug}"'s condition first.`);
  }

  const raw = readFileSync(path, 'utf-8');
  const { data, content } = parseManifestFrontmatter(raw);
  const prompt = (sectionOrNull(content, 'Prompt') ?? '').trim();
  const job = PLACEHOLDER_PROMPT.test(prompt) ? '' : prompt;
  // EVERY field and section the routine does not keep is named, never only the known identity ones.
  const kept = new Set<string>([...JOB_KEYS, 'agent', 'updated']);
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(data)) if (!kept.has(k) && v !== undefined && v !== null && v !== false && v !== '') dropped.push(k);
  if ((sectionOrNull(content, SOUL_HEADING) ?? '').trim()) dropped.push('soul');
  if ((sectionOrNull(content, PATTERN_HEADING) ?? '').trim()) dropped.push('pattern (its learned lessons)');
  for (const h of otherSections(content)) dropped.push(`section "${h}"`);

  const frontmatter = { ...pick(data, JOB_KEYS), agent: memberSlug, updated: now.toISOString() };
  const body = [...(job ? [`## ${JOB_HEADING}`, '', job, ''] : []), ...jobTail(content)].join('\n');
  rewriteManifestText(path, matter.stringify(body, frontmatter));
  return { before, after: readAutomationFile(path), dropped };
}

/** Make the routine `slug` its own member again: the member's identity, the job folded into its prompt. */
export function detachRoutine(contextRoot: string, slug: string, now: Date = new Date()): AttachResult {
  const path = automationPath(contextRoot, slug);
  if (!pathOccupied(path)) throw new AutomationError(`No such automation: ${slug}`);
  const parts = readManifestParts(path);
  if (parts.kind !== 'bound') throw new AutomationError(`"${slug}" runs as no member: it is its own member already.`);
  const before = readAutomationFile(path);
  const jobPart = parts.job;
  if (jobPart.slug === jobPart.agent || pathOccupied(agentPath(contextRoot, slug))) {
    throw new AutomationError(`"${slug}" is the member's own routine (the same name): it cannot leave its member.`);
  }
  assertOwned({ owner: jobPart.owner ?? null }, jobPart.title || slug);
  const member = getAgent(contextRoot, jobPart.agent);
  if (!member) throw new AutomationError(`"${slug}"'s member "${jobPart.agent}" is not here: there is no identity to carry over.`);
  // The new member runs under its member's WHOLE envelope or not at all: a file of its own holds no
  // autonomy level and no read tools, so a member with either cannot be carried over unwidened.
  if (member.autonomy !== DEFAULT_AGENT_AUTONOMY || (member.readTools?.length ?? 0) > 0) {
    throw new AutomationError(`"${jobPart.agent}" has ${member.autonomy !== DEFAULT_AGENT_AUTONOMY ? `autonomy "${member.autonomy}"` : 'read tools'}, which a member of its own file cannot carry. Make the new member with \`dreamcontext agents create\` and give it the routine instead.`);
  }
  // Never publishes the member's private text: a shared routine would carry its prompt and soul.
  if (jobPart.shared && !member.shared) {
    throw new AutomationError(`"${slug}" is shared and "${jobPart.agent}" is not: detaching would publish ${member.title || jobPart.agent}'s prompt. Unshare "${slug}" first.`);
  }

  const raw = readFileSync(path, 'utf-8');
  const { data, content } = parseManifestFrontmatter(raw);
  const prompt = [member.prompt.trim(), jobPart.job.trim()].filter(Boolean).join('\n\n');
  const soul = member.soul.trim();
  const frontmatter: Record<string, unknown> = {
    ...pick(data, JOB_KEYS),
    updated: now.toISOString(),
    // Never the member's photo: a photo file is per slug, and removing either member would delete it.
    photo: null,
    model: member.model ?? null,
    effort: member.effort ?? null,
    ...(member.tool ? { tool: member.tool, ...(member.account ? { account: member.account } : {}) } : {}),
    learning: member.learning,
    ...(member.whiteboard ? { whiteboard: member.whiteboard } : {}),
    ...(member.whiteboard && member.boardOnly ? { scope: 'board' } : {}),
  };
  const body = [
    '## Prompt', '', prompt || '(What should this automation do? Write the prompt the scheduled run will send.)', '',
    ...(soul ? [`## ${SOUL_HEADING}`, '', soul, ''] : []),
    ...jobTail(content),
  ].join('\n');
  rewriteManifestText(path, matter.stringify(body, frontmatter));
  // The member's learned lessons and team place stay with the member: named, never silently.
  const dropped = [
    ...(member.photo ? ['photo (it starts with initials; the picture stays the member\'s)'] : []),
    ...(member.pattern.trim() ? ['pattern (the member\'s lessons stay with the member)'] : []),
    ...(member.reportsTo || member.team ? ['team place'] : []),
  ];
  return { before, after: readAutomationFile(path), dropped };
}
