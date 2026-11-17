/**
 * Hackathon routes (plan C5, C6). Reads are open to the dashboard; the four owner writes
 * (start, resume, pick, pr) require the app's own page with its owner key and refuse any request
 * carrying the window token (that is the chat agent's identity, never the owner's). They are also
 * in the listener-wide owner-write backstop (middleware `isOwnerCardWrite`). Stop is open to any
 * local caller: the safe direction.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { redactSecrets } from '../../lib/telegram/format.js';
import { WINDOW_TOKEN_HEADER } from '../../lib/window-control.js';
import { resolveLinkedRepos } from '../../lib/linked-repos.js';
import { checkPr, fetchWinner, keepAndClean, openPr, writeResult } from '../../lib/hackathon/apply.js';
import { launchConductor, ownerStart, realReadUsage, stopRun } from '../../lib/hackathon/conductor.js';
import { previewText, readDecisions, readMedia } from '../../lib/hackathon/crossing.js';
import { wholeDiskTeams } from '../../lib/hackathon/designer.js';
import { runFrames } from '../../lib/hackathon/frames.js';
import { judgeLimit, readingLabel } from '../../lib/hackathon/limit.js';
import { juryPath } from '../../lib/hackathon/phases.js';
import { readPresentation, shotsDir } from '../../lib/hackathon/presentation.js';
import { addMoment, designHash, listRuns, readJson, readRun, resultPath, teamWorkspace, updateRun, RUN_ID_RE, TEAM_ID_RE, type RunRecord } from '../../lib/hackathon/run-store.js';
import { headSha } from '../../lib/hackathon/snapshot.js';
import { MEDIA_MIME } from '../../lib/hackathon/team-files.js';
import { serversOf } from '../../lib/hackathon/team-session.js';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { fromOwnerPage, ownerRefusalMessage } from './assistant.js';

const clip = (s: string, n = 400) => redactSecrets(s.length > n ? `${s.slice(0, n - 1)}…` : s);

function runOf(res: ServerResponse, params: Record<string, string>, ctx: string): RunRecord | null {
  const id = params.run ?? '';
  if (!RUN_ID_RE.test(id)) { sendError(res, 400, 'bad_run', 'Not a hackathon run id.'); return null; }
  const r = readRun(ctx, id);
  if (!r) { sendError(res, 404, 'no_run', 'No such hackathon run.'); return null; }
  return r;
}

function teamOf(res: ServerResponse, r: RunRecord, params: Record<string, string>): string | null {
  const t = params.team ?? '';
  if (!TEAM_ID_RE.test(t) || !r.design.teams.some((x) => x.id === t)) { sendError(res, 404, 'no_team', 'No such team.'); return null; }
  return t;
}

/** The owner-write gate: the app's own page with its key, and never the window token. */
export function ownerWriteRefusal(req: IncomingMessage): string | null {
  if (req.headers[WINDOW_TOKEN_HEADER]) return 'Hackathon kararlarını yalnız sahip verir: ajanın penceresi başlatamaz.';
  if (!fromOwnerPage(req)) return ownerRefusalMessage(req, 'Hackathon kararlarını yalnız uygulamanın kendi sayfası verir.');
  return null;
}

function gate(req: IncomingMessage, res: ServerResponse): boolean {
  const why = ownerWriteRefusal(req);
  if (why) { sendError(res, 403, 'owner_page_only', why); return false; }
  return true;
}

function strip(r: RunRecord) {
  const v = judgeLimit({ limit: r.design.limit, start: r.usageAtStart, now: r.state === 'running' ? realReadUsage() : null, guardOverride: r.guardOverride });
  return {
    endsAt: r.design.limit.endsAt,
    reading: readingLabel(v, r.design.limit.weeklyShareCeiling),
    used: v.used,
    ceiling: r.design.limit.weeklyShareCeiling,
    reason: r.paused ?? (r.state === 'running' ? v.reason : null),
    moments: (r.moments ?? []).slice(-8).map((m) => ({ at: m.at, text: clip(m.text, 200) })),
  };
}

/** GET /api/hackathon — every run, newest first. */
export async function handleHackathonList(_req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, ctx: string): Promise<void> {
  sendJson(res, 200, { runs: listRuns(ctx).map((r) => ({ id: r.id, state: r.state, problem: clip(r.problem, 200), teams: r.design.teams.length, createdAt: r.createdAt, kind: r.design.kind })) });
}

/** GET /api/hackathon/:run — the run with its strip. */
export async function handleHackathonGet(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  const r = runOf(res, params, ctx);
  if (!r) return;
  sendJson(res, 200, {
    id: r.id, state: r.state, phase: r.phase ?? null, round: r.round ?? null, problem: clip(r.problem, 500), kind: r.design.kind,
    rounds: r.design.rounds, roundMinutes: r.design.roundMinutes, controlTeam: r.design.controlTeam,
    teams: r.design.teams.map((t) => ({ id: t.id, name: clip(t.name, 40), persona: clip(t.persona, 300), tool: t.tool, model: t.model, inner: t.inner })),
    paused: r.paused ?? null, stopReason: r.stopReason ?? null, strip: strip(r),
  });
}

/** GET /api/hackathon/:run/design — the start card's facts, never the agent's labels. */
export async function handleHackathonDesign(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  const r = runOf(res, params, ctx);
  if (!r) return;
  const d = r.design;
  const disk = wholeDiskTeams(d);
  sendJson(res, 200, {
    run: r.id, state: r.state, designHash: designHash(r), problem: clip(d.problem, 500), kind: d.kind,
    teams: d.teams.map((t) => ({ id: t.id, name: clip(t.name, 40), tool: t.tool, model: t.model || '(hesabın varsayılanı)', inner: t.inner, readIsolated: t.tool === 'claude', wholeDisk: disk.includes(t.id), control: t.id === d.controlTeam })),
    mcpTools: d.mcpTools, mcpServers: serversOf(d.mcpTools),
    rounds: d.rounds, roundMinutes: d.roundMinutes, endsAt: d.limit.endsAt,
    limit: { weeklyShareCeiling: d.limit.weeklyShareCeiling, sessionGuard: d.limit.sessionGuard },
    target: d.target,
    experiment: d.experiment,
  });
}

/** POST /api/hackathon/:run/start — the owner's Başlat, bound to the hash the card showed. */
export async function handleHackathonStart(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  if (!gate(req, res)) return;
  const r = runOf(res, params, ctx);
  if (!r) return;
  const b = (await parseJsonBody(req)) ?? {};
  const hash = typeof b.designHash === 'string' ? b.designHash : '';
  const out = ownerStart(ctx, r.id, hash, { baseSha: headSha, usage: realReadUsage });
  if (!out.ok) { sendError(res, out.status, out.status === 409 ? 'design_changed' : 'start_refused', out.reason); return; }
  const cli = process.env.DREAMCONTEXT_CLI || process.argv[1] || '';
  const pid = launchConductor({ file: process.execPath, args: [cli] }, r.id, dirname(ctx));
  sendJson(res, 200, { ok: true, state: out.run.state, pid });
}

/** POST /api/hackathon/:run/stop — any local caller may stop a run. */
export async function handleHackathonStop(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  const r = runOf(res, params, ctx);
  if (!r) return;
  const next = stopRun(ctx, r.id, 'sahip durdurdu');
  if (r.state !== 'awaiting-owner' && r.state !== 'draft' && r.state !== 'stopped' && r.state !== 'picked') writeResult(ctx, next, next.design, null, { stoppedReason: 'sahip durdurdu' });
  if (r.conductorPid) try { process.kill(r.conductorPid, 'SIGTERM'); } catch { /* gone */ }
  sendJson(res, 200, { ok: true, state: next.state });
}

/** POST /api/hackathon/:run/resume — Devam: the session guard is off for this run. */
export async function handleHackathonResume(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  if (!gate(req, res)) return;
  const r = runOf(res, params, ctx);
  if (!r) return;
  if (r.state !== 'running') { sendError(res, 409, 'not_running', 'Koşu sürmüyor.'); return; }
  const next = updateRun(ctx, r.id, (x) => addMoment({ ...x, guardOverride: true, paused: null }, 'sahip Devam dedi'));
  sendJson(res, 200, { ok: true, state: next.state });
}

/** GET /api/hackathon/:run/frames — tables and their screens, from the transcripts. */
export async function handleHackathonFrames(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  const r = runOf(res, params, ctx);
  if (!r) return;
  const frames = runFrames(ctx, r.id, r.design, (t) => teamWorkspace(r.id, t).repo);
  sendJson(res, 200, { run: r.id, state: r.state, round: r.round ?? null, frames, strip: strip(r) });
}

/** GET /api/hackathon/:run/teams/:team/files — validated team files, edits and previews. */
export async function handleHackathonFiles(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  const r = runOf(res, params, ctx);
  if (!r) return;
  const team = teamOf(res, r, params);
  if (!team) return;
  const ws = teamWorkspace(r.id, team);
  const frame = runFrames(ctx, r.id, r.design, (t) => teamWorkspace(r.id, t).repo).find((f) => f.team === team);
  const want = new URL(req.url ?? '/', 'http://x').searchParams.get('preview');
  let preview: { path: string; lines: string[]; truncated: boolean } | { path: string; reason: string } | null = null;
  if (want) {
    const p = previewText(ws.repo, want);
    preview = p.ok ? { path: want, lines: p.lines.map((l) => clip(l, 240)), truncated: p.truncated } : { path: want, reason: p.reason };
  }
  const d = readDecisions(ws.out);
  sendJson(res, 200, {
    team, edited: frame?.edited ?? [], reads: frame?.reads ?? 0,
    decisions: d.lines.slice(-40).map((l) => ({ ...l, text: clip(l.text, 280) })), dropped: d.dropped.slice(-5),
    preview,
  });
}

/** GET /api/hackathon/:run/teams/:team/presentation — the validated stage. */
export async function handleHackathonPresentation(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  const r = runOf(res, params, ctx);
  if (!r) return;
  const team = teamOf(res, r, params);
  if (!team) return;
  const p = readPresentation(r.id, team, r.design.rounds);
  sendJson(res, 200, JSON.parse(redactSecrets(JSON.stringify(p))));
}

/** GET /api/hackathon/:run/teams/:team/media?m=shot:<name>|out:<path> — bytes checked by magic. */
export async function handleHackathonMedia(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  const r = runOf(res, params, ctx);
  if (!r) return;
  const team = teamOf(res, r, params);
  if (!team) return;
  const m = new URL(req.url ?? '/', 'http://x').searchParams.get('m') ?? '';
  let got: ReturnType<typeof readMedia>;
  if (m.startsWith('shot:')) {
    const name = m.slice(5);
    if (!/^[A-Za-z0-9._-]{1,120}\.png$/.test(name)) { sendError(res, 400, 'bad_media', 'Not a media name.'); return; }
    got = readMedia(shotsDir(r.id, team), name);
  } else if (m.startsWith('out:')) {
    got = readMedia(teamWorkspace(r.id, team).out, m.slice(4));
  } else { sendError(res, 400, 'bad_media', 'Not a media name.'); return; }
  if (!got.ok) { sendError(res, 404, 'no_media', got.reason); return; }
  res.writeHead(200, { 'Content-Type': MEDIA_MIME[got.type], 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'no-store', 'Content-Length': got.bytes.length });
  res.end(got.bytes);
}

/** GET /api/hackathon/:run/result — jury and result. */
export async function handleHackathonResult(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  const r = runOf(res, params, ctx);
  if (!r) return;
  const jury = readJson<Record<string, unknown>>(juryPath(ctx, r.id));
  const result = readJson<Record<string, unknown>>(resultPath(ctx, r.id));
  sendJson(res, 200, JSON.parse(redactSecrets(JSON.stringify({ run: r.id, state: r.state, jury, result }))));
}

function sources(ctx: string) {
  const root = dirname(ctx);
  let linked: string[] = [];
  try { linked = resolveLinkedRepos(root).map((x) => x.path).filter((p): p is string => !!p); } catch { /* none */ }
  return { contextRoot: ctx, repoRoots: [root, ...linked] };
}

/** POST /api/hackathon/:run/pick — the owner's pick: result written, work kept, winner fetched. */
export async function handleHackathonPick(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  if (!gate(req, res)) return;
  const r = runOf(res, params, ctx);
  if (!r) return;
  if (r.state !== 'judging') { sendError(res, 409, 'not_judging', 'Seçim jüriden sonra yapılır.'); return; }
  const b = (await parseJsonBody(req)) ?? {};
  const team = typeof b.team === 'string' && r.design.teams.some((t) => t.id === b.team) ? b.team : null;
  if (!team) { sendError(res, 400, 'bad_team', 'Hangi ekip?'); return; }
  const next = updateRun(ctx, r.id, (x) => (x.state === 'judging' ? addMoment({ ...x, state: 'picked' }, `sahip seçti: ${x.design.teams.find((t) => t.id === team)?.name}`) : null));
  if (next.state !== 'picked') { sendError(res, 409, 'not_judging', 'Seçim jüriden sonra yapılır.'); return; }
  writeResult(ctx, next, next.design, team);
  let branch: string | null = null;
  let fetchError: string | null = null;
  try { branch = fetchWinner(next, next.design, team); } catch (e) { fetchError = clip((e as Error).message.split('\n')[0] ?? '', 200); }
  const kept = keepAndClean(ctx, next, next.design);
  let check = null;
  if (branch) try { check = checkPr(next, next.design, team, sources(ctx)); } catch { /* shown as unavailable */ }
  sendJson(res, 200, { ok: true, branch, fetchError, kept, check: check && { branch: check.branch, secretHits: check.secretHits, elsewhere: check.elsewhere.map((f) => ({ path: f.path, hunks: clip(f.hunks, 6000) })), confirmHash: check.confirmHash, diffstat: clip(check.diffstat, 4000), codexWinner: check.codexWinner } });
}

/** POST /api/hackathon/:run/pr — push and open the PR, only on the owner's word. */
export async function handleHackathonPr(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string): Promise<void> {
  if (!gate(req, res)) return;
  const r = runOf(res, params, ctx);
  if (!r) return;
  if (r.state !== 'picked') { sendError(res, 409, 'not_picked', 'Önce bir ekip seç.'); return; }
  const result = readJson<{ pick: string | null }>(resultPath(ctx, r.id));
  if (!result?.pick) { sendError(res, 409, 'not_picked', 'Önce bir ekip seç.'); return; }
  const b = (await parseJsonBody(req)) ?? {};
  const confirm = typeof b.confirmHash === 'string' ? b.confirmHash : null;
  const out = openPr(r, r.design, result.pick, confirm, sources(ctx));
  if (!out.ok) { sendJson(res, 409, { error: 'pr_refused', message: clip(out.reason, 600), confirmHash: out.check?.confirmHash ?? null }); return; }
  updateRun(ctx, r.id, (x) => addMoment(x, `PR açıldı: ${out.url}`));
  sendJson(res, 200, { ok: true, url: out.url });
}

/** Read for tests: the hackathon route patterns, as registered. */
export const HACKATHON_ROUTES = {
  get: ['/api/hackathon', '/api/hackathon/:run', '/api/hackathon/:run/design', '/api/hackathon/:run/frames', '/api/hackathon/:run/result',
    '/api/hackathon/:run/teams/:team/files', '/api/hackathon/:run/teams/:team/presentation', '/api/hackathon/:run/teams/:team/media'],
  post: ['/api/hackathon/:run/start', '/api/hackathon/:run/stop', '/api/hackathon/:run/resume', '/api/hackathon/:run/pick', '/api/hackathon/:run/pr'],
} as const;
