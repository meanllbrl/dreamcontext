#!/usr/bin/env node
// Eco from this Mac's real history (owner, 22 Nov: "eco için koşma, geçmişte sessionlar var orada anla").
// Every handoff the app took is a line in <vault>/_dream_context/state/.handoff-log.jsonl with the old
// session, its context at the handoff and the fresh session that continued. For each one we read the
// fresh session's transcript and replay its API calls as if the old session had gone on instead:
// each call would have carried (handoff context - fresh session's first context) more tokens, capped
// at the 1M window. Prints aggregates only (no titles, no content).
//   node bench/eco/eco-history.mjs <vault-root>... [--days 30]
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PRICES, family } from './measure.mjs';

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 30;
const roots = [...new Set(args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--days').map((p) => realpathSync(p)))];
const since = Date.now() - days * 864e5;
const WINDOW = 1_000_000;

// Every Claude account dir on this Mac (dreamcontext keeps one per account).
const accountDirs = [join(homedir(), '.claude')];
const acc = join(homedir(), '.dreamcontext', 'claude-accounts');
if (existsSync(acc)) for (const a of readdirSync(acc)) accountDirs.push(join(acc, a));
const index = new Map();
for (const a of accountDirs) {
  const p = join(a, 'projects');
  if (!existsSync(p)) continue;
  for (const d of readdirSync(p)) {
    let names; try { names = readdirSync(join(p, d)); } catch { continue; }
    for (const n of names) if (n.endsWith('.jsonl') && !index.has(n.slice(0, -6))) index.set(n.slice(0, -6), join(p, d, n));
  }
}

function calls(file) {
  const seen = new Set(); const out = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant' || d.isSidechain) continue;
    const m = d.message || {}; const u = m.usage;
    if (!u || !m.id || seen.has(m.id) || m.model === '<synthetic>') continue;
    seen.add(m.id);
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0; const cw = u.cache_creation_input_tokens ?? 0; const p = PRICES[family(m.model)] || PRICES.opus;
    const usd = ((u.input_tokens ?? 0) * p.in + (cw - cw1h) * p.in * 1.25 + cw1h * p.in * 2 + (u.cache_read_input_tokens ?? 0) * p.cr + (u.output_tokens ?? 0) * p.out) / 1e6;
    out.push({ model: m.model, ctx: (u.input_tokens ?? 0) + cw + (u.cache_read_input_tokens ?? 0), cw, usd });
  }
  return out;
}

const rows = [];
let skipped = 0, dup = 0;
const seenHandoff = new Set();
for (const root of roots) {
  const f = join(root, '_dream_context', 'state', '.handoff-log.jsonl');
  if (!existsSync(f)) continue;
  for (const l of readFileSync(f, 'utf-8').split('\n').filter(Boolean)) {
    let h; try { h = JSON.parse(l); } catch { continue; }
    if (Date.parse(h.at) < since || !h.toSession || !h.contextTokens) { skipped++; continue; }
    const hk = `${h.fromSession}>${h.toSession}`;
    if (seenHandoff.has(hk)) { dup++; continue; }
    seenHandoff.add(hk);
    const file = index.get(h.toSession);
    if (!file) { skipped++; continue; }
    const c = calls(file);
    if (c.length < 2) { skipped++; continue; }
    const base = c[0].ctx;
    const extra = Math.max(0, h.contextTokens - base);
    let avoidedTok = 0, avoidedUsd = 0, actualTok = 0, actualUsd = 0;
    for (const x of c) {
      const cf = Math.min(WINDOW, x.ctx + extra);
      const add = Math.max(0, cf - x.ctx);
      avoidedTok += add; actualTok += x.ctx; actualUsd += x.usd;
      avoidedUsd += add * (PRICES[family(x.model)] || PRICES.opus).cr / 1e6;
    }
    // What the switch itself cost: the fresh session writing its base context into the cache (1h write,
    // 2x input) instead of reading it. An upper bound: the old session would have had to re-cache too
    // after a 5-minute or 1-hour gap.
    const p = PRICES[family(c[0].model)] || PRICES.opus;
    const switchUsd = base * p.in * 2 / 1e6;
    rows.push({ vault: root.split('/').pop(), handoffCtx: h.contextTokens, freshCtx: base, calls: c.length, avoidedTok, actualTok, avoidedUsd, actualUsd, switchUsd, model: family(c[0].model) });
  }
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null; };
const sum = (a) => a.reduce((s, x) => s + x, 0);
const n = rows.length;
const out = {
  days, vaults: [...new Set(rows.map((r) => r.vault))].length, handoffs: n, skipped, duplicates: dup,
  medianHandoffCtx: q(rows.map((r) => r.handoffCtx), 0.5), medianFreshCtx: q(rows.map((r) => r.freshCtx), 0.5),
  medianDrop: q(rows.map((r) => 1 - r.freshCtx / r.handoffCtx), 0.5),
  p25Drop: q(rows.map((r) => 1 - r.freshCtx / r.handoffCtx), 0.25), p75Drop: q(rows.map((r) => 1 - r.freshCtx / r.handoffCtx), 0.75),
  freshCalls: sum(rows.map((r) => r.calls)),
  inputTokensActual: sum(rows.map((r) => r.actualTok)), inputTokensAvoided: sum(rows.map((r) => r.avoidedTok)),
  shareOfInputAvoided: sum(rows.map((r) => r.avoidedTok)) / (sum(rows.map((r) => r.avoidedTok)) + sum(rows.map((r) => r.actualTok))),
  avoidedUsd: sum(rows.map((r) => r.avoidedUsd)), actualUsd: sum(rows.map((r) => r.actualUsd)), switchUsd: sum(rows.map((r) => r.switchUsd)),
  byModel: Object.fromEntries(['opus', 'sonnet', 'other'].map((m) => [m, rows.filter((r) => r.model === m).length])),
  hist: rows.map((r) => [r.handoffCtx, r.freshCtx]),
  perHandoff: rows.map((r) => [r.actualUsd, r.avoidedUsd - r.switchUsd]),
};
out.netUsd = out.avoidedUsd - out.switchUsd;
// Cost of the post-handoff work with Eco (actual) vs without it (actual + avoided - switch cost).
out.costShareWithEco = out.actualUsd / (out.actualUsd + out.netUsd);
console.log(JSON.stringify(out));
