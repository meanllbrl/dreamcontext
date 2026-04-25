/**
 * mk doctor — env present + FK integrity + retroactive secret-scan + Reinfluence health.
 */
import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { error, success, header, info, warn } from '../../../lib/format.js';
import { isBootstrapped } from '../../../lib/marketing/bootstrap.js';
import { loadEnv, REQUIRED_KEYS, OPTIONAL_KEYS } from '../../../lib/marketing/config.js';
import { listCohorts } from '../../../lib/marketing/cohort.js';
import { health as reinfluenceHealth } from '../../../lib/marketing/competitors.js';
import { redactSecrets } from '../../../lib/marketing/secrets.js';
import { resolveContextRoot } from '../../../lib/context-path.js';

export function registerMarketingDoctor(parent: Command): void {
  parent
    .command('doctor')
    .description('Run diagnostics: env, FK integrity, retroactive secret scan, Reinfluence health.')
    .option('--scan', 'Run retroactive secret scan over the entire _dream_context/ tree', false)
    .action(async (opts: { scan?: boolean }) => {
      console.log(header('Marketing doctor'));
      let issues = 0;

      // 1. Bootstrap
      if (!isBootstrapped()) {
        error('Marketing not bootstrapped. Run `dreamcontext marketing init` first.');
        issues += 1;
      } else {
        success('marketing bootstrap present');
      }

      // 2. Env keys
      console.log();
      console.log(chalk.bold('Environment'));
      const env = loadEnv();
      for (const k of REQUIRED_KEYS) {
        if (env[k] && env[k].trim() !== '') {
          console.log(`  ${chalk.green('✓')} ${k}`);
        } else {
          console.log(`  ${chalk.red('✗')} ${k} ${chalk.red('MISSING')}`);
          issues += 1;
        }
      }
      for (const k of OPTIONAL_KEYS) {
        const present = env[k] && env[k].trim() !== '';
        console.log(`  ${present ? chalk.dim('·') : chalk.dim('·')} ${k} ${chalk.dim(present ? '(set)' : '(unset, optional)')}`);
      }

      // 3. FK integrity across cohorts → campaigns
      console.log();
      console.log(chalk.bold('FK integrity'));
      const cohorts = listCohorts();
      info(`${cohorts.length} cohort(s) on disk`);
      // (Campaign-side store wired in PR 3; for now just check cohort hypotheses are present.)
      for (const c of cohorts) {
        const h = c.hypothesis;
        const ok = h && h.predicted_winner && h.predicted_metric && h.decision_threshold != null && h.kill_condition != null;
        if (!ok) {
          console.log(`  ${chalk.red('✗')} ${c.id}: hypothesis fields missing`);
          issues += 1;
        }
      }
      if (cohorts.length === 0) info('  (no cohorts yet — nothing to check)');

      // 4. Reinfluence health
      console.log();
      console.log(chalk.bold('Reinfluence'));
      const h = reinfluenceHealth();
      for (const c of h.checks) {
        const sym = c.ok ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${sym} ${c.name}${c.detail ? chalk.dim(' — ' + c.detail) : ''}`);
        if (!c.ok) issues += 1;
      }

      // 5. Retroactive secret scan (opt-in)
      if (opts.scan) {
        console.log();
        console.log(chalk.bold('Secret scan'));
        const root = resolveContextRoot();
        if (!root) {
          warn('No _dream_context/ — skipping scan');
        } else {
          const found = scanForSecrets(root);
          if (found.length === 0) {
            success('no leaked secrets detected');
          } else {
            for (const f of found) {
              console.log(`  ${chalk.red('✗')} ${f.path}:${f.line} — ${chalk.dim(f.kind)}`);
              issues += 1;
            }
          }
        }
      } else {
        info('skip --scan to run retroactive secret scan over _dream_context/');
      }

      console.log();
      if (issues === 0) {
        success('doctor: clean');
      } else {
        error(`doctor: ${issues} issue(s) found`);
        process.exitCode = 1;
      }
    });
}

interface SecretHit { path: string; line: number; kind: string; }

function scanForSecrets(root: string): SecretHit[] {
  const hits: SecretHit[] = [];
  // Use the same patterns as redactSecrets — if redaction would change the
  // line, it contains a secret.
  for (const file of walkText(root)) {
    let txt: string;
    try { txt = readFileSync(file, 'utf8'); } catch { continue; }
    if (txt.length === 0) continue;
    const redacted = redactSecrets(txt);
    if (redacted === txt) continue;
    // Find the first differing line
    const origLines = txt.split('\n');
    const redLines = redacted.split('\n');
    for (let i = 0; i < origLines.length; i += 1) {
      if (origLines[i] !== redLines[i]) {
        hits.push({ path: file, line: i + 1, kind: 'redactable secret' });
        break;
      }
    }
  }
  return hits;
}

const SKIP_DIRS = new Set(['.venv', '.tools', '.cache', 'node_modules', '_assets', '_media', '.git', 'dist']);
const TEXT_EXT = new Set(['.md', '.json', '.txt', '.yaml', '.yml', '.ts', '.js', '.py']);

function* walkText(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e.startsWith('.') && (e === '.env' || e === '.env.local')) continue; // never scan .env
    const full = join(dir, e);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(e)) continue;
      yield* walkText(full);
    } else {
      const dot = e.lastIndexOf('.');
      const ext = dot >= 0 ? e.slice(dot) : '';
      if (TEXT_EXT.has(ext)) {
        if (stat.size > 5 * 1024 * 1024) continue;   // skip files >5MB
        yield full;
      }
    }
  }
}
