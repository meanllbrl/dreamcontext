import chalk from 'chalk';
import { createProgram } from './program.js';
import { startInteractive } from './interactive.js';
import { renderBanner } from '../lib/pixel-banner.js';
import { dreamcontextVersion } from '../lib/manifest.js';

/** Re-exported so `src/cli/index.js` stays the one import path anything outside this folder
 *  has ever needed. The tree itself now lives in `program.ts` — see its header for why. */
export { createProgram };

// ─── Logo ────────────────────────────────────────────────────────────────────

function getBanner(): string {
  const logo = renderBanner();
  // Logo visual center is ~col 19 (4-space pad + 15-char center of content)
  const title = `${chalk.bold.cyan('D R E A M')}${chalk.bold.cyanBright('   C O N T E X T')}`;
  const sep = chalk.dim('━'.repeat(25));
  const tagline = chalk.dim('persistent memory for AI agents');
  const text = [
    '',
    `       ${title}`,
    `       ${sep}`,
    `    ${tagline}`,
  ].join('\n');
  return '\n' + logo + text + '\n';
}

async function main() {
  // Root version request. Handled here (not via Commander's global `.version()`)
  // so subcommands can own `--version <id>`. A leading `--version`/`-V` token
  // unambiguously means the root, since subcommand names always come first.
  const firstArg = process.argv[2];
  if (firstArg === '--version' || firstArg === '-V') {
    console.log(dreamcontextVersion());
    return;
  }

  const program = createProgram();

  // If no arguments, show banner + enter interactive mode
  if (process.argv.length <= 2) {
    console.log(getBanner());
    await startInteractive(program);
  } else {
    await program.parseAsync(process.argv);
  }
}

main().catch((err) => {
  console.error(chalk.red('✗') + ' ' + err.message);
  process.exit(1);
});
