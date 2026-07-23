import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readFrontmatter, writeFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { generateId, slugify, today } from '../../lib/id.js';
import { readJsonArray, writeJsonArray, insertToJsonArray } from '../../lib/json-file.js';
import { success, error, warn, info, header } from '../../lib/format.js';
import { insertToSection } from '../../lib/markdown.js';
import {
  getCouncilDir,
  getDebateDir,
  getPersonaDir,
  ensureCouncilDir,
  ensureDebateExists,
  ensurePersonaExists,
  readDebateFrontmatter,
  loadCouncilIndex,
  upsertCouncilIndex,
  loadTemplate,
  validateRoundEntry,
  getPersonaRoundSummary,
  parseReportRounds,
  readStdin,
  readVerdicts,
  writeVerdicts,
  withVerdictsLock,
  parseOptionsSpec,
  resolveStanceKey,
  leadingStance,
  convergence,
  updateCouncilLive,
  clearCouncilLive,
  writeCouncilLiveRaw,
  COUNCIL_LIVE_PHASES,
  CouncilLivePhase,
  CouncilLiveState,
  DebateFrontmatter,
  PersonaFrontmatter,
  RoundVerdicts,
  VerdictsFile,
} from '../../lib/council.js';
import { renderChamberBoard, shiftMarker } from '../../lib/council-board.js';

const VALID_MODELS = ['opus', 'sonnet', 'haiku'];

function roundRunningStatus(n: number): string {
  return `round_${n}_running`;
}
function roundCompleteStatus(n: number): string {
  return `round_${n}_complete`;
}

function formatPersonaList(personas: string[]): string {
  return personas.length === 0 ? chalk.dim('(none)') : personas.join(', ');
}

// ─── Registration ───────────────────────────────────────────────────────────

export function registerCouncilCommand(program: Command): void {
  const council = program
    .command('council')
    .description('Run structured multi-agent debates on decisions');

  registerCreate(council);
  registerAgent(council);
  registerRound(council);
  registerRoundContext(council);
  registerReport(council);
  registerSummaries(council);
  registerResearch(council);
  registerSynthesize(council);
  registerComplete(council);
  registerPromote(council);
  registerList(council);
  registerShow(council);
  registerVerdict(council);
  registerBoard(council);
  registerTimeline(council);
  registerInject(council);
  registerQuestion(council);
  registerLive(council);
  registerDemoLive(council);
}

// ─── Verdict helpers (v2) ───────────────────────────────────────────────────

function hasRegisteredOptions(data: DebateFrontmatter): boolean {
  return Array.isArray(data.options) && data.options.length > 0;
}

/** Highest round number present in verdicts.rounds, or null when none. */
function latestVerdictRound(verdicts: VerdictsFile): number | null {
  const rounds = Object.keys(verdicts.rounds)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && Object.keys(verdicts.rounds[String(n)] ?? {}).length > 0);
  if (rounds.length === 0) return null;
  return Math.max(...rounds);
}

function roundVerdictsOf(verdicts: VerdictsFile, round: number): RoundVerdicts {
  return verdicts.rounds[String(round)] ?? {};
}

// ─── council create ─────────────────────────────────────────────────────────

function registerCreate(council: Command): void {
  council
    .command('create')
    .argument('<topic...>', 'Debate topic / question')
    .option('-r, --rounds <n>', 'Number of rounds planned', '2')
    .option('--interrupt', 'Pause for user input between rounds', false)
    .option('--no-interrupt', 'Do not pause between rounds')
    .option('--options <spec>', 'Decision options, e.g. "A=Keep sync,B=Drop it"')
    .description('Create a new debate folder and debate.md')
    .action((topicParts: string[], opts: { rounds: string; interrupt: boolean; options?: string }) => {
      try {
        ensureContextRoot();
        ensureCouncilDir();

        const topic = topicParts.join(' ').trim();
        if (!topic) {
          error('Topic is required.');
          process.exit(1);
        }

        const rounds = Number(opts.rounds);
        if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
          error('--rounds must be an integer between 1 and 10.');
          process.exit(1);
        }

        const options = opts.options ? parseOptionsSpec(opts.options) : null;

        const id = generateId('council');
        const dir = getDebateDir(id);
        mkdirSync(dir, { recursive: true });

        const template = loadTemplate('council-debate.md');
        const content = template
          .replaceAll('{{ID}}', id)
          .replaceAll('{{TOPIC}}', topic.replace(/"/g, '\\"'))
          .replaceAll('{{ROUNDS}}', String(rounds))
          .replaceAll('{{INTERRUPT}}', opts.interrupt ? 'true' : 'false')
          .replaceAll('{{DATE}}', today());

        writeFileSync(join(dir, 'debate.md'), content, 'utf-8');
        writeFileSync(
          join(dir, 'round-log.md'),
          `# Round log — ${id}\n\n(Main agent appends timeline entries here.)\n`,
          'utf-8',
        );

        if (options) {
          // Options live in verdicts.json AND mirrored into debate.md frontmatter.
          writeVerdicts(id, { options, rounds: {} });
          updateFrontmatterFields(join(dir, 'debate.md'), { options });
        }

        upsertCouncilIndex({
          id,
          topic,
          status: 'created',
          rounds_planned: rounds,
          current_round: 0,
          promoted_to_knowledge: null,
          created_at: today(),
          updated_at: today(),
        });

        updateCouncilLive(id, { phase: 'setup' });

        success(`Debate created: ${id}`);
        console.log(chalk.dim(`  dir: _dream_context/council/${id}/`));
        console.log(chalk.dim(`  rounds: ${rounds}  interrupt: ${opts.interrupt ? 'yes' : 'no'}`));
        if (options) {
          console.log(chalk.dim(`  options: ${options.map((o) => `${o.key}=${o.label}`).join(', ')}`));
        }
        // Print ID alone on final line for easy scripting
        console.log(id);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council agent create ───────────────────────────────────────────────────

function registerAgent(council: Command): void {
  const agent = council
    .command('agent')
    .description('Manage personas within a debate');

  agent
    .command('create')
    .argument('<debate_id>')
    .argument('<persona_slug>')
    .option('-m, --model <model>', 'Model: opus | sonnet | haiku', 'sonnet')
    .option('-a, --aspects <aspects>', 'Comma-separated aspects / focus areas', '')
    .option('-b, --body <text>', 'Persona body (otherwise read from stdin)')
    .option('--force', 'Overwrite existing persona', false)
    .description('Create a persona folder + context-and-persona.md (body from --body or stdin)')
    .action(async (
      debateId: string,
      rawSlug: string,
      opts: { model: string; aspects: string; body?: string; force: boolean },
    ) => {
      try {
        ensureDebateExists(debateId);

        const slug = slugify(rawSlug);
        if (!slug) {
          error('Invalid persona slug.');
          process.exit(1);
        }

        if (!VALID_MODELS.includes(opts.model)) {
          error(`--model must be one of: ${VALID_MODELS.join(', ')}`);
          process.exit(1);
        }

        const personaDir = getPersonaDir(debateId, slug);
        const personaFile = join(personaDir, 'context-and-persona.md');

        if (existsSync(personaFile) && !opts.force) {
          error(`Persona already exists: ${slug}`, 'Use --force to overwrite.');
          process.exit(1);
        }

        const body = opts.body ?? (await readStdin());
        if (!body.trim()) {
          error('Persona body is empty.', 'Pass --body "..." or pipe markdown via stdin.');
          process.exit(1);
        }

        const aspects = opts.aspects
          ? opts.aspects.split(',').map((a) => a.trim()).filter(Boolean)
          : [];

        mkdirSync(personaDir, { recursive: true });

        const template = loadTemplate('council-persona.md');
        const personaContent = template
          .replaceAll('{{SLUG}}', slug)
          .replaceAll('{{MODEL}}', opts.model)
          .replaceAll('{{ASPECTS}}', JSON.stringify(aspects))
          .replaceAll('{{PERSONA_BODY}}', body.trim());
        writeFileSync(personaFile, personaContent, 'utf-8');

        // Empty report.md with frontmatter
        const reportTemplate = loadTemplate('council-report.md');
        const reportContent = reportTemplate.replaceAll('{{SLUG}}', slug);
        writeFileSync(join(personaDir, 'report.md'), reportContent, 'utf-8');

        // Register in debate.md personas[]
        const debateFile = join(getDebateDir(debateId), 'debate.md');
        const { data } = readFrontmatter<DebateFrontmatter>(debateFile);
        const personas = Array.isArray(data.personas) ? data.personas.slice() : [];
        if (!personas.includes(slug)) personas.push(slug);
        updateFrontmatterFields(debateFile, {
          personas,
          updated_at: today(),
        });

        updateCouncilLive(debateId, { setPersona: { [slug]: 'wait' } });

        success(`Persona created: ${slug} (${opts.model})`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council round start / end ──────────────────────────────────────────────

function registerRound(council: Command): void {
  const round = council.command('round').description('Round lifecycle');

  round
    .command('start')
    .argument('<debate_id>')
    .argument('<n>')
    .description('Start round N. For N≥2, injects prior-round peer summaries into each persona.')
    .action((debateId: string, nRaw: string) => {
      try {
        const n = Number(nRaw);
        if (!Number.isInteger(n) || n < 1) {
          error('Round number must be a positive integer.');
          process.exit(1);
        }

        const data = readDebateFrontmatter(debateId);
        if (n > data.rounds_planned) {
          error(`Round ${n} exceeds planned rounds (${data.rounds_planned}).`);
          process.exit(1);
        }

        const debateFile = join(getDebateDir(debateId), 'debate.md');
        const personas = data.personas ?? [];
        if (personas.length === 0) {
          error('No personas registered. Run `council agent create` first.');
          process.exit(1);
        }

        // Idempotency: if already running this round, still inject context (no-op if already injected)
        // We re-inject only if the persona file doesn't already have a matching header.
        const crossContextHeader = `## Round ${n} — Cross-context loaded`;

        if (n >= 2) {
          // Build peer summaries from round n-1
          for (const persona of personas) {
            const personaFile = join(getPersonaDir(debateId, persona), 'context-and-persona.md');
            if (!existsSync(personaFile)) continue;

            const existing = readFileSync(personaFile, 'utf-8');
            if (existing.includes(crossContextHeader)) {
              continue; // already injected — idempotent
            }

            const peerLines: string[] = [];
            for (const peer of personas) {
              if (peer === persona) continue;
              const summary = getPersonaRoundSummary(debateId, peer, n - 1);
              if (summary) {
                peerLines.push(`### ${peer}\n\n${summary}`);
              } else {
                peerLines.push(`### ${peer}\n\n_(no round ${n - 1} report submitted)_`);
              }
            }

            const newSection = `${crossContextHeader}\n\n${peerLines.join('\n\n')}`;
            const updated = existing.trimEnd() + '\n\n' + newSection + '\n';
            writeFileSync(personaFile, updated, 'utf-8');
          }
        }

        // Update debate frontmatter
        updateFrontmatterFields(debateFile, {
          status: roundRunningStatus(n),
          current_round: n,
          updated_at: today(),
        });

        // Append round-log entry
        const logFile = join(getDebateDir(debateId), 'round-log.md');
        const logExisting = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
        const logEntry = `\n## Round ${n} started — ${today()}\n- Personas: ${formatPersonaList(personas)}\n`;
        writeFileSync(logFile, logExisting.trimEnd() + '\n' + logEntry + '\n', 'utf-8');

        upsertCouncilIndex({
          id: debateId,
          topic: data.topic,
          status: roundRunningStatus(n),
          rounds_planned: data.rounds_planned,
          current_round: n,
          promoted_to_knowledge: data.promoted_to_knowledge ?? null,
          created_at: data.created_at,
          updated_at: today(),
        });

        updateCouncilLive(debateId, { phase: 'debate', setAll: 'think' });

        success(`Round ${n} started for ${debateId} (${personas.length} personas).`);
        if (n >= 2) {
          info(`Cross-context from round ${n - 1} injected into each persona.`);
        }
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });

  round
    .command('end')
    .argument('<debate_id>')
    .argument('<n>')
    .description('End round N after all personas have submitted their reports.')
    .action((debateId: string, nRaw: string) => {
      try {
        const n = Number(nRaw);
        const data = readDebateFrontmatter(debateId);
        const personas = data.personas ?? [];

        const missing: string[] = [];
        for (const persona of personas) {
          const summary = getPersonaRoundSummary(debateId, persona, n);
          if (!summary) missing.push(persona);
        }

        if (missing.length > 0) {
          error(`Round ${n} incomplete. Missing reports from: ${missing.join(', ')}`);
          process.exit(1);
        }

        const debateFile = join(getDebateDir(debateId), 'debate.md');
        updateFrontmatterFields(debateFile, {
          status: roundCompleteStatus(n),
          updated_at: today(),
        });

        const logFile = join(getDebateDir(debateId), 'round-log.md');
        const logExisting = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
        const logEntry = `\n## Round ${n} complete — ${today()}\n- All ${personas.length} personas submitted reports.\n`;
        writeFileSync(logFile, logExisting.trimEnd() + '\n' + logEntry + '\n', 'utf-8');

        upsertCouncilIndex({
          id: debateId,
          topic: data.topic,
          status: roundCompleteStatus(n),
          rounds_planned: data.rounds_planned,
          current_round: n,
          promoted_to_knowledge: data.promoted_to_knowledge ?? null,
          created_at: data.created_at,
          updated_at: today(),
        });

        updateCouncilLive(debateId, { phase: 'interlude', setAll: 'wait' });

        success(`Round ${n} complete for ${debateId}.`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council round-context ──────────────────────────────────────────────────

function registerRoundContext(council: Command): void {
  council
    .command('round-context')
    .argument('<debate_id>')
    .argument('<persona_slug>')
    .description('(sub-agent) Print persona body + peer cross-summaries for the current round.')
    .action((debateId: string, personaSlug: string) => {
      try {
        const data = readDebateFrontmatter(debateId);
        ensurePersonaExists(debateId, personaSlug);

        const personaFile = join(getPersonaDir(debateId, personaSlug), 'context-and-persona.md');
        const personaContent = readFileSync(personaFile, 'utf-8');

        console.log(`# Council debate: ${data.topic}`);
        console.log(`Debate ID: ${debateId}`);
        console.log(`Current round: ${data.current_round}/${data.rounds_planned}`);
        console.log(`Your persona: ${personaSlug}`);
        console.log('');
        console.log('---');
        console.log('');
        console.log(personaContent);

        // Also print the debate's Question + Constraints
        const debateFile = join(getDebateDir(debateId), 'debate.md');
        const debateRaw = readFileSync(debateFile, 'utf-8');
        const questionMatch = debateRaw.match(/##\s+Question\s*\n([\s\S]*?)(?=\n##\s|\Z)/);
        const constraintsMatch = debateRaw.match(/##\s+Constraints & Known Facts\s*\n([\s\S]*?)(?=\n##\s|\Z)/);

        if (questionMatch) {
          console.log('\n---\n');
          console.log('## Debate Question\n');
          console.log(questionMatch[1].trim());
        }
        if (constraintsMatch) {
          console.log('\n## Constraints & Known Facts\n');
          console.log(constraintsMatch[1].trim());
        }

        // ── v2: verdict landscape of the last completed round ──
        const verdicts = readVerdicts(debateId);
        const landscapeRound = ((): number | null => {
          const rounds = Object.keys(verdicts.rounds)
            .map(Number)
            .filter(
              (r) =>
                Number.isInteger(r) &&
                r > 0 &&
                r < data.current_round &&
                Object.keys(verdicts.rounds[String(r)] ?? {}).length > 0,
            );
          return rounds.length > 0 ? Math.max(...rounds) : null;
        })();
        if (landscapeRound !== null) {
          const rv = roundVerdictsOf(verdicts, landscapeRound);
          console.log(`\n## Verdict landscape (round ${landscapeRound})\n`);
          console.log('| Persona | Stance | Conviction | Headline |');
          console.log('| --- | --- | --- | --- |');
          for (const [slug, v] of Object.entries(rv)) {
            console.log(`| ${slug} | ${v.stance} | ${v.conviction} | ${v.headline.replace(/\|/g, '\\|')} |`);
          }
          const lead = leadingStance(rv);
          console.log(`\nLeading: ${lead ?? '(none)'} · Convergence: ${convergence(rv)}%`);
        }

        // ── v2: facts injected since the last round (interlude injections) ──
        if (constraintsMatch) {
          const newFacts = constraintsMatch[1]
            .split('\n')
            .filter((line) => {
              const m = line.match(/\*\*\[Interlude R(\d+)\]\*\*/);
              return m !== null && Number(m[1]) >= data.current_round - 1;
            });
          if (newFacts.length > 0) {
            console.log('\n## New facts since last round\n');
            for (const line of newFacts) console.log(line);
          }
        }

        // ── v2: pending directives for THIS persona, this round ──
        const directivesMatch = personaContent.match(
          new RegExp(`^##\\s+Round\\s+${data.current_round}\\s+—\\s+Directives\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'm'),
        );
        if (directivesMatch && directivesMatch[1].trim()) {
          console.log(`\n## Pending directives for you (round ${data.current_round})\n`);
          console.log(directivesMatch[1].trim());
          console.log('\nAnswer directives in a `### Cross-examination` subsection of this round\'s report.');
        }
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council report append ──────────────────────────────────────────────────

function registerReport(council: Command): void {
  const report = council.command('report').description('Sub-agent report operations');

  report
    .command('append')
    .argument('<debate_id>')
    .argument('<persona_slug>')
    .option('-b, --body <text>', 'Report body (otherwise read from stdin)')
    .option('--round <n>', 'Round number (default: debate.current_round)')
    .description('(sub-agent) Append a round entry to report.md. Validates required subsections.')
    .action(async (
      debateId: string,
      personaSlug: string,
      opts: { body?: string; round?: string },
    ) => {
      try {
        const data = readDebateFrontmatter(debateId);
        ensurePersonaExists(debateId, personaSlug);

        const round = opts.round ? Number(opts.round) : data.current_round;
        if (!Number.isInteger(round) || round < 1) {
          error('Round must be a positive integer.');
          process.exit(1);
        }

        let body = opts.body ?? (await readStdin());
        // The CLI owns the `## Round N` heading (added below). Personas sometimes
        // include their own copy at the top of the body; strip it so the round
        // doesn't end up with a duplicate heading and an empty first entry.
        body = body.trim().replace(/^##\s+Round\s+\d+[^\n]*\n+/i, '');
        if (!body.trim()) {
          error('Report body is empty.', 'Pass --body "..." or pipe markdown via stdin.');
          process.exit(1);
        }

        const validation = validateRoundEntry(body);
        if (!validation.ok) {
          error(
            `Report rejected. Missing required subsections: ${validation.missing.join(', ')}`,
            'Each round entry needs: ### Executive Summary, ### Position, ### Reasoning, ### Reactions to peers, ### Open questions.',
          );
          process.exit(1);
        }
        for (const w of validation.warnings) warn(w);

        // v2: a verdict is expected before the report (warn, never fail —
        // v1 debates without verdicts.json keep working).
        const verdicts = readVerdicts(debateId);
        if (!roundVerdictsOf(verdicts, round)[personaSlug]) {
          warn(
            `No verdict submitted for round ${round}. Run \`council verdict ${debateId} ${personaSlug} ${round} --stance <s> --conviction <0-100> --headline "..."\` — the chamber board will not show this persona otherwise.`,
          );
        }

        const reportFile = join(getPersonaDir(debateId, personaSlug), 'report.md');
        const { data: reportData, content } = readFrontmatter<{ persona: string; rounds_completed: number }>(reportFile);

        // Rebuild content: drop any prior entry for the same round, prepend the new one (LIFO).
        const existingRounds = parseReportRounds(content);
        if (existingRounds.find((r) => r.round === round)) {
          warn(`Round ${round} entry already exists for ${personaSlug}. Replacing.`);
        }
        const otherEntries = existingRounds.filter((r) => r.round !== round);

        const newEntry = `## Round ${round} — ${today()}\n\n${body.trim()}`;
        const otherSerialized = otherEntries
          .sort((a, b) => b.round - a.round)
          .map((e) => `${e.heading}\n\n${e.body}`.trim())
          .join('\n\n');

        const merged = otherSerialized
          ? `${newEntry}\n\n${otherSerialized}\n`
          : `${newEntry}\n`;

        writeFrontmatter(reportFile, {
          persona: personaSlug,
          rounds_completed: Math.max(reportData.rounds_completed ?? 0, round),
        }, '\n' + merged);

        // Update persona frontmatter round_entries
        const personaFile = join(getPersonaDir(debateId, personaSlug), 'context-and-persona.md');
        const { data: pData } = readFrontmatter<PersonaFrontmatter>(personaFile);
        updateFrontmatterFields(personaFile, {
          round_entries: Math.max(pData.round_entries ?? 0, round),
        });

        success(`Round ${round} report appended for ${personaSlug}.`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council summaries ──────────────────────────────────────────────────────

function registerSummaries(council: Command): void {
  council
    .command('summaries')
    .argument('<debate_id>')
    .argument('<n>')
    .description('Print ONLY executive summaries from round N across all personas (main-agent view).')
    .action((debateId: string, nRaw: string) => {
      try {
        const n = Number(nRaw);
        const data = readDebateFrontmatter(debateId);
        const personas = data.personas ?? [];
        const verdicts = readVerdicts(debateId);
        const cur = roundVerdictsOf(verdicts, n);
        const prev = roundVerdictsOf(verdicts, n - 1);

        console.log(`# Round ${n} executive summaries — ${data.topic}`);
        console.log('');

        for (const persona of personas) {
          const summary = getPersonaRoundSummary(debateId, persona, n);
          console.log(`## ${persona}`);
          console.log('');
          console.log(summary ?? '_(no report for this round)_');
          const v = cur[persona];
          if (v) {
            console.log('');
            console.log(`stance=${v.stance} conviction=${v.conviction} (${shiftMarker(prev[persona], v)})`);
          }
          console.log('');
        }
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council research ───────────────────────────────────────────────────────

interface ResearchIndexEntry {
  slug: string;
  topic: string;
  added_at: string;
}

function registerResearch(council: Command): void {
  const research = council.command('research').description('Persist/list sub-agent research notes');

  research
    .command('add')
    .argument('<debate_id>')
    .argument('<persona_slug>')
    .argument('<topic...>', 'Research topic (becomes filename)')
    .option('-b, --body <text>', 'Research body (otherwise read from stdin)')
    .description('(sub-agent) Write a research note to researches/ and update index.')
    .action(async (
      debateId: string,
      personaSlug: string,
      topicParts: string[],
      opts: { body?: string },
    ) => {
      try {
        ensurePersonaExists(debateId, personaSlug);
        const topic = topicParts.join(' ').trim();
        if (!topic) {
          error('Research topic is required.');
          process.exit(1);
        }

        const researchesDir = join(getPersonaDir(debateId, personaSlug), 'researches');
        mkdirSync(researchesDir, { recursive: true });

        const indexPath = join(researchesDir, 'index.json');
        if (!existsSync(indexPath)) writeJsonArray(indexPath, []);

        const slug = slugify(topic);
        const file = join(researchesDir, `${slug}.md`);
        if (existsSync(file)) {
          error(`Research note already exists: ${slug}.md`);
          process.exit(1);
        }

        const body = opts.body ?? (await readStdin());
        if (!body.trim()) {
          error('Research body is empty.', 'Pass --body "..." or pipe markdown via stdin.');
          process.exit(1);
        }

        const noteContent = `# ${topic}\n\n_Added ${today()} by ${personaSlug}_\n\n${body.trim()}\n`;
        writeFileSync(file, noteContent, 'utf-8');

        insertToJsonArray<ResearchIndexEntry>(indexPath, {
          slug,
          topic,
          added_at: today(),
        });

        success(`Research added: ${slug}.md`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });

  research
    .command('list')
    .argument('<debate_id>')
    .argument('<persona_slug>')
    .description('List this persona\'s prior research notes.')
    .action((debateId: string, personaSlug: string) => {
      try {
        ensurePersonaExists(debateId, personaSlug);
        const researchesDir = join(getPersonaDir(debateId, personaSlug), 'researches');
        const indexPath = join(researchesDir, 'index.json');
        if (!existsSync(indexPath)) {
          console.log(chalk.dim('(no researches)'));
          return;
        }
        const entries = readJsonArray<ResearchIndexEntry>(indexPath);
        if (entries.length === 0) {
          console.log(chalk.dim('(no researches)'));
          return;
        }
        for (const e of entries) {
          console.log(`  ${chalk.magentaBright(e.slug)}  ${chalk.dim(e.added_at)}  ${e.topic}`);
        }
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council synthesize ─────────────────────────────────────────────────────

function registerSynthesize(council: Command): void {
  council
    .command('synthesize')
    .argument('<debate_id>')
    .description('Mark status=synthesizing; print manifest of files synthesizer should read.')
    .action((debateId: string) => {
      try {
        const data = readDebateFrontmatter(debateId);
        const debateFile = join(getDebateDir(debateId), 'debate.md');

        updateFrontmatterFields(debateFile, {
          status: 'synthesizing',
          updated_at: today(),
        });

        upsertCouncilIndex({
          id: debateId,
          topic: data.topic,
          status: 'synthesizing',
          rounds_planned: data.rounds_planned,
          current_round: data.current_round,
          promoted_to_knowledge: data.promoted_to_knowledge ?? null,
          created_at: data.created_at,
          updated_at: today(),
        });

        // Print manifest — validate every persona path before printing (guard
        // against tampered debate.md personas[] entries that could point outside
        // the debate directory).
        const manifest: string[] = [];
        manifest.push(`_dream_context/council/${debateId}/debate.md`);
        manifest.push(`_dream_context/council/${debateId}/round-log.md`);
        for (const persona of data.personas ?? []) {
          // Throws if persona contains a path separator or `..`; ensures the
          // resolved path is under the council dir.
          const personaDir = getPersonaDir(debateId, persona);
          manifest.push(`_dream_context/council/${debateId}/${persona}/context-and-persona.md`);
          manifest.push(`_dream_context/council/${debateId}/${persona}/report.md`);
          const researchesIndex = join(personaDir, 'researches', 'index.json');
          if (existsSync(researchesIndex)) {
            manifest.push(`_dream_context/council/${debateId}/${persona}/researches/`);
          }
        }

        updateCouncilLive(debateId, { phase: 'synthesis', setAll: 'wait' });

        console.log('# Synthesizer manifest — read every file below, then write final-report.md\n');
        for (const p of manifest) console.log(p);
        if (existsSync(join(getDebateDir(debateId), 'verdicts.json'))) {
          console.log(`_dream_context/council/${debateId}/verdicts.json`);
          console.log(`\nAlso run: dreamcontext council timeline ${debateId} — embed the table verbatim in ## Position timeline.`);
        }
        console.log(`\nTarget output: _dream_context/council/${debateId}/final-report.md`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council complete ───────────────────────────────────────────────────────

function registerComplete(council: Command): void {
  council
    .command('complete')
    .argument('<debate_id>')
    .description('Mark status=complete after final-report.md is written.')
    .action((debateId: string) => {
      try {
        const data = readDebateFrontmatter(debateId);
        const finalReport = join(getDebateDir(debateId), 'final-report.md');
        if (!existsSync(finalReport)) {
          error('final-report.md not found.', 'Synthesizer must write it before calling `council complete`.');
          process.exit(1);
        }

        const debateFile = join(getDebateDir(debateId), 'debate.md');
        updateFrontmatterFields(debateFile, {
          status: 'complete',
          updated_at: today(),
        });

        upsertCouncilIndex({
          id: debateId,
          topic: data.topic,
          status: 'complete',
          rounds_planned: data.rounds_planned,
          current_round: data.current_round,
          promoted_to_knowledge: data.promoted_to_knowledge ?? null,
          created_at: data.created_at,
          updated_at: today(),
        });

        updateCouncilLive(debateId, { phase: 'done', setAll: 'done' });

        success(`Debate ${debateId} marked complete.`);
        console.log(chalk.dim(`  final-report: _dream_context/council/${debateId}/final-report.md`));
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council promote ────────────────────────────────────────────────────────

function registerPromote(council: Command): void {
  council
    .command('promote')
    .argument('<debate_id>')
    .option('--force', 'Overwrite existing knowledge file', false)
    .description('Copy trimmed final-report into _dream_context/knowledge/decision-{slug}.md.')
    .action((debateId: string, opts: { force: boolean }) => {
      try {
        const root = ensureContextRoot();
        const data = readDebateFrontmatter(debateId);
        if (data.status !== 'complete') {
          error(`Cannot promote: debate status is "${data.status}", expected "complete".`);
          process.exit(1);
        }

        const finalReport = join(getDebateDir(debateId), 'final-report.md');
        if (!existsSync(finalReport)) {
          error('final-report.md not found.');
          process.exit(1);
        }

        const { data: frData, content: frContent } = readFrontmatter(finalReport);

        // Trim to report v2 sections 1,2,3,6,7: Verdict, Decision card, Why,
        // Minority view & revisit conditions, Open risks. Each entry lists
        // fallbacks so v1 reports (e.g. "Minority views") still promote.
        const sections = extractSections(frContent);
        const keep: string[][] = [
          ['Verdict'],
          ['Decision card'],
          ['Why'],
          ['Minority view & revisit conditions', 'Minority views'],
          ['Open risks'],
        ];
        const kept = keep
          .map((names) => {
            for (const name of names) {
              const sec = sections.find((s) => normalize(s.name) === normalize(name));
              if (sec) return `## ${sec.name}\n\n${sec.body.trim()}`;
            }
            return null;
          })
          .filter(Boolean)
          .join('\n\n');

        const knowledgeDir = join(root, 'knowledge');
        mkdirSync(knowledgeDir, { recursive: true });

        const slug = slugify(data.topic).slice(0, 80) || debateId;
        const filename = `decision-${slug}.md`;
        const target = join(knowledgeDir, filename);
        if (existsSync(target) && !opts.force) {
          error(`Knowledge file exists: ${filename}`, 'Use --force to overwrite.');
          process.exit(1);
        }

        const knowledgeFrontmatter = {
          id: generateId('know'),
          name: `Decision: ${data.topic}`,
          type: 'decision',
          source_debate: debateId,
          topic: data.topic,
          personas: data.personas ?? [],
          rounds: data.rounds_planned,
          created_at: today(),
          updated_at: today(),
          tags: ['decision', 'council'],
        };

        const body = `\n${kept}\n\n---\n\n_Promoted from council debate \`${debateId}\` on ${today()}. See \`_dream_context/council/${debateId}/final-report.md\` for the full record._\n`;
        writeFrontmatter(target, knowledgeFrontmatter, body);

        // Update debate.md pointer
        updateFrontmatterFields(join(getDebateDir(debateId), 'debate.md'), {
          promoted_to_knowledge: `knowledge/${filename}`,
          updated_at: today(),
        });

        upsertCouncilIndex({
          id: debateId,
          topic: data.topic,
          status: 'complete',
          rounds_planned: data.rounds_planned,
          current_round: data.current_round,
          promoted_to_knowledge: `knowledge/${filename}`,
          created_at: data.created_at,
          updated_at: today(),
        });

        success(`Promoted to knowledge: ${filename}`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council list / show ────────────────────────────────────────────────────

function registerList(council: Command): void {
  council
    .command('list')
    .option('--unpromoted', 'Only completed debates not yet promoted to knowledge', false)
    .option('--all', 'Include all statuses', false)
    .description('List debates (inspection / sleep-agent triage).')
    .action((opts: { unpromoted: boolean; all: boolean }) => {
      try {
        ensureContextRoot();
        const entries = loadCouncilIndex();
        let filtered = entries;
        if (opts.unpromoted) {
          filtered = entries.filter((e) => e.status === 'complete' && !e.promoted_to_knowledge);
        } else if (!opts.all) {
          filtered = entries.filter((e) => e.status !== 'complete' || !e.promoted_to_knowledge);
        }

        if (filtered.length === 0) {
          console.log(chalk.dim('No debates.'));
          return;
        }

        console.log(header('Debates'));
        for (const e of filtered) {
          const promoted = e.promoted_to_knowledge ? chalk.green(' [promoted]') : '';
          console.log(
            `  ${chalk.magentaBright(e.id)}  ${chalk.dim(e.status.padEnd(22))}  ${e.topic}${promoted}`,
          );
          console.log(`  ${' '.repeat(e.id.length)}  ${chalk.dim(`round ${e.current_round}/${e.rounds_planned}  updated ${e.updated_at}`)}`);
        }
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

function registerShow(council: Command): void {
  council
    .command('show')
    .argument('<debate_id>')
    .description('Show debate metadata and round log.')
    .action((debateId: string) => {
      try {
        const data = readDebateFrontmatter(debateId);
        console.log(header(`Debate ${debateId}`));
        console.log(`  topic:     ${data.topic}`);
        console.log(`  status:    ${data.status}`);
        console.log(`  round:     ${data.current_round}/${data.rounds_planned}`);
        console.log(`  personas:  ${formatPersonaList(data.personas ?? [])}`);
        console.log(`  promoted:  ${data.promoted_to_knowledge ?? chalk.dim('(no)')}`);
        console.log(`  created:   ${data.created_at}`);
        console.log(`  updated:   ${data.updated_at}`);

        const logFile = join(getDebateDir(debateId), 'round-log.md');
        if (existsSync(logFile)) {
          console.log('\n' + chalk.dim('─── Round log ───'));
          console.log(readFileSync(logFile, 'utf-8'));
        }
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council verdict ────────────────────────────────────────────────────────

function registerVerdict(council: Command): void {
  council
    .command('verdict')
    .argument('<debate_id>')
    .argument('<persona_slug>')
    .argument('<round>')
    .requiredOption('--stance <stance>', 'Option key (registered options) or free-form stance')
    .requiredOption('--conviction <n>', 'Conviction 0-100')
    .requiredOption('--headline <headline>', 'One-line position')
    .option('--concession <concession>', 'Strongest opposing point you accept')
    .description('(sub-agent) Record a structured verdict for a round. Idempotent per (round, persona) — last write wins.')
    .action(async (
      debateId: string,
      personaSlug: string,
      roundRaw: string,
      opts: { stance: string; conviction: string; headline: string; concession?: string },
    ) => {
      try {
        const data = readDebateFrontmatter(debateId);
        ensurePersonaExists(debateId, personaSlug);

        const round = Number(roundRaw);
        if (!Number.isInteger(round) || round < 1) {
          error('Round must be a positive integer.');
          process.exit(1);
        }

        const conviction = Number(opts.conviction);
        if (!Number.isInteger(conviction) || conviction < 0 || conviction > 100) {
          error('--conviction must be an integer between 0 and 100.');
          process.exit(1);
        }

        const headline = opts.headline.trim();
        if (!headline) {
          error('--headline is required.');
          process.exit(1);
        }

        // Personas submit verdicts in PARALLEL — the whole read→mutate→write
        // (including dynamic-option minting) must run under the verdicts lock,
        // or a concurrent writer silently drops a sibling's verdict.
        const { key, replacing } = await withVerdictsLock(debateId, () => {
          const verdicts = readVerdicts(debateId);
          const resolved = resolveStanceKey(
            verdicts,
            hasRegisteredOptions(data),
            opts.stance,
          );
          if (resolved.addedOption) verdicts.options.push(resolved.addedOption);

          const roundKey = String(round);
          if (!verdicts.rounds[roundKey]) verdicts.rounds[roundKey] = {};
          const replaced = Boolean(verdicts.rounds[roundKey][personaSlug]);
          verdicts.rounds[roundKey][personaSlug] = {
            stance: resolved.key,
            conviction,
            headline,
            ...(opts.concession?.trim() ? { concession: opts.concession.trim() } : {}),
            at: new Date().toISOString(),
          };
          writeVerdicts(debateId, verdicts);
          return { key: resolved.key, replacing: replaced };
        });

        updateCouncilLive(debateId, { setPersona: { [personaSlug]: 'done' } });

        success(
          `Verdict recorded: ${personaSlug} R${round} → ${key} (conviction ${conviction})${replacing ? ' [replaced]' : ''}`,
        );
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council board ──────────────────────────────────────────────────────────

function registerBoard(council: Command): void {
  council
    .command('board')
    .argument('<debate_id>')
    .option('--round <n>', 'Round to render (default: latest round with verdicts)')
    .option('--plain', 'Disable colors (auto when output is not a TTY)', false)
    .description('Render the chamber board: convergence, per-persona stances, shifts, options tally.')
    .action((debateId: string, opts: { round?: string; plain: boolean }) => {
      try {
        const data = readDebateFrontmatter(debateId);
        const verdicts = readVerdicts(debateId);

        let round: number;
        if (opts.round !== undefined) {
          round = Number(opts.round);
          if (!Number.isInteger(round) || round < 1) {
            error('--round must be a positive integer.');
            process.exit(1);
          }
        } else {
          round = latestVerdictRound(verdicts) ?? data.current_round;
        }
        if (round < 1) {
          info('No rounds yet — nothing to render.');
          return;
        }

        const previous = round > 1 ? roundVerdictsOf(verdicts, round - 1) : {};
        const board = renderChamberBoard(
          {
            debateId,
            topic: data.topic,
            round,
            roundsPlanned: data.rounds_planned,
            phase: data.status,
            options: verdicts.options,
            roster: data.personas ?? [],
            current: roundVerdictsOf(verdicts, round),
            previous: Object.keys(previous).length > 0 ? previous : null,
          },
          { plain: opts.plain || !process.stdout.isTTY },
        );
        console.log(board);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council timeline ───────────────────────────────────────────────────────

function registerTimeline(council: Command): void {
  council
    .command('timeline')
    .argument('<debate_id>')
    .option('--json', 'Machine-readable output', false)
    .description('Per-round stance + conviction table across all personas (markdown or --json).')
    .action((debateId: string, opts: { json: boolean }) => {
      try {
        const data = readDebateFrontmatter(debateId);
        const verdicts = readVerdicts(debateId);
        const roundNumbers = Object.keys(verdicts.rounds)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0 && Object.keys(verdicts.rounds[String(n)] ?? {}).length > 0)
          .sort((a, b) => a - b);

        if (opts.json) {
          const payload = {
            options: verdicts.options,
            rounds: roundNumbers.map((n) => {
              const rv = roundVerdictsOf(verdicts, n);
              return {
                round: n,
                verdicts: Object.fromEntries(
                  Object.entries(rv).map(([slug, v]) => [
                    slug,
                    { stance: v.stance, conviction: v.conviction, headline: v.headline },
                  ]),
                ),
                convergence: convergence(rv),
                leading: leadingStance(rv),
              };
            }),
          };
          console.log(JSON.stringify(payload, null, 2));
          return;
        }

        if (roundNumbers.length === 0) {
          console.log('_(no verdicts recorded)_');
          return;
        }

        // Persona rows: roster order first, then any extra slugs seen in verdicts.
        const slugs: string[] = [...(data.personas ?? [])];
        for (const n of roundNumbers) {
          for (const slug of Object.keys(roundVerdictsOf(verdicts, n))) {
            if (!slugs.includes(slug)) slugs.push(slug);
          }
        }

        const headerCells = ['Persona', ...roundNumbers.map((n) => `R${n}`)];
        console.log(`| ${headerCells.join(' | ')} |`);
        console.log(`| ${headerCells.map(() => '---').join(' | ')} |`);
        for (const slug of slugs) {
          const cells = roundNumbers.map((n) => {
            const v = roundVerdictsOf(verdicts, n)[slug];
            return v ? `${v.stance} ${v.conviction}` : '—';
          });
          console.log(`| ${slug} | ${cells.join(' | ')} |`);
        }
        const convCells = roundNumbers.map((n) => {
          const rv = roundVerdictsOf(verdicts, n);
          const lead = leadingStance(rv);
          return `${convergence(rv)}%${lead ? ` → ${lead}` : ''}`;
        });
        console.log(`| _convergence_ | ${convCells.join(' | ')} |`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council inject ─────────────────────────────────────────────────────────

function registerInject(council: Command): void {
  council
    .command('inject')
    .argument('<debate_id>')
    .argument('<fact...>', 'Fact to add to Constraints & Known Facts')
    .description('(interlude) Inject a new fact into the debate. Personas see it via round-context next round.')
    .action((debateId: string, factParts: string[]) => {
      try {
        const data = readDebateFrontmatter(debateId);
        const fact = factParts.join(' ').trim();
        if (!fact) {
          error('Fact is required.');
          process.exit(1);
        }

        const debateFile = join(getDebateDir(debateId), 'debate.md');
        insertToSection(
          debateFile,
          'Constraints & Known Facts',
          `- **[Interlude R${data.current_round}]** ${fact}`,
          'bottom',
          true,
        );
        updateFrontmatterFields(debateFile, { updated_at: today() });

        updateCouncilLive(debateId);

        success(`Fact injected (interlude after round ${data.current_round}).`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council question ───────────────────────────────────────────────────────

function registerQuestion(council: Command): void {
  council
    .command('question')
    .argument('<debate_id>')
    .argument('<persona_slug>')
    .argument('<question...>', 'Directive / cross-examination question for the persona')
    .description('(interlude) Queue a directive for a persona. Surfaced by round-context next round.')
    .action((debateId: string, personaSlug: string, questionParts: string[]) => {
      try {
        const data = readDebateFrontmatter(debateId);
        ensurePersonaExists(debateId, personaSlug);
        const question = questionParts.join(' ').trim();
        if (!question) {
          error('Question is required.');
          process.exit(1);
        }

        const nextRound = data.current_round + 1;
        const personaFile = join(getPersonaDir(debateId, personaSlug), 'context-and-persona.md');
        insertToSection(
          personaFile,
          `Round ${nextRound} — Directives`,
          `- ${question}`,
          'bottom',
          true,
        );

        updateCouncilLive(debateId);

        success(`Directive queued for ${personaSlug} (round ${nextRound}).`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council live ───────────────────────────────────────────────────────────

function registerLive(council: Command): void {
  const live = council.command('live').description('Live chamber state file operations');

  live
    .command('clear')
    .description('Delete _dream_context/tmp/.council-live.json')
    .action(() => {
      try {
        ensureContextRoot();
        clearCouncilLive();
        success('Council live state cleared.');
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── council demo-live ──────────────────────────────────────────────────────

function registerDemoLive(council: Command): void {
  council
    .command('demo-live')
    .option('--phase <phase>', `Phase: ${COUNCIL_LIVE_PHASES.join(' | ')}`, 'debate')
    .description('(dev) Write a plausible fake .council-live.json for testing the app panel.')
    .action((opts: { phase: string }) => {
      try {
        ensureContextRoot();
        if (!COUNCIL_LIVE_PHASES.includes(opts.phase as CouncilLivePhase)) {
          error(`--phase must be one of: ${COUNCIL_LIVE_PHASES.join(', ')}`);
          process.exit(1);
        }
        const phase = opts.phase as CouncilLivePhase;
        const now = new Date().toISOString();
        const state: CouncilLiveState = {
          debate: 'council_demo',
          topic: 'Should we drop ClickUp sync?',
          session: process.env.CLAUDE_CODE_SESSION_ID ?? '',
          started: now,
          updated: now,
          phase,
          round: 2,
          rounds: 3,
          options: [
            { key: 'A', label: 'Keep ClickUp sync' },
            { key: 'B', label: 'Drop it' },
          ],
          personas: [
            { slug: 'migration-risk-auditor', model: 'sonnet', state: 'done', stance: 'B', conviction: 82, headline: 'sync debt compounds weekly', prevStance: 'A', prevConviction: 64 },
            { slug: 'growth-cfo', model: 'sonnet', state: 'done', stance: 'B', conviction: 71, headline: 'cost cut pays for itself', prevStance: 'B', prevConviction: 66 },
            { slug: 'user-advocate', model: 'opus', state: 'think', stance: 'A', conviction: 45, headline: 'users still rely on it', prevStance: 'A', prevConviction: 78 },
            { slug: 'platform-architect', model: 'haiku', state: 'wait' },
          ],
          convergence: 68,
          leading: 'B',
        };
        writeCouncilLiveRaw(state);
        success(`Demo live state written (phase: ${phase}).`);
        console.log(chalk.dim('  path: _dream_context/tmp/.council-live.json'));
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

// ─── Section helpers for promote ────────────────────────────────────────────

interface ParsedSection {
  name: string;
  body: string;
}

function extractSections(content: string): ParsedSection[] {
  const lines = content.split('\n');
  const sections: ParsedSection[] = [];
  let current: { name: string; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m) {
      if (current) {
        sections.push({
          name: current.name,
          body: lines.slice(current.start + 1, i).join('\n'),
        });
      }
      current = { name: m[1].trim(), start: i };
    }
  }
  if (current) {
    sections.push({
      name: current.name,
      body: lines.slice(current.start + 1).join('\n'),
    });
  }
  return sections;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}
