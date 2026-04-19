import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureContextRoot } from './context-path.js';
import { readFrontmatter } from './frontmatter.js';
import { readJsonArray, writeJsonArray } from './json-file.js';

export const COUNCIL_STATUSES = [
  'created',
  'round_1_running',
  'round_1_complete',
  'round_2_running',
  'round_2_complete',
  'round_3_running',
  'round_3_complete',
  'synthesizing',
  'complete',
] as const;

export interface DebateIndexEntry {
  id: string;
  topic: string;
  status: string;
  rounds_planned: number;
  current_round: number;
  promoted_to_knowledge: string | null;
  created_at: string;
  updated_at: string;
}

export interface DebateFrontmatter {
  id: string;
  topic: string;
  status: string;
  rounds_planned: number;
  current_round: number;
  interrupt_between_rounds: boolean;
  personas: string[];
  promoted_to_knowledge: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonaFrontmatter {
  name: string;
  model: string;
  aspects: string[];
  round_entries: number;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function getCouncilDir(): string {
  const root = ensureContextRoot();
  return join(root, 'council');
}

/**
 * Assert that `id` is a safe single path segment: no separators, no dots-only,
 * no null bytes. Throws with a clear message otherwise.
 */
function assertSafeSegment(kind: string, id: string): void {
  if (!id || typeof id !== 'string') {
    throw new Error(`Invalid ${kind}: (empty)`);
  }
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`Invalid ${kind}: "${id}" contains a path separator`);
  }
  if (id === '.' || id === '..') {
    throw new Error(`Invalid ${kind}: "${id}"`);
  }
}

/**
 * Belt-and-suspenders: ensure the resolved path is still under the council dir.
 */
function assertWithinCouncil(target: string): string {
  const council = resolve(getCouncilDir());
  const resolved = resolve(target);
  if (resolved !== council && !resolved.startsWith(council + sep)) {
    throw new Error(`Path escapes council directory: ${target}`);
  }
  return resolved;
}

export function getDebateDir(debateId: string): string {
  assertSafeSegment('debate_id', debateId);
  const target = join(getCouncilDir(), debateId);
  return assertWithinCouncil(target);
}

export function getPersonaDir(debateId: string, personaSlug: string): string {
  assertSafeSegment('persona_slug', personaSlug);
  const target = join(getDebateDir(debateId), personaSlug);
  return assertWithinCouncil(target);
}

export function getCouncilIndexPath(): string {
  return join(getCouncilDir(), 'index.json');
}

export function ensureCouncilDir(): string {
  const dir = getCouncilDir();
  mkdirSync(dir, { recursive: true });
  const indexPath = getCouncilIndexPath();
  if (!existsSync(indexPath)) {
    writeJsonArray(indexPath, []);
  }
  return dir;
}

export function ensureDebateExists(debateId: string): string {
  const dir = getDebateDir(debateId);
  if (!existsSync(dir)) {
    throw new Error(`Debate not found: ${debateId}`);
  }
  return dir;
}

export function ensurePersonaExists(debateId: string, personaSlug: string): string {
  ensureDebateExists(debateId);
  const dir = getPersonaDir(debateId, personaSlug);
  if (!existsSync(dir)) {
    throw new Error(`Persona not found in ${debateId}: ${personaSlug}`);
  }
  return dir;
}

export function readDebateFrontmatter(debateId: string): DebateFrontmatter {
  ensureDebateExists(debateId);
  const { data } = readFrontmatter<DebateFrontmatter>(join(getDebateDir(debateId), 'debate.md'));
  return data;
}

export function loadCouncilIndex(): DebateIndexEntry[] {
  const indexPath = getCouncilIndexPath();
  if (!existsSync(indexPath)) return [];
  return readJsonArray<DebateIndexEntry>(indexPath);
}

export function saveCouncilIndex(entries: DebateIndexEntry[]): void {
  writeJsonArray(getCouncilIndexPath(), entries);
}

export function upsertCouncilIndex(entry: DebateIndexEntry): void {
  const entries = loadCouncilIndex();
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx === -1) {
    entries.unshift(entry);
  } else {
    entries[idx] = { ...entries[idx], ...entry };
  }
  saveCouncilIndex(entries);
}

// ─── Templates ──────────────────────────────────────────────────────────────

export function loadTemplate(filename: string): string {
  const candidates = [
    join(__dirname, 'templates', filename),           // bundled: dist/templates/
    join(__dirname, '..', 'templates', filename),     // alt layout
    join(__dirname, '..', 'src', 'templates', filename), // dev fallback
    join(__dirname, '..', '..', 'src', 'templates', filename),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  }
  throw new Error(`Template not found: ${filename}`);
}

// ─── Report parsing & validation ────────────────────────────────────────────

export const REQUIRED_REPORT_SUBSECTIONS = [
  'Executive Summary',
  'Position',
  'Reasoning',
  'Reactions to peers',
  'Open questions',
] as const;

export interface ValidationResult {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Validate that a round entry contains all required ### subsections.
 * Also warns on executive summaries >150 words (soft-warn, does not fail).
 */
export function validateRoundEntry(body: string): ValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  const headings = Array.from(body.matchAll(/^###\s+(.+)$/gm)).map((m) =>
    normalize(m[1]),
  );

  for (const required of REQUIRED_REPORT_SUBSECTIONS) {
    if (!headings.includes(normalize(required))) {
      missing.push(required);
    }
  }

  const execMatch = body.match(
    /^###\s+Executive Summary\s*\n([\s\S]*?)(?=^###\s+|\Z)/m,
  );
  if (execMatch) {
    const words = execMatch[1].trim().split(/\s+/).filter(Boolean).length;
    if (words > 150) {
      warnings.push(`Executive Summary is ${words} words (>150). Consider tightening.`);
    }
  }

  return { ok: missing.length === 0, missing, warnings };
}

/**
 * Extract the Executive Summary text from a single round entry body.
 * Returns null if not found.
 */
export function extractExecutiveSummary(roundBody: string): string | null {
  const match = roundBody.match(
    /^###\s+Executive Summary\s*\n([\s\S]*?)(?=^###\s+|\Z)/m,
  );
  return match ? match[1].trim() : null;
}

/**
 * Parse a persona's report.md into a list of round entries (newest-first, LIFO).
 * Each entry is delimited by a `## Round N — ...` heading.
 */
export interface RoundEntry {
  round: number;
  heading: string;
  body: string;
}

export function parseReportRounds(reportContent: string): RoundEntry[] {
  const lines = reportContent.split('\n');
  const entries: RoundEntry[] = [];
  let current: { round: number; heading: string; start: number } | null = null;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track triple-backtick fences (opening or closing). A line that is
    // *exactly* a fence toggles state; indented fences also count.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = line.match(/^##\s+Round\s+(\d+)\b/i);
    if (match) {
      if (current) {
        entries.push({
          round: current.round,
          heading: current.heading,
          body: lines.slice(current.start + 1, i).join('\n').trim(),
        });
      }
      current = {
        round: Number(match[1]),
        heading: line,
        start: i,
      };
    }
  }

  if (current) {
    entries.push({
      round: current.round,
      heading: current.heading,
      body: lines.slice(current.start + 1).join('\n').trim(),
    });
  }

  return entries;
}

/**
 * Get the executive summary for a given persona + round, if present.
 */
export function getPersonaRoundSummary(
  debateId: string,
  personaSlug: string,
  round: number,
): string | null {
  const reportPath = join(getPersonaDir(debateId, personaSlug), 'report.md');
  if (!existsSync(reportPath)) return null;
  const { content } = readFrontmatter(reportPath);
  const entries = parseReportRounds(content);
  const entry = entries.find((e) => e.round === round);
  if (!entry) return null;
  return extractExecutiveSummary(entry.body);
}

// ─── Stdin ──────────────────────────────────────────────────────────────────

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
