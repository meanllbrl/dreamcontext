import './inspector-guard.js';
import './hide-windows.js';
import chalk from 'chalk';
import { dreamcontextVersion } from '../lib/manifest.js';
import { createProgramFor } from './lazy-program.js';

// The whole command tree (`./program.js`), the interactive menu and the banner are imported only
// on the starts that need them: a start naming one command loads that command alone (see
// lazy-program.ts). The tree's import path for everything else is `src/cli/program.js`.

// ─── Logo ────────────────────────────────────────────────────────────────────

async function getBanner(): Promise<string> {
  const { renderBanner } = await import('../lib/pixel-banner.js');
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

  const program = (await createProgramFor(firstArg)) ?? (await import('./program.js')).createProgram();

  // If no arguments, show banner + enter interactive mode
  if (process.argv.length <= 2) {
    console.log(await getBanner());
    const { startInteractive } = await import('./interactive.js');
    await startInteractive(program);
  } else {
    await program.parseAsync(process.argv);
  }
}

main().catch((err) => {
  console.error(chalk.red('✗') + ' ' + err.message);
  process.exit(1);
});
