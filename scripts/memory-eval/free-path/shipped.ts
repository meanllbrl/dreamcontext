// Re-measure the SHIPPED judged recall (src/lib/recall-judged.ts, the hook's code path) on the same 111
// train turns as the three-setting measurement (super/hafiza-uc-ayar settings.ts, u25p10 + e5 passage + conf
// >= 1). The sealed half is never read. The gold, the turn-time births rule and the scorer come from the
// w1 harness (W1_ROOT), exactly as settings.ts used them; the candidates, passages, prompt, judge call, its
// 30 s deadline and the delivery threshold are this branch's product code.
//
//   npx tsx scripts/memory-eval/free-path/shipped.ts plain [--estimate] [--tier local|cloud-index] [--tag t]
//   npx tsx scripts/memory-eval/free-path/shipped.ts seq [--estimate] [--window 3]
//   npx tsx scripts/memory-eval/free-path/shipped.ts score [--tag t]
//
// plain: every turn on its own (empty context), as measured. seq: the owner turns replayed as sessions from
// the frozen transcripts (up to --window owner turns before each gold turn), the session's delivered set
// carried from turn to turn and reset at every SessionStart the transcript recorded (compact, clear, resume),
// as the hook resets it. On gold turns the judge runs even when the skip rule holds (so what a skip would
// lose is measured); on the other turns the rule is applied as shipped.
//
// "When needed" lines: the measured lines (gold/train.when.jsonl), seeded into a throwaway home's store for
// the files the shipped sleep writer covers (curatedDocs), and read through the shipped lookup.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCorpus, docKey, bm25Search, type CorpusDoc } from '../../../src/lib/recall.js';
import { judgedRecall, type JudgedRecall } from '../../../src/lib/recall-judged.js';
import { JUDGE_TIMEOUT_MS, callDir } from '../../../src/lib/recall-judge.js';
import { curatedDocs, docHash, vaultIdOf, whenLinesLookup, whenLinesPath } from '../../../src/lib/when-lines.js';
import { recallQuery } from '../../../src/lib/agents/team-roster.js';
import { recallGatePasses } from '../../../src/cli/commands/hook.js';

const W1 = process.env.W1_ROOT ?? join(process.env.HOME!, '.claude-worktrees', 'dreamcontext-super-hafiza-dogru-anda-w1');
const imp = <T>(rel: string): Promise<T> => import(pathToFileURL(join(W1, rel)).href) as Promise<T>;
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const OUT = join(process.env.TMPDIR ?? '/tmp', 'hafiza-yeni-varsayilan');
const HOME = join(OUT, 'home');

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  const arg = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
  mkdirSync(OUT, { recursive: true });
  const L: Any = await imp('scripts/recall-gold/lib.ts');
  const P: Any = await imp('scripts/recall-gold/pool.ts');
  const HJ: Any = await imp('scripts/recall-gold/haiku-judge.ts');
  const W: Any = await imp('scripts/recall-gold/when-lines.ts');
  const gold: Any[] = L.readJsonl(L.goldPath('train'));
  const tag = arg('--tag', '');
  const tier = arg('--tier', 'local') as 'local' | 'cloud-index';

  // Per vault: the corpus, the turn-time rule, the seeded when-lines store.
  const vaults = new Map<string, { root: string; corpus: CorpusDoc[]; births: Map<string, string> }>();
  const when = new Map<string, string[]>(L.readJsonl(W.whenPath('train')).map((l: Any) => [l.key, l.lines]));
  const vaultOf = (name: string) => {
    let v = vaults.get(name);
    if (v) return v;
    const root = L.vaultRoot(name);
    const corpus = buildCorpus(root);
    v = { root, corpus, births: P.births(name) };
    vaults.set(name, v);
    // Seed the shipped store with the measured lines, only for files the shipped writer covers.
    const path = whenLinesPath(vaultIdOf(root), HOME);
    mkdirSync(join(HOME, '.dreamcontext', 'when-lines'), { recursive: true });
    const at = new Date().toISOString();
    const lines = curatedDocs(corpus).filter((d) => when.has(docKey(d)))
      .map((d) => JSON.stringify({ docKey: docKey(d), hash: docHash(d), lines: when.get(docKey(d)), at }));
    writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
    return v;
  };
  const excludeFor = (vault: string, at: string) => {
    const v = vaultOf(vault);
    const day = L.dayOf(at);
    return (doc: CorpusDoc): boolean => { const b = v.births.get(doc.relPath); return b !== undefined && L.dayOf(b) >= day; };
  };
  // Calibrated on the stored runs: ~$0.0015 + $0.00011 per candidate; ~55 candidates.
  const EST = 0.0015 + 0.00011 * 55;

  const runOne = async (guard: Any, what: string, vault: string, at: string, text: string, prev: string | null, ctx: { inContext: Set<string>; passedOver: Set<string> } | null, forceJudge: boolean): Promise<JudgedRecall & { totalMs: number }> => {
    const v = vaultOf(vault);
    guard.allow(EST);
    const t0 = Date.now();
    const r = await judgedRecall(text, prev, v.corpus, v.root, {
      tier, home: HOME, now: new Date(Date.parse(at)), exclude: excludeFor(vault, at),
      inContext: ctx?.inContext, passedOver: ctx?.passedOver, forceJudge,
      whenLines: whenLinesLookup(v.root, HOME), deadlineAt: Date.now() + JUDGE_TIMEOUT_MS,
      judge: { cwd: callDir('dreamcontext-eval-judge-calls') },
    });
    if (r.shown.length) guard.record(what, r.usd, r.usd === 0);
    return { ...r, totalMs: Date.now() - t0 };
  };

  if (cmd === 'plain') {
    const out = join(OUT, `plain${tag ? '.' + tag : ''}.${tier}.jsonl`);
    const done = new Set<string>(L.readJsonl(out).map((l: Any) => l.id));
    const todo = gold.filter((g) => !done.has(g.id));
    console.log(`[estimate] shipped plain ${tier}: ${todo.length} turns (${done.size} stored), ~$${(todo.length * EST).toFixed(2)}`);
    if (argv.includes('--estimate') || !todo.length) return;
    const guard = new L.SpendGuard(L.spendLedgerPath(), `shipped-plain-${tier}`);
    guard.preflight(todo.length * EST, `shipped plain ${tier}`);
    await L.mapLimit(todo, Number(arg('--parallel', '4')), async (g: Any) => {
      const prev = g.surface === 'owner' ? g.prev_owner_text ?? null : null;
      const r = await runOne(guard, `shipped plain ${g.id}`, g.vault, g.at, g.text, prev, null, false);
      // The fallback's model-free answer for the same turn ($0): the default mode's BM25 top 3 under today's gate.
      const v = vaultOf(g.vault);
      const ex = excludeFor(g.vault, g.at);
      const fb = bm25Search(g.text, v.corpus.filter((d) => !ex(d)), 3, { now: new Date(Date.parse(g.at)), collapseFamilies: true })
        .filter((h) => !h.doc.relPath.startsWith('knowledge/patterns/'));
      const fbKeys = recallGatePasses(fb, false, g.text) ? fb.map((h) => docKey(h.doc)) : [];
      L.append0600(out, JSON.stringify({
        id: g.id, outcome: r.outcome, channel: r.channel, picks: Object.fromEntries(r.hits.map((h) => [docKey(h.doc), h.level])),
        shown: r.shown.length, usd: r.usd, searchMs: r.searchMs, judgeMs: r.judgeMs, totalMs: r.totalMs, fallback: fbKeys, cause: r.cause,
      }));
    });
    console.log(`-> ${out}`);
    return;
  }

  if (cmd === 'seq') {
    const window = Number(arg('--window', '3'));
    const out = join(OUT, `seq${tag ? '.' + tag : ''}.${tier}.jsonl`);
    if (existsSync(out) && !argv.includes('--estimate')) throw new Error(`${out} exists: a sequence run does not resume (move it aside)`);
    const owner = gold.filter((g) => g.surface === 'owner');
    const bySession = new Map<string, Any[]>();
    for (const g of owner) bySession.set(g.session, [...(bySession.get(g.session) ?? []), g]);
    // Each session's owner turns and SessionStart markers, in order, from its frozen transcript.
    type Step = { kind: 'turn'; uuid: string; raw: string; at: string } | { kind: 'reset'; source: string };
    const plan: Array<{ session: string; vault: string; steps: Array<Step & { gold?: Any }> }> = [];
    let unmatched = 0;
    for (const [session, gs] of bySession) {
      const p = join(L.epochDir(), 'fixed', 'transcripts', `${session}.jsonl`);
      if (!existsSync(p)) { unmatched += gs.length; continue; }
      const steps: Step[] = [];
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        let e: Any; try { e = JSON.parse(line); } catch { continue; }
        const hn: string | undefined = e?.attachment?.hookName;
        if (e?.attachment?.hookEvent === 'SessionStart' && typeof hn === 'string') { steps.push({ kind: 'reset', source: hn.split(':')[1] ?? '' }); continue; }
        if (e?.type !== 'user' || e.isSidechain || e.isMeta) continue;
        const c = e.message?.content;
        let raw: string | null = null;
        if (typeof c === 'string') raw = c;
        else if (Array.isArray(c) && !c.some((b: Any) => b?.type === 'tool_result')) raw = c.filter((b: Any) => b?.type === 'text').map((b: Any) => b.text).join('\n') || null;
        if (raw !== null) steps.push({ kind: 'turn', uuid: e.uuid, raw, at: e.timestamp });
      }
      const goldIdx = new Map<number, Any>();
      for (const g of gs) {
        const i = steps.findIndex((s) => s.kind === 'turn' && s.uuid === g.record_uuid);
        if (i < 0) { unmatched++; continue; }
        goldIdx.set(i, g);
      }
      if (!goldIdx.size) continue;
      // Keep each gold turn and up to `window` owner turns before it (markers in between kept).
      const keep = new Set<number>();
      for (const i of goldIdx.keys()) {
        keep.add(i);
        let n = 0;
        for (let j = i - 1; j >= 0 && n < window; j--) {
          const s = steps[j]!;
          if (s.kind === 'reset') { keep.add(j); continue; }
          if (recallQuery(s.raw) === null) continue;
          keep.add(j); n++;
        }
      }
      plan.push({ session, vault: gs[0].vault, steps: [...keep].sort((a, b) => a - b).map((i) => ({ ...steps[i]!, gold: goldIdx.get(i) })) });
    }
    const turns = plan.reduce((s, p) => s + p.steps.filter((x) => x.kind === 'turn' && (x.gold || recallQuery(x.raw) !== null)).length, 0);
    const golds = plan.reduce((s, p) => s + p.steps.filter((x) => x.gold).length, 0);
    console.log(`[estimate] shipped seq ${tier}: ${plan.length} sessions, ${turns} owner turns (${golds} gold, ${unmatched} gold turns not found in their transcript), at most ~$${(turns * EST).toFixed(2)}`);
    if (argv.includes('--estimate')) return;
    const guard = new L.SpendGuard(L.spendLedgerPath(), `shipped-seq-${tier}`);
    guard.preflight(turns * EST, `shipped seq ${tier}`);
    await L.mapLimit(plan, Number(arg('--parallel', '4')), async (p) => {
      const ctx = { inContext: new Set<string>(), passedOver: new Set<string>() };
      let prev: string | null = null;
      for (const s of p.steps) {
        if (s.kind === 'reset') {
          // The hook's reset (resetSessionOnce at SessionStart): the context set goes, the previous turn stays.
          ctx.inContext.clear(); ctx.passedOver.clear();
          L.append0600(out, JSON.stringify({ session: p.session, reset: s.source }));
          continue;
        }
        const text = s.gold ? s.gold.text : recallQuery(s.raw);
        if (text === null) continue;
        const usePrev = s.gold ? s.gold.prev_owner_text ?? null : prev;
        const before = [...ctx.inContext];
        const r = await runOne(guard, `shipped seq ${s.gold?.id ?? s.uuid}`, p.vault, s.at, text, usePrev, ctx, !!s.gold);
        for (const h of r.hits) ctx.inContext.add(docKey(h.doc));
        if (r.outcome === 'picked') for (const k of r.shown) if (!ctx.inContext.has(k)) ctx.passedOver.add(k);
        prev = text;
        L.append0600(out, JSON.stringify({
          session: p.session, id: s.gold?.id ?? null, outcome: r.outcome, wouldSkip: r.wouldSkip, called: r.shown.length > 0,
          picks: Object.fromEntries(r.hits.map((h) => [docKey(h.doc), h.level])), inContextBefore: before,
          usd: r.usd, totalMs: r.totalMs, judgeMs: r.judgeMs,
        }));
      }
    });
    console.log(`-> ${out}`);
    return;
  }

  if (cmd === 'score') {
    const owner = gold.filter((g) => g.surface === 'owner');
    const nf = owner.filter((g) => g.nothing_fits);
    const pct = (a: number[]): string => { const s = [...a].sort((x, y) => x - y); return `p50 ${s[Math.floor(s.length / 2)] ?? '-'} p90 ${s[Math.floor(s.length * 0.9)] ?? '-'}`; };
    const line = (name: string, picks: Map<string, Any>, rows: Any[]): void => {
      const sink: string[] = [];
      HJ.report(owner.filter((g) => picks.has(g.id)), picks, 2, (s: string) => sink.push(s));
      let all = '';
      HJ.report(rows.filter((g) => picks.has(g.id)), picks, 2, (s: string) => { if (s.startsWith('ALL')) all = s; });
      const o = sink.find((s) => s.startsWith('owner')) ?? '';
      const mr = /must-arrive ([\d.]+)% \((\d+)\/(\d+)/.exec(o) ?? [];
      const pr = /precision ([\d.]+)% \((\d+)\/(\d+)/.exec(o) ?? [];
      const nfr = /nothing-fits ([\d.]+)% \((\d+)\/(\d+)/.exec(o) ?? [];
      const am = /must-arrive ([\d.]+)% \((\d+)\/(\d+)/.exec(all) ?? [];
      console.log(`${name} | owner must ${mr[2]}/${mr[3]} | precision ${pr[1]}% (${pr[2]}/${pr[3]}) | silent ${nfr[2]}/${nfr[3]} (of ${nf.length}) | ALL must ${am[2]}/${am[3]}`);
    };
    for (const t of ['local', 'cloud-index']) {
      const f = join(OUT, `plain${tag ? '.' + tag : ''}.${t}.jsonl`);
      if (!existsSync(f)) continue;
      const ls: Any[] = L.readJsonl(f);
      const asPicks = (l: Any, keys: Record<string, number>): Any => ({ id: l.id, picks: Object.fromEntries(Object.keys(keys).map((k) => [k, 2])), usd: l.usd, ms: l.totalMs, shortlist: l.shown });
      line(`shipped ${t}`, new Map(ls.map((l) => [l.id, asPicks(l, l.picks)])), gold);
      line(`fallback 'search' (BM25 top 3, today's gate) ${t}`, new Map(ls.map((l) => [l.id, asPicks(l, Object.fromEntries((l.fallback ?? []).map((k: string) => [k, 2])))])), gold);
      const called = ls.filter((l) => l.shown > 0);
      const usd = called.reduce((s, l) => s + l.usd, 0);
      const outcomes = ls.reduce((m: Record<string, number>, l) => { m[l.outcome] = (m[l.outcome] ?? 0) + 1; return m; }, {});
      console.log(`  turns ${ls.length}, judge calls ${called.length}, outcomes ${JSON.stringify(outcomes)}`);
      console.log(`  cost: $${usd.toFixed(4)} total, $${(usd / Math.max(1, called.length)).toFixed(4)} per judged turn (second calls hit the prompt cache: see the first-run note)`);
      console.log(`  latency per turn (search + judge, ms): ${pct(ls.map((l) => l.totalMs))}; search ${pct(ls.map((l) => l.searchMs))}; judge ${pct(called.map((l) => l.judgeMs))}`);
      console.log(`  judge 20-30 s: ${called.filter((l) => l.judgeMs >= 20_000 && l.outcome !== 'judge_timeout').length}; hit the 30 s cap: ${ls.filter((l) => l.outcome === 'judge_timeout').length}`);
    }
    const sf = join(OUT, `seq${tag ? '.' + tag : ''}.local.jsonl`);
    if (existsSync(sf)) {
      const rows: Any[] = L.readJsonl(sf).filter((r: Any) => r.outcome);
      const resets = L.readJsonl(sf).filter((r: Any) => r.reset).length;
      const byId = new Map(gold.map((g) => [g.id, g]));
      const mustOf = (g: Any): string[] => Object.entries(g.labels as Record<string, number>).filter(([k, v]) => v === 2 && !(g.lost ?? []).includes(k) && !k.includes('::')).map(([k]) => k);
      const inter = rows.filter((r) => !r.id);
      const gr = rows.filter((r) => r.id);
      let must = 0, delivered = 0, covered = 0, lostOnSkip = 0, good = 0, picked = 0;
      for (const r of gr) {
        const g = byId.get(r.id)!;
        const ctx = new Set<string>(r.inContextBefore);
        for (const k of mustOf(g)) {
          must++;
          if (k in r.picks) delivered++;
          else if (ctx.has(k)) covered++;
          if (r.wouldSkip && k in r.picks) lostOnSkip++;
        }
        for (const k of Object.keys(r.picks)) { picked++; if ((g.labels[k] ?? 0) >= 1) good++; }
      }
      console.log(`seq: ${resets} context resets seen; ${rows.length} owner turns (${gr.length} gold, ${inter.length} before them)`);
      console.log(`  judge calls: ${rows.filter((r) => r.called).length}/${rows.length}; skipped by the rule on non-gold turns ${inter.filter((r) => r.wouldSkip).length}/${inter.length}; the rule held on gold turns ${gr.filter((r) => r.wouldSkip).length}/${gr.length}`);
      console.log(`  gold owner must ${must}: delivered on the turn ${delivered}, already in context (covered) ${covered}, together ${delivered + covered}; must a skip would have lost ${lostOnSkip}`);
      console.log(`  gold precision of what arrived on the turn: ${good}/${picked}`);
    }
    return;
  }
  throw new Error('usage: shipped.ts plain|seq|score');
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
