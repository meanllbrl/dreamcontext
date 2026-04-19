import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { readJsonArray } from '../../lib/json-file.js';
import {
  parseReportRounds,
  extractExecutiveSummary,
  type DebateIndexEntry,
  type DebateFrontmatter,
  type PersonaFrontmatter,
  type RoundEntry,
} from '../../lib/council.js';
import { sendJson, sendError } from '../middleware.js';

function getCouncilDir(contextRoot: string): string {
  return join(contextRoot, 'council');
}

function assertSafeSegment(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return false;
  if (id === '.' || id === '..') return false;
  return true;
}

function assertWithin(root: string, target: string): string | null {
  const r = resolve(root);
  const t = resolve(target);
  if (t !== r && !t.startsWith(r + sep)) return null;
  return t;
}

interface ResearchIndexEntry {
  slug: string;
  topic: string;
  added_at: string;
}

interface ParsedRound {
  round: number;
  body: string;
  executiveSummary: string | null;
  position: string | null;
  reasoning: string | null;
  reactions: string | null;
  openQuestions: string | null;
}

interface PersonaDetail {
  slug: string;
  frontmatter: PersonaFrontmatter;
  persona: string;
  crossContext: Record<number, string>;
  rounds: ParsedRound[];
  researches: ResearchIndexEntry[];
}

interface DebateDetail {
  frontmatter: DebateFrontmatter;
  body: string;
  roundLog: string | null;
  finalReport: { frontmatter: Record<string, unknown>; content: string } | null;
  personas: PersonaDetail[];
}

function extractNamedSubsection(body: string, heading: string): string | null {
  const pattern = new RegExp(
    `^###\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=^###\\s+|\\Z)`,
    'm',
  );
  const match = body.match(pattern);
  return match ? match[1].trim() : null;
}

function parsePersonaBody(raw: string): { persona: string; crossContext: Record<number, string> } {
  // Split on "## Round N — Cross-context loaded" headings
  const crossContext: Record<number, string> = {};
  const regex = /^##\s+Round\s+(\d+)\s+—\s+Cross-context\s+loaded\s*$/gim;
  const matches = Array.from(raw.matchAll(regex));
  if (matches.length === 0) {
    return { persona: raw.trim(), crossContext };
  }

  const first = matches[0];
  const personaEnd = first.index ?? raw.length;
  const persona = raw.slice(0, personaEnd).trim();

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const round = Number(m[1]);
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
    crossContext[round] = raw.slice(start, end).trim();
  }

  return { persona, crossContext };
}

function toParsedRound(entry: RoundEntry): ParsedRound {
  return {
    round: entry.round,
    body: entry.body,
    executiveSummary: extractExecutiveSummary(entry.body),
    position: extractNamedSubsection(entry.body, 'Position'),
    reasoning: extractNamedSubsection(entry.body, 'Reasoning'),
    reactions: extractNamedSubsection(entry.body, 'Reactions to peers'),
    openQuestions: extractNamedSubsection(entry.body, 'Open questions'),
  };
}

function loadPersonaDetail(debateDir: string, slug: string): PersonaDetail | null {
  const personaDir = join(debateDir, slug);
  if (!existsSync(personaDir)) return null;

  const personaFile = join(personaDir, 'context-and-persona.md');
  const reportFile = join(personaDir, 'report.md');

  let fm: PersonaFrontmatter = { name: slug, model: 'unknown', aspects: [], round_entries: 0 };
  let persona = '';
  let crossContext: Record<number, string> = {};

  if (existsSync(personaFile)) {
    const parsed = readFrontmatter<PersonaFrontmatter>(personaFile);
    fm = {
      name: parsed.data.name ?? slug,
      model: parsed.data.model ?? 'unknown',
      aspects: Array.isArray(parsed.data.aspects) ? parsed.data.aspects : [],
      round_entries: typeof parsed.data.round_entries === 'number' ? parsed.data.round_entries : 0,
    };
    const split = parsePersonaBody(parsed.content);
    persona = split.persona;
    crossContext = split.crossContext;
  }

  let rounds: ParsedRound[] = [];
  if (existsSync(reportFile)) {
    const { content } = readFrontmatter(reportFile);
    rounds = parseReportRounds(content).map(toParsedRound);
  }

  const researchIndex = join(personaDir, 'researches', 'index.json');
  let researches: ResearchIndexEntry[] = [];
  if (existsSync(researchIndex)) {
    try {
      researches = readJsonArray<ResearchIndexEntry>(researchIndex);
    } catch {
      researches = [];
    }
  }

  return { slug, frontmatter: fm, persona, crossContext, rounds, researches };
}

/**
 * GET /api/council — List all debates.
 */
export async function handleCouncilList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const indexPath = join(getCouncilDir(contextRoot), 'index.json');
  if (!existsSync(indexPath)) {
    sendJson(res, 200, { debates: [] });
    return;
  }

  try {
    const debates = readJsonArray<DebateIndexEntry>(indexPath);
    const enriched = debates.map((d) => {
      const debateFile = join(getCouncilDir(contextRoot), d.id, 'debate.md');
      let personaSlugs: string[] = [];
      if (existsSync(debateFile)) {
        try {
          const fm = readFrontmatter<Record<string, unknown>>(debateFile).data;
          if (Array.isArray(fm.personas)) personaSlugs = fm.personas as string[];
        } catch {
          personaSlugs = [];
        }
      }
      return { ...d, personaSlugs };
    });
    sendJson(res, 200, { debates: enriched });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to read council index';
    sendError(res, 500, 'read_error', message);
  }
}

/**
 * GET /api/council/:debateId — Get a single debate hydrated with personas + rounds.
 */
export async function handleCouncilGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { debateId } = params;
  if (!assertSafeSegment(debateId)) {
    sendError(res, 400, 'bad_request', `Invalid debateId: ${debateId}`);
    return;
  }

  const councilDir = getCouncilDir(contextRoot);
  const debateDirUnchecked = join(councilDir, debateId);
  const debateDir = assertWithin(councilDir, debateDirUnchecked);
  if (!debateDir || !existsSync(debateDir)) {
    sendError(res, 404, 'not_found', `Debate not found: ${debateId}`);
    return;
  }

  const debateFile = join(debateDir, 'debate.md');
  if (!existsSync(debateFile)) {
    sendError(res, 404, 'not_found', `Debate metadata missing: ${debateId}`);
    return;
  }

  const { data: fmRaw, content: body } = readFrontmatter<Record<string, unknown>>(debateFile);
  const frontmatter: DebateFrontmatter = {
    id: String(fmRaw.id ?? debateId),
    topic: String(fmRaw.topic ?? ''),
    status: String(fmRaw.status ?? 'created'),
    rounds_planned: typeof fmRaw.rounds_planned === 'number' ? fmRaw.rounds_planned : 0,
    current_round: typeof fmRaw.current_round === 'number' ? fmRaw.current_round : 0,
    interrupt_between_rounds: Boolean(fmRaw.interrupt_between_rounds),
    personas: Array.isArray(fmRaw.personas) ? (fmRaw.personas as string[]) : [],
    promoted_to_knowledge:
      typeof fmRaw.promoted_to_knowledge === 'string' ? fmRaw.promoted_to_knowledge : null,
    created_at: String(fmRaw.created_at ?? ''),
    updated_at: String(fmRaw.updated_at ?? ''),
  };

  const roundLogFile = join(debateDir, 'round-log.md');
  const roundLog = existsSync(roundLogFile)
    ? readFrontmatter(roundLogFile).content
    : null;

  const finalReportFile = join(debateDir, 'final-report.md');
  let finalReport: DebateDetail['finalReport'] = null;
  if (existsSync(finalReportFile)) {
    const parsed = readFrontmatter<Record<string, unknown>>(finalReportFile);
    finalReport = { frontmatter: parsed.data, content: parsed.content };
  }

  const personas: PersonaDetail[] = [];
  for (const slug of frontmatter.personas) {
    if (!assertSafeSegment(slug)) continue;
    const detail = loadPersonaDetail(debateDir, slug);
    if (detail) personas.push(detail);
  }

  const debate: DebateDetail = {
    frontmatter,
    body,
    roundLog,
    finalReport,
    personas,
  };

  sendJson(res, 200, { debate });
}

/**
 * GET /api/council/:debateId/:personaSlug/research/:researchSlug
 * Returns raw markdown content of a persona's research note.
 */
export async function handleCouncilResearchGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { debateId, personaSlug, researchSlug } = params;
  if (!assertSafeSegment(debateId) || !assertSafeSegment(personaSlug) || !assertSafeSegment(researchSlug)) {
    sendError(res, 400, 'bad_request', 'Invalid segment');
    return;
  }

  const councilDir = getCouncilDir(contextRoot);
  const researchFile = assertWithin(
    councilDir,
    join(councilDir, debateId, personaSlug, 'researches', `${researchSlug}.md`),
  );
  if (!researchFile || !existsSync(researchFile)) {
    sendError(res, 404, 'not_found', `Research not found: ${researchSlug}`);
    return;
  }

  const { data, content } = readFrontmatter<Record<string, unknown>>(researchFile);
  sendJson(res, 200, { research: { slug: researchSlug, frontmatter: data, content } });
}

