import { Command } from 'commander';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { error, info, success, warn } from '../../lib/format.js';
import { resolveContextRoot } from '../../lib/context-path.js';
import { accountIdsFor, accountLoginLine, launchAccountLogin } from '../../lib/handsfree/account-login.js';
import { createSpawnRunner } from '../../lib/handsfree/git-snapshot.js';
import { laptopEnv } from '../../lib/handsfree/laptop-env.js';
import { readConfig, readCredentials } from '../../lib/handsfree/local-store.js';
import {
  abandonTrip, changePassword, githubDeviceLogin, go, HandsfreeError, resumeTrip, returnTrip, revokeAllDevices, rollbackTrip, setup, status,
  teardown, type HandsfreeEnv, type Progress, type Receipt,
} from '../../lib/handsfree/orchestrator.js';
import { processTurnControl } from '../../lib/handsfree/turns.js';
import { readRosterSurface, writeMergedRosterSurfaceAsync } from '../../server/routes/agent-sessions.js';

/**
 * `dreamcontext handsfree …` — hands-free mode from the terminal. Every subcommand calls the
 * same lib functions as the laptop routes (`src/server/routes/handsfree.ts`). The CLI cannot
 * see the desktop app's live chat registry, so it waits for (or cuts) every `claude` process
 * whose cwd is inside the project instead.
 */

function cliEnv(): HandsfreeEnv {
  const run = createSpawnRunner();
  return laptopEnv({ run, turns: processTurnControl(run), roster: { read: readRosterSurface, write: (c, s) => writeMergedRosterSurfaceAsync(c, s) } });
}

const progress: Progress = (e) => {
  if (e.step === 'waiting') info(`waiting for ${e.detail ?? 'running turns'} (Ctrl+C, then re-run with --cut-running to stop them)`);
  else info(`${e.step}${e.detail ? `: ${e.detail}` : ''}`);
};

function fail(err: unknown): never {
  if (err instanceof HandsfreeError) {
    error(err.message);
    if (err.code === 'quota') console.log(chalk.dim('  Nothing is lost: `dreamcontext handsfree abandon` unlocks this laptop; the cloud work is recovered by the next go.'));
  } else {
    error((err as Error)?.message ?? String(err));
  }
  process.exit(1);
}

function needContextRoot(): string {
  const root = resolveContextRoot();
  if (!root) fail(new HandsfreeError('not_setup', 'run this inside a dreamcontext project (no _dream_context/ found)'));
  return root;
}

async function doubleConfirm(first: string, second: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  return (await confirm({ message: first, default: false })) && (await confirm({ message: second, default: false }));
}

function printReceipt(r: Receipt): void {
  console.log(chalk.bold(`\n  Receipt for trip ${r.tripId}`));
  for (const repo of r.repos) {
    console.log(`  ${chalk.cyan(repo.path)}: ${repo.outcome}`);
    for (const reason of repo.parkReasons) console.log(chalk.yellow(`    parked: ${reason} (cloud refs under refs/handsfree/${r.tripId}/*)`));
    for (const b of repo.branches) console.log(`    ${b.ref}: ${b.from?.slice(0, 8) ?? 'new'} -> ${b.to?.slice(0, 8) ?? 'deleted'}`);
    if (repo.written.length || repo.deleted.length) console.log(`    files: ${repo.written.length} written, ${repo.deleted.length} deleted`);
    for (const c of repo.conflicts) console.log(chalk.yellow(`    conflict: ${c.path} (${c.reason})`));
    for (const w of repo.worktreesAdded) console.log(`    new worktree: ${w}`);
  }
  for (const f of r.files) {
    if (!f.written.length && !f.conflicts.length && !f.deletedInCloud.length && !f.secrets.length && !f.notReturned.length) continue;
    console.log(`  ${chalk.cyan(f.path)}: ${f.written.length} files came home`);
    for (const c of f.conflicts) console.log(chalk.yellow(`    conflict: ${c.path} (${c.reason})`));
    for (const p of f.deletedInCloud) console.log(`    ${p}: ${r.deletedInCloudReason}`);
    for (const p of f.secrets) console.log(`    secret came home: ${p}`);
    for (const p of f.notReturned) console.log(chalk.dim(`    not returned (wiped in the cloud): ${p}`));
  }
  for (const s of r.sessions) {
    if (s.roster) {
      for (const t of s.roster.openedOnPhone) console.log(`  session opened on the phone: ${t}`);
      for (const t of s.roster.closedOnPhone) console.log(`  session closed on the phone: ${t}`);
    }
  }
  for (const a of r.autoExec) console.log(chalk.yellow(`\n  auto-executing config changed: ${a.path}\n${a.diff}`));
  for (const l of r.links) for (const p of l.escaping) console.log(chalk.red(`  symlink escapes its root (left untouched): ${p}`));
  console.log(chalk.dim(`  conflicts: ${r.conflictsDir}\n  backups (Roll back): ${r.backupDir}`));
  const f = r.finalization;
  console.log(`  cloud: secrets ${f.secretsWiped ? 'wiped' : 'NOT wiped yet'}, ${f.sealed ? 'sealed' : 'not sealed yet'}, ${f.stopped ? 'stopped' : 'not stopped yet'}${f.queued.length ? ` (queued for the next contact: ${f.queued.join(', ')})` : ''}\n`);
}

export function registerHandsfreeCommand(program: Command): void {
  const hf = program
    // 0.30.0 ships hands-free unannounced: the commands work, but stay out of --help.
    .command('handsfree', { hidden: true })
    .description('Hands-free mode: move the project to your own cloud machine and drive it from the phone');

  hf.command('setup')
    .description('Sign in to GitHub (repo + codespace), create the private repo and the codespace, print the phone passphrase')
    .option('--machine <type>', 'Codespaces machine type (default basicLinux32gb)')
    .action(async (opts: { machine?: string }) => {
      try {
        const env = cliEnv();
        let creds: { token?: string; login?: string } = {};
        if (!readConfig(env.home)?.owner || !readCredentials(env.home).githubToken) {
          creds = await githubDeviceLogin({
            onCode: (c) => info(`Open ${c.verificationUri} and enter the code ${chalk.bold(c.userCode)} (scopes: repo, codespace)`),
          });
          success(`signed in to GitHub as ${creds.login}`);
        }
        const r = await setup(env, { ...creds, machine: opts.machine, onProgress: progress });
        success(`${r.created ? 'created' : 'kept'} the codespace ${r.codespace.name} (${r.codespace.machine}) from ${r.repo}; it is stopped until your first go`);
        if (r.passphrase) {
          console.log(`\n  Phone passphrase (shown ONCE): ${chalk.bold(r.passphrase)}\n  Change it any time with \`dreamcontext handsfree password\`.\n`);
        }
        info('Sign each Claude account in on the cloud machine: `dreamcontext handsfree account-login --all`');
      } catch (err) { fail(err); }
    });

  hf.command('account-login [id]')
    .description('Sign a Claude account in INSIDE the cloud machine (opens `gh codespace ssh`; nothing is captured or stored)')
    .option('--all', 'every registered Claude account, one after another')
    .option('--print', 'only print the command')
    .action(async (id: string | undefined, opts: { all?: boolean; print?: boolean }) => {
      try {
        const cfg = readConfig();
        if (!cfg?.codespace) throw new HandsfreeError('not_setup', 'run `dreamcontext handsfree setup` first');
        for (const acc of accountIdsFor({ id, all: opts.all })) {
          const line = accountLoginLine(cfg.codespace.name, acc);
          if (opts.print || !process.stdin.isTTY) { console.log(line); continue; }
          info(`${acc}: running ${line}`);
          const code = await launchAccountLogin(cfg.codespace.name, acc);
          if (code !== 0) warn(`${acc}: gh exited with ${code}; run the command above yourself`);
        }
      } catch (err) { fail(err); }
    });

  hf.command('password')
    .description('Generate a new phone passphrase (signs every device out); pending until the cloud confirms')
    .action(async () => {
      try {
        const r = await changePassword(cliEnv());
        console.log(`\n  New phone passphrase (shown ONCE): ${chalk.bold(r.passphrase)}\n`);
        if (r.confirmed) success(`the cloud confirmed generation ${r.generation}`);
        else warn(`pending: the cloud has not confirmed generation ${r.generation} yet${r.error ? ` (${r.error})` : ''}; it is pushed at the next contact`);
      } catch (err) { fail(err); }
    });

  hf.command('go')
    .description('Take the active project to the cloud machine (locks it here until you return)')
    .option('--cut-running', 'stop running turns instead of waiting for them')
    .option('--take-over', 'adopt a cloud machine another (lost) laptop started')
    .action(async (opts: { cutRunning?: boolean; takeOver?: boolean }) => {
      try {
        const env = cliEnv();
        const contextRoot = needContextRoot();
        let confirmLive = false;
        for (;;) {
          try {
            const r = await go(env, { contextRoot, cutRunning: opts.cutRunning, takeOver: opts.takeOver, confirmTakeOverLive: confirmLive, onProgress: progress });
            success(`hands-free: open ${chalk.bold(r.url)} on the phone`);
            if (r.recreated) warn('the codespace was re-created (new URL): re-add the app on the phone');
            for (const s of r.staysHome) console.log(chalk.dim(`  stays on the laptop: ${s.path} (${s.reason})`));
            for (const s of r.cloudRefused) console.log(chalk.yellow(`  the cloud refused ${s.path} (${s.reason})`));
            for (const a of r.signedOutAccounts) warn(`Claude account ${a} is signed out in the cloud: dreamcontext handsfree account-login ${a}`);
            if (r.recovery) info(`recovered the abandoned trip ${r.recovery.oldTrip} into refs/handsfree/${r.recovery.oldTrip}/* and trips/${r.recovery.oldTrip}/orphaned/`);
            for (const w of r.warnings) warn(w);
            return;
          } catch (err) {
            if (err instanceof HandsfreeError && err.code === 'confirm_take_over' && !confirmLive) {
              confirmLive = await doubleConfirm(
                'Another laptop\'s trip is LIVE on the cloud machine. Take it over (its cloud work is recovered here first)?',
                'Really take it over? The other laptop will be unlocked with nothing returned.',
              );
              if (confirmLive) continue;
            }
            throw err;
          }
        }
      } catch (err) { fail(err); }
    });

  hf.command('status')
    .description('Where the project is (home / going / away / returning), the cloud machine, pending verifiers')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const s = await status(cliEnv());
        if (opts.json) { console.log(JSON.stringify(s, null, 2)); return; }
        if (s.unreadable) error(s.unreadable);
        console.log(`  phase: ${chalk.bold(s.phase)}${s.tripId ? ` (trip ${s.tripId})` : ''}`);
        if (!s.setUp) { info('not set up: run `dreamcontext handsfree setup`'); return; }
        console.log(`  cloud: ${s.codespace ? `${s.codespace.name} ${s.codespace.rawState}` : 'gone (the next go re-creates it)'}  ${s.url ?? ''}`);
        if (s.verifier?.pending) warn(`${s.verifier.pending.kind} (generation ${s.verifier.pending.generation}) is pending until the cloud confirms`);
        if (s.queued) warn(`queued for the next contact: ${s.queued.steps.join(', ')}`);
        console.log(`  quota used this month (own count): ${Math.round(s.uptime.usedCoreMinutes / 60)} of ${Math.round(s.uptime.budgetCoreMinutes / 60)} core-hours`);
        for (const w of s.warnings) warn(w);
        console.log(`  you can: ${s.offers.join(', ') || 'repair the state file first'}`);
      } catch (err) { fail(err); }
    });

  hf.command('return')
    .description('Bring every diff, session and file back from the cloud machine')
    .option('--cut-running', 'stop running turns on the phone instead of waiting for them')
    .action(async (opts: { cutRunning?: boolean }) => {
      try {
        const r = await returnTrip(cliEnv(), { cutRunning: opts.cutRunning, onProgress: progress });
        if (r.receipt) printReceipt(r.receipt);
        if (r.message) info(r.message);
        success(`the laptop is ${r.outcome === 'home' ? 'home' : r.outcome}`);
      } catch (err) { fail(err); }
    });

  hf.command('resume')
    .description('Finish an interrupted go or return from its journal')
    .action(async () => {
      try {
        const r = await resumeTrip(cliEnv(), { onProgress: progress });
        if (r.receipt) printReceipt(r.receipt);
        if (r.message) info(r.message);
      } catch (err) { fail(err); }
    });

  hf.command('rollback')
    .description('Undo the interrupted return\'s own writes (back to away; the phone can continue)')
    .action(async () => {
      try {
        const r = await rollbackTrip(cliEnv());
        success(`rolled back ${r.undone.length} step(s); the trip is away again`);
        for (const k of r.kept) warn(`kept ${k.path}: ${k.reason}`);
        if (!r.cloudUnquiesced) info('the cloud could not be told; it reverts on its own');
      } catch (err) { fail(err); }
    });

  hf.command('abandon')
    .description('Unlock the laptop now without returning (the cloud work is recovered by the next go)')
    .action(async () => {
      try {
        if (!(await doubleConfirm('Abandon the trip and unlock this laptop now?', 'Sure? Nothing comes back now; the next go recovers the cloud work first.'))) {
          info('not abandoned');
          return;
        }
        const r = await abandonTrip(cliEnv());
        success(`abandoned ${r.tripId}${r.cloudSealed ? ' (the cloud is sealed)' : ''}`);
      } catch (err) { fail(err); }
    });

  const devices = hf.command('devices').description('Phone devices signed in to the cloud machine');
  devices.command('list')
    .description('What this laptop knows about the phone sign-in (generation, pending changes)')
    .action(async () => {
      try {
        const s = await status(cliEnv(), { probe: false });
        if (!s.verifier) { info('not set up'); return; }
        console.log(`  verifier generation ${s.verifier.generation} (cloud confirmed ${s.verifier.confirmed}); devices stay signed in 30 days`);
        if (s.verifier.pending) warn(`${s.verifier.pending.kind} pending since ${s.verifier.pending.since}`);
      } catch (err) { fail(err); }
    });
  devices.command('revoke')
    .description('Sign every device out (--all)')
    .option('--all', 'every device')
    .action(async (opts: { all?: boolean }) => {
      try {
        if (!opts.all) throw new HandsfreeError('not_setup', 'pass --all (devices are not individually named)');
        const r = await revokeAllDevices(cliEnv());
        if (r.confirmed) success(`every device is signed out (generation ${r.generation})`);
        else warn(`pending: the cloud has not confirmed generation ${r.generation} yet${r.error ? ` (${r.error})` : ''}`);
      } catch (err) { fail(err); }
    });

  hf.command('teardown')
    .description('Delete the cloud machine (recovers abandoned cloud work first)')
    .option('--discard-abandoned-work', 'delete even when abandoned cloud work was never recovered')
    .action(async (opts: { discardAbandonedWork?: boolean }) => {
      try {
        if (opts.discardAbandonedWork && !(await doubleConfirm('Delete the cloud machine WITHOUT recovering abandoned work?', 'That work is gone for good. Continue?'))) return;
        const r = await teardown(cliEnv(), { discardAbandonedWork: opts.discardAbandonedWork, contextRoot: resolveContextRoot() ?? undefined, onProgress: progress });
        if (r.recovery) info(`recovered ${r.recovery.oldTrip} first`);
        success(r.deleted ? `deleted the codespace ${r.deleted}` : 'no codespace to delete');
      } catch (err) { fail(err); }
    });
}
