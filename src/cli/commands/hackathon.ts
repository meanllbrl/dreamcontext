import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureContextRoot } from '../../lib/context-path.js';
import { findCodexBin } from '../../lib/codex-bin.js';
import { resolveLinkedRepos } from '../../lib/linked-repos.js';
import { codexStrictArgs } from '../../lib/t3-bridge/launch.js';
import { setOutcome, writeResult } from '../../lib/hackathon/apply.js';
import {
  conduct, codexListedServers, readState, realReadUsage, realStartTurn, releaseConductorLock, stopRun, takeConductorLock,
} from '../../lib/hackathon/conductor.js';
import { KINDS, proposeDesign, validateDesign, wholeDiskTeams, type DesignEnv, type HackathonKind } from '../../lib/hackathon/designer.js';
import { judgeLimit, readingLabel } from '../../lib/hackathon/limit.js';
import { allPhases } from '../../lib/hackathon/phases.js';
import { createRun, designHash, listRuns, newRunId, readRun, runWorkspace, updateRun, type RunRecord } from '../../lib/hackathon/run-store.js';
import { initSnapshots, prepareWorkspace, takeSnapshot } from '../../lib/hackathon/snapshot.js';
import { computeStats, formatStats, readResults } from '../../lib/hackathon/stats.js';

/** Codex is usable for a team: installed, and every server it lists can be switched off. */
export function codexEnv(cwd: string): DesignEnv {
  if (!findCodexBin()) return { codexUsable: false, codexWhy: 'Codex kurulu değil' };
  const listed = codexListedServers(cwd, process.env);
  if (codexStrictArgs(listed, []) == null) return { codexUsable: false, codexWhy: 'Codex MCP sunucuları kapatılamıyor' };
  return { codexUsable: true };
}

function projectRoot(ctx: string): string {
  return dirname(ctx);
}

function linkedPaths(root: string): string[] {
  try { return resolveLinkedRepos(root).map((r) => r.path).filter((p): p is string => !!p); } catch { return []; }
}

function mustRun(ctx: string, id: string): RunRecord {
  const r = readRun(ctx, id);
  if (!r) {
    process.stderr.write(`Hackathon koşusu yok: ${id}\n`);
    process.exit(1);
  }
  return r;
}

function statusLine(r: RunRecord): string {
  const v = judgeLimit({ limit: r.design.limit, start: r.usageAtStart, now: realReadUsage(), guardOverride: r.guardOverride });
  return [
    `${r.id}  ${r.state}${r.phase ? ` · ${r.phase}` : ''}${r.round ? ` · tur ${r.round}/${r.design.rounds}` : ''}`,
    `  Sorun: ${r.design.problem}`,
    `  Ekipler: ${r.design.teams.map((t) => `${t.name} (${t.tool}${t.model ? ` · ${t.model}` : ''}${t.id === r.design.controlTeam ? ' · kontrol' : ''})`).join(', ')}`,
    `  Bitiş: ${new Date(r.design.limit.endsAt).toLocaleString('tr-TR')} · ${readingLabel(v, r.design.limit.weeklyShareCeiling)}`,
    r.paused ? `  Bekliyor: ${r.paused}` : '',
    r.stopReason ? `  Durdu: ${r.stopReason}` : '',
  ].filter(Boolean).join('\n');
}

export function registerHackathonCommand(program: Command): void {
  const hk = program.command('hackathon').description('Hackathon: several teams solve one problem; results side by side on its page');

  hk.command('design')
    .description('Print a stats-backed draft design (no model call): every line with its reason and run count')
    .requiredOption('--problem <text>', 'The problem the teams solve')
    .option('--kind <kind>', `One of ${KINDS.join(', ')}`, 'plan')
    .option('--target <repo>', 'The repo teams clone (default: this project)')
    .option('--json', 'Emit JSON')
    .action((o: { problem: string; kind: string; target?: string; json?: boolean }) => {
      const ctx = ensureContextRoot();
      if (!KINDS.includes(o.kind as HackathonKind)) { process.stderr.write(`--kind ${KINDS.join('|')}\n`); process.exit(1); }
      const target = o.target ?? linkedPaths(projectRoot(ctx))[0] ?? projectRoot(ctx);
      const stats = computeStats(readResults(ctx), o.kind as HackathonKind);
      const p = proposeDesign({ problem: o.problem, kind: o.kind as HackathonKind, target, stats, env: codexEnv(target) });
      if (o.json) { console.log(JSON.stringify(p, null, 2)); return; }
      console.log(`Taslak (${stats.runs} geçmiş koşu):`);
      for (const t of p.design.teams) console.log(`  ${t.name.padEnd(12)} ${t.tool}${t.model ? ` · ${t.model}` : ''} · ${t.inner === 'trio' ? 'Kaptan+Yapıcı+Eleştirmen' : 'tek ajan'}${t.id === p.design.controlTeam ? ' · kontrol (göz atmaz)' : ''}`);
      console.log(`  ${p.design.rounds} tur × ${p.design.roundMinutes} dk, bitiş ${new Date(p.design.limit.endsAt).toLocaleString('tr-TR')}`);
      for (const r of p.reasons) console.log(`  · ${r.field}: ${r.text}`);
      const disk = wholeDiskTeams(p.design);
      if (disk.length) console.log(`  · Codex ekipleri (${disk.join(', ')}) bütün diski okuyabilir; MCP yok.`);
      console.log('Personaları doldur, düzenle; sonra: dreamcontext hackathon start --design <dosya>');
    });

  hk.command('start')
    .description('Create the run from a design file and print the start card; the owner presses Başlat on it')
    .requiredOption('--design <file>', 'Design JSON (from hackathon design --json, edited)')
    .action((o: { design: string }) => {
      const ctx = ensureContextRoot();
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(o.design, 'utf-8')); } catch (e) { process.stderr.write(`Tasarım dosyası okunamadı: ${(e as Error).message}\n`); process.exit(1); }
      const body = (raw && typeof raw === 'object' && 'design' in (raw as object) ? (raw as { design: unknown }).design : raw) as Record<string, unknown>;
      const target = typeof body?.target === 'string' ? body.target : projectRoot(ctx);
      let v;
      try { v = validateDesign(body, codexEnv(target)); } catch (e) { process.stderr.write(`Tasarım geçersiz: ${(e as Error).message}\n`); process.exit(1); }
      delete (v.design as { baseSha?: string }).baseSha;
      const id = newRunId(ctx, v.design.problem);
      const now = new Date().toISOString();
      createRun(ctx, { version: 1, id, problem: v.design.problem, state: 'draft', createdAt: now, design: v.design, moments: [] });
      updateRun(ctx, id, (r) => ({ ...r, state: 'awaiting-owner' }));
      for (const n of v.notes) console.log(`not: ${n}`);
      console.log(`Hackathon ${id} hazır; sahip Başlat'a basınca başlar.`);
      console.log('```dream-view');
      console.log(JSON.stringify({ type: 'hackathon', run: id }));
      console.log('```');
    });

  hk.command('status').description('Where a run is (default: the newest)').argument('[run]').action((id?: string) => {
    const ctx = ensureContextRoot();
    const r = id ? mustRun(ctx, id) : listRuns(ctx)[0];
    if (!r) { console.log('Hackathon yok.'); return; }
    console.log(statusLine(r));
  });

  hk.command('list').description('Every hackathon run, newest first').option('--json').action((o: { json?: boolean }) => {
    const runs = listRuns(ensureContextRoot());
    if (o.json) { console.log(JSON.stringify(runs.map((r) => ({ id: r.id, state: r.state, problem: r.problem, teams: r.design.teams.length })), null, 2)); return; }
    if (!runs.length) { console.log('Hackathon yok.'); return; }
    for (const r of runs) console.log(`${r.id}  ${r.state.padEnd(15)} ${r.design.teams.length} ekip  ${r.problem.slice(0, 60)}`);
  });

  hk.command('show').description('A run in full: design, hash, moments').argument('<run>').option('--json').action((id: string, o: { json?: boolean }) => {
    const r = mustRun(ensureContextRoot(), id);
    if (o.json) { console.log(JSON.stringify({ ...r, designHash: designHash(r) }, null, 2)); return; }
    console.log(statusLine(r));
    console.log(`  Tasarım: ${designHash(r).slice(0, 12)}${r.design.mcpTools.length ? ` · MCP: ${r.design.mcpTools.join(', ')}` : ''}`);
    for (const m of (r.moments ?? []).slice(-12)) console.log(`  ${m.at.slice(11, 16)} ${m.text}`);
  });

  hk.command('stop').description('Stop a run now (any caller may: the safe direction)').argument('<run>').option('--why <text>', 'Reason', 'sahip durdurdu').action((id: string, o: { why: string }) => {
    const ctx = ensureContextRoot();
    const before = mustRun(ctx, id);
    const r = stopRun(ctx, id, o.why);
    if (before.state !== 'awaiting-owner' && before.state !== 'draft') writeResult(ctx, r, r.design, null, { stoppedReason: o.why });
    console.log(`${id}: ${r.state}`);
  });

  hk.command('stats').description('What past hackathons taught, derived from every result.json').option('--kind <kind>').option('--json').action((o: { kind?: string; json?: boolean }) => {
    const s = computeStats(readResults(ensureContextRoot()), o.kind as HackathonKind | undefined);
    console.log(o.json ? JSON.stringify(s, null, 2) : formatStats(s));
  });

  hk.command('outcome').description('Record what became of the winner\'s PR').argument('<run>').requiredOption('--pr <state>', 'merged | closed | none').action((id: string, o: { pr: string }) => {
    if (!['merged', 'closed', 'none'].includes(o.pr)) { process.stderr.write('--pr merged|closed|none\n'); process.exit(1); }
    const r = setOutcome(ensureContextRoot(), id, o.pr as 'merged' | 'closed' | 'none');
    console.log(`${id}: pr ${r.pr}`);
  });

  // The detached conductor (started by the owner route). Hidden: nobody types it.
  hk.command('conduct', { hidden: true }).argument('<run>').action(async (id: string) => {
    const ctx = ensureContextRoot();
    const root = projectRoot(ctx);
    const linked = linkedPaths(root);
    if (!takeConductorLock(id)) { console.error('başka bir koşturucu çalışıyor'); process.exit(0); }
    // SIGTERM (shutdown, a kill): every live team group goes with the conductor, and the run is
    // left for a relaunch (Sürdür), never holding a dead lock or a stale pid.
    let killAll = (): void => {};
    const leave = (): void => { try { updateRun(ctx, id, (r) => (r.conductorPid === process.pid ? { ...r, conductorPid: undefined } : null)); } catch { /* best effort */ } releaseConductorLock(id); };
    const onSignal = (): void => { killAll(); leave(); process.exit(143); };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    try {
      updateRun(ctx, id, (r) => ({ ...r, conductorPid: process.pid }));
      const hookCommand = null;
      const final = await conduct(id, {
        contextRoot: ctx, brainRoot: root, linkedRepos: linked,
        now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
        startTurn: realStartTurn({ brainRoot: root, linkedRepos: linked, env: process.env, hookCommand }),
        readUsage: realReadUsage,
        onAbort: (k) => { killAll = k; },
        prepare: (run, design) => {
          const base = design.baseSha!;
          const out: Record<string, { installPaths: string[]; codexServers?: string[] }> = {};
          for (const t of design.teams) {
            const w = prepareWorkspace(run.id, t.id, design.target, base);
            if (w.note) updateRun(ctx, run.id, (r) => ({ ...r, moments: [...(r.moments ?? []), { at: new Date().toISOString(), text: `${t.name}: ${w.note}` }] }));
            out[t.id] = { installPaths: w.installPaths };
            if (t.tool === 'codex') out[t.id]!.codexServers = (codexListedServers(runWorkspace(run.id) + `/${t.id}/repo`, process.env) ?? []).map((s) => s.name);
          }
          initSnapshots(run.id, design.target, base, design.teams.map((t) => t.id));
          return out;
        },
        snapshot: (run, team, label) => {
          const st = readState(run.id).teams[team];
          const r = takeSnapshot(run.id, team, `${team} ${label}`, { skip: st?.installPaths ?? [] });
          if (!r.ok) throw new Error(r.reason ?? 'kopya alınamadı');
          return { kept: r.kept };
        },
      }, allPhases());
      console.log(`${id}: ${final.state}`);
    } catch (e) {
      stopRun(ctx, id, `koşturucu hatası: ${(e as Error).message.slice(0, 160)}`);
    } finally {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      leave();
    }
  });
}
