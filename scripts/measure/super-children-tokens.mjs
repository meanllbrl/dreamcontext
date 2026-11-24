#!/usr/bin/env node
// Super children: tokens, Eco nudges, handoffs, follow-up work on big contexts, models.
// Plan super-cocuk-tasarruf D7: Doc re-runs this every two days (before / after). Read-only.
//
// usage: node scripts/measure/super-children-tokens.mjs \
//   --super <state/.super-agent.json> [--super <member record> ...] \
//   [--handoff-log <state/.handoff-log.jsonl> ...] [--projects ~/.claude/projects] \
//   [--days 14] [--ladder 250000] [--json <out.json>]
//
// A child is a session the Super record names (`children` or `formerChildren`); a rotated
// successor is joined through the handoff log (`fromSession` -> `toSession`, transitively), so
// one child's later conversations count as that child's too.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRICE = { opus: [4, 20, 8, 0.4], sonnet: [2, 10, 4, 0.2], haiku: [0.1, 0.5, 0.2, 0.01], fable: [10, 50, 20, 1] };
export const family = (m) => (/fable/i.test(m) ? 'fable' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : /opus/i.test(m) ? 'opus' : 'other');
const dollars = (f, u) => { const p = PRICE[f] || PRICE.opus; return (u.in * p[0] + u.out * p[1] + u.cw * p[2] + u.cr * p[3]) / 1e6; };

function jsonl(path) {
  const out = [];
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* torn */ } }
  return out;
}

/** Child ids from Super records, plus their successors through handoff lines (transitive). */
export function childSessions(superRecords, handoffLines) {
  const kids = new Map(); // sid -> { mode, model, origin }
  for (const sup of superRecords) {
    for (const [k, c] of Object.entries(sup?.children ?? {})) kids.set(c?.sessionId || k, { mode: c?.mode ?? null, model: c?.model ?? null, origin: k });
    for (const f of sup?.formerChildren ?? []) if (typeof f === 'string' && !kids.has(f)) kids.set(f, { mode: null, model: null, origin: f });
  }
  let grew = true;
  let successors = 0;
  while (grew) {
    grew = false;
    for (const l of handoffLines) {
      if (!l?.fromSession || !l?.toSession || !kids.has(l.fromSession) || kids.has(l.toSession)) continue;
      kids.set(l.toSession, { ...kids.get(l.fromSession), successor: true });
      successors++;
      grew = true;
    }
  }
  return { kids, successors };
}

/** One conversation's main chain: peak, nudges, handoffs, follow-up turns started past `ladder`. */
export function scanConversation(records, ladder) {
  const calls = new Map();
  let ctx = 0;
  const nudges = [];
  const handoffs = [];
  let followUpsAbove = 0;
  let turnSeen = false;
  let model = null;
  for (const r of records) {
    if (r.isSidechain) continue;
    if (r.type === 'assistant' && r.message?.usage) {
      const u = r.message.usage;
      const c = { in: u.input_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0, out: u.output_tokens || 0, model: r.message.model || '?' };
      ctx = c.in + c.cr + c.cw;
      c.ctx = ctx;
      calls.set(r.message.id || r.uuid || calls.size, c);
      if (!model && c.model !== '<synthetic>') model = c.model;
      for (const b of r.message.content || []) {
        if (b?.type === 'tool_use' && b.name === 'Bash' && /\b(tasks|super) handoff\b/.test(String(b.input?.command || ''))) handoffs.push(ctx);
      }
    }
    const s = r.type === 'user' || r.type === 'attachment' ? JSON.stringify(r) : '';
    if (s.includes('[context handoff')) nudges.push(ctx);
    // A follow-up: a typed user turn (not a tool result) after the first, started past the ladder.
    if (r.type === 'user' && !r.isMeta) {
      const content = r.message?.content;
      const typed = typeof content === 'string' || (Array.isArray(content) && content.some((b) => b?.type === 'text'));
      if (typed) {
        if (turnSeen && ctx >= ladder) followUpsAbove++;
        turnSeen = true;
      }
    }
  }
  const list = [...calls.values()];
  const tot = list.reduce((a, c) => { const f = family(c.model); a.in += c.in; a.cr += c.cr; a.cw += c.cw; a.out += c.out; a.usd += dollars(f, c); return a; }, { in: 0, cr: 0, cw: 0, out: 0, usd: 0 });
  return { peak: list.reduce((m, c) => Math.max(m, c.ctx), 0), nudges, handoffs, followUpsAbove, model, calls: list.length, ...tot };
}

function subagents(sessionDir) {
  const dir = join(sessionDir, 'subagents');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const n of readdirSync(dir)) {
    if (!n.endsWith('.jsonl')) continue;
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(dir, n.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* none */ }
    const first = jsonl(join(dir, n)).find((r) => r.type === 'assistant' && r.message?.model);
    out.push({ type: meta.agentType || '?', asked: meta.model || null, family: family(first?.message?.model || '') });
  }
  return out;
}

const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

/** The diagnosis table, from the records, the handoff lines and a Claude projects folder. */
export function measure({ superRecords, handoffLines, projectsDir, since = 0, ladder = 250_000 }) {
  const { kids, successors } = childSessions(superRecords, handoffLines);
  const rows = [];
  let dirs = [];
  try { dirs = readdirSync(projectsDir); } catch { /* none */ }
  for (const d of dirs) {
    const dir = join(projectsDir, d);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const sid = n.slice(0, -6);
      const kid = kids.get(sid);
      if (!kid) continue;
      const p = join(dir, n);
      try { if (statSync(p).mtimeMs < since) continue; } catch { continue; }
      const c = scanConversation(jsonl(p), ladder);
      if (!c.calls) continue;
      rows.push({ sid, successor: !!kid.successor, mode: kid.mode, askedModel: kid.model, ...c, subs: subagents(join(dir, sid)) });
    }
  }
  const nudged = rows.filter((r) => r.nudges.length);
  const handed = rows.filter((r) => r.handoffs.length);
  const byModel = {};
  for (const r of rows) { const k = `${r.mode ?? '?'}/${family(r.model || '')}`; byModel[k] = byModel[k] ?? { n: 0, usd: [] }; byModel[k].n++; byModel[k].usd.push(r.usd); }
  const subs = rows.flatMap((r) => r.subs);
  return {
    children: rows.length,
    successorsJoined: successors,
    successorConversations: rows.filter((r) => r.successor).length,
    peak: { p50: q(rows.map((r) => r.peak), 0.5), p90: q(rows.map((r) => r.peak), 0.9) },
    pastLadder: rows.filter((r) => r.peak >= ladder).length,
    nudged: nudged.length,
    firstNudge: { p50: q(nudged.map((r) => r.nudges[0]), 0.5) },
    handedOff: handed.length,
    handoffAt: { p50: q(handed.map((r) => r.handoffs[0]), 0.5), p90: q(handed.map((r) => r.handoffs[0]), 0.9) },
    followUpsAboveLadder: rows.reduce((a, r) => a + r.followUpsAbove, 0),
    childrenWithFollowUpsAbove: rows.filter((r) => r.followUpsAbove > 0).length,
    byModeModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, { n: v.n, usdP50: Number((q(v.usd, 0.5) ?? 0).toFixed(2)) }])),
    subagents: { total: subs.length, fable: subs.filter((s) => s.family === 'fable').length, noModelAsked: subs.filter((s) => !s.asked || s.asked === 'inherit').length },
    usd: Number(rows.reduce((a, r) => a + r.usd, 0).toFixed(2)),
  };
}

function main(argv) {
  const opts = { super: [], log: [], projects: join(homedir(), '.claude', 'projects'), days: 14, ladder: 250_000, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--super') { opts.super.push(v); i++; } else if (a === '--handoff-log') { opts.log.push(v); i++; } else if (a === '--projects') { opts.projects = v; i++; } else if (a === '--days') { opts.days = Number(v); i++; } else if (a === '--ladder') { opts.ladder = Number(v); i++; } else if (a === '--json') { opts.json = v; i++; } else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  if (!opts.super.length) { console.error('give at least one --super <record>'); process.exit(2); }
  const superRecords = opts.super.map((p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }).filter(Boolean);
  const handoffLines = opts.log.flatMap((p) => jsonl(p));
  const out = measure({ superRecords, handoffLines, projectsDir: opts.projects, since: Date.now() - opts.days * 86_400_000, ladder: opts.ladder });
  if (opts.json) writeFileSync(opts.json, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
