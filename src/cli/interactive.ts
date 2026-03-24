import { Command } from 'commander';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';

// ─── Types ───────────────────────────────────────────────────────────────────

interface MenuArg {
  name: string;
  type: 'input' | 'select';
  choices?: Array<{ value: string; name: string }>;
}

interface MenuCommand {
  emoji: string;
  name: string;
  description: string;
  argv: string[];
  args?: MenuArg[];
}

interface MenuCategory {
  id: string;
  emoji: string;
  label: string;
  description: string;
  color: (text: string) => string;
  colorBright: (text: string) => string;
  commands: MenuCommand[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SECTION_CHOICES = [
  { value: 'changelog', name: 'Changelog' },
  { value: 'notes', name: 'Notes' },
  { value: 'technical_details', name: 'Technical Details' },
  { value: 'constraints', name: 'Constraints & Decisions' },
  { value: 'user_stories', name: 'User Stories' },
  { value: 'acceptance_criteria', name: 'Acceptance Criteria' },
  { value: 'why', name: 'Why' },
];

const EXIT_SENTINEL = '__EXIT__';
const BACK_SENTINEL = '__BACK__';

// ─── Categories ─────────────────────────────────────────────────────────────

const CATEGORIES: MenuCategory[] = [
  {
    id: 'setup',
    emoji: '\u{1F680}',
    label: 'Setup',
    description: 'Initialize project and install skills',
    color: chalk.cyan,
    colorBright: chalk.cyanBright,
    commands: [
      {
        emoji: '\u{1F4E6}',
        name: 'Initialize project',
        description: 'Create _dream_context/ directory',
        argv: ['init'],
      },
      {
        emoji: '\u{1F9E9}',
        name: 'Install skill',
        description: 'Install Claude Code skill + agents + hooks',
        argv: ['install-skill'],
      },
      {
        emoji: '\u{1F4E6}',
        name: 'Install skill packs',
        description: 'Browse and install optional skill packs',
        argv: ['install-skill', '--packs'],
      },
      {
        emoji: '\u{1F4CB}',
        name: 'List skill packs',
        description: 'Show all available skill packs',
        argv: ['install-skill', '--list'],
      },
    ],
  },
  {
    id: 'tasks',
    emoji: '\u{1F4CB}',
    label: 'Tasks',
    description: 'Create tasks, log progress, mark complete',
    color: chalk.green,
    colorBright: chalk.greenBright,
    commands: [
      {
        emoji: '\u{2795}',
        name: 'Create task',
        description: 'Create a new task',
        argv: ['tasks', 'create'],
        args: [{ name: 'Task name', type: 'input' }],
      },
      {
        emoji: '\u{1F4DD}',
        name: 'Log progress',
        description: 'Add a changelog entry to a task',
        argv: ['tasks', 'log'],
        args: [{ name: 'Task name', type: 'input' }],
      },
      {
        emoji: '\u2714\uFE0F',
        name: 'Complete task',
        description: 'Mark a task as completed',
        argv: ['tasks', 'complete'],
        args: [{ name: 'Task name', type: 'input' }],
      },
    ],
  },
  {
    id: 'features',
    emoji: '\u{1F9E9}',
    label: 'Features',
    description: 'Create features and add content to sections',
    color: chalk.yellow,
    colorBright: chalk.yellowBright,
    commands: [
      {
        emoji: '\u{2728}',
        name: 'Create feature',
        description: 'Create a new feature document',
        argv: ['features', 'create'],
        args: [{ name: 'Feature name', type: 'input' }],
      },
      {
        emoji: '\u{1F4E5}',
        name: 'Insert into feature',
        description: 'Add content to a feature section',
        argv: ['features', 'insert'],
        args: [
          { name: 'Feature name', type: 'input' },
          { name: 'Section', type: 'select', choices: SECTION_CHOICES },
        ],
      },
    ],
  },
  {
    id: 'knowledge',
    emoji: '\u{1F4DA}',
    label: 'Knowledge',
    description: 'Create and browse knowledge documents',
    color: chalk.blue,
    colorBright: chalk.blueBright,
    commands: [
      {
        emoji: '\u{1F4C4}',
        name: 'Create knowledge file',
        description: 'Create a new knowledge document',
        argv: ['knowledge', 'create'],
        args: [{ name: 'Knowledge name', type: 'input' }],
      },
      {
        emoji: '\u{1F5C2}\uFE0F',
        name: 'Show index',
        description: 'List all knowledge files with tags',
        argv: ['knowledge', 'index'],
      },
      {
        emoji: '\u{1F3F7}\uFE0F',
        name: 'Show tags',
        description: 'List standard knowledge tags',
        argv: ['knowledge', 'tags'],
      },
    ],
  },
  {
    id: 'changelog',
    emoji: '\u{1F4DD}',
    label: 'Changelog',
    description: 'Record changelog entries and releases',
    color: chalk.magenta,
    colorBright: chalk.magentaBright,
    commands: [
      {
        emoji: '\u{1F4AC}',
        name: 'Add changelog entry',
        description: 'Record a changelog entry',
        argv: ['core', 'changelog', 'add'],
      },
      {
        emoji: '\u{1F4E6}',
        name: 'Add release',
        description: 'Create a release with auto-discovered items',
        argv: ['core', 'releases', 'add'],
      },
      {
        emoji: '\u{1F4CB}',
        name: 'List releases',
        description: 'Show recent releases',
        argv: ['core', 'releases', 'list'],
      },
    ],
  },
  {
    id: 'system',
    emoji: '\u{1F527}',
    label: 'System',
    description: 'Sleep tracking, diagnostics, snapshots',
    color: chalk.whiteBright,
    colorBright: (s: string) => chalk.whiteBright.bold(s),
    commands: [
      {
        emoji: '\u{1F4CA}',
        name: 'Sleep status',
        description: 'Show current sleep debt level',
        argv: ['sleep', 'status'],
      },
      {
        emoji: '\u{1F4A4}',
        name: 'Add sleep debt',
        description: 'Record a debt-accumulating action',
        argv: ['sleep', 'add'],
        args: [
          { name: 'Score (1-3)', type: 'input' },
          { name: 'Description', type: 'input' },
        ],
      },
      {
        emoji: '\u{1F31F}',
        name: 'Complete consolidation',
        description: 'Mark consolidation done, reset debt',
        argv: ['sleep', 'done'],
        args: [{ name: 'Summary', type: 'input' }],
      },
      {
        emoji: '\u{1F4F8}',
        name: 'Snapshot',
        description: 'Output full context snapshot',
        argv: ['snapshot'],
      },
      {
        emoji: '\u{1FA7A}',
        name: 'Doctor',
        description: 'Validate _dream_context/ structure',
        argv: ['doctor'],
      },
    ],
  },
  {
    id: 'dashboard',
    emoji: '\u{1F5A5}\uFE0F',
    label: 'Dashboard',
    description: 'Open the web dashboard in your browser',
    color: chalk.magentaBright,
    colorBright: (s: string) => chalk.magentaBright.bold(s),
    commands: [
      {
        emoji: '\u{1F310}',
        name: 'Open dashboard',
        description: 'Start server and open in browser',
        argv: ['dashboard'],
      },
    ],
  },
];

// ─── Row Rendering ──────────────────────────────────────────────────────────

const BW = 32;

/** Outlined row (unfocused): dim borders, colored label */
function outlinedRow(emoji: string, label: string, colorFn: (s: string) => string): string {
  const contentWidth = 2 + 2 + 2 + label.length;
  const pad = Math.max(1, BW - contentWidth);
  return `${chalk.dim('\u2502')}  ${emoji}  ${colorFn(label)}${' '.repeat(pad)}${chalk.dim('\u2502')}`;
}

/** Solid row (focused): bright borders, white bold label (no bg - highlight wraps it) */
function solidRow(emoji: string, label: string): string {
  const contentWidth = 2 + 2 + 2 + label.length;
  const pad = Math.max(1, BW - contentWidth);
  return `${chalk.magentaBright('\u2503')}  ${emoji}  ${chalk.white.bold(label)}${' '.repeat(pad)}${chalk.magentaBright('\u2503')}`;
}

/** Outlined back row */
function outlinedBackRow(): string {
  const contentWidth = 2 + 1 + 3 + 4;
  const pad = Math.max(1, BW - contentWidth);
  return `${chalk.dim('\u2502')}  \u2190   ${chalk.dim('Back')}${' '.repeat(pad)}${chalk.dim('\u2502')}`;
}

/** Solid back row */
function solidBackRow(): string {
  const contentWidth = 2 + 1 + 3 + 4;
  const pad = Math.max(1, BW - contentWidth);
  return `${chalk.magentaBright('\u2503')}  ${chalk.white('\u2190')}   ${chalk.white.bold('Back')}${' '.repeat(pad)}${chalk.magentaBright('\u2503')}`;
}

// ─── Choice Builders ────────────────────────────────────────────────────────

/**
 * Build choices + a solidMap for the highlight function.
 * Keys = outlined name, values = solid name.
 * highlight() receives `cursor + ' ' + name` from inquirer,
 * so we slice(2) to extract the name for lookup.
 */
function buildTopLevelMenu() {
  const solidMap = new Map<string, string>();
  const choices: Array<{ value: string; name: string; short: string; description: string }> = [];

  for (const cat of CATEGORIES) {
    const outlined = outlinedRow(cat.emoji, cat.label, cat.color);
    const solid = solidRow(cat.emoji, cat.label);
    solidMap.set(outlined, solid);
    choices.push({
      value: cat.id,
      name: outlined,
      short: `${cat.emoji}  ${cat.label}`,
      description: cat.description,
    });
  }

  const exitOutlined = outlinedRow('\u{1F6AA}', 'Exit', chalk.dim);
  const exitSolid = solidRow('\u{1F6AA}', 'Exit');
  solidMap.set(exitOutlined, exitSolid);
  choices.push({
    value: EXIT_SENTINEL,
    name: exitOutlined,
    short: 'Exit',
    description: '',
  });

  return { choices, solidMap };
}

function buildSubmenuMenu(cat: MenuCategory) {
  const solidMap = new Map<string, string>();
  const choices: Array<{ value: MenuCommand | string; name: string; short: string; description: string }> = [];

  const bOutlined = outlinedBackRow();
  const bSolid = solidBackRow();
  solidMap.set(bOutlined, bSolid);
  choices.push({
    value: BACK_SENTINEL,
    name: bOutlined,
    short: 'Back',
    description: 'Return to main menu',
  });

  for (const cmd of cat.commands) {
    const outlined = outlinedRow(cmd.emoji, cmd.name, cat.color);
    const solid = solidRow(cmd.emoji, cmd.name);
    solidMap.set(outlined, solid);
    choices.push({
      value: cmd,
      name: outlined,
      short: `${cmd.emoji}  ${cmd.name}`,
      description: cmd.description,
    });
  }

  return { choices, solidMap };
}

// ─── Theme ──────────────────────────────────────────────────────────────────

/**
 * Build theme with solid highlight.
 * inquirer's select renders active items as:
 *   highlight(`${cursor} ${name}`)
 * cursor is ' ' (1 char) + literal ' ' = 2-char prefix.
 * We slice(2) to extract the name, look up the solid version,
 * then wrap everything in bgHex for the filled effect.
 */
function makeTheme(solidMap: Map<string, string>) {
  return {
    prefix: { idle: chalk.magentaBright('\u25C6'), done: chalk.green('\u2714') },
    icon: { cursor: ' ' },
    style: {
      highlight: (text: string) => {
        const name = text.slice(2); // strip cursor(' ') + ' '
        const solid = solidMap.get(name);
        if (solid) return chalk.bgHex('#581C87')('  ' + solid);
        return chalk.bgHex('#581C87')(text);
      },
      description: (text: string) => chalk.dim(text),
    },
  };
}

// ─── Arg Collection ─────────────────────────────────────────────────────────

async function collectArgs(args: MenuArg[]): Promise<string[] | null> {
  const collected: string[] = [];
  for (const arg of args) {
    if (arg.type === 'select' && arg.choices) {
      const value = await select({ message: arg.name + ':', choices: arg.choices });
      collected.push(value);
    } else {
      const value = await input({ message: arg.name + ':' });
      if (!value.trim()) return null;
      collected.push(value);
    }
  }
  return collected;
}

// ─── Command Execution ──────────────────────────────────────────────────────

async function executeCommand(command: MenuCommand): Promise<void> {
  let collectedArgs: string[] = [];
  if (command.args) {
    try {
      const result = await collectArgs(command.args);
      if (result === null) {
        console.log(chalk.dim('  Cancelled.\n'));
        return;
      }
      collectedArgs = result;
    } catch {
      console.log(chalk.dim('  Cancelled.\n'));
      return;
    }
  }

  const fullArgv = [...command.argv, ...collectedArgs];
  console.log();

  try {
    const { createProgram } = await import('./index.js');
    const freshProgram = createProgram();
    freshProgram.exitOverride();
    freshProgram.configureOutput({
      writeErr: (str: string) => {
        if (!str.startsWith('error:')) {
          process.stderr.write(str);
        }
      },
    });
    await freshProgram.parseAsync(fullArgv, { from: 'user' });
  } catch (err: any) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      // Fine
    } else {
      console.error(chalk.red(`  \u2717 ${err.message}`));
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function startInteractive(_program: Command): Promise<void> {
  const totalCommands = CATEGORIES.reduce((sum, cat) => sum + cat.commands.length, 0);
  console.log(chalk.dim(`  v0.1.0 \u00B7 ${totalCommands} commands in ${CATEGORIES.length} categories`));
  console.log(chalk.dim(`  Use \u2191\u2193 to navigate, Enter to select.\n`));

  const { choices: topChoices, solidMap: topSolid } = buildTopLevelMenu();

  while (true) {
    let categoryId: string;
    try {
      categoryId = await select<string>({
        message: 'Choose a category',
        choices: topChoices,
        loop: false,
        pageSize: topChoices.length,
        theme: makeTheme(topSolid),
      });
    } catch {
      console.log(chalk.dim('\n  Until next session.\n'));
      process.exit(0);
    }

    if (categoryId === EXIT_SENTINEL) {
      console.log(chalk.dim('\n  Until next session.\n'));
      process.exit(0);
    }

    const category = CATEGORIES.find((c) => c.id === categoryId);
    if (!category) continue;

    if (category.commands.length === 1) {
      await executeCommand(category.commands[0]);
      console.log();
      continue;
    }

    const { choices: subChoices, solidMap: subSolid } = buildSubmenuMenu(category);

    while (true) {
      let selected: MenuCommand | string;
      try {
        selected = await select<MenuCommand | string>({
          message: `${category.emoji}  ${category.color(category.label)}`,
          choices: subChoices,
          loop: false,
          pageSize: subChoices.length,
          theme: makeTheme(subSolid),
        });
      } catch {
        console.log();
        break;
      }

      if (selected === BACK_SENTINEL) {
        break;
      }

      await executeCommand(selected as MenuCommand);
      console.log();
    }
  }
}
