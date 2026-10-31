/** MIRRORED from `src/lib/usage-report.ts` (`StatsWire`): the dashboard cannot import from `src/`. */
export type StatsRange = '24h' | '7d' | '30d' | '90d';
export type StatsTab = 'cost' | 'tokens' | 'limits' | 'dc';

export interface SpendRow {
  key: string; label: string; tool: 'claude' | 'codex' | null; sub?: string; tokens: number; cost: number | null;
  trend?: number[]; cacheHit?: number; priceSource?: 'yours' | 'list' | 'none'; price?: number[] | null;
}
export interface SleepSpecialist { name: string; model: string; effort: string | null; tokens: number; cost: number }
export interface SleepRun {
  id: string; session: string; project: string; account: string; accountLabel: string; trigger: 'you' | 'background' | 'automation';
  start: number; end: number; tokens: number; cost: number; debtBefore: number | null; debtAfter: number | null; reportedCostUsd: number | null;
  specialists: SleepSpecialist[]; estWindowShare: number | null; estLimitPoints: number | null;
}
export interface LimitWindow {
  kind: 'session' | 'weekly'; account: string; accountLabel: string; start: number; end: number; cost: number; sleepCost: number;
  runs: Array<{ project: string; cost: number }>; hit: boolean; estSleepShare: number; thin?: boolean;
}
export interface LimitAnswer { verdict: 'yes' | 'partly' | 'no' | 'none'; hits: number; worst: LimitWindow | null; twoProject: number; windows: LimitWindow[] }
export interface EcoRow { project: string; title: string; at: number; kind: 'eco' | 'fresh'; before: number; after: number | null; turns: number; estSaved: number; estSavedCost: number }
export interface ToolWindow { id: string; kind: string; label: string; usedPercent: number; resetsAt: number | null; durationMins: number | null; estSleepPercent: number | null }
export interface ToolAccount { id: string; label: string; plan: string; fetchedAt: number | null; windows: ToolWindow[]; signedIn: boolean }
export interface ToolLimits { id: 'claude' | 'codex'; name: string; accounts: ToolAccount[] }

export interface StatsWire {
  scanning: { done: number; total: number } | null;
  range: StatsRange;
  buckets: Array<{ start: number; end: number }>;
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
    estWeekShare: number | null;
    eco: { rows: EcoRow[]; estSaved: number; estSavedCost: number; turns: number; avgBefore: number; avgAfter: number };
    memory: { first: number; carried: number; starts: number; messages: number; inputShare: number };
    answer: LimitAnswer;
  };
  limits: ToolLimits[];
  notCounted: Array<{ id: string; name: string }>;
}

export const TOOL_COLOR: Record<string, string> = { claude: 'var(--chart-5)', codex: 'var(--chart-2)' };
