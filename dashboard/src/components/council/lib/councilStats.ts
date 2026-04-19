import type { DebateDetail, PersonaDetail, ParsedRound } from '../../../hooks/useCouncil';

/**
 * Extract a compact position chip label (≤ 18 chars) from a round's Position text.
 * Takes the first line, strips punctuation, uppercases, truncates.
 */
export function extractPositionChip(position: string | null): string | null {
  if (!position) return null;
  const firstLine = position.split('\n')[0].trim();
  if (!firstLine) return null;
  // Strip leading "Recommend ", "I recommend ", etc.
  const cleaned = firstLine
    .replace(/^(recommend(?:ed|ing)?|i\s+(?:would\s+)?recommend|proposal|my\s+position|conclusion|verdict)\s*[:\-—]?\s*/i, '')
    .replace(/\.$/, '');
  const words = cleaned.split(/\s+/).slice(0, 3).join(' ');
  const truncated = words.length > 18 ? words.slice(0, 17).trimEnd() + '…' : words;
  return truncated.toUpperCase();
}

/**
 * Categorize a position into a coarse bucket for color coding + shift detection.
 * Returns one of: "go" | "defer" | "hold" | "pivot" | "other".
 */
export function categorizePosition(position: string | null): string {
  if (!position) return 'other';
  const t = position.toLowerCase();
  if (/\b(go\b|ship|launch|proceed|approve|yes|adopt|migrate\b)/.test(t)) return 'go';
  if (/\b(defer|postpone|delay|wait|later|q[2-9]|next\s+(?:quarter|year))/.test(t)) return 'defer';
  if (/\b(no-go|no\b|reject|abandon|stop|cancel|block)/.test(t)) return 'hold';
  if (/\b(pivot|phased|poc|proof.?of.?concept|pilot|partial|subset|scope\s+down)/.test(t)) return 'pivot';
  return 'other';
}

export type PositionShift = 'first' | 'steady' | 'shift' | 'reversal';

/**
 * Given two adjacent rounds for the same persona, describe the position change.
 */
export function describeShift(prev: ParsedRound | null, curr: ParsedRound): PositionShift {
  if (!prev) return 'first';
  const a = categorizePosition(prev.position);
  const b = categorizePosition(curr.position);
  if (a === b) return 'steady';
  const reversalPairs = new Set(['go/hold', 'hold/go', 'go/defer', 'defer/go']);
  if (reversalPairs.has(`${a}/${b}`)) return 'reversal';
  return 'shift';
}

/**
 * Return the parsed round for a persona at a given round number, or null.
 */
export function findRound(persona: PersonaDetail, round: number): ParsedRound | null {
  return persona.rounds.find((r) => r.round === round) ?? null;
}

/**
 * Count how many peer reactions a round contains by counting "###"-level
 * subheadings inside "Reactions to peers" or by counting bold lead-ins
 * like "**peer-slug**:" used in templates.
 */
export function countReactions(round: ParsedRound): number {
  if (!round.reactions) return 0;
  const byBold = (round.reactions.match(/\*\*[a-z][a-z0-9-]+\*\*/g) ?? []).length;
  if (byBold > 0) return byBold;
  const byHeading = (round.reactions.match(/^####\s+/gm) ?? []).length;
  return byHeading;
}

/**
 * Extract referenced peer slugs from a round's reactions text.
 * Looks for **slug**: or ### slug patterns.
 */
export function extractReactionTargets(round: ParsedRound, knownSlugs: string[]): string[] {
  if (!round.reactions) return [];
  const slugSet = new Set(knownSlugs);
  const found: string[] = [];
  const boldRe = /\*\*([a-z][a-z0-9-]+)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(round.reactions)) !== null) {
    if (slugSet.has(m[1]) && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * Count open questions in a round (lines starting with "-" or numbered).
 */
export function countOpenQuestions(round: ParsedRound): number {
  if (!round.openQuestions) return 0;
  return (round.openQuestions.match(/^\s*[-*\d]/gm) ?? []).length;
}

/**
 * Count how many times a persona slug is cited in the final report content
 * (looking for "persona-slug in RN" or "**persona-slug**" patterns).
 */
export function countCitations(personaSlug: string, finalReportContent: string): number {
  const re = new RegExp(`\\b${personaSlug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'g');
  return (finalReportContent.match(re) ?? []).length;
}

export type MedalKey = 'iron' | 'flipper' | 'engager' | 'inquirer' | 'agenda';

export interface Medal {
  key: MedalKey;
  glyph: string;
  label: string;
  tooltip: string;
}

const MEDAL_DEFS: Record<MedalKey, { glyph: string; label: string }> = {
  iron: { glyph: '🛡', label: 'Iron Position' },
  flipper: { glyph: '⟳', label: 'Flipper' },
  engager: { glyph: '⚔', label: 'Engager' },
  inquirer: { glyph: '❓', label: 'Inquirer' },
  agenda: { glyph: '★', label: 'Agenda Setter' },
};

/**
 * Compute medals for each persona based on their rounds + the final report.
 * Returns map from persona slug → array of medals earned.
 */
export function computeMedals(debate: DebateDetail): Record<string, Medal[]> {
  const result: Record<string, Medal[]> = {};
  for (const p of debate.personas) result[p.slug] = [];

  if (debate.personas.length === 0) return result;

  // Iron Position: unchanged category across all submitted rounds (min 2 rounds)
  for (const p of debate.personas) {
    if (p.rounds.length >= 2) {
      const cats = p.rounds.map((r) => categorizePosition(r.position));
      const allEqual = cats.every((c) => c === cats[0] && c !== 'other');
      if (allEqual) {
        result[p.slug].push({
          key: 'iron',
          ...MEDAL_DEFS.iron,
          tooltip: `Held ${cats[0].toUpperCase()} across all ${p.rounds.length} rounds`,
        });
      }
    }
  }

  // Flipper: biggest number of category shifts round-to-round (min 1 shift)
  const flipCounts: Record<string, number> = {};
  for (const p of debate.personas) {
    const sorted = [...p.rounds].sort((a, b) => a.round - b.round);
    let flips = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (describeShift(sorted[i - 1], sorted[i]) === 'shift' || describeShift(sorted[i - 1], sorted[i]) === 'reversal') {
        flips++;
      }
    }
    flipCounts[p.slug] = flips;
  }
  const maxFlips = Math.max(0, ...Object.values(flipCounts));
  if (maxFlips > 0) {
    for (const slug in flipCounts) {
      if (flipCounts[slug] === maxFlips) {
        result[slug].push({
          key: 'flipper',
          ...MEDAL_DEFS.flipper,
          tooltip: `Changed position ${maxFlips} time${maxFlips === 1 ? '' : 's'}`,
        });
      }
    }
  }

  // Engager: most total peer reactions
  const reactionCounts: Record<string, number> = {};
  for (const p of debate.personas) {
    reactionCounts[p.slug] = p.rounds.reduce((sum, r) => sum + countReactions(r), 0);
  }
  const maxReactions = Math.max(0, ...Object.values(reactionCounts));
  if (maxReactions > 0) {
    for (const slug in reactionCounts) {
      if (reactionCounts[slug] === maxReactions) {
        result[slug].push({
          key: 'engager',
          ...MEDAL_DEFS.engager,
          tooltip: `${maxReactions} peer reaction${maxReactions === 1 ? '' : 's'}`,
        });
      }
    }
  }

  // Inquirer: most total open questions raised
  const questionCounts: Record<string, number> = {};
  for (const p of debate.personas) {
    questionCounts[p.slug] = p.rounds.reduce((sum, r) => sum + countOpenQuestions(r), 0);
  }
  const maxQuestions = Math.max(0, ...Object.values(questionCounts));
  if (maxQuestions > 0) {
    for (const slug in questionCounts) {
      if (questionCounts[slug] === maxQuestions) {
        result[slug].push({
          key: 'inquirer',
          ...MEDAL_DEFS.inquirer,
          tooltip: `${maxQuestions} open question${maxQuestions === 1 ? '' : 's'}`,
        });
      }
    }
  }

  // Agenda Setter: most citations in final report
  if (debate.finalReport) {
    const citationCounts: Record<string, number> = {};
    for (const p of debate.personas) {
      citationCounts[p.slug] = countCitations(p.slug, debate.finalReport.content);
    }
    const maxCites = Math.max(0, ...Object.values(citationCounts));
    if (maxCites > 0) {
      for (const slug in citationCounts) {
        if (citationCounts[slug] === maxCites) {
          result[slug].push({
            key: 'agenda',
            ...MEDAL_DEFS.agenda,
            tooltip: `Cited ${maxCites} time${maxCites === 1 ? '' : 's'} in the verdict`,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Debate-wide stats shown in the verdict HUD strip.
 */
export interface DebateStats {
  rounds: number;
  personas: number;
  pushbacks: number;
  openRisks: number;
  minorityViews: number;
}

export function computeDebateStats(debate: DebateDetail): DebateStats {
  const rounds = debate.frontmatter.rounds_planned || debate.personas.reduce((m, p) => Math.max(m, ...p.rounds.map((r) => r.round), 0), 0);
  const personas = debate.personas.length;
  const pushbacks = debate.personas.reduce((sum, p) => sum + p.rounds.reduce((s, r) => s + countReactions(r), 0), 0);

  let openRisks = 0;
  let minorityViews = 0;
  if (debate.finalReport) {
    const c = debate.finalReport.content;
    const risksMatch = c.match(/##\s+Open\s+risks\s*\n([\s\S]*?)(?=^##\s+|\Z)/im);
    if (risksMatch) {
      openRisks = (risksMatch[1].match(/^\s*[-*]/gm) ?? []).length;
    }
    const minorityMatch = c.match(/##\s+Minority\s+views\s*\n([\s\S]*?)(?=^##\s+|\Z)/im);
    if (minorityMatch) {
      const body = minorityMatch[1].trim();
      if (body.length > 0 && !/\(none\)|n\/?a/i.test(body)) {
        minorityViews = Math.max(1, (body.match(/^\s*[-*]/gm) ?? []).length);
      }
    }
  }

  return { rounds, personas, pushbacks, openRisks, minorityViews };
}

/**
 * Deterministic hue (0–360) derived from a slug — for stable avatar coloring.
 */
export function slugHue(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/**
 * Deterministic glyph from a slug — picks from a curated set.
 */
const AVATAR_GLYPHS = ['◈', '◉', '◎', '◆', '◇', '✦', '✧', '❖', '⬡', '⬢', '▲', '▼', '●', '■', '◐', '◑', '◒', '◓'];
export function slugGlyph(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return AVATAR_GLYPHS[h % AVATAR_GLYPHS.length];
}

/**
 * Brand model colors (hues) — opus=indigo, sonnet=cyan, haiku=mint.
 */
export function modelHue(model: string): number {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 245;
  if (m.includes('sonnet')) return 195;
  if (m.includes('haiku')) return 160;
  return 280;
}

/**
 * Parse a final report into an ordered list of H2 sections. The synthesizer
 * does not always emit the same section names, so we extract whatever is
 * there and let the UI render the list generically. The first "Verdict"
 * section (case-insensitive) is surfaced separately as the hero.
 * Any "Appendix*" section is split off to render collapsed.
 */
export interface FinalReportSection {
  heading: string;
  body: string;
}

export interface FinalReportSections {
  verdict: string;
  appendix: FinalReportSection | null;
  sections: FinalReportSection[];
}

export function parseFinalReport(content: string): FinalReportSections {
  const result: FinalReportSections = { verdict: '', appendix: null, sections: [] };
  const re = /^##\s+(.+?)\s*\n([\s\S]*?)(?=^##\s+|\Z)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const heading = m[1].trim();
    const body = m[2].trim();
    if (!result.verdict && /^verdict\b/i.test(heading)) {
      result.verdict = body;
      continue;
    }
    if (/^appendix\b/i.test(heading)) {
      if (!result.appendix) result.appendix = { heading, body };
      continue;
    }
    result.sections.push({ heading, body });
  }
  return result;
}
