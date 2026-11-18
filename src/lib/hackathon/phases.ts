/**
 * The phases a run walks (plan C6), in order: rounds (each round one resumed turn per team, the
 * peek between rounds, the last round as the wrap-up), presentation, jury. The conductor resumes
 * at `run.phase` and, inside rounds, at `run.round`.
 */
import { findCodexBin } from '../codex-bin.js';
import type { PhaseCtx } from './conductor.js';
import { roundMessage } from './conductor.js';
import { readAnswer, readQuestion, readThesis } from './crossing.js';
import { runJury } from './jury.js';
import { answerBlock, planPeek, questionBlock, routeQuestions } from './peek.js';
import { captureEvidence, juryText, readPresentation } from './presentation.js';
import { addMoment, readRun, runDir, teamWorkspace, updateRun, writeJsonAtomic, type Phase, type RunRecord } from './run-store.js';
import { overlapLines, realModelCall, scorePairs, type ModelCall, type SimilarPair } from './similarity.js';
import type { PeekQuestion, ThesisCard } from './team-files.js';

export const PRESENTATION_MINUTES = 15;

export interface PhaseOptions {
  modelCall?: ModelCall;
  codexInstalled?: () => boolean;
}

function outOf(run: RunRecord, team: string, ctx: PhaseCtx): string {
  return teamWorkspace(run.id, team, ctx.deps.wsHome).out;
}

function moment(ctx: PhaseCtx, run: RunRecord, text: string): RunRecord {
  return updateRun(ctx.deps.contextRoot, run.id, (r) => addMoment(r, text, new Date(ctx.deps.now())));
}

export function roundsPhase(opts: PhaseOptions = {}): Phase<PhaseCtx> {
  return {
    name: 'rounds',
    async run(run, ctx) {
      const { design, state, deps } = ctx;
      const call = opts.modelCall ?? realModelCall;
      for (let round = Math.max(1, run.round ?? 1); round <= design.rounds; round++) {
        if ((readRun(deps.contextRoot, run.id)?.state ?? 'stopped') === 'stopped') return readRun(deps.contextRoot, run.id) ?? run;
        if (round > 1) {
          const v = ctx.limit();
          if (!v.newRound) { run = moment(ctx, run, v.reason ?? 'yeni tur yok'); break; }
        }
        run = updateRun(deps.contextRoot, run.id, (r) => addMoment({ ...r, round }, `tur ${round} başladı`, new Date(deps.now())));
        const pending = state.pending ?? {};
        const messages: Record<string, string> = {};
        for (const t of design.teams) messages[t.id] = roundMessage(run, design, t, round, deps.brainRoot, pending[t.id] ?? []);
        state.pending = {};
        ctx.saveState();
        await ctx.runTurns(`r${round}`, round, messages, design.roundMinutes * 60_000);
        if ((readRun(deps.contextRoot, run.id)?.state ?? 'stopped') === 'stopped') return readRun(deps.contextRoot, run.id) ?? run;

        // Thesis cards: valid or dropped with a reason line on the strip.
        const cards: Record<string, ThesisCard | null> = {};
        for (const t of design.teams) {
          const c = readThesis(outOf(run, t.id, ctx), round);
          cards[t.id] = c.ok ? c.value : null;
          if (!c.ok) run = moment(ctx, run, `${t.name}: tez kartı düşürüldü (${c.reason})`);
        }
        const next: Record<string, string[]> = {};
        const push = (team: string, block: string) => { (next[team] ??= []).push(block); };

        // Answers to last round's questions go back to the askers.
        for (const [answerer, askers] of Object.entries(state.asked ?? {})) {
          const a = readAnswer(outOf(run, answerer, ctx), round);
          if (a.ok) for (const asker of askers) push(asker, answerBlock(a.value.text));
        }
        state.asked = {};

        // The peek (rounds 1 and last closed: planPeek gives nothing then).
        const peek = planPeek(design, round, Object.fromEntries(Object.entries(cards).filter(([id]) => id !== design.controlTeam)));
        for (const [team, blocks] of Object.entries(peek.messages)) push(team, blocks.join('\n\n'));
        if (Object.keys(peek.messages).length) run = moment(ctx, run, `göz atma: ${Object.keys(peek.messages).length} ekip komşu kartlarını görecek`);

        // Questions written this round reach the asked neighbour next round (one per team).
        const qs: Record<string, PeekQuestion | null> = {};
        for (const t of design.teams) {
          if (t.id === design.controlTeam) continue;
          const q = readQuestion(outOf(run, t.id, ctx), round);
          qs[t.id] = q.ok ? q.value : null;
        }
        const routed = routeQuestions(design, qs);
        for (const [to, list] of Object.entries(routed)) {
          push(to, questionBlock(round + 1, list));
          state.asked = { ...state.asked, [to]: list.map((x) => x.from) };
        }

        // Similarity gate: the later team of a pair above the gate is told.
        let pairs: SimilarPair[] = [];
        if (round < design.rounds) {
          const peers = Object.fromEntries(Object.entries(cards).filter(([id]) => id !== design.controlTeam));
          pairs = await scorePairs(peers, call);
          const lines = overlapLines(pairs, design.teams.map((t) => t.id), design.peek.gate);
          for (const [team, ls] of Object.entries(lines)) for (const l of ls) push(team, l);
          const close = pairs.filter((p) => p.score > design.peek.gate).length;
          if (pairs.length) run = moment(ctx, run, `yakınlık: ${pairs.length} çift ölçüldü${close ? `, ${close} çift çok yakın` : ''}`);
        }
        // The owner's record of the round (the peek screen and the strip's "how different"): who
        // saw whom, the cards, the routed questions and the pair scores. Local only (gitignored).
        writeRoundRecord(deps.contextRoot, run.id, {
          round, at: new Date(deps.now()).toISOString(), cards, seen: peek.seen,
          questions: Object.entries(routed).flatMap(([to, list]) => list.map((q) => ({ from: q.from, to, text: q.text }))),
          pairs: pairs.map((p) => ({ a: p.a, b: p.b, score: p.score })), gate: design.peek.gate,
        });
        state.pending = next;
        ctx.saveState();
      }
      return readRun(deps.contextRoot, run.id) ?? run;
    },
  };
}

export function presentationPhase(): Phase<PhaseCtx> {
  return {
    name: 'presentation',
    async run(run, ctx) {
      const { design, deps } = ctx;
      run = updateRun(deps.contextRoot, run.id, (r) => (r.state === 'running' ? addMoment({ ...r, state: 'presenting' }, 'sunumlar hazırlanıyor', new Date(deps.now())) : null));
      if (run.state !== 'presenting') return run;
      const msg = [
        '=== SUNUM ===',
        `Prepare your presentation in ${PRESENTATION_MINUTES} minutes: write out/presentation/manifest.json`,
        '{"cards": [{"kind": "thesis"|"screen"|"video"|"pdf"|"image"|"data", "title": "≤80 chars", "file"?: "path inside out/"}], "borrowed": [{"from": "left"|"right", "round": n, "idea": "…"}] (at most one, only if you borrowed)}',
        'Media: PNG, JPEG, WebP, MP4 or PDF only. No SVG.',
        design.kind === 'screen' ? 'Leave your static build in out/build/ with out/shot-request.json {"entry":"index.html"}; the conductor takes the screenshots.' : '',
      ].filter(Boolean).join('\n');
      const messages = Object.fromEntries(design.teams.map((t) => [t.id, msg]));
      await ctx.runTurns('sunum', design.rounds + 1, messages, PRESENTATION_MINUTES * 60_000);
      for (const t of design.teams) {
        const notes = await captureEvidence(run.id, t.id, design.kind, deps.wsHome);
        for (const n of notes) run = moment(ctx, run, `${t.name}: ${n}`);
      }
      return readRun(deps.contextRoot, run.id) ?? run;
    },
  };
}

/** One round's owner record (the peek screen reads it). */
export interface RoundRecord {
  round: number;
  at: string;
  cards: Record<string, ThesisCard | null>;
  /** team -> the teams whose cards it saw (empty when the peek was closed). */
  seen: Record<string, string[]>;
  questions: { from: string; to: string; text: string }[];
  pairs: { a: string; b: string; score: number }[];
  gate: number;
}

export function roundPath(contextRoot: string, runId: string, round: number): string {
  return `${runDir(contextRoot, runId)}/rounds/r${round}.json`;
}

export function writeRoundRecord(contextRoot: string, runId: string, rec: RoundRecord): void {
  writeJsonAtomic(roundPath(contextRoot, runId, rec.round), rec);
}

export function juryPath(contextRoot: string, runId: string): string {
  return `${runDir(contextRoot, runId)}/jury.json`;
}

export function juryPhase(opts: PhaseOptions = {}): Phase<PhaseCtx> {
  return {
    name: 'jury',
    async run(run, ctx) {
      const { design, deps } = ctx;
      run = updateRun(deps.contextRoot, run.id, (r) => (r.state === 'presenting' ? addMoment({ ...r, state: 'judging' }, 'jüri değerlendiriyor', new Date(deps.now())) : null));
      if (run.state !== 'judging') return run;
      const texts: Record<string, string> = {};
      for (const t of design.teams) texts[t.id] = juryText(readPresentation(run.id, t.id, design.rounds, deps.wsHome));
      const installed = { codex: (opts.codexInstalled ?? (() => !!findCodexBin()))() };
      const result = await runJury(design, texts, opts.modelCall ?? realModelCall, installed);
      writeJsonAtomic(juryPath(deps.contextRoot, run.id), { ...result, at: new Date(deps.now()).toISOString() });
      if (result.undecided) return moment(ctx, run, 'jüri karar veremedi (hiçbir yargıç cevap vermedi); seçim senin');
      const first = design.teams.find((t) => t.id === result.ranking[0]);
      return moment(ctx, run, `jüri önerisi: ${first?.name ?? '—'}${result.sameVendor ? ' (aynı firma)' : ''}; seçim senin`);
    },
  };
}

export function allPhases(opts: PhaseOptions = {}): Phase<PhaseCtx>[] {
  return [roundsPhase(opts), presentationPhase(), juryPhase(opts)];
}
