/**
 * The learning-loop evals (plan `ogrenme-dongusu`, criterion 14 and the spend rule of "Evals"):
 * the repo fixture is synthetic, every model-spending script prints its estimate before it can
 * spend and honours the cap through one shared ledger, and the package ships no eval/learn file
 * beyond the four allowed. No model call, no real home: every path here is a temp dir.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  E6_CONTROL, E6_JOBS, E6_RULES, FICTIONAL, HARD_CAP_USD, SpendGuard, bestCoverage, buildIdf, capFromEnv, coverage, e2bDenominator,
  e6Filler, e6StartBlock, evalClaudeArgs, fillerDigest, frozenDir, loadFixture, overApplied, parseClaudeJson, parseReceipt,
  repeatBucket, resultsDir, scoreNoDash, scoreNoPath, scoreVerdict, shapeText, spendLedgerPath, spentSoFar,
} from '../../scripts/learn-eval/lib.js';

const REPO = join(__dirname, '..', '..');
const tmps: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'learn-eval-test-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('the repo fixture is synthetic', () => {
  const fx = loadFixture(join(REPO, 'eval', 'learn', 'fixture.synthetic.json'));
  const f = fx.fixture;
  const texts = [...f.turns.map((t) => t.own), ...f.clusters.map((c) => c.rule), ...f.childBriefs.map((b) => b.brief), ...f.machine, ...f.repeats.map((r) => r.where)];

  it('declares itself synthetic and names the fictional project and owner', () => {
    expect(f.synthetic).toBe(true);
    expect(f.project).toBe(FICTIONAL.project);
    expect(f.person).toBe(FICTIONAL.person);
    expect(texts.some((t) => t.includes(FICTIONAL.project))).toBe(true);
  });

  it('carries only synthetic sessions and no real-data markers', () => {
    for (const t of f.turns) expect(t.sid.startsWith('syn-')).toBe(true);
    for (const r of f.repeats) expect(r.sid.startsWith('syn-')).toBe(true);
    const raw = readFileSync(join(REPO, 'eval', 'learn', 'fixture.synthetic.json'), 'utf-8');
    expect(raw).not.toMatch(/\/Users\//);
    expect(raw).not.toMatch(/projects-[a-z]/i); // the measured data's project-slug prefix
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // a real session uuid
    expect(raw).not.toMatch(/[\w.+-]+@(?!example\.invalid)[\w-]+\.[\w.]+/); // an email that is not the eval's
  });

  it('has the frozen set\'s shape', () => {
    for (const t of f.turns) expect(Object.keys(t).sort()).toEqual(['at', 'kind', 'n', 'own', 'proj', 'sid', 'surf']);
    for (const c of f.clusters) expect(Object.keys(c).sort()).toEqual(['group', 'id', 'landing', 'rule', 'scope', 'turns']);
  });

  it('no em or en dash in any eval/learn text', () => {
    for (const name of readdirSync(join(REPO, 'eval', 'learn'))) {
      expect(readFileSync(join(REPO, 'eval', 'learn', name), 'utf-8')).not.toMatch(/[—–]/);
    }
  });
});

describe('E2b denominator: occasions are session ids, card answers are not ledger turns', () => {
  const fx = loadFixture(join(REPO, 'eval', 'learn', 'fixture.synthetic.json'));
  const rows = Object.fromEntries(e2bDenominator(fx.clusters, fx.turns).map((r) => [r.id, r]));

  it('a cluster typed in two sessions is in', () => {
    expect(rows.S1!.included).toBe(true);
    expect(rows.S1!.occasions).toBe(2);
  });
  it('typed twice in one session is out, and says why', () => {
    expect(rows.S2!.included).toBe(false);
    expect(rows.S2!.why).toMatch(/one occasion/);
  });
  it('said only on cards is out, and says why', () => {
    expect(rows.S3!.included).toBe(false);
    expect(rows.S3!.why).toMatch(/card answers only/);
  });
  it('a second occasion that is only a card answer does not count', () => {
    expect(rows.S4!.included).toBe(false);
    expect(rows.S4!.why).toMatch(/card answers/);
  });
  it('the repeat buckets follow criterion 8', () => {
    expect(fx.repeats.map((r) => repeatBucket(r))).toEqual(['in-context', 'never-written', 'in-scope', 'quick-edit']);
  });
});

describe('spend guard: estimate first, one shared ledger, the cap', () => {
  const plan = (script: string) => ({ script, runs: 10, perRunEstimateUsd: 1, perRunMaxUsd: 2 });

  it('refuses a run before the estimate is printed', () => {
    const g = new SpendGuard({ plan: plan('a'), ledgerPath: join(tmp(), 'spend.jsonl'), capUsd: 60, log: () => {} });
    expect(g.check().ok).toBe(false);
    expect(g.check().reason).toMatch(/announce/);
  });

  it('prints an estimate, then allows runs under the cap', () => {
    const out: string[] = [];
    const g = new SpendGuard({ plan: plan('a'), ledgerPath: join(tmp(), 'spend.jsonl'), capUsd: 60, log: (s) => out.push(s) });
    const text = g.announce();
    expect(text).toMatch(/^ESTIMATE a: 10 model runs/);
    expect(out.join('\n')).toBe(text);
    expect(g.check().ok).toBe(true);
  });

  it('stops before a run that could cross the cap, counting every script in the ledger', () => {
    const ledger = join(tmp(), 'spend.jsonl');
    const a = new SpendGuard({ plan: plan('a'), ledgerPath: ledger, capUsd: 10, log: () => {} });
    const b = new SpendGuard({ plan: plan('b'), ledgerPath: ledger, capUsd: 10, log: () => {} });
    a.announce(); b.announce();
    a.record(5, 'a/1');
    b.record(3, 'b/1');
    expect(spentSoFar(ledger)).toBe(8);
    expect(a.check(2).ok).toBe(true); // 8 + 2 = 10, not over
    a.record(0.5, 'a/2');
    expect(b.check(2).ok).toBe(false); // 8.5 + 2 > 10
    expect(b.check(2).reason).toMatch(/cross the cap/);
  });

  it('skips a torn ledger line and never counts a negative', () => {
    const ledger = join(tmp(), 'spend.jsonl');
    writeFileSync(ledger, '{"usd":2}\n{"usd":-5}\n{"usd":1.5\nnot json\n');
    expect(spentSoFar(ledger)).toBe(2);
  });

  it('the cap defaults to 60 and never goes above the hard cap', () => {
    expect(HARD_CAP_USD).toBe(60);
    expect(capFromEnv({})).toBe(60);
    expect(capFromEnv({ DREAMCONTEXT_EVAL_MAX_USD: '25' })).toBe(25);
    expect(capFromEnv({ DREAMCONTEXT_EVAL_MAX_USD: '500' })).toBe(60);
    expect(capFromEnv({ DREAMCONTEXT_EVAL_MAX_USD: 'x' })).toBe(60);
    expect(new SpendGuard({ plan: plan('a'), ledgerPath: join(tmp(), 's'), capUsd: 999, log: () => {} }).capUsd).toBe(60);
  });

  it('frozen paths follow the injected home', () => {
    const h = tmp();
    expect(frozenDir(h)).toBe(join(h, '.dreamcontext', 'eval-frozen', 'learn-202611'));
    expect(spendLedgerPath(h)).toBe(join(frozenDir(h), 'spend.jsonl'));
    expect(resultsDir(h)).toBe(join(frozenDir(h), 'results'));
  });
});

describe('every model-spending script goes through the guard', () => {
  const dir = join(REPO, 'scripts', 'learn-eval');
  const src = (n: string): string => readFileSync(join(dir, n), 'utf-8');

  for (const name of ['position.ts', 'surfaces.ts', 'sleep-replay.ts', 'updated-input-probe.ts']) {
    it(`${name}: a SpendGuard, its estimate printed before the first model call, a --dry-run`, () => {
      const s = src(name);
      expect(s).toMatch(/new SpendGuard\(/);
      // Past the import block, the estimate is printed before any code that can call a model.
      const body = s.slice(s.indexOf("from './lib.js'"));
      const announce = body.indexOf('guard.announce()');
      expect(announce).toBeGreaterThan(0);
      const calls = ['runClaude(', 'appTurn('].map((k) => body.indexOf(k)).filter((i) => i >= 0);
      expect(calls.length).toBeGreaterThan(0);
      expect(announce).toBeLessThan(Math.min(...calls));
      expect(s).toMatch(/'dry-run'/);
      expect(s).toMatch(/spendLedgerPath\(/);
    });
  }

  for (const name of ['freeze.ts', 'reach.ts', 'repeats.ts']) {
    it(`${name}: makes no model call`, () => {
      expect(src(name)).not.toMatch(/runClaude\(|evalClaudeArgs\(|spawn\('claude'/);
    });
  }

  it('every run is opus with --settings and json output, never Fable', () => {
    const a = evalClaudeArgs({ prompt: 'hi', settings: '/tmp/s.json', maxUsd: 1 });
    expect(a.slice(0, 2)).toEqual(['-p', 'hi']);
    expect(a[a.indexOf('--model') + 1]).toBe('opus');
    expect(a[a.indexOf('--output-format') + 1]).toBe('json');
    expect(a[a.indexOf('--settings') + 1]).toBe('/tmp/s.json');
    expect(a).toContain('--max-budget-usd');
    expect(a.join(' ')).not.toMatch(/fable/i);
  });

  it('reads the cost and result of a json run', () => {
    expect(parseClaudeJson('{"type":"result","result":"ok","total_cost_usd":0.42,"session_id":"s1","is_error":false}')).toEqual({ result: 'ok', costUsd: 0.42, sessionId: 's1', isError: false });
    expect(parseClaudeJson('garbage').isError).toBe(true);
  });
});

describe('the package ships no eval/learn file beyond the four allowed', () => {
  it('package.json "files" does not include eval/ or scripts/ (or only the allowed four)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as { files?: string[] };
    const allowed = new Set(['eval/learn/README.md', 'eval/learn/FROZEN.md', 'eval/learn/BASELINE.md', 'eval/learn/fixture.synthetic.json']);
    for (const f of pkg.files ?? []) {
      const p = f.replace(/^\.\//, '').replace(/\/$/, '');
      if (p === 'eval' || p === 'eval/learn' || p.startsWith('eval/learn/')) expect(allowed.has(p)).toBe(true);
      expect(p === 'scripts' || p.startsWith('scripts/learn-eval')).toBe(false);
    }
    expect(Array.isArray(pkg.files)).toBe(true); // a missing "files" would ship the whole repo
  });

  it('eval/learn holds exactly the four allowed files', () => {
    expect(readdirSync(join(REPO, 'eval', 'learn')).sort()).toEqual(['BASELINE.md', 'FROZEN.md', 'README.md', 'fixture.synthetic.json']);
  });
});

describe('E6: the loaded session and its mechanical scores', () => {
  it('the start block holds 30 rules: the three report rules and the control among them', () => {
    const b = e6StartBlock();
    expect(b.match(/^- \[r\d\d\]/gm)?.length).toBe(30);
    for (const r of E6_RULES) expect(b).toContain(r.text);
    expect(b).toContain(E6_CONTROL.text);
    expect(E6_JOBS.length).toBe(12);
  });

  it('the filler is frozen: same bytes every time, about 250,000 chars, one failing test', () => {
    const a = e6Filler(); const b = e6Filler();
    expect(fillerDigest(a)).toBe(fillerDigest(b));
    const total = a.reduce((n, f) => n + f.text.length, 0);
    expect(total).toBeGreaterThanOrEqual(250_000);
    expect(total).toBeLessThan(252_000);
    expect(a.map((f) => f.text).join('').match(/^FAIL /gm)?.length).toBe(1);
  });

  it('verdict word: alone on the first line, else misapplied or unaware', () => {
    expect(scoreVerdict('TAMAM\n\nThe build is fine.')).toBe('obeyed');
    expect(scoreVerdict('**SORUN**\nOne test broke.')).toBe('obeyed');
    expect(scoreVerdict('Durum: SORUN, bir test kırık.')).toBe('misapplied');
    expect(scoreVerdict('The nightly build failed on one test.')).toBe('unaware');
  });

  it('long dashes: em is unaware, en is misapplied', () => {
    expect(scoreNoDash('One test broke, the rounding one.')).toBe('obeyed');
    expect(scoreNoDash('One test broke — the rounding one.')).toBe('unaware');
    expect(scoreNoDash('Stages 1–6 passed.')).toBe('misapplied');
  });

  it('paths: a path is unaware, a bare file name misapplied, plain words obeyed', () => {
    expect(scoreNoPath('The rounding test in the currency module broke.')).toBe('obeyed');
    expect(scoreNoPath('See logs/build-07.log for details.')).toBe('unaware');
    expect(scoreNoPath('It failed in rounding.spec.ts.')).toBe('misapplied');
  });

  it('the control rule showing in a report is over-applied', () => {
    expect(overApplied(`TAMAM\nAll good.\n${E6_CONTROL.marker}`)).toBe(true);
    expect(overApplied('TAMAM\nAll good.')).toBe(false);
  });
});

describe('phrase coverage and receipts', () => {
  it('coverage is the share of a phrase\'s IDF mass, with at least two distinct terms to count', () => {
    const { idf } = buildIdf(['invoice export csv format', 'report short verdict', 'nightly build passed', 'weather nice']);
    const c = coverage('please export the invoice as csv', 'invoice export csv', idf);
    expect(c.distinct).toBe(3);
    expect(c.mass).toBeCloseTo(1, 5);
    expect(bestCoverage('the weather is nice', ['invoice export csv'], idf)).toBe(0);
    expect(bestCoverage('csv only please', ['invoice export csv'], idf)).toBe(0); // one term is not enough
  });

  it('shapeText keeps the C1 text shape: one line, no tags, no long dash, at most max', () => {
    const s = shapeText('a <b>\nline — that is long enough to cut somewhere here', 30);
    expect(s.length).toBeLessThanOrEqual(30);
    expect(s).not.toMatch(/[<>\n—]/);
  });

  it('reads the receipt in its text and json forms', () => {
    expect(parseReceipt('LEARNED ab12cd34ef active me\nKaydedildi: "x" · senin tercihlerin, her projede · yanlışsa "geri al" de')).toEqual({ id: 'ab12cd34ef', status: 'active', scope: 'me', owner: 'Kaydedildi: "x" · senin tercihlerin, her projede · yanlışsa "geri al" de' });
    expect(parseReceipt('{"id":"zz","status":"proposed","scope":"project"}')?.status).toBe('proposed');
    expect(parseReceipt('Refused: near twin')).toBeNull();
  });
});
