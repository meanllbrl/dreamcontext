import chalk from 'chalk';

// ─── Status & Priority Badges ───────────────────────────────────────────────

const STATUS_COLORS: Record<string, (s: string) => string> = {
  active: (s) => chalk.green(s),
  in_progress: (s) => chalk.cyan(s),
  in_review: (s) => chalk.magenta(s),
  todo: (s) => chalk.yellow(s),
  blocked: (s) => chalk.red(s),
  completed: (s) => chalk.dim(s),
  backlog: (s) => chalk.dim(s),
  unknown: (s) => chalk.dim(s),
  error: (s) => chalk.red(s),
};

const PRIORITY_COLORS: Record<string, (s: string) => string> = {
  critical: (s) => chalk.red.bold(s),
  high: (s) => chalk.yellow(s),
  medium: (s) => chalk.white(s),
  low: (s) => chalk.dim(s),
};

/**
 * Colorize a status value.
 */
export function formatStatus(status: string): string {
  const colorFn = STATUS_COLORS[status.toLowerCase()] ?? ((s: string) => s);
  return colorFn(status);
}

/**
 * Colorize a priority value.
 */
export function formatPriority(priority: string): string {
  const colorFn = PRIORITY_COLORS[priority.toLowerCase()] ?? ((s: string) => s);
  return colorFn(priority);
}

// ─── Section Header ─────────────────────────────────────────────────────────

/**
 * Print a section header with diamond bullet.
 */
export function header(title: string): string {
  return `\n  ${chalk.magentaBright('◆')} ${chalk.bold(title)}\n  ${chalk.dim('─'.repeat(title.length + 2))}`;
}

// ─── Tables ─────────────────────────────────────────────────────────────────

/**
 * Format data as a styled ASCII table.
 */
export function formatTable(
  headers: string[],
  rows: string[][],
  opts?: { statusCol?: number; priorityCol?: number },
): string {
  if (rows.length === 0) return chalk.dim('  (no results)');

  // Calculate column widths from raw text (strip ANSI for width calc)
  const colWidths = headers.map((h, i) => {
    const maxData = rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), 0);
    return Math.max(h.length, maxData) + 2;
  });

  const headerLine = '  ' + headers
    .map((h, i) => chalk.bold.underline(h.padEnd(colWidths[i])))
    .join('');

  const dataLines = rows.map((row, rowIdx) => {
    const cells = row.map((cell, colIdx) => {
      const padded = (cell ?? '').padEnd(colWidths[colIdx]);
      // Apply semantic coloring
      if (opts?.statusCol === colIdx) return formatStatus(padded);
      if (opts?.priorityCol === colIdx) return formatPriority(padded);
      return padded;
    });
    return `  ${chalk.dim(String(rowIdx + 1).padStart(2) + '.')} ${cells.join('')}`;
  });

  return [headerLine, ...dataLines].join('\n');
}

/**
 * Format a list of items with name and optional description.
 */
export function formatList(
  items: { name: string; description?: string }[],
): string {
  if (items.length === 0) return chalk.dim('  (no results)');

  return items
    .map(
      (item) =>
        `  ${chalk.magentaBright(item.name)}${item.description ? chalk.dim(` — ${item.description}`) : ''}`,
    )
    .join('\n');
}

// ─── Search Highlighting ────────────────────────────────────────────────────

/**
 * Highlight matched terms in text.
 */
export function highlight(text: string, query: string): string {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let result = text;
  for (const token of tokens) {
    const regex = new RegExp(`(${escapeRegex(token)})`, 'gi');
    result = result.replace(regex, chalk.yellow.bold('$1'));
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Messages ───────────────────────────────────────────────────────────────

/**
 * Print a success message.
 */
export function success(msg: string): void {
  console.log(chalk.green('✓') + ' ' + msg);
}

/**
 * Print an error message with optional hint.
 */
export function error(msg: string, hint?: string): void {
  console.error(chalk.red('✗') + ' ' + msg);
  if (hint) console.error(chalk.dim('  ' + hint));
}

/**
 * Print a warning message.
 */
export function warn(msg: string): void {
  console.log(chalk.yellow('⚠') + ' ' + msg);
}

/**
 * Print an info message.
 */
export function info(msg: string): void {
  console.log(chalk.magentaBright('ℹ') + ' ' + msg);
}

// ─── Box ────────────────────────────────────────────────────────────────────

/**
 * Create a simple bordered box using Unicode box-drawing characters.
 * Avoids needing boxen for inline usage (boxen used only for big summaries).
 */
export function miniBox(lines: string[], opts?: { color?: 'magenta' | 'green' | 'dim' }): string {
  const maxLen = Math.max(...lines.map((l) => l.length));
  const colorFn = opts?.color === 'green' ? chalk.green
    : opts?.color === 'dim' ? chalk.dim
    : chalk.magentaBright;

  const top = colorFn('  ╭' + '─'.repeat(maxLen + 2) + '╮');
  const bottom = colorFn('  ╰' + '─'.repeat(maxLen + 2) + '╯');
  const body = lines.map((l) => colorFn('  │') + ' ' + l.padEnd(maxLen) + ' ' + colorFn('│'));

  return [top, ...body, bottom].join('\n');
}
