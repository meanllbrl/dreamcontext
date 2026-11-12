import { Command, Option } from 'commander';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { confirm, password } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header } from '../../lib/format.js';
import { spawnMarkerFromEnv } from '../../lib/session-origin.js';
import type { CorpusDoc } from '../../lib/recall.js';
import { buildCorpusCached } from '../../lib/recall-corpus-cache.js';
import {
  RERANK_MODELS,
  appendCloudAudit,
  churnSentence,
  copyVoiceKeyToRecall,
  grantVaultConsent,
  indexStopSentence,
  recallCloudKeyInfo,
  recallCloudStatus,
  revokeVaultConsent,
  setRecallCloudKey,
  type CloudTier,
  type RecallCloudStatus,
  type RerankModel,
} from '../../lib/recall-cloud-config.js';
import { renderDisclosure } from '../../lib/recall-cloud-disclosure.js';
import { DEFAULT_RERANK_MODEL } from '../../lib/embeddings/fusion-config.js';
import { CloudRecallError } from '../../lib/embeddings/openrouter.js';
import {
  buildCloudIndex,
  cloudIndexReady,
  planCloudIndex,
  readVectorMeta,
  type BuildCloudIndexResult,
} from '../../lib/embeddings/vector-store.js';

/**
 * `dreamcontext recall cloud <verb>` — consent, key and index management for the opt-in cloud
 * recall tiers. Everything that grants access (`enable`, `key copy-voice`) needs a human at a TTY
 * and is refused in a spawned session: a TTY-less agent cannot turn cloud recall on through this
 * CLI, and there is no `--yes`. Nothing here prints the key, in any mode, including `--json`.
 */

export interface CloudCliDeps {
  /** True when a human can answer: stdin and stdout are both terminals. */
  isTTY: () => boolean;
  env: NodeJS.ProcessEnv;
  home?: string;
  print: (line: string) => void;
  printErr: (line: string) => void;
  confirm: (message: string) => Promise<boolean>;
  /** A hidden prompt (no echo). */
  readSecret: (message: string) => Promise<string>;
  root: () => string;
  loadCorpus: (root: string) => CorpusDoc[];
  setHybrid: (root: string) => void | Promise<void>;
  build: typeof buildCloudIndex;
}

const defaultDeps = (): CloudCliDeps => ({
  isTTY: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  env: process.env,
  print: (l) => { process.stdout.write(`${l}\n`); },
  printErr: (l) => { process.stderr.write(`${l}\n`); },
  confirm: (message) => confirm({ message, default: false }),
  readSecret: (message) => password({ message, mask: '*' }),
  root: ensureContextRoot,
  loadCorpus: (root) => buildCorpusCached(root),
  setHybrid: async (root) => {
    const { readSleepState, writeSleepState } = await import('./sleep.js');
    const state = readSleepState(root);
    state.recall_mode = 'hybrid';
    writeSleepState(root, state);
  },
  build: buildCloudIndex,
});

const VOYAGE = 'voyage-4' as const;

// format.ts's success/error/info print directly; the verbs here write through injected streams.
const ok = (m: string): string => `${chalk.green('✓')} ${m}`;
const bad = (m: string): string => `${chalk.red('✗')} ${m}`;
const note = (m: string): string => `${chalk.magentaBright('ℹ')} ${m}`;

/**
 * Never let the key reach an output stream. This module cannot read the key (only the OpenRouter
 * client does), so instead of scrubbing free text for it, an error is described by its kind or its
 * class and system code, never by its message: a message is the one place a key could ride along.
 */
function describeError(err: unknown): string {
  if (err instanceof CloudRecallError) return `cloud request failed (${err.kind})`;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return `unexpected ${err.name}${typeof code === 'string' ? ` (${code})` : ''}; the message is withheld so no secret can leak`;
  }
  return 'unexpected error';
}

/** The refusal shared by every verb that grants access. Null when allowed. */
function accessRefusal(deps: CloudCliDeps, verb: string): string | null {
  const spawned = spawnMarkerFromEnv(deps.env);
  if (spawned) return `\`${verb}\` is refused in a spawned session (${spawned.by}). Run it yourself, in a terminal.`;
  if (!deps.isTTY()) return `\`${verb}\` needs an interactive terminal: cloud recall can only be enabled by a person at a TTY.`;
  return null;
}

function parseMaxUsd(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── status ───────────────────────────────────────────────────────────────────

export interface CloudStatusReport extends RecallCloudStatus {
  indexReady: boolean;
  indexCoverage: { coveredDocs: number; eligibleTotal: number } | null;
}

export function cloudStatusReport(root: string, home?: string): CloudStatusReport {
  const status = recallCloudStatus(root, home);
  const meta = readVectorMeta(root, VOYAGE);
  return {
    ...status,
    indexReady: cloudIndexReady(root, VOYAGE),
    indexCoverage: meta ? { coveredDocs: meta.coveredDocs, eligibleTotal: meta.eligibleTotal } : null,
  };
}

export function cloudStatus(deps: CloudCliDeps, opts: { json?: boolean } = {}): number {
  const report = cloudStatusReport(deps.root(), deps.home);
  if (opts.json) {
    deps.print(JSON.stringify(report, null, 2));
    return 0;
  }
  deps.print(header('Cloud recall'));
  deps.print(`  Tier: ${report.tier}`);
  deps.print(`  Consent: ${report.consent}${report.consentedAt ? ` (${report.consentedAt}, via ${report.consentSurface})` : ''}`);
  if (report.consent === 're-consent-required') deps.print(`  ${chalk.yellow('Re-consent required')}: the disclosure changed. Run \`dreamcontext recall cloud enable <tier>\` again.`);
  if (report.consentSurface === 'dashboard') deps.print(`  ${chalk.yellow('Granted from the dashboard')}: confirm that was you (audit log: ~/.dreamcontext/recall-cloud-audit.log).`);
  deps.print(`  Key: ${report.key ? `present (source ${report.keySource}, origin ${report.keyOrigin ?? 'environment'})` : 'not set'}`);
  deps.print(`  Rerank model: ${report.rerankModel ?? 'none'}`);
  deps.print(`  Index: ${report.indexReady ? 'ready' : 'not ready'}${report.indexCoverage ? ` (${report.indexCoverage.coveredDocs}/${report.indexCoverage.eligibleTotal} docs)` : ''}`);
  const s = report.spend;
  deps.print(`  Spend: vault lifetime $${s.vaultLifetimeUsd.toFixed(4)}, last 24 h index $${s.indexSpend24hUsd.toFixed(4)} (cap $${s.maxIndexUsd24h}), per build cap $${s.maxIndexUsd}`);
  deps.print(`  Cloud queries today: ${s.todayQueries}/${s.maxQueriesPerDay}`);
  if (report.indexStop) deps.print(`  ${chalk.yellow('Index stale')}: ${indexStopSentence(report.indexStop)}`);
  if (report.churn) deps.print(`  ${chalk.dim('Churn noticed')}: ${churnSentence(report.churn)}`);
  return 0;
}

// ── enable / disable ─────────────────────────────────────────────────────────

export interface EnableOptions {
  rerank?: string;
  maxUsd?: string;
}

function resolveRerank(tier: CloudTier, raw: string | undefined): { model: RerankModel | null } | { problem: string } {
  if (tier === 'cloud-index') return { model: null };
  if (raw === undefined) return { model: DEFAULT_RERANK_MODEL };
  if (raw === 'none') return { model: null };
  const full = raw.startsWith('voyageai/') ? raw : `voyageai/${raw}`;
  const found = RERANK_MODELS.find((m) => m === full);
  return found ? { model: found } : { problem: `Unknown rerank model "${raw}". Use rerank-2.5, rerank-2.5-lite or none.` };
}

export async function cloudEnable(deps: CloudCliDeps, tierArg: string, opts: EnableOptions = {}): Promise<number> {
  const refusal = accessRefusal(deps, 'recall cloud enable');
  if (refusal) { deps.printErr(bad(refusal)); return 1; }
  if (tierArg !== 'cloud-index' && tierArg !== 'cloud') {
    deps.printErr(bad(`Tier must be "cloud-index" or "cloud" (got "${tierArg}").`));
    return 1;
  }
  const tier: CloudTier = tierArg;
  const rerank = resolveRerank(tier, opts.rerank);
  if ('problem' in rerank) { deps.printErr(bad(rerank.problem)); return 1; }
  if (tier === 'cloud-index' && opts.rerank !== undefined && opts.rerank !== 'none') {
    deps.print(note('cloud-index makes no query-time calls, so no rerank model is used.'));
  }
  const maxUsd = parseMaxUsd(opts.maxUsd);
  if (maxUsd === null) { deps.printErr(bad('--max-usd must be a positive number.')); return 1; }
  if (!recallCloudKeyInfo(deps.home).present) {
    deps.printErr(bad('No recall key is set. Run `dreamcontext recall cloud key set` (or `key copy-voice`) first.'));
    return 1;
  }

  const root = deps.root();
  try {
    const corpus = deps.loadCorpus(root);
    const plan = planCloudIndex(root, VOYAGE, corpus);
    for (const line of renderDisclosure(tier, plan, recallCloudStatus(root, deps.home), rerank.model)) deps.print(line);
    if (!(await deps.confirm(`Enable cloud recall (${tier}) for this vault and send the content described above?`))) {
      deps.print(note('Cancelled. Nothing was enabled and nothing was sent.'));
      return 1;
    }
    grantVaultConsent(root, { tier, rerankModel: rerank.model, surface: 'cli-tty' }, deps.home);
    await deps.setHybrid(root);
    deps.print(ok(`Cloud recall (${tier}) enabled for this vault. Recall mode set to hybrid.`));

    const result = await deps.build(root, VOYAGE, corpus, { trigger: 'explicit', home: deps.home, maxUsd });
    deps.print(describeBuild(result));
    if (result.aborted === null) deps.print(note(`Run \`dreamcontext recall cloud status\` to check the index.`));
    return 0;
  } catch (err) {
    deps.printErr(bad(`Enable failed: ${describeError(err)}`));
    return 1;
  }
}

export function cloudDisable(deps: CloudCliDeps, opts: { purge?: boolean } = {}): number {
  const root = deps.root();
  revokeVaultConsent(root, deps.home);
  if (opts.purge) {
    for (const f of ['voyage-4.f32', 'voyage-4.json', 'voyage-4.meta.json']) {
      rmSync(join(root, '.embeddings', f), { force: true });
    }
  }
  deps.print(ok(`Cloud recall disabled for this vault; recall runs on the local tier.${opts.purge ? ' Cloud index files removed.' : ''}`));
  return 0;
}

// ── key ──────────────────────────────────────────────────────────────────────

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function cloudKeySet(deps: CloudCliDeps, opts: { fromEnv?: string } = {}): Promise<number> {
  const spawned = spawnMarkerFromEnv(deps.env);
  if (spawned) { deps.printErr(bad(`\`recall cloud key set\` is refused in a spawned session (${spawned.by}).`)); return 1; }
  let value: string;
  let origin: 'manual' | 'env-copy';
  if (opts.fromEnv !== undefined) {
    if (!ENV_NAME.test(opts.fromEnv)) { deps.printErr(bad('--from-env takes an environment variable NAME, not a value.')); return 1; }
    value = (deps.env[opts.fromEnv] ?? '').trim();
    origin = 'env-copy';
    if (!value) { deps.printErr(bad(`Environment variable ${opts.fromEnv} is empty or unset.`)); return 1; }
  } else {
    if (!deps.isTTY()) { deps.printErr(bad('`recall cloud key set` needs a terminal for the hidden prompt, or --from-env <VAR>.')); return 1; }
    value = (await deps.readSecret('OpenRouter API key for cloud recall (hidden):')).trim();
    origin = 'manual';
    if (!value) { deps.printErr(bad('No key entered; nothing stored.')); return 1; }
  }
  setRecallCloudKey(value, origin, deps.home);
  appendCloudAudit('key_set', null, 'cli', deps.home);
  deps.print(ok(`Recall key stored (origin ${origin}). It is never printed.`));
  return 0;
}

export async function cloudKeyCopyVoice(deps: CloudCliDeps): Promise<number> {
  const refusal = accessRefusal(deps, 'recall cloud key copy-voice');
  if (refusal) { deps.printErr(bad(refusal)); return 1; }
  if (!(await deps.confirm('Recall will spend your Voice OpenRouter credit. Copy the Voice key into cloud recall?'))) {
    deps.print(note('Cancelled. No key was copied.'));
    return 1;
  }
  if (!copyVoiceKeyToRecall(deps.home)) {
    deps.printErr(bad('There is no Voice key to copy.'));
    return 1;
  }
  appendCloudAudit('key_copy_voice', null, 'cli', deps.home);
  deps.print(ok('Voice key copied into cloud recall (origin voice-copy). It is never printed.'));
  return 0;
}

export function cloudKeyClear(deps: CloudCliDeps): number {
  setRecallCloudKey(null, 'manual', deps.home);
  appendCloudAudit('key_clear', null, 'cli', deps.home);
  deps.print(ok('Recall key removed. Cloud tiers fall back to local until a key is set again.'));
  return 0;
}

// ── index ────────────────────────────────────────────────────────────────────

const ABORT_TEXT: Record<NonNullable<BuildCloudIndexResult['aborted']>, string> = {
  not_consented: 'this vault has not consented to a cloud tier (run `recall cloud enable`)',
  tier_local: 'the tier is local (consent revoked or key missing)',
  max_usd: 'the estimated cost exceeds the per-build cap (raise it with --max-usd)',
  eval_cap: 'the eval spend ceiling was reached',
  daily_index_cap: 'the rolling 24 h automatic index cap is reached',
  lock_busy: 'another build is already running for this vault',
  throttled: 'an automatic build started less than 30 minutes ago',
};

function describeBuild(r: BuildCloudIndexResult): string {
  const spent = `$${r.spentUsd.toFixed(4)}`;
  return r.aborted
    ? `Index build stopped: ${ABORT_TEXT[r.aborted]}. Embedded ${r.embedded}, spent ${spent}.`
    : `Index built: embedded ${r.embedded}, reused ${r.reused}, evicted ${r.evicted}, spent ${spent}.`;
}

export async function cloudIndex(deps: CloudCliDeps, opts: { maxUsd?: string; auto?: boolean } = {}): Promise<number> {
  const maxUsd = parseMaxUsd(opts.maxUsd);
  if (maxUsd === null) { deps.printErr(bad('--max-usd must be a positive number.')); return 1; }
  const root = deps.root();
  // Only a person at a terminal runs an explicit build; anything else gets the automatic guards
  // (throttle, rolling 24 h cap), so a script can never spend past the automatic cap.
  const human = !opts.auto && deps.isTTY() && spawnMarkerFromEnv(deps.env) === null;
  try {
    const result = await deps.build(root, VOYAGE, deps.loadCorpus(root), { trigger: human ? 'explicit' : 'auto', home: deps.home, maxUsd });
    if (!opts.auto) deps.print(describeBuild(result));
    return opts.auto || result.aborted === null ? 0 : 1;
  } catch (err) {
    if (!opts.auto) deps.printErr(bad(`Index build failed: ${describeError(err)}`));
    return opts.auto ? 0 : 1;
  }
}

// ── registration ─────────────────────────────────────────────────────────────

export function registerRecallCloudCommands(recall: Command, overrides: Partial<CloudCliDeps> = {}): void {
  const deps = (): CloudCliDeps => ({ ...defaultDeps(), ...overrides });
  const cloud = recall.command('cloud').description('Opt-in cloud recall tiers (cloud-index, cloud): consent, key, index');

  cloud
    .command('status')
    .description('Show the tier, consent, key source, spend and index coverage (never the key)')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => { process.exitCode = cloudStatus(deps(), opts); });

  cloud
    .command('enable')
    .argument('<tier>', 'cloud-index | cloud')
    .option('--rerank <model>', 'rerank-2.5 | rerank-2.5-lite | none (cloud only; default rerank-2.5-lite)')
    .option('--max-usd <n>', 'Spend cap for the first index build')
    .description('Show what leaves this machine, then (at a terminal) enable the tier for this vault and set recall mode to hybrid')
    .action(async (tier: string, opts: EnableOptions) => { process.exitCode = await cloudEnable(deps(), tier, opts); });

  cloud
    .command('disable')
    .option('--purge', 'Also delete the cloud index files')
    .description('Revoke consent for this vault; recall falls back to the local tier')
    .action((opts: { purge?: boolean }) => { process.exitCode = cloudDisable(deps(), opts); });

  const key = cloud.command('key').description('Manage the recall API key (stored 0600; never printed)');
  key
    .command('set')
    .option('--from-env <VAR>', 'Copy the key from this environment variable (a name, never a value)')
    .description('Store the key from a hidden prompt, or from an environment variable')
    .action(async (opts: { fromEnv?: string }) => { process.exitCode = await cloudKeySet(deps(), opts); });
  key
    .command('copy-voice')
    .description('Copy the Voice OpenRouter key into cloud recall (at a terminal, after a confirm)')
    .action(async () => { process.exitCode = await cloudKeyCopyVoice(deps()); });
  key
    .command('clear')
    .description('Remove the stored recall key')
    .action(() => { process.exitCode = cloudKeyClear(deps()); });

  cloud
    .command('index')
    .option('--max-usd <n>', 'Spend cap for this build')
    .addOption(new Option('--auto', 'Automatic build (spawned after sleep); quiet, with throttle and caps').hideHelp())
    .description('Build or refresh this vault\'s cloud index')
    .action(async (opts: { maxUsd?: string; auto?: boolean }) => { process.exitCode = await cloudIndex(deps(), opts); });
}

