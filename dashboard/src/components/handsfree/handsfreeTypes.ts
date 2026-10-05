/**
 * The laptop's hands-free wire shapes, MIRRORED from the server (the dashboard bundle cannot
 * import `src/lib`): `StatusReport`, `Receipt`, `GoResult`, `ReturnResult` in
 * `src/lib/handsfree/orchestrator.ts`, `HandsfreeJob` and `PreflightReport` in
 * `src/server/routes/handsfree.ts`. Every field the UI reads is optional-safe: a server a
 * build behind or ahead renders what it has rather than throwing.
 */

export type HandsfreePhase = 'home' | 'going' | 'away' | 'returning';
export type HandsfreeOffer = 'setup' | 'go' | 'return' | 'resume' | 'rollback' | 'abandon' | 'teardown';

export interface RunningWork {
  kind: 'chat' | 'pty' | 'detached' | 'process' | string;
  id: string;
  cwd?: string;
  busy: boolean;
  command?: string;
}

export interface HandsfreeJob {
  id: string;
  kind: 'go' | 'return' | 'resume' | 'rollback' | 'abandon' | 'revoke-all';
  status: 'running' | 'success' | 'error';
  step: string | null;
  detail: string | null;
  running: RunningWork[];
  startedAt: number;
  finishedAt: number | null;
  result: unknown;
  error: { code: string; message: string; detail: Record<string, unknown> } | null;
}

export interface HandsfreeStatus {
  phase: HandsfreePhase;
  tripId: string | null;
  unreadable: string | null;
  setUp: boolean;
  laptopId: string | null;
  codespace: { name: string; state: string; machine: string; url: string; webUrl: string; retentionExpiresAt: string | null } | null;
  url: string | null;
  verifier: { generation: number; confirmed: number; pending: { kind: string; generation: number; since: string } | null } | null;
  queued: { tripId: string; epoch: number; steps: string[]; since: string } | null;
  lastTrip: { tripId: string; status: string; recovered?: boolean; at: string } | null;
  uptime: { usedCoreMinutes: number; budgetCoreMinutes: number };
  journal: { direction: 'go' | 'return'; writeStarted: boolean; complete: boolean } | null;
  offers: HandsfreeOffer[];
  warnings: string[];
  job: HandsfreeJob | null;
}

export interface PreflightReport {
  roots: Array<{ rootId: string; path: string; kind: 'repo' | 'files'; bytes: number }>;
  totalBytes: number;
  machine: {
    name: string;
    freeBytes: number | null;
    needBytes: number;
    biggerMachine: string | null;
    remainingCoreMinutes: number | null;
    needCoreMinutes: number;
    quotaSource: 'github' | 'laptop';
    running: boolean;
  } | null;
  warnings: string[];
  runningTurns: RunningWork[];
  refusal: { code: 'not_setup' | 'not_home' | 'scope' | 'preflight' | 'disk' | 'quota' | string; message: string; detail?: Record<string, unknown> } | null;
}

export interface GoResult {
  tripId: string;
  url: string;
  webUrl: string;
  recreated: boolean;
  staysHome?: Array<{ rootId: string; path: string; reason: string }>;
  cloudRefused?: Array<{ rootId: string; path: string; reason: string }>;
  signedOutAccounts?: string[];
  warnings?: string[];
}

export interface Conflict { path: string; reason: string }

export interface RepoReceipt {
  rootId: string;
  path: string;
  outcome: 'applied' | 'parked' | 'refused';
  parkReasons: string[];
  parkedRefs: Record<string, string>;
  branches: Array<{ ref: string; from: string | null; to: string | null }>;
  written: string[];
  deleted: string[];
  conflicts: Conflict[];
  refused: Conflict[];
  worktreesAdded?: string[];
  worktreesRemoved?: string[];
}

export interface FilesReceipt {
  rootId: string;
  path: string;
  written: string[];
  conflicts: Conflict[];
  refused: Conflict[];
  deletedInCloud: string[];
  notReturned: string[];
  secrets: string[];
  transcriptCopies?: string[];
}

export interface Receipt {
  version: 1;
  tripId: string;
  createdAt: string;
  pass: number;
  repos: RepoReceipt[];
  files: FilesReceipt[];
  sessions: Array<{ rootId: string; roster: { closedOnPhone: string[]; openedOnPhone: string[]; updated: number } | null; titlesChanged: number; mapFilesWritten: number }>;
  autoExec: Array<{ rootId: string; path: string; diff: string }>;
  links: Array<{ rootId: string; undone: string[]; escaping: string[] }>;
  previousPasses?: Receipt[];
  ignoredRoots?: Array<{ rootId: string; reason: string }>;
  deletedInCloudReason?: string;
  conflictsDir: string;
  backupDir: string;
  finalization: { secretsWiped: boolean; sealed: boolean; stopped: boolean; queued: string[] };
}

export interface ReturnResult {
  tripId: string;
  outcome: 'home' | 'superseded' | 'lost' | 'cancelled';
  receipt: Receipt | null;
  message?: string;
}
