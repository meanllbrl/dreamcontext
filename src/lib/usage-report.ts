/**
 * Everything the Stats screen shows, read off the one ledger (usage-ledger.ts).
 *
 * Three kinds of number, kept apart on purpose:
 *   MEASURED    a transcript said it.
 *   CALCULATED  an exact rule over measured numbers (cost at list price, a share of tokens).
 *   ESTIMATE    what would have happened otherwise, or a share of a limit nobody publishes.
 *               Every estimate lives under a key named `est*` or `~`-labelled by the client, and
 *               NO total below ever adds one: sleep and memory are parts of the total, Eco's
 *               saving is outside it.
 *
 * "Did sleep fill the limit?": Anthropic publishes no token-to-percent rate, so a sleep's share
 * of a limit is its share of the account's spend in that window, at API price. That assumes the
 * limit burns in proportion to API price, which is why it always carries a `~`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { listClaudeAccounts } from './claude-accounts.js';
import { EMPTY_USAGE_LIMITS, readUsageLimits, type UsageLimitsResponse } from './claude-usage.js';
import { listCodexAccounts, readCodexUsage } from './codex-accounts.js';
import { resolveLinkedRepos } from './linked-repos.js';
import { costParts, readPrices, resolvePrice, type PriceBook, type PriceSource } from './usage-pricing.js';
import { readHandoffLog, readLimitHistory, readSleepRuns, type LimitPoint, type SleepRunRecord, type SleepTrigger } from './usage-records.js';
import type { LimitHit } from './usage-readers.js';
import { currentLedger, rowAccount, scanProgress, type Ledger, type LedgerFile, type LedgerRow, type ScanProgress } from './usage-ledger.js';
import { listVaults, type Vault } from './vaults.js';

export type StatsRange = '24h' | '7d' | '30d' | '90d';

export interface StatsQuery {
  range: StatsRange;
  /** A project's name, or null for all. */
  project: string | null;
  /** Hidden tools (`codex`) and accounts (`claude:<id>`). */
  off: Set<string>;
  now?: number;
}

export interface Bucket { start: number; end: number }

export interface SpendRow { alias?: string; key: string; label: string; tool: 'claude' | 'codex' | 'antigravity' | null; sub?: string; tokens: number; cost: number | null; trend?: number[]; cacheHit?: number; priceSource?: PriceSource; price?: number[] | null }

export interface SleepSpecialist { name: string; model: string; effort: string | null; tokens: number; cost: number }

export interface SleepRun {
  id: string; session: string; project: string; account: string; accountLabel: string; trigger: SleepTrigger;
  start: number; end: number; tokens: number; cost: number;
  debtBefore: number | null; debtAfter: number | null; reportedCostUsd: number | null;
  specialists: SleepSpecialist[];
  /** ESTIMATE: this run's share of its 5-hour window's spend. */
  estWindowShare: number | null;
  /** ESTIMATE: points of the 5-hour limit, when the window's rise is known. */
  estLimitPoints: number | null;
}

export interface LimitWindow {
  kind: 'session' | 'weekly';
  account: string; accountLabel: string; start: number; end: number; cost: number; sleepCost: number;
  runs: Array<{ project: string; cost: number }>; hit: boolean;
  /** ESTIMATE: sleep's share of this window's spend. */
  estSleepShare: number;
  /** A limit ran out here on far less spend than this account's other ran-out windows, so the log
   *  does not explain it (spend on another machine, a limit already low). Never decides the answer. */
  thin?: boolean;
}

export interface LimitAnswer {
  /** `unclear`: limits ran out, but the logs explain none of those windows. */
  verdict: 'yes' | 'partly' | 'no' | 'none' | 'unclear';
  hits: number;
  /** Hits whose window the logs explain: the only ones the verdict and its sentence speak for. */
  counted: number;
  /** Doubtful hits (`thin`) that had a sleep in them, reported apart. */
  doubtful: number;
  worst: LimitWindow | null;
  /** Windows where sleeps in two or more projects landed together. */
  twoProject: number;
  windows: LimitWindow[];
}

/** Who wrote a project's prompts. `null` on a row: only Codex ran there, and its prompts are not read. */
export interface PromptCounts { owner: number; super: number; auto: number }

export interface ProjectRow {
  key: string; label: string; tokens: number; cost: number | null;
  prompts: PromptCounts | null;
  /** MEASURED: the same in-range rows as the Sleep card and the trend. */
  sleep: { tokens: number; cost: number };
  /** ESTIMATE, as the Memory card: chars / 3.5, priced at the row's cache rates. */
  estMemory: { tokens: number; cost: number };
  /** ESTIMATE, as the Eco card. */
  estSaved: { tokens: number; cost: number };
  /** ESTIMATE: saved minus sleep and memory. */
  estNet: { tokens: number; cost: number };
}

export interface EcoRow { project: string; title: string; at: number; kind: 'eco' | 'fresh'; before: number; after: number | null; turns: number; estSaved: number; estSavedCost: number }

export interface ToolWindow { id: string; kind: string; label: string; usedPercent: number; resetsAt: number | null; durationMins: number | null; estSleepPercent: number | null }
export interface ToolAccount { id: string; label: string; plan: string; fetchedAt: number | null; windows: ToolWindow[]; signedIn: boolean }
export interface ToolLimits { id: 'claude' | 'codex'; name: string; accounts: ToolAccount[] }

export interface StatsWire {
  scanning: ScanProgress | null;
  range: StatsRange;
  buckets: Bucket[];
  hourly: boolean;
  tools: Array<{ id: string; name: string; counted: boolean; accounts: Array<{ id: string; label: string; plan: string }> }>;
  projects: string[];
  series: Record<string, { tokens: number[]; cost: number[] }>;
  totals: { tokens: number; input: number; cacheRead: number; cacheWrite: number; output: number; cost: number; cacheSavings: number; costParts: [number, number, number, number]; fastCost: number; hasFast: boolean };
  unpriced: string[];
  breakdown: { model: SpendRow[]; account: SpendRow[]; project: SpendRow[] };
  dc: {
    claudeTokens: number;
    chart: { work: number[]; memory: number[]; sleep: number[]; estSaved: number[] };
    sleep: { tokens: number; cost: number; runs: SleepRun[]; vaults: SpendRow[]; specialists: SleepSpecialist[]; configured: Record<string, { model?: string; effort?: string }>; firstRecord: string | null };
    /** ESTIMATE: sleep's share of this week's limit, averaged over accounts with a reading. */
    estWeekShare: number | null;
    eco: { rows: EcoRow[]; estSaved: number; estSavedCost: number; turns: number; avgBefore: number; avgAfter: number };
    memory: { first: number; carried: number; starts: number; messages: number; inputShare: number };
    answer: LimitAnswer;
    projects: ProjectRow[];
    /** The oldest handoff this Mac still has a record of, in any range. */
    ecoFrom: number | null;
    /** The range opens before `ecoFrom`: every row's saving is short of the truth. */
    ecoPartial: boolean;
    /** Per bucket, in dollars: sleep is measured, memory and saved are ESTIMATES. */
    trend: { sleep: number[]; memory: number[]; saved: number[] };
  };
  limits: ToolLimits[];
  notCounted: Array<{ id: string; name: string }>;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const RANGE_DAYS: Record<StatsRange, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };

/** The tools with no usage reader, so the screen says so. Antigravity is counted from the
 *  transcripts its turns leave (usage-ledger.ts), tokens only: it reports no price. */
const NOT_COUNTED = [{ id: 'opencode', name: 'OpenCode' }];

export function bucketsFor(range: StatsRange, now: number): { buckets: Bucket[]; hourly: boolean } {
  if (range === '24h') {
    const top = Math.floor(now / HOUR) * HOUR;
    return { hourly: true, buckets: Array.from({ length: 24 }, (_, i) => ({ start: top - (23 - i) * HOUR, end: top - (22 - i) * HOUR })) };
  }
  const n = RANGE_DAYS[range];
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return {
    hourly: false,
    buckets: Array.from({ length: n }, (_, i) => {
      const s = new Date(today); s.setDate(today.getDate() - (n - 1 - i));
      const e = new Date(s); e.setDate(s.getDate() + 1);
      return { start: s.getTime(), end: e.getTime() };
    }),
  };
}

/** "claude-opus-5-5[1m]" → "Opus 5.5". Anything else stays as the tool wrote it. */
export function modelLabel(model: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:\b|-|\[)/i.exec(model);
  if (!m) return model.replace(/\[.*$/, '');
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

/** The name people call a working folder: its vault, its linked repo, or the folder. */
export function projectResolver(vaults: Vault[], repos: Array<{ name: string; path: string }>): (cwd: string) => string {
  const sorted = [...vaults].sort((a, b) => b.path.length - a.path.length);
  const seen = new Map<string, string>();
  // A brain and the code repo it governs are one project.
  const repoNames = new Set(repos.map((r) => r.name));
  const clean = (s: string) => (s.endsWith('-brain') && repoNames.has(s.slice(0, -6)) ? s.slice(0, -6) : s);
  return (cwd) => {
    if (!cwd) return 'Unknown';
    const known = seen.get(cwd);
    if (known) return known;
    let name: string | null = null;
    for (const v of sorted) if (cwd === v.path || cwd.startsWith(`${v.path}/`)) { name = v.name; break; }
    if (!name) for (const r of repos) if (cwd === r.path || cwd.startsWith(`${r.path}/`)) { name = r.name; break; }
    if (!name) {
      const wt = /\/\.claude-worktrees\/([^/]+)/.exec(cwd);
      name = wt ? wt[1].replace(/-super-.*$/, '') : basename(cwd);
    }
    const out = clean(name);
    seen.set(cwd, out);
    return out;
  };
}

interface AccountNames { label: (tool: string, id: string | undefined) => string }

function accountNames(home: string): AccountNames & { claude: Array<{ id: string; label: string; plan: string; dir: string }>; codex: Array<{ id: string; label: string; plan: string }> } {
  let claude: Array<{ id: string; label: string; plan: string; dir: string }> = [];
  try {
    claude = listClaudeAccounts(home).map((a) => ({ id: a.id, label: a.email, plan: a.tier ?? '', dir: a.configDir ?? home }));
  } catch { /* the ledger still has the numbers */ }
  let codex: Array<{ id: string; label: string; plan: string }> = [];
  try {
    codex = listCodexAccounts(home).map((a) => ({ id: a.id, label: a.email || (a.primary ? 'Default account' : a.id), plan: a.planType }));
  } catch { /* the same */ }
  return {
    claude, codex,
    label: (tool, id) => {
      if (!id) return 'Not known';
      if (tool === 'claude') return claude.find((a) => a.id === id)?.label ?? id;
      return codex.find((a) => a.id === id)?.label ?? `Account …${id.slice(-6)}`;
    },
  };
}

// ── Sleep runs, rebuilt from the log ─────────────────────────────────────────────────

interface FileView { path: string; f: LedgerFile; project: string; account: string | undefined; asleep: boolean; owner: LedgerFile }

interface RunDraft { id: string; session: string; project: string; account: string | undefined; trigger: SleepTrigger; start: number; end: number; files: Array<{ view: FileView; span: number | null }> }

const isSleepAgent = (f: LedgerFile) => typeof f.agent === 'string' && f.agent.startsWith('sleep-');

function draftRuns(views: FileView[]): RunDraft[] {
  const bySession = new Map<string, FileView[]>();
  for (const v of views) {
    if (v.f.tool !== 'claude') continue;
    const list = bySession.get(v.f.session) ?? [];
    list.push(v);
    bySession.set(v.f.session, list);
  }
  const runs: RunDraft[] = [];
  for (const [session, list] of bySession) {
    const main = list.find((v) => !v.f.agent);
    const background = main?.f.origin === 'sleep';
    const auto = main?.f.origin === 'automation';
    const trigger: SleepTrigger = background ? 'background' : auto ? 'automation' : 'you';
    const own: RunDraft[] = [];
    if (background && main) {
      own.push({ id: `${session}:bg`, session, project: main.project, account: main.account, trigger, start: main.f.first, end: main.f.last, files: [{ view: main, span: null }] });
    } else if (main) {
      main.f.spans.forEach(([start, end], i) => {
        own.push({ id: `${session}:${i}`, session, project: main.project, account: main.account, trigger, start, end: end || start, files: [{ view: main, span: i }] });
      });
    }
    const agents = list.filter((v) => v.f.agent && (background || isSleepAgent(v.f))).sort((a, b) => a.f.first - b.f.first);
    for (const v of agents) {
      let home = own.find((r) => v.f.first >= r.start - 60_000 && v.f.first <= r.end + 10 * 60_000);
      if (!home) {
        // A sleep whose `sleep start` is not on the log: its specialists still mark it.
        home = { id: `${session}:a${own.length}`, session, project: v.project, account: v.account, trigger, start: v.f.first, end: v.f.last, files: [] };
        own.push(home);
      }
      home.files.push({ view: v, span: null });
      home.end = Math.max(home.end, v.f.last);
    }
    runs.push(...own);
  }
  return runs.sort((a, b) => a.start - b.start);
}

// ── Super's sends ────────────────────────────────────────────────────────────────────

/** A send behind an open question waits for it: past this it is no longer that message. */
const SEND_REACH_MS = 15 * 60_000;

/**
 * `<file path>|<prompt index>` of every Super send into a chat the owner opened (an adopted child).
 * Such a turn reads exactly like the owner's, so the Super's own log says which: each `super send`
 * claims the first unclaimed `owner` turn there at or after it.
 */
export function superSends(files: Record<string, LedgerFile>): Set<string> {
  const mains = Object.entries(files).filter(([, f]) => !f.agent && f.tool === 'claude');
  const bySession = new Map(mains.map(([path, f]) => [f.session, { path, f }]));
  const sends = mains.flatMap(([, f]) => f.sends).sort((a, b) => a[0] - b[0]);
  const claimed = new Set<string>();
  for (const [at, child] of sends) {
    const to = bySession.get(child) ?? [...bySession.values()].find((m) => m.f.session.startsWith(child));
    if (!to) continue;
    const i = to.f.prompts.findIndex(([ts, kind], n) => kind === 'owner' && ts >= at - 5_000 && ts <= at + SEND_REACH_MS && !claimed.has(`${to.path}|${n}`));
    if (i >= 0) claimed.add(`${to.path}|${i}`);
  }
  return claimed;
}

// ── The one read ─────────────────────────────────────────────────────────────────────

function handoffRecords(vaults: Vault[], toProject: (v: Vault) => string): Array<{ project: string; rec: Record<string, unknown> }> {
  const out: Array<{ project: string; rec: Record<string, unknown> }> = [];
  for (const v of vaults) {
    const logged = readHandoffLog(join(v.path, '_dream_context'));
    const seen = new Set(logged.map((l) => `${l.fromSession}|${l.at}`));
    for (const rec of logged) out.push({ project: toProject(v), rec: rec as unknown as Record<string, unknown> });
    const dir = join(v.path, '_dream_context', 'state', '.handoff-requests');
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(dir, n), 'utf-8')) as Record<string, unknown>;
        if (!seen.has(`${String(rec.fromSession)}|${String(rec.at)}`)) out.push({ project: toProject(v), rec });
      } catch { /* a torn record */ }
    }
  }
  return out;
}

function configuredSpecialists(vaults: Vault[]): Record<string, { model?: string; effort?: string }> {
  for (const v of vaults) {
    try {
      const raw = JSON.parse(readFileSync(join(v.path, '_dream_context', 'state', '.config.json'), 'utf-8')) as { specialists?: Record<string, { model?: string; effort?: string }> };
      if (raw.specialists) return raw.specialists;
    } catch { /* next */ }
  }
  return {};
}

export function buildStats(q: StatsQuery, home: string = homedir()): StatsWire {
  const now = q.now ?? Date.now();
  const ledger: Ledger = currentLedger(home);
  const book: PriceBook = readPrices(home);
  const { buckets, hourly } = bucketsFor(q.range, now);
  const rangeStart = buckets[0].start;
  const rangeEnd = buckets[buckets.length - 1].end;
  const indexOf = (hour: number): number => {
    if (hour < rangeStart || hour >= rangeEnd) return -1;
    if (hourly) return Math.floor((hour - rangeStart) / HOUR);
    let lo = 0; let hi = buckets.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (buckets[mid].start <= hour) lo = mid; else hi = mid - 1; }
    return lo;
  };

  let vaults: Vault[] = [];
  try { vaults = listVaults(home); } catch { /* names fall back to folders */ }
  let repos: Array<{ name: string; path: string }> = [];
  for (const v of vaults) {
    try { repos.push(...resolveLinkedRepos(v.path, home).flatMap((r) => (r.path ? [{ name: r.name, path: r.path }] : []))); } catch { /* the same */ }
  }
  const projectOf = projectResolver(vaults, repos);
  const names = accountNames(home);

  // Per-session facts a sub-agent's file does not carry.
  const mainBySession = new Map<string, LedgerFile>();
  for (const f of Object.values(ledger.files)) if (!f.agent) mainBySession.set(f.session, f);
  const views: FileView[] = Object.entries(ledger.files).map(([path, f]) => {
    const parent = mainBySession.get(f.session);
    return {
      path, f,
      project: projectOf(f.cwd || parent?.cwd || ''),
      account: f.account ?? parent?.account,
      // A sub-agent ran on whichever account its session held at that hour.
      owner: !f.account && parent ? parent : f,
      asleep: f.origin === 'sleep' || parent?.origin === 'sleep' || isSleepAgent(f),
    };
  });

  const shown = (v: FileView): boolean => !q.off.has(v.f.tool) && (q.project === null || v.project === q.project);

  const zero = () => new Array<number>(buckets.length).fill(0);
  const series: StatsWire['series'] = {};
  const seriesOf = (tool: string) => (series[tool] ??= { tokens: zero(), cost: zero() });
  const totals: StatsWire['totals'] = { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, cacheSavings: 0, costParts: [0, 0, 0, 0], fastCost: 0, hasFast: false };
  const unpriced = new Set<string>();
  const chart = { work: zero(), memory: zero(), sleep: zero(), estSaved: zero() };
  const memory = { first: 0, carried: 0, starts: 0, messages: 0 };
  const trend = { sleep: zero(), memory: zero(), saved: zero() };
  const sleepOf = new Map<string, { tokens: number; cost: number }>();
  const memoryOf = new Map<string, { tokens: number; cost: number }>();
  const promptsOf = new Map<string, PromptCounts>();
  const sent = superSends(ledger.files);
  let claudeTokens = 0;
  let claudeInput = 0;

  interface Group { label: string; tool: SpendRow['tool']; sub?: string; tokens: number; cost: number; priced: boolean; trend: number[]; cacheRead: number; allInput: number }
  const byModel = new Map<string, Group>();
  const byAccount = new Map<string, Group>();
  const byProject = new Map<string, Group>();
  const group = (m: Map<string, Group>, key: string, make: () => Pick<Group, 'label' | 'tool' | 'sub'>): Group => {
    let g = m.get(key);
    if (!g) { g = { ...make(), tokens: 0, cost: 0, priced: true, trend: zero(), cacheRead: 0, allInput: 0 }; m.set(key, g); }
    return g;
  };

  // Spend per account per hour, over the whole ledger: limits do not care which range is open.
  interface HourSpend { cost: number; sleepCost: number; runs: Map<string, number> }
  const spend = new Map<string, Map<number, HourSpend>>();
  const runDrafts = draftRuns(views);
  const runOfFileSpan = new Map<string, RunDraft>();
  for (const r of runDrafts) for (const { view, span } of r.files) runOfFileSpan.set(`${view.path}|${span ?? '*'}`, r);

  interface RunTotals { tokens: number; cost: number; byAgent: Map<string, SleepSpecialist> }
  const runTotals = new Map<string, RunTotals>();

  for (const v of views) {
    const on = shown(v);
    const claude = v.f.tool === 'claude';
    for (const row of v.f.rows) {
      const [hour, modelIdx, fast, input, cacheRead, cacheWrite, output, span, memFirst, memCarried, cacheWrite1h] = row;
      const model = ledger.models[modelIdx];
      const { price } = resolvePrice(model, book);
      const t = { input, cacheRead, cacheWrite, cacheWrite1h, output };
      const tokens = input + cacheRead + cacheWrite + output;
      const parts = price ? costParts(price, t) : null;
      const cost = parts ? parts[0] + parts[1] + parts[2] + parts[3] : 0;
      const asleep = v.asleep || span >= 0;
      // A background run owns its whole file, so its own `sleep start` span is the same run.
      const run = runOfFileSpan.get(`${v.path}|${span >= 0 ? span : '*'}`) ?? runOfFileSpan.get(`${v.path}|*`);
      const who = claude ? rowAccount(v.owner, row) : v.account;

      if (claude && who) {
        const hours = spend.get(who) ?? new Map<number, HourSpend>();
        spend.set(who, hours);
        const h = hours.get(hour) ?? { cost: 0, sleepCost: 0, runs: new Map<string, number>() };
        hours.set(hour, h);
        h.cost += cost;
        if (asleep) {
          h.sleepCost += cost;
          if (run) h.runs.set(run.id, (h.runs.get(run.id) ?? 0) + cost);
        }
      }
      if (run) {
        const rt = runTotals.get(run.id) ?? { tokens: 0, cost: 0, byAgent: new Map<string, SleepSpecialist>() };
        runTotals.set(run.id, rt);
        rt.tokens += tokens; rt.cost += cost;
        const name = v.f.agent ?? 'Sleep (main)';
        const key = `${name}|${model}`;
        const a = rt.byAgent.get(key) ?? { name, model: modelLabel(model), effort: v.f.effort ?? null, tokens: 0, cost: 0 };
        rt.byAgent.set(key, a);
        a.tokens += tokens; a.cost += cost;
      }

      // A sleep is its run's project's, wherever a specialist's folder was: every total below reads
      // this one name, so a project filter cannot split a run between two bases.
      const project = asleep && run ? run.project : v.project;
      if (q.off.has(v.f.tool) || (q.project !== null && project !== q.project) || q.off.has(`${v.f.tool}:${who ?? ''}`)) continue;
      const i = indexOf(hour);
      if (i < 0) continue;
      const s = seriesOf(v.f.tool);
      s.tokens[i] += tokens; s.cost[i] += cost;
      totals.tokens += tokens; totals.input += input; totals.cacheRead += cacheRead; totals.cacheWrite += cacheWrite; totals.output += output;
      totals.cost += cost;
      if (parts) {
        parts.forEach((p, k) => { totals.costParts[k] += p; });
        totals.cacheSavings += cacheRead * Math.max(0, (price as number[])[0] - (price as number[])[2]) / 1e6;
        if (fast) totals.fastCost += cost;
      } else unpriced.add(model);
      if (fast) totals.hasFast = true;

      const addTo = (g: Group) => {
        g.tokens += tokens; g.cost += cost; g.cacheRead += cacheRead; g.allInput += input + cacheRead + cacheWrite;
        g.trend[i] += cost;
        if (!price) g.priced = false;
      };
      addTo(group(byModel, model, () => ({ label: modelLabel(model), tool: v.f.tool })));
      addTo(group(byAccount, `${v.f.tool}:${who ?? ''}`, () => ({ label: names.label(v.f.tool, who), tool: v.f.tool, sub: v.f.tool === 'claude' ? names.claude.find((a) => a.id === who)?.plan : names.codex.find((a) => a.id === who)?.plan })));
      addTo(group(byProject, project, () => ({ label: project, tool: null })));

      if (claude) {
        claudeTokens += tokens;
        claudeInput += input + cacheRead + cacheWrite;
        const mem = asleep ? 0 : memFirst + memCarried;
        if (asleep) {
          // The run list shows a run whole; these count what fell in the range.
          chart.sleep[i] += tokens; trend.sleep[i] += cost;
          const z = sleepOf.get(project) ?? { tokens: 0, cost: 0 };
          sleepOf.set(project, z);
          z.tokens += tokens; z.cost += cost;
        }
        else {
          chart.memory[i] += mem; chart.work[i] += Math.max(0, tokens - mem); memory.first += memFirst; memory.carried += memCarried;
          const m = memoryOf.get(v.project) ?? { tokens: 0, cost: 0 };
          memoryOf.set(v.project, m);
          m.tokens += mem;
          if (price) {
            const memCost = (memFirst * price[3] + memCarried * price[2]) / 1e6;
            m.cost += memCost;
            trend.memory[i] += memCost;
          }
        }
      }
    }
    if (on && v.f.tool === 'claude') {
      // A row with Claude work shows counts even when nobody wrote in this range.
      if (promptsOf.has(v.project) === false && v.f.rows.some((r) => indexOf(r[0]) >= 0 && !q.off.has(`claude:${rowAccount(v.owner, r) ?? ''}`))) promptsOf.set(v.project, { owner: 0, super: 0, auto: 0 });
      v.f.prompts.forEach(([ts, kind, who], n) => {
        if (ts < rangeStart || ts >= rangeEnd) return;
        const id = v.owner.accounts?.[who]?.[1] ?? v.owner.account;
        if (q.off.has(`claude:${id ?? ''}`)) return;
        const c = promptsOf.get(v.project) ?? { owner: 0, super: 0, auto: 0 };
        promptsOf.set(v.project, c);
        c[sent.has(`${v.path}|${n}`) ? 'super' : kind] += 1;
      });
    }
    if (on && v.f.tool === 'claude' && !v.asleep && v.f.first >= rangeStart && v.f.first < rangeEnd) {
      memory.starts += v.f.snapshots; memory.messages += v.f.recalls;
    }
  }

  const toRows = (m: Map<string, Group>): SpendRow[] => [...m.entries()].map(([key, g]) => ({
    key, label: g.label, tool: g.tool, ...(g.sub ? { sub: g.sub } : {}), tokens: g.tokens, cost: g.priced ? g.cost : (g.cost > 0 ? g.cost : null),
    trend: g.trend, cacheHit: g.allInput ? g.cacheRead / g.allInput : 0,
  })).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.tokens - a.tokens);

  const models = toRows(byModel).map((r) => { const { price, source } = resolvePrice(r.key, book); return { ...r, priceSource: source, price, ...(Object.hasOwn(book.alias, r.key) ? { alias: book.alias[r.key] } : {}) }; });

  // ── Windows: each 5-hour stretch of an account's spend, as Claude opens them ──────
  const hitsByAccount = new Map<string, LimitHit[]>();
  for (const v of views) {
    for (const h of v.f.hits) {
      const who = h.account ?? v.account;
      if (!who) continue;
      const list = hitsByAccount.get(who) ?? [];
      list.push(h);
      hitsByAccount.set(who, list);
    }
  }
  const runById = new Map(runDrafts.map((r) => [r.id, r]));
  const history = readLimitHistory(home);
  const dirOf = (id: string) => names.claude.find((a) => a.id === id)?.dir;
  const windows: LimitWindow[] = [];
  const pointsInWindow = (account: string, start: number, end: number): LimitPoint[] => {
    const dir = dirOf(account);
    return history.filter((p) => p.account === dir && p.key === 'session' && p.ts >= start && p.ts <= end);
  };
  const riseOf = new Map<LimitWindow, number>();
  const makeWindow = (kind: LimitWindow['kind'], account: string, start: number, end: number, hit: boolean): LimitWindow => {
    const c = { cost: 0, sleepCost: 0, runs: new Map<string, number>() };
    for (const [hour, h] of spend.get(account) ?? []) {
      if (hour < start - HOUR + 1 || hour >= end) continue;
      c.cost += h.cost; c.sleepCost += h.sleepCost;
      for (const [id, cost] of h.runs) c.runs.set(id, (c.runs.get(id) ?? 0) + cost);
    }
    const w: LimitWindow = {
      kind, account, accountLabel: names.label('claude', account), start, end, cost: c.cost, sleepCost: c.sleepCost,
      runs: [...c.runs.entries()].map(([id, cost]) => ({ project: runById.get(id)?.project ?? '?', cost })).sort((a, b) => b.cost - a.cost),
      hit, estSleepShare: c.cost > 0 ? c.sleepCost / c.cost : 0,
    };
    if (kind === 'session') {
      const pts = pointsInWindow(account, start, end);
      if (pts.length >= 2) riseOf.set(w, Math.max(0, pts[pts.length - 1].percent - pts[0].percent));
    }
    return w;
  };
  for (const [account, hours] of spend) {
    if (q.off.has('claude') || q.off.has(`claude:${account}`)) continue;
    // A hit names the window's real end, so it is taken at its word; the rest of the account's
    // hours are walked into 5-hour stretches the way Claude opens them.
    const taken: Array<[number, number]> = [];
    const hit = new Set<string>();
    for (const h of hitsByAccount.get(account) ?? []) {
      const end = h.resetsAt ?? h.ts;
      const key = `${h.kind}|${end}`;
      if (hit.has(key)) continue;
      hit.add(key);
      const start = end - (h.kind === 'weekly' ? 7 * DAY : FIVE_HOURS);
      windows.push(makeWindow(h.kind, account, start, end, true));
      if (h.kind === 'session') taken.push([start, end]);
    }
    let open: number | null = null;
    for (const hour of [...hours.keys()].sort((a, b) => a - b)) {
      if (taken.some(([s, e]) => hour + HOUR > s && hour < e)) continue;
      if (open !== null && hour < open + FIVE_HOURS) continue;
      open = hour;
      windows.push(makeWindow('session', account, hour, hour + FIVE_HOURS, false));
    }
  }

  // ── Sleep, on screen ──────────────────────────────────────────────────────────────
  const recorded: SleepRunRecord[] = vaults.flatMap((v) => readSleepRuns(join(v.path, '_dream_context')));
  const runViews: SleepRun[] = [];
  for (const r of runDrafts) {
    if (r.end < rangeStart || r.start >= rangeEnd) continue;
    if (q.project !== null && r.project !== q.project) continue;
    const first = r.files[0].view;
    const atStart = first.f.rows.find((row) => row[0] + HOUR > r.start);
    const who = atStart ? rowAccount(first.owner, atStart as LedgerRow) : r.account;
    if (q.off.has('claude') || q.off.has(`claude:${who ?? ''}`)) continue;
    const t = runTotals.get(r.id);
    if (!t || t.tokens === 0) continue;
    const rec = recorded.find((x) => x.session === r.session && Math.abs(Date.parse(x.startedAt) - r.start) < 10 * 60_000);
    const win = windows.find((w) => w.kind === 'session' && w.account === who && r.start >= w.start && r.start < w.end);
    const rise = win ? riseOf.get(win) ?? null : null;
    const share = win && win.cost > 0 ? t.cost / win.cost : null;
    runViews.push({
      id: r.id, session: r.session, project: r.project, account: who ?? '', accountLabel: names.label('claude', who),
      trigger: rec?.trigger ?? r.trigger, start: r.start, end: r.end, tokens: t.tokens, cost: t.cost,
      debtBefore: rec?.debtBefore ?? null, debtAfter: rec?.debtAfter ?? null, reportedCostUsd: rec?.costUsd ?? null,
      specialists: [...t.byAgent.values()].sort((a, b) => b.cost - a.cost),
      estWindowShare: share,
      estLimitPoints: share !== null && rise !== null ? rise * share : null,
    });
  }
  const vaultMap = new Map<string, { tokens: number; cost: number; runs: number }>();
  const specMap = new Map<string, SleepSpecialist>();
  for (const r of runViews) {
    const g = vaultMap.get(r.project) ?? { tokens: 0, cost: 0, runs: 0 };
    vaultMap.set(r.project, g);
    g.tokens += r.tokens; g.cost += r.cost; g.runs += 1;
    for (const s of r.specialists) {
      const k = `${s.name}|${s.model}`;
      const e = specMap.get(k) ?? { ...s, tokens: 0, cost: 0 };
      specMap.set(k, e);
      e.tokens += s.tokens; e.cost += s.cost;
    }
  }

  // ── Limits now, with sleep's share of each open window ────────────────────────────
  const costIn = (account: string, start: number, end: number): { cost: number; sleepCost: number } => {
    const out = { cost: 0, sleepCost: 0 };
    for (const [hour, h] of spend.get(account) ?? []) if (hour >= start - HOUR && hour < end) { out.cost += h.cost; out.sleepCost += h.sleepCost; }
    return out;
  };
  const claudeLimits: ToolAccount[] = names.claude.map((a) => {
    let reading: UsageLimitsResponse = EMPTY_USAGE_LIMITS;
    try { reading = readUsageLimits(a.dir); } catch { /* a folder the gate refuses reads as no reading */ }
    const windowsNow: ToolWindow[] = reading.limits.filter((l) => l.key === 'session' || l.key === 'weekly').map((l) => {
      const durationMins = l.key === 'session' ? 300 : 7 * 1440;
      const c = costIn(a.id, l.resetsAt - durationMins * 60_000, l.resetsAt);
      return {
        id: l.key, kind: l.key, label: l.key === 'session' ? '5-hour window' : 'Weekly',
        usedPercent: l.percent, resetsAt: l.resetsAt, durationMins,
        estSleepPercent: c.cost > 0 ? l.percent * (c.sleepCost / c.cost) : null,
      };
    });
    return { id: a.id, label: a.label, plan: a.plan, fetchedAt: reading.fetchedAtMs, windows: windowsNow, signedIn: true };
  });
  const codexLimits: ToolAccount[] = names.codex.map((a) => {
    const reading = readCodexUsage(a.id, home);
    const checked = reading ? Date.parse(reading.checkedAt) : NaN;
    return {
      id: a.id, label: a.label, plan: a.plan, fetchedAt: Number.isFinite(checked) ? checked : null, signedIn: reading !== null,
      windows: (reading?.windows ?? []).map((w) => ({
        id: w.id, kind: w.kind, label: w.label, usedPercent: w.usedPercent,
        resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : null, durationMins: w.windowDurationMins ?? null, estSleepPercent: null,
      })),
    };
  });
  const weekShares = claudeLimits.flatMap((a) => a.windows.filter((w) => w.kind === 'weekly' && w.estSleepPercent !== null).map((w) => w.estSleepPercent as number));

  // ── Eco and fresh sessions ────────────────────────────────────────────────────────
  const ecoRows: EcoRow[] = [];
  let ecoFrom: number | null = null;
  const mains = views.filter((v) => !v.f.agent && v.f.tool === 'claude');
  const contextCeiling = 1_000_000;
  for (const { project, rec } of handoffRecords(vaults, (v) => projectOf(v.path))) {
    const at = typeof rec.at === 'string' ? Date.parse(rec.at) : NaN;
    const consumed = typeof rec.consumedAt === 'string' ? Date.parse(rec.consumedAt) : NaN;
    const before = typeof rec.contextTokens === 'number' ? rec.contextTokens : null;
    if (Number.isFinite(at) && before !== null && Number.isFinite(consumed) && (ecoFrom === null || at < ecoFrom)) ecoFrom = at;
    if (!Number.isFinite(at) || at < rangeStart || at >= rangeEnd || before === null || !Number.isFinite(consumed)) continue;
    if (q.project !== null && project !== q.project) continue;
    const to = typeof rec.toSession === 'string'
      ? mainBySession.get(rec.toSession)
      : mains.filter((v) => v.project === project && v.f.session !== rec.fromSession && v.f.first >= consumed - 5_000 && v.f.first <= consumed + 5 * 60_000)
        .sort((a, b) => a.f.first - b.f.first)[0]?.f;
    if (to && (q.off.has('claude') || q.off.has(`claude:${to.account ?? ''}`))) continue;
    const after = to?.ctx0 ?? null;
    const turns = to ? Math.max(0, to.reqs - 1) : 0;
    let estSaved = 0;
    let estSavedCost = 0;
    if (to && after !== null && before > after) {
      // The old chat would have stopped at the auto-compact ceiling, so later turns count only
      // until the old context plus the new chat's own growth reaches it.
      const growth = turns > 0 ? Math.max(0, to.ctx1 - to.ctx0) / turns : 0;
      const horizon = growth > 0 ? Math.floor(Math.max(0, contextCeiling - before) / growth) : turns;
      const saved = (before - after) * Math.min(turns, horizon);
      // The fresh session's first cache write is the handoff's own cost.
      estSaved = Math.max(0, saved - after);
      const modelIdx = to.rows[0]?.[1];
      const p = modelIdx === undefined ? null : resolvePrice(ledger.models[modelIdx], book).price;
      if (p) estSavedCost = Math.max(0, saved * p[2] / 1e6 - after * p[3] / 1e6);
      const i = indexOf(Math.floor(to.first / HOUR) * HOUR);
      if (i >= 0) { chart.estSaved[i] += estSaved; trend.saved[i] += estSavedCost; }
    }
    ecoRows.push({ project, title: typeof rec.title === 'string' ? rec.title : '', at, kind: rec.actedAt ? 'eco' : 'fresh', before, after, turns, estSaved, estSavedCost });
  }
  ecoRows.sort((a, b) => b.at - a.at);
  const measured = ecoRows.filter((e) => e.after !== null);

  // ── The owner's question ──────────────────────────────────────────────────────────
  const inRange = windows.filter((w) => w.end > rangeStart && w.start < rangeEnd);
  const hitWindows = inRange.filter((w) => w.hit);
  for (const w of hitWindows.filter((x) => x.kind === 'session')) {
    const costs = windows.filter((x) => x.hit && x.kind === 'session' && x.account === w.account).map((x) => x.cost).sort((x, y) => x - y);
    if (w.cost < costs[costs.length >> 1] / 2) w.thin = true;
    // One account cannot have two 5-hour windows at once: a session moved and the folder stamp
    // that says when lagged. The smaller of the two is the doubtful one.
    const clash = windows.filter((x) => x !== w && x.hit && x.kind === 'session' && x.account === w.account && x.start < w.end && w.start < x.end)
      .sort((x, y) => y.cost - x.cost)[0];
    if (clash && (clash.cost > w.cost || (clash.cost === w.cost && clash.end > w.end))) w.thin = true;
  }
  const sleptHits = hitWindows.filter((w) => w.sleepCost > 0 && !w.thin).sort((a, b) => b.estSleepShare - a.estSleepShare);
  const slept = inRange.filter((w) => w.sleepCost > 0).sort((a, b) => b.sleepCost - a.sleepCost);
  const worst = sleptHits[0] ?? null;
  const verdict: LimitAnswer['verdict'] = hitWindows.length === 0 ? 'none'
    : hitWindows.every((w) => w.thin) ? 'unclear'
    : (sleptHits[0]?.estSleepShare ?? 0) >= 0.5 ? 'yes'
      : (sleptHits[0]?.estSleepShare ?? 0) >= 0.2 ? 'partly' : 'no';
  const answer: LimitAnswer = {
    verdict, hits: hitWindows.length, worst,
    counted: hitWindows.filter((w) => !w.thin).length,
    doubtful: hitWindows.filter((w) => w.thin && w.sleepCost > 0).length,
    twoProject: inRange.filter((w) => w.kind === 'session' && new Set(w.runs.map((r) => r.project)).size >= 2).length,
    windows: [...new Set([...sleptHits, ...slept.filter((w) => !w.thin), ...slept])].slice(0, 8),
  };

  // ── One row per project, from the numbers the cards above already hold ─────────────
  const spendRows = toRows(byProject);
  const ecoOf = new Map<string, { tokens: number; cost: number }>();
  for (const e of ecoRows) {
    const g = ecoOf.get(e.project) ?? { tokens: 0, cost: 0 };
    ecoOf.set(e.project, g);
    g.tokens += e.estSaved; g.cost += e.estSavedCost;
  }
  const projectRows: ProjectRow[] = [...new Set([...spendRows.map((r) => r.key), ...sleepOf.keys(), ...ecoOf.keys(), ...promptsOf.keys()])].map((key) => {
    const s = spendRows.find((r) => r.key === key);
    const sleep = sleepOf.get(key) ?? { tokens: 0, cost: 0 };
    const estMemory = memoryOf.get(key) ?? { tokens: 0, cost: 0 };
    const estSaved = ecoOf.get(key) ?? { tokens: 0, cost: 0 };
    return {
      key, label: key, tokens: s?.tokens ?? 0, cost: s?.cost ?? 0, prompts: promptsOf.get(key) ?? null, sleep, estMemory, estSaved,
      estNet: { tokens: estSaved.tokens - sleep.tokens - estMemory.tokens, cost: estSaved.cost - sleep.cost - estMemory.cost },
    };
  }).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.tokens - a.tokens);

  const firstRun = recorded.map((r) => r.startedAt).sort()[0] ?? null;
  return {
    scanning: scanProgress(home),
    range: q.range, buckets, hourly,
    tools: [
      { id: 'claude', name: 'Claude Code', counted: true, accounts: names.claude.map(({ id, label, plan }) => ({ id, label, plan })) },
      { id: 'codex', name: 'Codex', counted: true, accounts: [...new Set(views.filter((v) => v.f.tool === 'codex' && v.account).map((v) => v.account as string))].map((id) => ({ id, label: names.label('codex', id), plan: names.codex.find((a) => a.id === id)?.plan ?? '' })) },
      { id: 'antigravity', name: 'Antigravity', counted: true, accounts: [] },
      ...NOT_COUNTED.map((t) => ({ ...t, counted: false, accounts: [] })),
    ],
    projects: [...new Set(views.map((v) => v.project))].filter((p) => p !== 'Unknown').sort((a, b) => a.localeCompare(b)),
    series, totals, unpriced: [...unpriced],
    breakdown: { model: models, account: toRows(byAccount), project: toRows(byProject) },
    dc: {
      claudeTokens, chart,
      sleep: {
        tokens: [...sleepOf.values()].reduce((a, s) => a + s.tokens, 0), cost: [...sleepOf.values()].reduce((a, s) => a + s.cost, 0),
        runs: runViews.sort((a, b) => b.start - a.start),
        vaults: [...vaultMap.entries()].map(([key, g]) => ({ key, label: key, tool: null, sub: String(g.runs), tokens: g.tokens, cost: g.cost })).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
        specialists: [...specMap.values()].sort((a, b) => b.cost - a.cost),
        configured: configuredSpecialists(vaults), firstRecord: firstRun,
      },
      estWeekShare: weekShares.length ? weekShares.reduce((a, b) => a + b, 0) / weekShares.length : null,
      eco: {
        rows: ecoRows.slice(0, 40),
        estSaved: ecoRows.reduce((a, e) => a + e.estSaved, 0), estSavedCost: ecoRows.reduce((a, e) => a + e.estSavedCost, 0),
        turns: ecoRows.reduce((a, e) => a + e.turns, 0),
        avgBefore: measured.length ? measured.reduce((a, e) => a + e.before, 0) / measured.length : 0,
        avgAfter: measured.length ? measured.reduce((a, e) => a + (e.after as number), 0) / measured.length : 0,
      },
      memory: { ...memory, inputShare: claudeInput ? (memory.first + memory.carried) / claudeInput : 0 },
      answer,
      projects: projectRows, ecoFrom, ecoPartial: ecoFrom === null || ecoFrom > rangeStart, trend,
    },
    limits: [{ id: 'claude', name: 'Claude Code', accounts: claudeLimits }, { id: 'codex', name: 'Codex', accounts: codexLimits }],
    notCounted: NOT_COUNTED,
  };
}
