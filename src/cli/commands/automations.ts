import { Command } from 'commander';
import { dirname } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { success, error, header, warn } from '../../lib/format.js';
import {
  AutomationError,
  WEEKDAYS,
  EFFORT_LEVELS,
  APPROVAL_DIFF_FIELDS,
  REVIEW_MODES,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  DEFAULT_CATCHUP_HOURS,
  MAX_CATCHUP_HOURS,
  PATTERN_LESSON_LIMIT,
  type Weekday,
  type EffortLevel,
  type AutomationManifest,
  type ReviewMode,
} from '../../lib/automations/types.js';
import {
  listAutomations,
  getAutomation,
  readAutomationCache,
  readRunSidecar,
  createAutomation,
  setAutomationEnabled,
  setAutomationShared,
  removeAutomation,
  shareStateFor,
  readPattern,
  recordLesson,
  type ShareState,
} from '../../lib/automations/store.js';
import { resolveRunSession, readSessionDigest, toolCallLabel } from '../../lib/automations/session.js';
import { applySteer, proposeFromRun, resumeWithVerdict } from '../../lib/automations/verdict.js';
import {
  describeTelegram,
  emitPendingCards,
  pollTelegram,
  readTelegramConfig,
  telegramConfigPath,
  writeTelegramConfig,
} from '../../lib/automations/telegram.js';
import {
  allPendingReviewCards,
  listReviewCards,
  pendingReviewCard,
} from '../../lib/automations/review.js';
import {
  shareAutomation,
  unshareAutomation,
  pruneStrayNegations,
  type ShareResult,
} from '../../lib/automations/sharing.js';
import { isDue, formatSchedule } from '../../lib/automations/schedule.js';
import {
  checkApproval,
  approveAutomation,
  approvalFields,
  registerProject,
  revokeApproval,
  readDispatcherHeartbeat,
} from '../../lib/automations/registry.js';
import { runAutomation, killRunGroup, type RunOutcome, type KillRunResult } from '../../lib/automations/runner.js';
import { tickProject, tickAll, type TickProjectResult, type TickAllResult } from '../../lib/automations/tick.js';
import {
  dispatcherPlistPath,
  automationsLogPath,
  inspectDispatcher,
  installDispatcher,
  uninstallDispatcher,
  type InstallCheck,
} from '../../lib/automations/launchd.js';
import {
  buildNotifierApp,
  inspectNotifier,
  notifyViaBundle,
  removeNotifierApp,
  NOTIFY_SOUND_OK,
} from '../../lib/automations/notifier.js';

/**
 * `dreamcontext automations` — the scheduled-headless-claude-run CLI. Mirrors
 * `lab.ts`'s verb-family shape exactly (thin renderer over the lib, one
 * `handle*Error` catch, `chalk.magentaBright` for slugs / `chalk.dim` for
 * metadata) so behaviour never drifts between this and the dispatcher/server
 * that call the same lib functions underneath.
 *
 * Every destructive or trust-elevating verb (`approve`, `kill`, `remove`,
 * `uninstall`, `unshare`) requires `-y/--yes` OR an interactive TTY confirmation —
 * NEVER both silently skipped. There is no flag on any verb here that
 * bypasses approval or the orphan guard; `run --force`/`tick` bypass dueness
 * and sleep-deference only (see runner.ts's own `force` doc comment).
 */

/** Resolve the project root that holds `_dream_context/` (registry/approval
 *  keys are project-root-relative, mirroring lab.ts's own helper). */
function projectRootFor(contextRoot: string): string {
  return dirname(contextRoot);
}

function handleAutomationsError(err: unknown): void {
  if (err instanceof AutomationError) {
    error(err.message);
    process.exitCode = 1;
    return;
  }
  error((err as Error).message ?? String(err));
  process.exitCode = 1;
}

/** Load a manifest or print a uniform "no such automation" error. Returns
 *  null on failure — callers must check and return without further action. */
function requireAutomation(root: string, slug: string): AutomationManifest | null {
  const manifest = getAutomation(root, slug);
  if (!manifest) {
    error(`No such automation: ${slug}`);
    process.exitCode = 1;
    return null;
  }
  return manifest;
}

/** One transcript item, one terminal line. A session replay is for scanning
 *  what happened, so a wrapped 2,000-character assistant turn would bury the
 *  tool call after it. */
function truncateLine(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Signal-0 liveness probe — the exact semantics `killRunGroup`'s internal
 *  probe uses (no throw, or EPERM ⇒ alive; ESRCH ⇒ dead), reimplemented here
 *  only because that probe is a private detail of runner.ts, not exported.
 *  Read-only: NEVER sends a real signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/** `--days daily|mon,wed` → the `'daily' | Weekday[]` shape `createAutomation`
 *  expects. Final schedule validity (a real weekday list, a parseable `--at`)
 *  is still enforced by `validateAutomationForWrite` — this only rejects an
 *  unrecognized day token so the error names the actual bad token, rather
 *  than falling through to `validateAutomationForWrite`'s generic message. */
function parseDaysFlag(value: string): 'daily' | Weekday[] {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'daily') return 'daily';
  const tokens = trimmed.split(',').map((d) => d.trim()).filter(Boolean);
  const valid: readonly string[] = WEEKDAYS;
  const invalid = tokens.filter((t) => !valid.includes(t));
  if (invalid.length > 0) {
    throw new AutomationError(
      `--days: invalid weekday(s) "${invalid.join(', ')}" — use "daily" or a comma list of ${WEEKDAYS.join(',')}.`,
    );
  }
  return tokens as Weekday[];
}

/** `--effort <level>` → a validated `EffortLevel`, or `null` when omitted.
 *  Mirrors `parseDaysFlag`'s pattern exactly: validate at the CLI boundary and
 *  throw an `AutomationError` naming the actual bad token, rather than
 *  passing an unchecked string through to `createAutomation` and relying on
 *  the store's own (differently-worded) strict check. */
function parseEffortFlag(value: string | undefined): EffortLevel | null {
  if (value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (!(EFFORT_LEVELS as readonly string[]).includes(trimmed)) {
    throw new AutomationError(`--effort: invalid level "${value}" — must be one of: ${EFFORT_LEVELS.join(', ')}.`);
  }
  return trimmed as EffortLevel;
}

/**
 * S3 — auto-repair the UNSAFE drift direction (a private automation whose
 * negation lines are still on disk, so its content actually leaves the
 * machine while the user believes it is private) at every human-facing
 * touchpoint (`list`, `show`, `create` call this). NEVER called from the
 * runner or `tick` — the scheduled path must stay cheap and must never
 * mutate repo files on its own; only a human-invoked CLI command may.
 *
 * `pruneStrayNegations` is itself a no-op for any slug that has no stray
 * negation, so passing every currently-private slug is safe and idempotent —
 * there is no need to pre-filter by `shareStateFor` first (which would cost
 * one extra read per manifest for no benefit: the removal itself is already
 * cheap and exact). Returns the lines actually removed so the caller can
 * print them — repair is announced, never silent.
 */
function repairStrayNegations(root: string): string[] {
  const privateSlugs = listAutomations(root)
    .filter((m) => !m.shared)
    .map((m) => m.slug);
  if (privateSlugs.length === 0) return [];
  return pruneStrayNegations(root, privateSlugs);
}

/** Inline badge + an optional loud warning line for one automation's
 *  {@link ShareState}. `drifted-ignore-only` is included for completeness
 *  (defence in depth) even though every call site runs
 *  {@link repairStrayNegations} first, which should already have resolved it
 *  back to `private` by the time this renders. */
function describeShareState(state: ShareState, slug: string): { badge: string; warning: string | null } {
  switch (state) {
    case 'private':
      return { badge: chalk.dim('private'), warning: null };
    case 'shared':
      return { badge: chalk.cyan('shared'), warning: null };
    case 'drifted-flag-only':
      return {
        badge: chalk.yellow('shared (NOT actually published)'),
        warning: `"${slug}" is flagged shared but nothing is actually published — run \`dreamcontext automations share ${slug}\` to fix.`,
      };
    case 'drifted-ignore-only':
      return {
        badge: chalk.yellow('private (drift just repaired)'),
        warning: `"${slug}" was flagged private but was still publishing — the stray entry was just removed above.`,
      };
    case 'tracked-despite-private':
      return {
        badge: chalk.red('TRACKED despite private'),
        warning:
          `"${slug}" is flagged private but its manifest is already tracked by git — .gitignore cannot untrack ` +
          `a path git already has. From the brain root: \`git rm --cached automations/${slug}.md\`.`,
      };
  }
}

/** Printed after `share <slug>` or `create --shared` actually publishes a
 *  slug — names every path that now leaves the machine, and the teammate
 *  reminder, so a user never has to guess what "shared" touches. */
function printPublishedPaths(slug: string, result: ShareResult): void {
  success(`"${slug}" will publish to the synced brain.`);
  console.log(chalk.dim(`  manifest: automations/${slug}.md`));
  console.log(chalk.dim(`  cache: automations/cache/${slug}.json`));
  console.log(chalk.dim(`  output: automations/output/${slug}/*`));
  if (result.repairedOrdering) {
    warn('  a broken .gitignore ordering was repaired first so existing shares stay effective.');
  }
  warn(`A teammate who pulls this must still \`dreamcontext automations approve ${slug}\` before it runs on their machine.`);
}

/**
 * The non-retroactive warning `unshare` must print VERBATIM before it ever
 * asks for confirmation — this warning IS the entire justification for the
 * verb existing at all: `unshare` can only stop FUTURE publishing, never
 * undo what already left. A single exported constant means the CLI's
 * printed text and the integration test's literal-string assertion can never
 * silently drift apart.
 */
export function unshareWarningLines(slug: string): string[] {
  return [
    `"${slug}" will no longer be published from this machine.`,
    'This does NOT unpublish what was already pushed — the manifest, its cache, and its',
    'outputs remain in git history on the remote and on every machine that pulled them.',
    'Removing the negation lines only stops FUTURE changes from publishing.',
    'To remove them from history you must rewrite it (`git filter-repo`) and force-push,',
    'and every teammate must re-clone. If the prompt or an output contained something',
    'sensitive, treat it as disclosed.',
  ];
}

function printRunOutcome(outcome: RunOutcome): void {
  const label = `${outcome.slug}: ${outcome.status}`;
  const suffix = outcome.error ? ` — ${outcome.error}` : '';
  if (outcome.status === 'ok') {
    success(label);
    if (outcome.outputPath) console.log(chalk.dim(`  output: ${outcome.outputPath}`));
  } else if (outcome.status === 'blocked' || outcome.status === 'deferred' || outcome.status === 'orphaned') {
    warn(`${label}${suffix}`);
    process.exitCode = 1;
  } else {
    error(`${label}${suffix}`);
    process.exitCode = 1;
  }
  if (outcome.denials > 0) warn(`  ${outcome.denials} permission denial(s) during this run.`);
}

function printTickProjectResult(result: TickProjectResult): void {
  console.log(header('Tick'));
  if (result.considered === 0) {
    console.log(chalk.dim('  (no automations)'));
    return;
  }
  for (const v of result.verdicts) {
    console.log(`  ${chalk.magentaBright(v.slug)}: ${v.verdict}`);
  }
}

function printTickAllResult(result: TickAllResult): void {
  console.log(header('Tick — all registered projects'));
  if (result.projects.length === 0 && result.missing.length === 0) {
    console.log(chalk.dim('  (no projects registered)'));
    return;
  }
  for (const p of result.projects) {
    console.log(`  ${p.projectRoot}`);
    if (p.verdicts.length === 0) {
      console.log(chalk.dim('    (no automations)'));
      continue;
    }
    for (const v of p.verdicts) console.log(`    ${chalk.magentaBright(v.slug)}: ${v.verdict}`);
  }
  for (const m of result.missing) warn(`  registered project's _dream_context/ is missing, skipped: ${m}`);
}

function printInstallCheck(check: InstallCheck): void {
  console.log(header('Dispatcher check'));
  console.log(`  resolved bin: ${check.resolved.bin ?? chalk.red('(none — install would refuse)')}`);
  console.log(`  running bin: ${check.runningBin ?? '(unknown)'}`);
  console.log(`  mismatch: ${check.mismatch ? chalk.red('true') : 'false'}`);
  console.log(`  wrapper: ${check.wrapperPresent ? (check.wrapperCurrent ? 'present, current' : chalk.red('present, STALE')) : chalk.dim('absent')}`);
  console.log(`  plist: ${check.plistPresent ? (check.plistCurrent ? 'present, current' : chalk.red('present, STALE')) : chalk.dim('absent')}`);
  console.log(`  bootstrapped: ${check.bootstrapped}`);
  console.log(`  log: ${check.logPath} (${check.logSizeBytes} bytes)`);

  // Raw heartbeat timestamps only — deliberately NO staleness verdict. A
  // healthy tick that runs several due automations sequentially can
  // legitimately take longer than any flat threshold would tolerate, and a
  // laptop asleep at fire time is an expected StartInterval miss, not a dead
  // dispatcher — a synthesized "stale" verdict here would be exactly the
  // reflexive-distrust failure the approval design argues against elsewhere.
  const hb = readDispatcherHeartbeat();
  console.log(`  last tick started: ${hb.lastTickStartedAt ?? '(never)'}`);
  console.log(
    `  last tick completed: ${hb.lastTickCompletedAt ?? '(never)'}` +
      (hb.lastTickDurationMs !== null ? ` (${hb.lastTickDurationMs}ms)` : ''),
  );

  // Notifier state, reported the same way as the heartbeat: facts, no verdict.
  // Whether macOS has GRANTED notification permission is deliberately NOT
  // claimed — that lives in a container this process cannot read, and an
  // unauthorised notification is filed silently rather than erroring, so any
  // guess here would be exactly the kind of confident-and-wrong signal that
  // made this problem hard to find in the first place.
  const n = inspectNotifier();
  if (!n.supported) {
    console.log(`  notifier: ${chalk.dim('n/a (macOS only)')}`);
  } else if (n.bundlePresent) {
    // Currency is reported for the SAME reason the wrapper and plist report it,
    // and it was missing here: the bundle is rebuilt only by `automations
    // install`, so a CLI upgrade that changes the applet leaves the old one
    // running with nothing to say so — a notifier fix that outlives its own fix.
    console.log(`  notifier: present${n.scriptCurrent ? ', current' : ''} at ${n.bundlePath}`);
    if (!n.scriptCurrent) {
      warn('  the installed notifier is STALE — it was built by an older dreamcontext.');
      console.log(chalk.dim('    re-run `dreamcontext automations install` to rebuild it.'));
    }
    if (n.queuedPayloads > 0) {
      console.log(chalk.dim(`    ${n.queuedPayloads} queued payload(s) not yet drained`));
    }
    console.log(chalk.dim('    if notifications never appear, allow "dreamcontext" in System Settings > Notifications'));
  } else {
    console.log(`  notifier: ${chalk.dim('absent')} — automations fall back to a generic system icon`);
    if (!n.iconPackaged) console.log(chalk.dim('    (assets/notify-icon.icns missing from this install)'));
  }
}

export function registerAutomationsCommand(program: Command): void {
  const automations = program
    .command('automations')
    .description('Scheduled headless claude runs — user-authored, ships fully disabled until installed and approved');

  automations
    .command('create')
    .argument('<slug>', 'Kebab-case automation slug (e.g. eod-digest)')
    .description('Scaffold a new automation manifest, auto-approved on this machine')
    .requiredOption('--title <title>', 'Automation title')
    .requiredOption('--days <daily|mon,wed>', 'Schedule days: "daily" or a comma list of weekdays')
    .requiredOption('--at <HH:MM>', 'Schedule time, 24h local (e.g. 18:00)')
    .option('--model <model>', 'Model override (default: let claude pick)')
    .option('--effort <level>', `Reasoning effort: ${EFFORT_LEVELS.join('|')} (default: let claude pick)`)
    .option('--timeout <minutes>', `Timeout in minutes, 1-${MAX_TIMEOUT_MINUTES} (default ${DEFAULT_TIMEOUT_MINUTES})`)
    .option('--catchup <hours>', `Catch-up window in hours, 1-${MAX_CATCHUP_HOURS} (default ${DEFAULT_CATCHUP_HOURS})`)
    .option('--prompt-file <path>', 'Read the ## Prompt body from this file instead of the scaffold stub')
    .option('--disabled', 'Create disabled (enabled: false)')
    .option('--shared', 'Publish this automation (manifest, cache, output) to the synced brain — private by default')
    .option('--no-notify', 'Stay silent when a scheduled run finishes (notifies on completion by default)')
    .option('--no-learning', 'Do not keep a pattern — the run reads no notes and records no lessons (learns by default)')
    .option(
      '--review <mode>',
      `Stop and ask a human before the work takes effect: ${REVIEW_MODES.join('|')} (default off)`,
    )
    .action((slug: string, opts: {
      title: string; days: string; at: string; model?: string; effort?: string; timeout?: string;
      catchup?: string; promptFile?: string; disabled?: boolean; shared?: boolean; notify?: boolean;
      learning?: boolean; review?: string;
    }) => {
      const root = ensureContextRoot();
      try {
        const days = parseDaysFlag(opts.days);
        const effort = parseEffortFlag(opts.effort);
        let prompt: string | undefined;
        if (opts.promptFile) {
          if (!existsSync(opts.promptFile)) {
            throw new AutomationError(`--prompt-file not found: ${opts.promptFile}`);
          }
          prompt = readFileSync(opts.promptFile, 'utf-8');
        }
        const manifest = createAutomation(root, {
          slug,
          title: opts.title,
          days,
          at: opts.at,
          model: opts.model ?? null,
          effort,
          timeoutMinutes: opts.timeout ? Number(opts.timeout) : undefined,
          catchupHours: opts.catchup ? Number(opts.catchup) : undefined,
          prompt,
          enabled: !opts.disabled,
          shared: !!opts.shared,
          // Commander sets `notify: false` for `--no-notify` and leaves it
          // `true` otherwise, so pass it through rather than coercing — `!!` here
          // would be identical today but would silently flip the default if the
          // flag were ever renamed to a plain `--notify`.
          notify: opts.notify,
          // Same Commander shape as `notify`. Written EXPLICITLY into every new
          // manifest rather than left to the read default, which is false — see
          // the field's comment in types.ts for why those two differ.
          learning: opts.learning,
          // Validated in the store's strict write path, so a typo'd mode is a
          // refusal here rather than a gate the owner believes they installed.
          review: opts.review as ReviewMode | undefined,
        });

        const projectRoot = projectRootFor(root);
        registerProject(projectRoot);
        approveAutomation(projectRoot, manifest, new Date());

        success(`Automation created: automations/${manifest.slug}.md (auto-approved on this machine).`);
        console.log(chalk.dim('  Private by default — nothing publishes unless you `automations share` it. No secrets'));
        console.log(chalk.dim('  in the manifest either way: a SHARED automation\'s outputs are brain-synced, and the'));
        console.log(chalk.dim('  pre-push scrub blocks credential-SHAPED strings, but PII/hostnames/bespoke tokens'));
        console.log(chalk.dim('  pass through, and `sleep done` auto-pushes when brain sync is on.'));
        if (!existsSync(dispatcherPlistPath())) {
          warn('The launchd dispatcher is not installed — run `dreamcontext automations install` so this can fire on schedule.');
        }
        console.log(chalk.dim(`  Edit its ## Prompt / ## Output instructions, then \`dreamcontext automations run ${manifest.slug} --force\` to test it live.`));

        if (opts.shared) {
          const result = shareAutomation(root, manifest.slug);
          printPublishedPaths(manifest.slug, result);
        }

        const repaired = repairStrayNegations(root);
        for (const line of repaired) {
          warn(`Auto-repaired: removed stray sharing entry "${line}" — that automation is flagged private.`);
        }
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('list')
    .description('List automations with schedule, approval, and last-run status')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);

      const repaired = repairStrayNegations(root);
      for (const line of repaired) {
        warn(`Auto-repaired: removed stray sharing entry "${line}" — that automation is flagged private.`);
      }

      const manifests = listAutomations(root);

      if (opts.json) {
        const rows = manifests.map((m) => ({
          ...m,
          cache: readAutomationCache(root, m.slug),
          approved: checkApproval(projectRoot, m).approved,
          shareState: shareStateFor(root, m),
        }));
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      console.log(header('Automations'));
      if (manifests.length === 0) {
        console.log(chalk.dim('  (none yet — dreamcontext automations create <slug> --title "..." --days daily --at 18:00)'));
        return;
      }
      for (const m of manifests) {
        const cache = readAutomationCache(root, m.slug);
        const approval = checkApproval(projectRoot, m);
        const enabledBadge = m.enabled ? '' : chalk.dim(' (disabled)');
        const approvalBadge = approval.approved ? '' : chalk.red(` ⚠ ${approval.reason}`);
        const statusBit = cache?.status ? ` · last: ${cache.status}` : ' · never run';
        const { badge, warning } = describeShareState(shareStateFor(root, m), m.slug);
        console.log(`  ${chalk.magentaBright(m.slug)} — ${m.title} · ${formatSchedule(m.schedule)}${enabledBadge}${statusBit}${approvalBadge} · ${badge}`);
        if (warning) warn(`    ${warning}`);
      }
    });

  automations
    .command('show')
    .argument('<slug>', 'Automation slug')
    .description('Show one automation\'s manifest, cache, approval, and orphan state')
    .option('--json', 'Emit as JSON')
    .option('--history <n>', 'Number of history entries to show (default 5)')
    .action((slug: string, opts: { json?: boolean; history?: string }) => {
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);

      const repaired = repairStrayNegations(root);
      for (const line of repaired) {
        warn(`Auto-repaired: removed stray sharing entry "${line}" — that automation is flagged private.`);
      }

      const manifest = requireAutomation(root, slug);
      if (!manifest) return;

      const cache = readAutomationCache(root, slug);
      const approval = checkApproval(projectRoot, manifest);
      const sidecar = readRunSidecar(root, slug);
      const shareState = shareStateFor(root, manifest);
      const historyLimit = opts.history ? Number(opts.history) : 5;

      if (opts.json) {
        console.log(JSON.stringify({
          manifest,
          cache,
          approved: approval.approved,
          approvalReason: approval.approved ? null : approval.reason,
          sidecar,
          shareState,
        }, null, 2));
        return;
      }

      console.log(header(`Automation: ${slug}`));
      console.log(`  title: ${manifest.title}`);
      console.log(`  schedule: ${formatSchedule(manifest.schedule)}`);
      console.log(`  enabled: ${manifest.enabled}`);
      console.log(`  model: ${manifest.model ?? '(default)'}`);
      console.log(`  effort: ${manifest.effort ?? '(default)'}`);
      console.log(`  timeout: ${manifest.timeoutMinutes}m · catchup: ${manifest.catchupHours}h`);
      console.log(`  notify: ${manifest.notify ? 'on completion' : chalk.dim('off')}`);
      {
        const pattern = readPattern(manifest);
        const learned = pattern.lessons.length;
        const playbook = pattern.playbook ? 'playbook' : null;
        const parts = [playbook, learned > 0 ? `${learned} lesson${learned === 1 ? '' : 's'}` : null].filter(Boolean);
        console.log(
          `  learning: ${manifest.learning
            ? `on${parts.length > 0 ? ` · ${parts.join(', ')}` : chalk.dim(' · nothing learned yet')}`
            : chalk.dim('off')}`,
        );
        if (manifest.learning && pattern.lessons.length > 0) {
          console.log('  pattern:');
          for (const lesson of pattern.lessons.slice(0, 3)) {
            console.log(chalk.dim(`    [${lesson.date}] ${lesson.text}`));
          }
          if (pattern.lessons.length > 3) {
            console.log(chalk.dim(`    … ${pattern.lessons.length - 3} more in automations/${slug}.md`));
          }
        }
      }
      {
        const card = pendingReviewCard(root, slug);
        console.log(
          `  review: ${manifest.review === 'off'
            ? chalk.dim('off — this automation acts without a human verdict')
            : manifest.review === 'output'
              ? 'output — every document waits for your verdict'
              : 'agent — the run decides when to stop and ask'}`,
        );
        // Rendered right under the mode, not buried in the history: this is the
        // reason the automation is not running, and a `show` that made you infer
        // that from an `awaiting-review` history entry would be hiding the lede.
        if (card) {
          warn(`  awaiting your verdict — "${card.title}" (card ${card.id})`);
          console.log(chalk.dim(`    it will not run again until you answer — \`dreamcontext automations review ${slug}\``));
        }
      }
      console.log(`  approval: ${approval.approved ? chalk.green('approved') : chalk.red(`NOT approved (${approval.reason})`)}`);
      {
        const { badge, warning } = describeShareState(shareState, slug);
        console.log(`  sharing: ${badge}`);
        if (shareState === 'shared') {
          console.log(chalk.dim(`    published: automations/${slug}.md, automations/cache/${slug}.json, automations/output/${slug}/*`));
        }
        if (warning) warn(`  ${warning}`);
      }

      if (cache) {
        console.log(`  last run: ${cache.lastRunAt ?? '(never)'} · status: ${cache.status ?? '—'}`);
        if (cache.error) console.log(chalk.red(`  error: ${cache.error}`));
        const recent = cache.history.slice(0, historyLimit);
        if (recent.length > 0) {
          console.log('  history:');
          for (const ev of recent) {
            console.log(`    ${ev.firedAt} — ${ev.status}${ev.error ? `: ${ev.error}` : ''}`);
          }
        }
      } else {
        console.log(chalk.dim(`  (never run — \`dreamcontext automations run ${slug} --force\`)`));
      }

      // Read-only orphan-liveness line. Gated on the RUNNER also being dead
      // (not just "a sidecar exists") — a sidecar with an ALIVE runner means a
      // legitimate run is simply in progress right now, and suggesting `kill`
      // there would be the exact footgun this whole subsystem's "never guess
      // a target" design argues against. This is a narrower, safer condition
      // than a literal two-way split on group-liveness alone.
      if (sidecar) {
        const groupAlive = isAlive(sidecar.childPgid);
        const runnerAlive = isAlive(sidecar.runnerPid);
        if (!groupAlive) {
          console.log(chalk.dim(`  stale run record (child group no longer alive) — pgid ${sidecar.childPgid}, started ${sidecar.startedAt}`));
        } else if (!runnerAlive) {
          warn(`a previous run's child group (pgid ${sidecar.childPgid}, started ${sidecar.startedAt}) is still alive — \`dreamcontext automations kill ${slug}\``);
        } else {
          console.log(chalk.dim(`  currently running (pgid ${sidecar.childPgid}, started ${sidecar.startedAt}) — not an orphan, leave it to finish.`));
        }
      }
    });

  automations
    .command('pattern')
    .argument('<slug>', 'Automation slug')
    .description('Show what this automation has learned — its playbook and lesson ledger')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = requireAutomation(root, slug);
      if (!manifest) return;
      const pattern = readPattern(manifest);

      if (opts.json) {
        console.log(JSON.stringify({ slug, learning: manifest.learning, ...pattern }, null, 2));
        return;
      }

      console.log(header(`Pattern: ${slug}`));
      if (!manifest.learning) {
        console.log(chalk.dim('  learning is off — nothing reads or writes this pattern.'));
      }
      if (pattern.playbook) {
        console.log(pattern.playbook.split('\n').map((l) => `  ${l}`).join('\n'));
        console.log('');
      }
      if (pattern.lessons.length === 0) {
        console.log(chalk.dim('  No lessons recorded yet.'));
        return;
      }
      console.log(`  ${chalk.dim(`Lessons (${pattern.lessons.length}/${PATTERN_LESSON_LIMIT}, newest first)`)}`);
      for (const lesson of pattern.lessons) {
        console.log(`    ${chalk.dim(`[${lesson.date}]`)} ${lesson.text}`);
      }
    });

  automations
    .command('learn')
    .argument('<slug>', 'Automation slug')
    .description('Record what a run learned into this automation\'s pattern (the run calls this itself)')
    .option('--lesson <text>', 'One line: what you learned that makes the next run more accurate')
    .option('--playbook <text>', 'Replace the standing playbook (how this job is best done)')
    .option('--playbook-file <path>', 'Read the playbook from a file instead')
    .action((slug: string, opts: { lesson?: string; playbook?: string; playbookFile?: string }) => {
      const root = ensureContextRoot();
      try {
        const manifest = requireAutomation(root, slug);
        if (!manifest) return;
        // Refusing when learning is off is the honest answer, not pedantry: a
        // pattern nothing ever reads is a file that quietly accumulates while
        // the operator believes the automation is improving.
        if (!manifest.learning) {
          warn(`"${slug}" has learning off — nothing would ever read this pattern.`);
          console.log(chalk.dim(`  Set \`learning: true\` in automations/${slug}.md, then re-approve (it is a hashed field).`));
          process.exitCode = 1;
          return;
        }
        let playbook = opts.playbook;
        if (opts.playbookFile) {
          if (!existsSync(opts.playbookFile)) {
            throw new AutomationError(`--playbook-file not found: ${opts.playbookFile}`);
          }
          playbook = readFileSync(opts.playbookFile, 'utf-8');
        }
        const updated = recordLesson(root, slug, { lesson: opts.lesson, playbook });
        const pattern = readPattern(updated);
        success(`Pattern updated for "${slug}".`);
        if (opts.lesson) {
          console.log(chalk.dim(`  lessons: ${pattern.lessons.length}/${PATTERN_LESSON_LIMIT}${pattern.lessons.length >= PATTERN_LESSON_LIMIT ? ' (oldest dropping off)' : ''}`));
        }
        if (playbook !== undefined) console.log(chalk.dim('  playbook rewritten.'));
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('propose')
    .argument('<slug>', 'Automation slug')
    .description('Stop and ask a human before acting (a run calls this about itself; it cannot be called by hand)')
    .option('--title <text>', 'What you are proposing, in a few words')
    .option('--summary <text>', 'One line for the notification banner (default: the body\'s first line)')
    .option('--body <text>', 'What the human judges: the proposed document, or what you want to do next')
    .option('--body-file <path>', 'Read the body from a file instead')
    .action((slug: string, opts: { title?: string; summary?: string; body?: string; bodyFile?: string }) => {
      const root = ensureContextRoot();
      try {
        const manifest = requireAutomation(root, slug);
        if (!manifest) return;
        // Refusing under `review: off` is the same honesty as `learn` refusing
        // when learning is off: a card nobody is watching for is a run that
        // stops and waits forever, and this automation's manifest says plainly
        // that it does not do that.
        if (manifest.review === 'off') {
          warn(`"${slug}" has review off — a card would be created that nothing is watching for.`);
          console.log(chalk.dim(`  Set \`review: agent\` in automations/${slug}.md, then re-approve (it is a hashed field).`));
          process.exitCode = 1;
          return;
        }
        let body = opts.body;
        if (opts.bodyFile) {
          if (!existsSync(opts.bodyFile)) throw new AutomationError(`--body-file not found: ${opts.bodyFile}`);
          body = readFileSync(opts.bodyFile, 'utf-8');
        }
        if (!opts.title?.trim() || !body?.trim()) {
          error('A proposal needs both --title and --body (or --body-file).');
          process.exitCode = 1;
          return;
        }
        const result = proposeFromRun(root, slug, { title: opts.title, summary: opts.summary, body });
        if (!result.ok) {
          error(result.reason);
          process.exitCode = 1;
          return;
        }
        success(`Proposal recorded for "${slug}" — waiting for a human verdict.`);
        console.log(chalk.dim(`  card ${result.card.id}`));
        console.log(chalk.dim('  Stop here. Your session stays on disk; the verdict resumes it.'));
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('review')
    .argument('[slug]', 'Automation slug (omit to list every proposal awaiting a verdict)')
    .description('Answer a proposal a run stopped to ask about: approve, reject, reject-forever, or correct it in words')
    .option('--approve', 'Carry it out')
    .option('--discard', 'Reject this one')
    .option('--drop', 'Reject it, and teach the automation never to propose this again')
    .option('--steer <text>', 'Correct it in plain language — it is rewritten and comes BACK to you, not sent')
    .action(async (slug: string | undefined, opts: { approve?: boolean; discard?: boolean; drop?: boolean; steer?: string }) => {
      const root = ensureContextRoot();

      // No slug ⇒ the queue. This is the answer to "what am I holding up?", and
      // it must work with no arguments, because the person asking it has just
      // been told by a snapshot that something is waiting and does not
      // necessarily know which automation.
      if (!slug) {
        const open = allPendingReviewCards(root);
        if (open.length === 0) {
          console.log(chalk.dim('  Nothing is waiting for a verdict.'));
          return;
        }
        console.log(header(`Awaiting your verdict (${open.length})`));
        for (const card of open) {
          console.log(`  ${chalk.bold(card.slug)} — ${card.title}`);
          if (card.summary) console.log(chalk.dim(`    ${card.summary}`));
          console.log(chalk.dim(`    ${card.createdAt} · card ${card.id} · \`dreamcontext automations review ${card.slug}\``));
        }
        return;
      }

      const manifest = requireAutomation(root, slug);
      if (!manifest) return;
      const card = pendingReviewCard(root, slug);
      if (!card) {
        console.log(chalk.dim(`  "${slug}" has nothing awaiting a verdict.`));
        const answered = listReviewCards(root, slug).filter((c) => c.state !== 'pending');
        if (answered.length > 0) {
          const last = answered[answered.length - 1];
          console.log(chalk.dim(`  last answered: ${last.title} → ${last.state} (${last.resolvedAt ?? '?'})`));
        }
        return;
      }

      const chosen = [opts.approve && 'approve', opts.discard && 'discard', opts.drop && 'drop', opts.steer && 'steer']
        .filter(Boolean) as string[];
      if (chosen.length > 1) {
        error(`Pick one: ${chosen.join(', ')} were all given.`);
        process.exitCode = 1;
        return;
      }

      // No verdict flag ⇒ SHOW the proposal. Reading is the default because a
      // verdict given without reading is the failure this whole feature exists
      // to prevent — the flags are how you answer, never how you look.
      if (chosen.length === 0) {
        console.log(header(`${manifest.title} — awaiting your verdict`));
        console.log(`  ${chalk.bold(card.title)}`);
        console.log(chalk.dim(`  proposed ${card.createdAt} · card ${card.id}`));
        if (card.stagedPath) console.log(chalk.dim(`  staged at ${card.stagedPath}`));
        console.log('');
        console.log(card.body.split('\n').map((l) => `  ${l}`).join('\n'));
        if (card.steers.length > 0) {
          console.log('');
          console.log(chalk.dim(`  ${card.steers.length} correction(s) so far:`));
          for (const s of card.steers) {
            console.log(chalk.dim(`    → "${s.text}"${s.lesson ? ` · learned: ${s.lesson}` : ''}`));
          }
        }
        console.log('');
        console.log(chalk.dim(`  --approve · --discard · --drop · --steer "<what to change>"`));
        if (!card.sessionId) {
          warn('  This proposal has no resumable session — it can be discarded, but not approved or corrected.');
        }
        return;
      }

      try {
        const outcome = opts.steer
          ? await applySteer(root, card, opts.steer, 'cli')
          : await resumeWithVerdict(root, card, opts.approve ? 'approve' : opts.discard ? 'discard' : 'drop', 'cli');

        if (outcome.status === 'refused' || outcome.status === 'not-spawned') {
          error(outcome.error ?? 'refused');
          process.exitCode = 1;
          return;
        }
        if (outcome.status !== 'ok') {
          warn(`${outcome.error ?? outcome.status}`);
          process.exitCode = 1;
          return;
        }

        if (opts.steer) {
          success('Rewritten — still waiting for your verdict.');
          console.log('');
          console.log((outcome.result ?? '').split('\n').map((l) => `  ${l}`).join('\n'));
          // The Concierge moment: the human sees the rule they just created, in
          // words, at the instant they created it. Without it, steering feels
          // like correcting the same thing forever.
          if (outcome.lesson) console.log(chalk.dim(`\n  🧠 Learned: «${outcome.lesson}»`));
          console.log(chalk.dim(`\n  \`dreamcontext automations review ${slug} --approve\` when it is right.`));
        } else {
          success(`${outcome.card.state}.`);
          if (outcome.card.resolutionNote) console.log(chalk.dim(`  ${outcome.card.resolutionNote}`));
          if (outcome.lesson) console.log(chalk.dim(`  🧠 Learned: «${outcome.lesson}»`));
        }
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  const telegram = automations
    .command('telegram')
    .description('Answer review cards from your phone (machine-local bot token; never synced)');

  telegram
    .command('setup')
    .description('Point a Telegram bot at this machine so cards reach you where you already are')
    .requiredOption('--token <token>', 'Bot token from @BotFather')
    .requiredOption('--chat <id>', 'Your chat id — the ONLY chat allowed to answer cards')
    .action(async (opts: { token: string; chat: string }) => {
      const root = ensureContextRoot();
      writeTelegramConfig({ botToken: opts.token.trim(), chatId: String(opts.chat).trim(), offset: 0 });
      success(`Telegram configured — ${telegramConfigPath()} (0600, machine-local, never synced).`);
      console.log(chalk.dim('  This token can resume a bypassPermissions session on this machine.'));
      console.log(chalk.dim('  It is deliberately NOT in the brain: a synced token would hand that to every teammate.'));
      const state = describeTelegram(root);
      if (state.pending > 0) {
        console.log(chalk.dim(`  ${state.pending} card(s) already waiting — they post on the next tick, or run \`automations telegram test\`.`));
      }
    });

  telegram
    .command('test')
    .description('Post any waiting cards now and report what the channel can see')
    .action(async () => {
      const root = ensureContextRoot();
      const cfg = readTelegramConfig();
      if (!cfg) {
        error('Telegram is not configured — run `dreamcontext automations telegram setup --token <t> --chat <id>`.');
        process.exitCode = 1;
        return;
      }
      const before = describeTelegram(root);
      console.log(header('Telegram channel'));
      console.log(`  chat: ${cfg.chatId}`);
      console.log(`  cards waiting: ${before.pending} (${before.posted} already posted)`);
      const posted = await emitPendingCards(root, cfg);
      const result = await pollTelegram(root);
      success(`Posted ${posted} card(s); handled ${result.processed} update(s).`);
      if (result.unauthorized > 0) {
        warn(`  ${result.unauthorized} update(s) came from a chat that is NOT yours and were dropped.`);
      }
    });

  telegram
    .command('off')
    .description('Forget the bot token and stop the channel (cards stay answerable everywhere else)')
    .action(() => {
      const path = telegramConfigPath();
      if (!existsSync(path)) {
        console.log(chalk.dim('  Telegram was not configured.'));
        return;
      }
      rmSync(path, { force: true });
      success('Telegram channel off — token removed from this machine.');
      console.log(chalk.dim('  Cards are unaffected: the dashboard and `dreamcontext automations review` still answer them.'));
    });

  automations
    .command('session')
    .argument('<slug>', 'Automation slug')
    .description('Show the claude session a run actually had — its turns, tool calls, and errors')
    .option('--run <n>', 'Which run, newest first (default: the most recent one that has a session)')
    .option('--path', 'Print only the transcript path')
    .option('--json', 'Emit the parsed session as JSON')
    .option('-n, --limit <n>', 'Number of transcript items to show (default 40)')
    .action((slug: string, opts: { run?: string; path?: boolean; json?: boolean; limit?: string }) => {
      const root = ensureContextRoot();
      const manifest = requireAutomation(root, slug);
      if (!manifest) return;

      const cache = readAutomationCache(root, slug);
      const runNumber = opts.run ? Number(opts.run) : undefined;
      if (runNumber !== undefined && (!Number.isInteger(runNumber) || runNumber < 1)) {
        error('--run must be a positive integer (1 = most recent).');
        process.exitCode = 1;
        return;
      }
      const resolved = resolveRunSession(cache, { runNumber });
      if (!resolved) {
        if (runNumber !== undefined) {
          // An explicitly-named run that does not exist is a user error, and
          // exits like every other "no such thing" here (requireAutomation).
          // "Never run at all" is not — it is a true, unremarkable answer.
          error(`No run #${runNumber} for "${slug}" — \`dreamcontext automations show ${slug}\` lists its history.`);
          process.exitCode = 1;
          return;
        }
        console.log(chalk.dim(`  "${slug}" has never run.`));
        return;
      }

      if (opts.path) {
        if (resolved.transcriptPath) console.log(resolved.transcriptPath);
        else process.exitCode = 1;
        return;
      }

      const digest = resolved.transcriptPath ? readSessionDigest(resolved.transcriptPath) : null;

      if (opts.json) {
        console.log(JSON.stringify({
          slug,
          runNumber: resolved.runNumber,
          event: resolved.event,
          sessionId: resolved.sessionId,
          transcriptPath: resolved.transcriptPath,
          digest,
        }, null, 2));
        return;
      }

      const ev = resolved.event;
      console.log(header(`Session: ${slug} · run #${resolved.runNumber}`));
      console.log(`  fired: ${ev.firedAt} · status: ${ev.status}`);
      if (ev.error) console.log(chalk.red(`  error: ${ev.error}`));
      console.log(`  session: ${resolved.sessionId ?? chalk.dim('(none recorded — the run never reached a claude session)')}`);
      if (ev.costUsd !== null || ev.numTurns !== null) {
        const bits = [
          ev.numTurns !== null ? `${ev.numTurns} turns` : null,
          ev.costUsd !== null ? `$${ev.costUsd.toFixed(4)}` : null,
          ev.permissionDenials > 0 ? chalk.yellow(`${ev.permissionDenials} permission denials`) : null,
        ].filter(Boolean);
        if (bits.length > 0) console.log(`  ${bits.join(' · ')}`);
      }

      if (!resolved.transcriptPath) {
        // A missing transcript is normal, not a fault: `claude` writes one only
        // once a session has produced a turn, and nothing in dreamcontext owns
        // that file's lifetime.
        console.log(chalk.dim('  transcript: not on disk (never written, or pruned by claude).'));
        if (ev.outputPath) console.log(chalk.dim(`  output document: ${ev.outputPath}`));
        return;
      }
      console.log(chalk.dim(`  transcript: ${resolved.transcriptPath}`));
      if (!digest) {
        console.log(chalk.dim('  transcript could not be read.'));
        return;
      }
      const toolSummary = Object.entries(digest.toolCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name}×${n}`)
        .join(' ');
      console.log(`  ${digest.toolCalls} tool calls${toolSummary ? ` (${toolSummary})` : ''}${digest.toolErrors > 0 ? chalk.yellow(` · ${digest.toolErrors} failed`) : ''}`);

      // A non-numeric --limit must fall back to the default, not become NaN —
      // `slice(-NaN)` is `slice(0)`, which silently dumps the whole transcript.
      const parsedLimit = Number(opts.limit);
      const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.floor(parsedLimit) : 40;
      const shown = digest.items.slice(-limit);
      if (shown.length < digest.items.length) {
        console.log(chalk.dim(`  … ${digest.items.length - shown.length} earlier items hidden (--limit ${digest.items.length} for all)`));
      }
      console.log('');
      for (const item of shown) {
        if (item.kind === 'user') {
          console.log(chalk.dim(`  › ${truncateLine(item.text ?? '')}`));
        } else if (item.kind === 'text') {
          console.log(`  ${truncateLine(item.text ?? '')}`);
        } else if (item.kind === 'thinking') {
          console.log(chalk.dim(`  ~ ${truncateLine(item.text ?? '')}`));
        } else if (item.kind === 'tool') {
          const mark = item.status === 'error' ? chalk.red('✗') : chalk.dim('·');
          console.log(`  ${mark} ${chalk.cyan(toolCallLabel(item))}`);
        }
      }
    });

  automations
    .command('run')
    .argument('<slug>', 'Automation slug')
    .description('Run one automation now — dueness and sleep-deference bypassed only with --force')
    .option('-f, --force', 'Bypass dueness and sleep-deference. Never bypasses approval or the orphan guard.')
    .action(async (slug: string, opts: { force?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = requireAutomation(root, slug);
      if (!manifest) return;

      try {
        const now = new Date();
        let fireAt = now;
        if (!opts.force) {
          const cache = readAutomationCache(root, slug);
          const due = isDue(manifest.schedule, cache?.lastFireAt ?? null, now, manifest.catchupHours);
          if (!due.due) {
            warn(`"${slug}" is not due right now (${due.reason}) — pass --force to run anyway.`);
            process.exitCode = 1;
            return;
          }
          fireAt = due.fireAt ?? now;
        }
        const outcome = await runAutomation(root, slug, { force: opts.force, fireAt, now: () => now, host: 'cli' });
        printRunOutcome(outcome);
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('tick')
    .argument('[slug]', 'Tick only this automation (dueness-gated, current project) — omit for the whole project')
    .description('Simulate a dispatcher tick: evaluate dueness and run whatever is due (never forces)')
    .option('-a, --all', 'Tick every project registered on this machine')
    .option('--json', 'Emit the tick result as JSON')
    .action(async (slug: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      if (opts.all) {
        // Machine-scoped: iterates the registry at ~/.dreamcontext/automations.json,
        // never the current project. MUST succeed from ANY cwd — including
        // one with no _dream_context/ at all — because this is exactly how
        // the generated launchd wrapper invokes it (§1.1): the real
        // dispatcher runs with no project directory whatsoever. Deliberately
        // resolved BEFORE any ensureContextRoot() call below, which throws
        // when no brain is found in cwd — that throw is correct for every
        // OTHER verb in this file, but --all must never reach it.
        try {
          const result = await tickAll({ log: opts.json ? undefined : (l) => console.log(chalk.dim(`  ${l}`)) });
          if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
          printTickAllResult(result);
        } catch (err) {
          handleAutomationsError(err);
        }
        return;
      }

      // Everything below operates on THIS project, so a brain is required —
      // matches every other project-scoped verb in this file (create/list/
      // show/run/enable/disable/approve/kill/remove), which all call this
      // unguarded so a missing brain bubbles to main()'s own top-level
      // handler with its existing "_dream_context/ not found" message.
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);

      try {
        if (slug) {
          const manifest = requireAutomation(root, slug);
          if (!manifest) return;

          // Mirror tickProject's own per-manifest decision procedure EXACTLY
          // (tick.ts, frozen/out of scope for this file) — same
          // enabled-before-dueness order, same verdict wording, same log
          // lines. This command's whole purpose is to simulate what a real
          // tick would do for one slug, so it must never decide differently
          // than tickProject would for that same slug — in particular, a
          // disabled automation must never reach isDue/runAutomation at all.
          if (!manifest.enabled) {
            if (opts.json) { console.log(JSON.stringify({ slug, verdict: 'disabled' }, null, 2)); return; }
            console.log(`  ${chalk.magentaBright(slug)}: disabled`);
            return;
          }

          const now = new Date();
          const cache = readAutomationCache(root, slug);
          const due = isDue(manifest.schedule, cache?.lastFireAt ?? null, now, manifest.catchupHours);
          if (!due.due) {
            if (opts.json) { console.log(JSON.stringify({ slug, verdict: due.reason }, null, 2)); return; }
            console.log(`  ${chalk.magentaBright(slug)}: ${due.reason}`);
            return;
          }

          const logFn = opts.json ? undefined : (l: string) => console.log(chalk.dim(`  ${l}`));
          logFn?.(`[automations] ${slug} is due (fire ${due.fireAt?.toISOString() ?? 'unknown'}) — running`);
          const outcome = await runAutomation(root, slug, { fireAt: due.fireAt ?? now, now: () => now, host: 'cli', log: logFn });
          logFn?.(`[automations] ${slug} finished: ${outcome.status}`);
          if (opts.json) { console.log(JSON.stringify(outcome, null, 2)); return; }
          printRunOutcome(outcome);
          return;
        }

        const result = await tickProject(projectRoot, {});
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        printTickProjectResult(result);
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('enable')
    .argument('<slug>', 'Automation slug')
    .description('Enable an automation (tick will consider it again)')
    .action((slug: string) => {
      const root = ensureContextRoot();
      try {
        setAutomationEnabled(root, slug, true);
        success(`"${slug}" enabled.`);
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('disable')
    .argument('<slug>', 'Automation slug')
    .description('Disable an automation (tick skips it; approval untouched)')
    .action((slug: string) => {
      const root = ensureContextRoot();
      try {
        setAutomationEnabled(root, slug, false);
        success(`"${slug}" disabled.`);
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('share')
    .argument('<slug>', 'Automation slug')
    .description('Publish this automation (manifest, cache, output) to the synced brain — private by default')
    .action((slug: string) => {
      const root = ensureContextRoot();
      const manifest = requireAutomation(root, slug);
      if (!manifest) return;

      try {
        setAutomationShared(root, slug, true);
        const result = shareAutomation(root, slug);
        printPublishedPaths(slug, result);
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('unshare')
    .argument('<slug>', 'Automation slug')
    .description('Stop publishing this automation from this machine — NOT retroactive, see the warning')
    .option('-y, --yes', 'Skip the interactive confirmation')
    .action(async (slug: string, opts: { yes?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = requireAutomation(root, slug);
      if (!manifest) return;

      console.log(header(`Unshare: ${slug}`));
      for (const line of unshareWarningLines(slug)) warn(line);

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          error(`Refusing to unshare "${slug}" non-interactively without --yes.`);
          process.exitCode = 1;
          return;
        }
        const confirmed = await confirm({ message: `Stop publishing "${slug}" from this machine?`, default: false });
        if (!confirmed) {
          warn('Not unshared.');
          return;
        }
      }

      try {
        setAutomationShared(root, slug, false);
        const result = unshareAutomation(root, slug);
        success(`"${slug}" will no longer publish from this machine.`);
        for (const line of result.removed) console.log(chalk.dim(`  removed: ${line}`));
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('approve')
    .argument('<slug>', 'Automation slug')
    .description('Review and approve an automation to run on this machine')
    .option('-y, --yes', 'Skip the interactive confirmation')
    .action(async (slug: string, opts: { yes?: boolean }) => {
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);
      const manifest = requireAutomation(root, slug);
      if (!manifest) return;

      try {
        const verdict = checkApproval(projectRoot, manifest);
        if (verdict.approved) {
          success(`"${slug}" is already approved (${verdict.entry.approvedAt}) — nothing has changed since.`);
          return;
        }

        console.log(header(`Approve: ${slug}`));
        if (verdict.reason === 'payload-format-changed') {
          warn('The approval format itself changed — this is not a normal manifest edit. Re-review in full.');
        } else if (verdict.reason === 'manifest-changed') {
          warn(`"${slug}" was edited since it was last approved — review every field below before approving.`);
        }

        // The registry stores only a sha256 of the hashed fields — never
        // their PRIOR values — so there is no persisted "old" text to diff
        // against. Rather than fabricate a changed/unchanged mark this data
        // cannot support, every review shows the CURRENT value of every
        // hashed field, every time. This is the more conservative of the two:
        // reviewing only the prompt is exactly the reflexive-approval failure
        // this command exists to prevent (a `timeoutMinutes` or `outputDir`
        // change hiding behind "the prompt looks the same") — showing every
        // field in full cannot miss a change in any of them.
        const fields = approvalFields(manifest);
        for (const key of APPROVAL_DIFF_FIELDS) {
          const value = fields[key];
          console.log(chalk.dim(`  ${key}:`));
          console.log(`    ${value === null || value === '' ? chalk.dim('(none)') : String(value)}`);
        }

        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            error(`Refusing to approve "${slug}" non-interactively without --yes.`);
            process.exitCode = 1;
            return;
          }
          const confirmed = await confirm({ message: `Approve "${slug}" to run on this machine?`, default: false });
          if (!confirmed) {
            warn('Not approved.');
            return;
          }
        }

        approveAutomation(projectRoot, manifest, new Date());
        success(`"${slug}" approved.`);
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('kill')
    .argument('<slug>', 'Automation slug')
    .description('Kill a previous run\'s orphaned process group, read from its sidecar (never guesses with pgrep/pkill)')
    .option('-y, --yes', 'Skip the interactive confirmation')
    .option('--force', 'Kill even if the sidecar is old enough that its pgid may have been recycled')
    .action(async (slug: string, opts: { yes?: boolean; force?: boolean }) => {
      const root = ensureContextRoot();
      if (!getAutomation(root, slug)) {
        error(`No such automation: ${slug}`);
        process.exitCode = 1;
        return;
      }

      const sidecar = readRunSidecar(root, slug);
      if (!sidecar) {
        success(`"${slug}": no in-flight or orphaned run recorded — nothing to kill.`);
        return;
      }

      const groupAlive = isAlive(sidecar.childPgid);
      const runnerAlive = isAlive(sidecar.runnerPid);
      const ageMs = Date.now() - Date.parse(sidecar.startedAt);
      const ageMin = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null;

      console.log(header(`Kill: ${slug}`));
      console.log(`  process group: ${sidecar.childPgid}`);
      console.log(`  started: ${sidecar.startedAt}${ageMin !== null ? ` (${ageMin}m ago)` : ''}`);
      console.log(`  group alive: ${groupAlive}`);
      console.log(`  recorded runner alive: ${runnerAlive}`);
      if (!groupAlive) {
        console.log(chalk.dim('  the process group is already gone — this will just clear the stale record.'));
      }

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          error(`Refusing to kill "${slug}"'s process group non-interactively without --yes.`);
          process.exitCode = 1;
          return;
        }
        const confirmed = await confirm({ message: `SIGKILL process group ${sidecar.childPgid}?`, default: false });
        if (!confirmed) {
          warn('Not killed.');
          return;
        }
      }

      const result: KillRunResult = killRunGroup(root, slug, { force: opts.force });
      if (!result.found) {
        success(`"${slug}": the run finished or the record cleared on its own — nothing to kill.`);
        return;
      }
      if (result.refusedReason) {
        error(result.refusedReason);
        process.exitCode = 1;
        return;
      }
      if (result.killed) {
        success(`"${slug}": process group ${result.childPgid} killed and cleared.`);
      } else {
        warn(`"${slug}": not killed.`);
      }
    });

  automations
    .command('remove')
    .argument('<slug>', 'Automation slug')
    .description('Delete an automation manifest and its machine-local cache/lock/sidecar (approval revoked too)')
    .option('-y, --yes', 'Skip the interactive confirmation')
    .option('--purge-output', 'Also delete this automation\'s output directory')
    .action(async (slug: string, opts: { yes?: boolean; purgeOutput?: boolean }) => {
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);
      if (!getAutomation(root, slug)) {
        error(`No such automation: ${slug}`);
        process.exitCode = 1;
        return;
      }

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          error(`Refusing to remove "${slug}" non-interactively without --yes.`);
          process.exitCode = 1;
          return;
        }
        const confirmed = await confirm({
          message: `Delete automation "${slug}"${opts.purgeOutput ? ' AND its output directory' : ''}? This cannot be undone.`,
          default: false,
        });
        if (!confirmed) {
          warn('Not removed.');
          return;
        }
      }

      try {
        removeAutomation(root, slug, { purgeOutput: opts.purgeOutput });
        revokeApproval(projectRoot, slug);
        // Rule 5 — remove also unshares, leaving no stray negations behind.
        // Called unconditionally (not gated on the manifest's last-read
        // `shared` value): the manifest is already deleted by this point, so
        // there is nothing left to trust for that flag anyway, and
        // `unshareAutomation` is a safe no-op when no negation exists.
        const shareResult = unshareAutomation(root, slug);
        for (const line of shareResult.removed) console.log(chalk.dim(`  removed sharing entry: ${line}`));
        success(`"${slug}" removed.`);
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('install')
    .description('Install the launchd dispatcher (ticks every 5 minutes)')
    .option('--check', 'Inspect only — writes nothing')
    .option('-f, --force', 'Install even if the resolved CLI does not match the one running this command')
    .action(async (opts: { check?: boolean; force?: boolean }) => {
      try {
        if (opts.check) {
          const check = await inspectDispatcher();
          printInstallCheck(check);
          return;
        }
        const result = await installDispatcher({ force: opts.force });
        for (const w of result.warnings) warn(w);
        if (result.method === 'none' && !result.bootstrapped) {
          process.exitCode = 1;
          return;
        }
        success(`Dispatcher installed (${result.method}) — logs at ${result.check.logPath}`);

        // Notifier setup rides `install` rather than the run path: building a
        // bundle means osacompile + codesign + lsregister, which has no business
        // running while an automation is trying to finish. A failure here is not
        // fatal — runs fall back to a generic system icon and still notify.
        const built = buildNotifierApp();
        if (!built.built) {
          warn(`Branded notifications unavailable (${built.reason}) — runs will notify with a generic system icon.`);
        } else {
          success('Notifier installed — automations will notify as "dreamcontext".');
          // Prime the permission prompt NOW, while a human is watching. macOS
          // does not error on an unauthorised notification: it files it away
          // invisibly, so without this step the first real failure of an
          // unattended run is a notification that never appears and never
          // explains itself.
          notifyViaBundle('dreamcontext', 'Notifications are set up. Allow them if macOS just asked.', undefined, {
            sound: NOTIFY_SOUND_OK,
          });
          console.log(chalk.dim('  A test notification was sent. If macOS asked for permission, choose Allow —'));
          console.log(chalk.dim('  until you do, notifications are filed silently and never appear on screen.'));
          // Allowing notifications and hearing them are two different switches,
          // and the second one is easy to spend an afternoon on: the sound IS
          // attached to the notification, macOS just declines to play it.
          console.log(chalk.dim('  Sound is a separate switch: System Settings > Notifications > dreamcontext'));
          console.log(chalk.dim('  > "Play sound for notifications". Allowing alerts does not turn it on.'));
        }
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('uninstall')
    .description('Remove the launchd dispatcher (registry approvals are left untouched)')
    .option('-y, --yes', 'Skip the interactive confirmation')
    .action(async (opts: { yes?: boolean }) => {
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          error('Refusing to uninstall the dispatcher non-interactively without --yes.');
          process.exitCode = 1;
          return;
        }
        const confirmed = await confirm({ message: 'Remove the automations dispatcher?', default: false });
        if (!confirmed) {
          warn('Not removed.');
          return;
        }
      }
      try {
        const result = await uninstallDispatcher();
        const n = removeNotifierApp();
        success(`Dispatcher removed (booted out: ${result.bootedOut}, plist removed: ${result.removedPlist}, wrapper removed: ${result.removedWrapper}).`);
        if (n.removedBundle) {
          success(`Notifier removed${n.removedPayloads > 0 ? ` (${n.removedPayloads} undrained payload(s) discarded)` : ''}.`);
          // Said plainly instead of quietly left behind: the grant is not ours
          // to revoke, so the honest move is to point at where it lives.
          console.log(chalk.dim('  macOS keeps its own notification permission for "dreamcontext" —'));
          console.log(chalk.dim('  remove it in System Settings > Notifications if you want it gone too.'));
        }
      } catch (err) {
        handleAutomationsError(err);
      }
    });

  automations
    .command('logs')
    .description('Tail the dispatcher log')
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .action((opts: { lines?: string }) => {
      const logPath = automationsLogPath();
      if (!existsSync(logPath)) {
        console.log(chalk.dim(`  (no log yet — ${logPath})`));
        return;
      }
      const n = Number(opts.lines) || 50;
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.length > 0);
      console.log(header(`Automations log (last ${n} lines) — ${logPath}`));
      for (const line of lines.slice(-n)) console.log(`  ${line}`);
    });
}
