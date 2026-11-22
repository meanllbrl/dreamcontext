#!/usr/bin/env node
// Tokens and list-price dollars of one run, read from the Claude Code transcripts of every session
// the run opened (main sessions + their sub-agents), deduplicated by API message id.
//   node bench/eco/measure.mjs <runDir> <sid,sid,...>   -> one JSON line
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Anthropic list prices, $ per million tokens (claude-api skill table, cached 2026-11-03).
// Cache write: 5-minute TTL = 1.25x input, 1-hour TTL = 2x input. Cache read as listed.
export const PRICES = {
  opus: { in: 4, out: 20, cr: 0.2 },
  sonnet: { in: 2, out: 10, cr: 0.1 },
  haiku: { in: 0.1, out: 0.5, cr: 0.01 },
};
export const family = (model) => (/opus/.test(model) ? 'opus' : /sonnet/.test(model) ? 'sonnet' : /haiku/.test(model) ? 'haiku' : 'other');

const CONFIG = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

export function measureRun(runDir, sids) {
  const dirs = [runDir, `/private${runDir}`].map((p) => join(CONFIG, 'projects', mangle(p))).filter(existsSync);
  const files = [];
  for (const d of dirs) {
    for (const sid of sids) {
      if (existsSync(join(d, `${sid}.jsonl`))) files.push({ f: join(d, `${sid}.jsonl`), kind: 'main' });
      const sub = join(d, sid, 'subagents');
      if (existsSync(sub)) for (const n of readdirSync(sub)) if (n.endsWith('.jsonl')) {
        const meta = join(sub, n.replace(/\.jsonl$/, '.meta.json'));
        const type = existsSync(meta) ? JSON.parse(readFileSync(meta, 'utf-8')).agentType ?? '?' : '?';
        files.push({ f: join(sub, n), kind: 'sub', type });
      }
    }
  }
  const seen = new Set();
  const byModel = {};
  const subagents = [];
  let peakContext = 0;
  for (const { f, kind, type } of files) {
    const subModels = new Set();
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'assistant') continue;
      const m = d.message || {};
      if (!m.usage || !m.id || seen.has(m.id) || m.model === '<synthetic>') continue;
      seen.add(m.id);
      const u = m.usage;
      const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const cw5m = (u.cache_creation_input_tokens ?? 0) - cw1h;
      const b = (byModel[m.model] ||= { in: 0, out: 0, cw5m: 0, cw1h: 0, cr: 0, calls: 0 });
      b.in += u.input_tokens ?? 0; b.out += u.output_tokens ?? 0; b.cw5m += cw5m; b.cw1h += cw1h; b.cr += u.cache_read_input_tokens ?? 0; b.calls++;
      // The advisor tool's own model call rides as an `advisor_message` iteration and is NOT in the
      // top-level usage: bill it to its own model.
      for (const it of u.iterations || []) {
        if (it.type !== 'advisor_message') continue;
        const a = (byModel[it.model || 'claude-opus'] ||= { in: 0, out: 0, cw5m: 0, cw1h: 0, cr: 0, calls: 0 });
        const a1h = it.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        a.in += it.input_tokens ?? 0; a.out += it.output_tokens ?? 0; a.cw5m += (it.cache_creation_input_tokens ?? 0) - a1h; a.cw1h += a1h; a.cr += it.cache_read_input_tokens ?? 0; a.calls++;
        subModels.add(it.model || 'claude-opus');
      }
      if (kind === 'main') peakContext = Math.max(peakContext, (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0));
      subModels.add(m.model);
    }
    if (kind === 'sub') subagents.push({ type, models: [...subModels] });
  }
  let usd = 0, tokens = 0;
  const usdByFamily = {};
  for (const [model, b] of Object.entries(byModel)) {
    const p = PRICES[family(model)] || PRICES.opus;
    const cost = (b.in * p.in + b.cw5m * p.in * 1.25 + b.cw1h * p.in * 2 + b.cr * p.cr + b.out * p.out) / 1e6;
    b.usd = cost;
    usd += cost;
    usdByFamily[family(model)] = (usdByFamily[family(model)] ?? 0) + cost;
    tokens += b.in + b.out + b.cw5m + b.cw1h + b.cr;
  }
  return { files: files.length, byModel, usd, usdByFamily, tokens, peakContext, subagents };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [runDir, sids] = process.argv.slice(2);
  console.log(JSON.stringify(measureRun(runDir, sids.split(','))));
}
