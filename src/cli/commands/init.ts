import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { input, confirm, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import { getInitPath } from '../../lib/context-path.js';
import { today } from '../../lib/id.js';
import { error, info, miniBox } from '../../lib/format.js';
import { insertToJsonArray } from '../../lib/json-file.js';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PLATFORMS,
  PLATFORM_CATALOG,
  ensurePlatformSelection,
  formatSupportedPlatforms,
  parsePlatformList,
  type PlatformId,
} from '../../lib/platforms.js';
import { writeProjectPlatformDefaults } from '../../lib/platform-defaults.js';
import { updateSetupConfig } from '../../lib/setup-config.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { printDeprecationHint, SETUP_INTERNAL_ENV } from './install-skill.js';
import { platformSkillRoot } from '../../lib/catalog.js';
import { ensureTaxonomyFile } from '../../lib/taxonomy.js';
import { detectTechStack } from '../../lib/tech-stack.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function getTemplateDir(subdir = 'init'): string {
  // In development: src/templates/<subdir>
  // In dist: try to find templates relative to the compiled file
  const candidates = [
    join(__dirname, '..', '..', 'templates', subdir),
    join(__dirname, '..', 'templates', subdir),
    join(__dirname, 'templates', subdir),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }

  // Fallback: use templates from the package
  return join(__dirname, '..', '..', 'templates', subdir);
}

function copyObsidianConfig(destDir: string): boolean {
  const src = getTemplateDir('obsidian');
  if (!existsSync(src)) return false;

  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(destDir, entry);
    if (statSync(from).isFile()) {
      copyFileSync(from, to);
    }
  }
  return true;
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
    .option('--platforms <list>', `Comma-separated platforms: ${formatSupportedPlatforms()}`)
    .option('--multi-product <list>', 'Comma-separated product names for monorepos (lowercase kebab-case). Skips the interactive prompt.')
    .action(async (opts: {
      yes?: boolean;
      name?: string;
      description?: string;
      user?: string;
      stack?: string;
      priority?: string;
      platforms?: string;
      multiProduct?: string | string[] | false;
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

      let selectedPlatforms: PlatformId[] = [...DEFAULT_PLATFORMS];
      if (opts.platforms) {
        const parsed = parsePlatformList(opts.platforms);
        if (parsed.invalid.length > 0) {
          error(`Unknown platform(s): ${parsed.invalid.join(', ')}. Supported: ${formatSupportedPlatforms()}`);
          return;
        }
        selectedPlatforms = ensurePlatformSelection(parsed.platforms);
      } else if (!useDefaults) {
        const picked = await checkbox<PlatformId>({
          message: 'Select platform support (multi-select)',
          choices: PLATFORM_CATALOG.map((p) => ({
            value: p.id,
            name: `${chalk.bold(p.label)} ${chalk.dim('— ' + p.description)}`,
            checked: DEFAULT_PLATFORMS.includes(p.id),
          })),
          pageSize: PLATFORM_CATALOG.length,
        });
        selectedPlatforms = ensurePlatformSelection(picked);
      }

      // Multi-product: monorepo product-list resolution.
      // Accepts (a) WS-1's pre-resolved multiProduct value (string[] | false),
      // (b) the --multi-product CLI flag as a comma-separated string,
      // or (c) interactive prompts.
      const SLUG_RE = /^[a-z][a-z0-9-]*$/;
      const validateProductNames = (raw: string): { ok: string[]; bad: string[] } => {
        const ok: string[] = [];
        const bad: string[] = [];
        for (const piece of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
          if (SLUG_RE.test(piece)) ok.push(piece);
          else bad.push(piece);
        }
        return { ok, bad };
      };

      let multiProduct: string[] | false = false;
      if (Array.isArray(opts.multiProduct)) {
        multiProduct = opts.multiProduct.filter((s) => SLUG_RE.test(s));
        if (multiProduct.length === 0) multiProduct = false;
      } else if (opts.multiProduct === false) {
        multiProduct = false;
      } else if (typeof opts.multiProduct === 'string') {
        const { ok, bad } = validateProductNames(opts.multiProduct);
        if (bad.length > 0) {
          error(`Invalid product name(s): ${bad.join(', ')}. Use lowercase kebab-case (e.g. "web", "ios", "ai-backend").`);
          return;
        }
        multiProduct = ok.length > 0 ? ok : false;
      } else if (!useDefaults) {
        const isMonorepo = await confirm({
          message: 'Is this a monorepo with multiple products?',
          default: false,
        });
        if (isMonorepo) {
          while (true) {
            const raw = await input({
              message: 'Enter product names (comma-separated, lowercase kebab-case):',
            });
            const { ok, bad } = validateProductNames(raw);
            if (ok.length === 0) {
              error('At least one valid product name is required (lowercase kebab-case).');
              continue;
            }
            if (bad.length > 0) {
              error(`Invalid name(s): ${bad.join(', ')}. Try again.`);
              continue;
            }
            multiProduct = ok;
            break;
          }
        }
      }

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
      mkdirSync(join(contextDir, 'knowledge', 'data-structures'), { recursive: true });
      mkdirSync(join(contextDir, 'knowledge', 'products'), { recursive: true });
      mkdirSync(join(contextDir, 'state'), { recursive: true });
      mkdirSync(join(contextDir, 'inbox'), { recursive: true });

      // Seed as an Obsidian vault: `.obsidian/` makes _dream_context/ openable
      // via "Open folder as vault". Graph colors distinguish soul/knowledge/state.
      const obsidianInstalled = copyObsidianConfig(join(contextDir, '.obsidian'));

      // Copy and process top-level template files
      const templateDir = getTemplateDir();
      const templateFiles = [
        '0.soul.md',
        '1.user.md',
        '2.memory.md',
        '3.style_guide_and_branding.md',
        '4.tech_stack.md',
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

      // Data structures: per-product file (or default.md for single-product).
      // Lives under knowledge/ so it gets recall indexing, staleness tracking,
      // pinning, and the knowledge UI for free (schemas ARE domain knowledge).
      const dataStructuresTemplate = join(templateDir, 'data-structures', 'default.md');
      const dataStructuresFallback = '---\nname: {{PRODUCT_NAME}}\ndescription: Data structures for {{PRODUCT_NAME}}\ntype: data-structures\nproduct: {{PRODUCT_NAME}}\ntags:\n  - data-structures\n  - database\n  - schema\nupdated: {{DATE}}\n---\n\n# Data Structures — {{PRODUCT_NAME}}\n\nDocument schemas, models, and API contracts here.\n';
      const dsTemplateContent = existsSync(dataStructuresTemplate)
        ? readFileSync(dataStructuresTemplate, 'utf-8')
        : dataStructuresFallback;

      const productList: string[] = multiProduct === false ? ['default'] : multiProduct;
      for (const product of productList) {
        const productTokens = { ...tokens, PRODUCT_NAME: product };
        const destPath = join(contextDir, 'knowledge', 'data-structures', `${product}.md`);
        writeFileSync(destPath, replaceTokens(dsTemplateContent, productTokens), 'utf-8');
      }

      // Per-product knowledge stubs (multi-product only).
      if (multiProduct !== false) {
        for (const product of multiProduct) {
          const knowledgeStub = `---\nname: ${product}\ndescription: Product knowledge for ${product}\ntype: knowledge\nproduct: ${product}\ntags:\n  - product:${product}\n---\n\n# ${product}\n\nProduct-scoped knowledge. Cross-cutting findings still go to top-level \`knowledge/\`.\n`;
          writeFileSync(join(contextDir, 'knowledge', 'products', `${product}.md`), knowledgeStub, 'utf-8');
        }
      }

      // JSON files
      const jsonFiles = ['CHANGELOG.json', 'RELEASES.json'];
      for (const file of jsonFiles) {
        writeFileSync(join(contextDir, 'core', file), '[]\n', 'utf-8');
      }

      // Scaffold taxonomy vocabulary (JSON format). contextDir is _dream_context/
      // which is the contextRoot expected by ensureTaxonomyFile.
      ensureTaxonomyFile(contextDir);

      // Write/merge state/.config.json via WS-1's helper (preserves any
      // platforms/packs/setupVersion WS-1 already wrote during a setup flow).
      // Init always sets platforms (we just collected them) and multiProduct (we own this field).
      updateSetupConfig(process.cwd(), {
        platforms: selectedPlatforms,
        multiProduct,
        setupVersion: dreamcontextVersion(),
      });

      // Persist project platform defaults
      writeProjectPlatformDefaults(process.cwd(), selectedPlatforms);

      // Add initial changelog entry
      insertToJsonArray(join(contextDir, 'core', 'CHANGELOG.json'), {
        date: dateStr,
        type: 'chore',
        scope: 'project',
        description: 'Agent context initialized',
        breaking: false,
      });

      const productSummary = multiProduct === false ? 'single (default)' : multiProduct.join(', ');
      console.log();
      console.log(miniBox([
        chalk.green.bold('✓ Agent context initialized!'),
        '',
        `  Project: ${chalk.magentaBright(projectName)}`,
        `  Stack:   ${chalk.white(techStack || 'Not specified')}`,
        `  Focus:   ${chalk.white(priority)}`,
        `  Platforms: ${chalk.white(selectedPlatforms.join(', '))}`,
        `  Products: ${chalk.white(productSummary)}`,
      ], { color: 'green' }));

      console.log();
      console.log(`  ${chalk.bold('Created structure:')}`);
      console.log(`  ${chalk.magentaBright.bold('_dream_context/')}`);
      console.log(`  ├── ${chalk.magentaBright.bold('core/')}`);
      console.log(`  │   ├── ${chalk.magentaBright.bold('features/')}`);
      console.log(`  │   ├── ${chalk.magentaBright.bold('data-structures/')}`);
      for (const product of productList) {
        console.log(`  │   │   ├── ${chalk.green(product + '.md')}`);
      }
      console.log(`  │   ├── ${chalk.green('0.soul.md')}`);
      console.log(`  │   ├── ${chalk.green('1.user.md')}`);
      console.log(`  │   ├── ${chalk.green('2.memory.md')}`);
      console.log(`  │   ├── ${chalk.green('3.style_guide_and_branding.md')}`);
      console.log(`  │   ├── ${chalk.green('4.tech_stack.md')}`);
      console.log(`  │   ├── ${chalk.yellow('CHANGELOG.json')}`);
      console.log(`  │   └── ${chalk.yellow('RELEASES.json')}`);
      console.log(`  ├── ${chalk.magentaBright.bold('knowledge/')}`);
      if (multiProduct !== false) {
        console.log(`  │   └── ${chalk.magentaBright.bold('products/')}`);
        for (const product of multiProduct) {
          console.log(`  │       ├── ${chalk.green(product + '.md')}`);
        }
      }
      console.log(`  ├── ${chalk.magentaBright.bold('state/')}`);
      console.log(`  │   └── ${chalk.dim('.config.json')}`);
      if (obsidianInstalled) {
        console.log(`  ├── ${chalk.magentaBright.bold('inbox/')}`);
        console.log(`  └── ${chalk.dim('.obsidian/')} ${chalk.dim('(open as Obsidian vault)')}`);
      } else {
        console.log(`  └── ${chalk.magentaBright.bold('inbox/')}`);
      }

      // `init` only scaffolds _dream_context/ — it does NOT install the platform
      // integration (.claude/ skills, agents, hooks). On its own that leaves the
      // project half-installed: the agent never loads this context. Offer to finish
      // the install right here so the user isn't stranded. Suppressed when init is
      // run as a child of `setup` (which installs afterwards itself) or when the
      // integration is already present (e.g. the `initializer` skill runs
      // `init` from inside an existing .claude/, only the context dir was missing).
      const viaSetup = process.env[SETUP_INTERNAL_ENV] === '1';
      // `every`, not `some`: the integration counts as present only when ALL
      // selected platforms are installed. With `some`, selecting claude+codex when
      // only claude is installed would suppress the offer and falsely report "Done"
      // while codex stays uninstalled. (Re-installing an already-present platform is
      // idempotent, so firing the offer in the mixed case is safe.)
      const integrationPresent = selectedPlatforms.every((p) =>
        existsSync(join(platformSkillRoot(process.cwd(), p), 'dreamcontext', 'SKILL.md')),
      );
      let integrationInstalled = false;
      if (!viaSetup && !integrationPresent && !useDefaults && process.stdin.isTTY) {
        let finish = false;
        try {
          finish = await confirm({
            message: 'Install platform integration now? (skills, agents, hooks, root instructions — required for your agent to load this context)',
            default: true,
          });
        } catch (err: any) {
          if (err?.name === 'ExitPromptError') finish = false;
          else throw err;
        }
        if (finish) {
          try {
            const { installPlatformIntegration } = await import('./setup.js');
            const { notes } = await installPlatformIntegration(process.cwd(), {
              platforms: selectedPlatforms,
              multiProduct,
            });
            integrationInstalled = true;
            console.log();
            console.log(chalk.green('  ✓ Platform integration installed — .claude/ is ready.'));
            for (const n of notes) console.log(`  ${n}`);
          } catch (err: any) {
            if (err?.name !== 'ExitPromptError') {
              error(`Platform integration install failed: ${err.message}`);
            }
          }
        }
      }

      console.log();
      if (integrationInstalled || integrationPresent) {
        console.log(chalk.bold('  What\'s next:'));
        console.log(`  ${chalk.dim('1.')} ${chalk.green('Done')} — next session the hook fires and your agent loads this context.`);
        console.log(`  ${chalk.dim('2.')} Run ${chalk.magentaBright('dreamcontext features create <name>')} to add features`);
        console.log(`  ${chalk.dim('3.')} Edit ${chalk.green('_dream_context/core/0.soul.md')} to define agent identity`);
        let nextStep = 4;
        if (obsidianInstalled) {
          console.log(`  ${chalk.dim(nextStep++ + '.')} In Obsidian: ${chalk.white('Open folder as vault')} → select ${chalk.green('_dream_context/')}`);
        }
      } else if (!viaSetup) {
        // Half-installed: make it unmistakable that the agent integration is NOT in place yet.
        console.log(chalk.yellow.bold('  ⚠ Not done yet — platform integration is NOT installed.'));
        console.log(`  ${chalk.dim('Your agent won\'t load this context until you install the skill, agents, and hooks.')}`);
        console.log();
        console.log(chalk.bold('  Finish setup:'));
        console.log(`  ${chalk.dim('1.')} Run ${chalk.magentaBright.bold('dreamcontext setup')} ${chalk.dim('— one-shot: skills + agents + hooks + root instructions')}`);
        console.log(`  ${chalk.dim('   ')} ${chalk.dim('(or')} ${chalk.magentaBright('dreamcontext install-skill')}${chalk.dim(' to install just the integration)')}`);
        console.log(`  ${chalk.dim('2.')} Run ${chalk.magentaBright('dreamcontext features create <name>')} to add features`);
        console.log(`  ${chalk.dim('3.')} Edit ${chalk.green('_dream_context/core/0.soul.md')} to define agent identity`);
        if (obsidianInstalled) {
          console.log(`  ${chalk.dim('4.')} In Obsidian: ${chalk.white('Open folder as vault')} → select ${chalk.green('_dream_context/')}`);
        }
      }

      printDeprecationHint('init');
    });
}
