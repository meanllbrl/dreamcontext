import type { Command } from 'commander';
import { resolveContextRoot } from '../../lib/context-path.js';
import { opsRootFromIntent } from '../../lib/lane-intent.js';
import { OPS_KEYS, readOpsCard, setOpsField, type OpsKey } from '../../lib/ops-card.js';

/** The brain whose card this checkout reads: a delegated worktree's recorded one, else the walk's. */
function opsRoot(): string | null {
  return opsRootFromIntent(process.cwd()) ?? resolveContextRoot();
}

/**
 * The code checkout a script must be tracked in: this one when it is a delegated worktree. From
 * the brain only the path's shape is checked; every reader in a worktree checks it again there.
 */
function codeCheckout(): string | undefined {
  return opsRootFromIntent(process.cwd()) ? process.cwd() : undefined;
}

export function registerOpsCommand(program: Command): void {
  const ops = program
    .command('ops')
    .description('The project\'s working-facts card: staging and preview URLs, basic-auth variable NAMES, the screenshot script (data only, never a command)');

  ops
    .command('show')
    .option('--json', 'Print the checked fields as JSON')
    .description('Print the card\'s fields that pass their checks (a field that fails is left out)')
    .action((opts: { json?: boolean }) => {
      const root = opsRoot();
      if (!root) { process.stderr.write('ops show: no _dream_context/ here\n'); process.exitCode = 2; return; }
      const card = readOpsCard(root, { worktree: codeCheckout() });
      if (opts.json) { process.stdout.write(`${JSON.stringify(card ?? {})}\n`); return; }
      if (!card || Object.keys(card).length === 0) { process.stdout.write('ops: no card yet (dreamcontext ops set staging_url <url>)\n'); return; }
      for (const k of OPS_KEYS) {
        const v = card[k];
        if (v !== undefined) process.stdout.write(`${k}: ${Array.isArray(v) ? v.join(' ') : v}\n`);
      }
    });

  ops
    .command('set')
    .argument('<key>', OPS_KEYS.join(' | '))
    .argument('<value...>', 'The value (auth_env: variable NAMES, never their values)')
    .description('Write one field of the card; each is checked (no secrets, no login in a URL, a tracked script)')
    .action((key: string, value: string[]) => {
      if (!(OPS_KEYS as readonly string[]).includes(key)) { process.stderr.write(`ops set: unknown key "${key}" (${OPS_KEYS.join(', ')})\n`); process.exitCode = 2; return; }
      const root = opsRoot();
      if (!root) { process.stderr.write('ops set: no _dream_context/ here\n'); process.exitCode = 2; return; }
      try {
        setOpsField(root, key as OpsKey, value.join(' '), codeCheckout());
        process.stdout.write(`ops: ${key} set\n`);
      } catch (err) {
        process.stderr.write(`ops set: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
      }
    });
}
