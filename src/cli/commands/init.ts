import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { getInitPath } from '../../lib/context-path.js';
import { today } from '../../lib/id.js';
import { success, error, info, miniBox } from '../../lib/format.js';
import { insertToJsonArray } from '../../lib/json-file.js';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function getTemplateDir(): string {
  // In development: src/templates/init
  // In dist: try to find templates relative to the compiled file
  const candidates = [
    join(__dirname, '..', '..', 'templates', 'init'),
    join(__dirname, '..', 'templates', 'init'),
    join(__dirname, 'templates', 'init'),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }

  // Fallback: use templates from the package
  return join(__dirname, '..', '..', 'templates', 'init');
}

function detectTechStack(): string | null {
  const cwd = process.cwd();

  // package.json -> Node/JS ecosystem
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const stack: string[] = ['Node.js'];

      if (deps['react'] || deps['react-dom']) stack.push('React');
      if (deps['next']) stack.push('Next.js');
      if (deps['vue']) stack.push('Vue');
      if (deps['nuxt']) stack.push('Nuxt');
      if (deps['svelte']) stack.push('Svelte');
      if (deps['express']) stack.push('Express');
      if (deps['fastify']) stack.push('Fastify');
      if (deps['typescript']) stack.push('TypeScript');
      if (deps['tailwindcss']) stack.push('Tailwind CSS');
      if (deps['prisma'] || deps['@prisma/client']) stack.push('Prisma');

      return stack.join(', ');
    } catch {
      return 'Node.js';
    }
  }

  // pubspec.yaml -> Flutter/Dart
  if (existsSync(join(cwd, 'pubspec.yaml'))) return 'Flutter, Dart';

  // Cargo.toml -> Rust
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'Rust';

  // go.mod -> Go
  if (existsSync(join(cwd, 'go.mod'))) return 'Go';

  // requirements.txt or pyproject.toml -> Python
  if (existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'pyproject.toml'))) {
    return 'Python';
  }

  return null;
}

function replaceTokens(content: string, tokens: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize _dream_context/ in the current directory')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .option('--name <name>', 'Project name')
    .option('--description <desc>', 'Project description')
    .option('--user <user>', 'Target user')
    .option('--stack <stack>', 'Tech stack')
    .option('--priority <priority>', 'Current priority')
    .action(async (opts: {
      yes?: boolean;
      name?: string;
      description?: string;
      user?: string;
      stack?: string;
      priority?: string;
    }) => {
      const contextDir = getInitPath();

      if (existsSync(contextDir)) {
        error('_dream_context/ already exists in this directory.');
        return;
      }

      info('Initializing agent context...\n');

      const detectedStack = detectTechStack();
      if (detectedStack) {
        info(`Detected tech stack: ${chalk.magentaBright(detectedStack)}`);
      }

      const defaultName = process.cwd().split('/').pop() || 'my-project';
      const useDefaults = opts.yes;

      const projectName = opts.name || (useDefaults ? defaultName : await input({
        message: 'What is this project?',
        default: defaultName,
      }));

      const projectDescription = opts.description || (useDefaults ? '' : await input({
        message: 'Brief description:',
      }));

      const targetUser = opts.user || (useDefaults ? 'Developers' : await input({
        message: 'Who is the target user?',
        default: 'Developers',
      }));

      const techStack = opts.stack || detectedStack || (useDefaults ? '' : await input({
        message: 'Tech stack (comma-separated):',
      }));

      const priority = opts.priority || (useDefaults ? 'Initial setup' : await input({
        message: 'Current priority / focus:',
        default: 'Initial setup',
      }));

      const dateStr = today();
      const tokens: Record<string, string> = {
        PROJECT_NAME: projectName,
        PROJECT_DESCRIPTION: projectDescription,
        TARGET_USER: targetUser,
        TECH_STACK: techStack,
        PRIORITY: priority,
        DATE: dateStr,
      };

      // Create directory structure
      mkdirSync(join(contextDir, 'core', 'features'), { recursive: true });
      mkdirSync(join(contextDir, 'knowledge'), { recursive: true });
      mkdirSync(join(contextDir, 'state'), { recursive: true });

      // Copy and process template files
      const templateDir = getTemplateDir();
      const templateFiles = [
        '0.soul.md',
        '1.user.md',
        '2.memory.md',
        '3.style_guide_and_branding.md',
        '4.tech_stack.md',
        '5.data_structures.sql',
      ];

      for (const file of templateFiles) {
        const templatePath = join(templateDir, file);
        const destPath = join(contextDir, 'core', file);

        if (existsSync(templatePath)) {
          const content = readFileSync(templatePath, 'utf-8');
          writeFileSync(destPath, replaceTokens(content, tokens), 'utf-8');
        } else {
          // Create minimal placeholder
          writeFileSync(destPath, `# ${file}\n\nCreated: ${dateStr}\n`, 'utf-8');
        }
      }

      // JSON files
      const jsonFiles = ['CHANGELOG.json', 'RELEASES.json'];
      for (const file of jsonFiles) {
        writeFileSync(join(contextDir, 'core', file), '[]\n', 'utf-8');
      }

      // Add initial changelog entry
      insertToJsonArray(join(contextDir, 'core', 'CHANGELOG.json'), {
        date: dateStr,
        type: 'chore',
        scope: 'project',
        description: 'Agent context initialized',
        breaking: false,
      });

      console.log();
      console.log(miniBox([
        chalk.green.bold('✓ Agent context initialized!'),
        '',
        `  Project: ${chalk.magentaBright(projectName)}`,
        `  Stack:   ${chalk.white(techStack || 'Not specified')}`,
        `  Focus:   ${chalk.white(priority)}`,
      ], { color: 'green' }));

      console.log();
      console.log(`  ${chalk.bold('Created structure:')}`);
      console.log(`  ${chalk.magentaBright.bold('_dream_context/')}`);
      console.log(`  ├── ${chalk.magentaBright.bold('core/')}`);
      console.log(`  │   ├── ${chalk.magentaBright.bold('features/')}`);
      console.log(`  │   ├── ${chalk.green('0.soul.md')}`);
      console.log(`  │   ├── ${chalk.green('1.user.md')}`);
      console.log(`  │   ├── ${chalk.green('2.memory.md')}`);
      console.log(`  │   ├── ${chalk.green('3.style_guide_and_branding.md')}`);
      console.log(`  │   ├── ${chalk.green('4.tech_stack.md')}`);
      console.log(`  │   ├── ${chalk.dim('5.data_structures.sql')}`);
      console.log(`  │   ├── ${chalk.yellow('CHANGELOG.json')}`);
      console.log(`  │   └── ${chalk.yellow('RELEASES.json')}`);
      console.log(`  ├── ${chalk.magentaBright.bold('knowledge/')}`);
      console.log(`  └── ${chalk.magentaBright.bold('state/')}`);

      console.log();
      console.log(chalk.bold('  What\'s next:'));
      console.log(`  ${chalk.dim('1.')} Run ${chalk.magentaBright('dreamcontext install-skill')} to set up Claude Code integration`);
      console.log(`  ${chalk.dim('2.')} Run ${chalk.magentaBright('dreamcontext features create <name>')} to add features`);
      console.log(`  ${chalk.dim('3.')} Edit ${chalk.green('_dream_context/core/0.soul.md')} to define agent identity`);
    });
}
