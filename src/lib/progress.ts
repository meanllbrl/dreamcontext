import chalk from 'chalk';

/**
 * Dependency-free single-line progress bar for long-running CLI operations
 * (bulk task sync). On a TTY it renders in place via `\r` with a rate-derived
 * ETA; when piped/CI it prints one dim line per 10% step so logs stay bounded.
 * A label change (e.g. pull → push) starts a fresh bar and ETA window.
 */
export class ProgressBar {
  private start = 0;
  private lastPct = -1;
  private lastLabel = '';
  private active = false;

  constructor(
    private readonly stream: NodeJS.WriteStream = process.stdout,
    private readonly nowFn: () => number = () => Date.now(),
  ) {}

  update(label: string, current: number, total: number): void {
    if (total <= 0) return;
    if (!this.active || label !== this.lastLabel) {
      this.clearLine();
      this.active = true;
      this.lastLabel = label;
      this.lastPct = -1;
      this.start = this.nowFn();
    }
    const pct = Math.min(100, Math.floor((current / total) * 100));
    if (this.stream.isTTY) {
      const width = 24;
      const filled = Math.min(width, Math.round((pct / 100) * width));
      const bar = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(width - filled));
      const eta = this.eta(current, total);
      this.stream.write(
        `\r  ${chalk.cyan(label)} ${bar} ${current}/${total}` +
        (eta !== null ? chalk.dim(` · ETA ${eta}`) : '') + '  ',
      );
    } else if (pct >= this.lastPct + 10 || (current === total && pct !== this.lastPct)) {
      this.stream.write(chalk.dim(`  ${label}: ${current}/${total} (${pct}%)`) + '\n');
    } else {
      return;
    }
    this.lastPct = pct;
  }

  /** Clear the in-place line (TTY) so whatever prints next starts clean. */
  done(): void {
    this.clearLine();
    this.active = false;
    this.lastLabel = '';
    this.lastPct = -1;
  }

  private clearLine(): void {
    if (this.active && this.stream.isTTY) {
      this.stream.write('\r' + ' '.repeat(Math.min(this.stream.columns ?? 80, 120)) + '\r');
    }
  }

  private eta(current: number, total: number): string | null {
    if (current <= 0) return null;
    const remainMs = ((this.nowFn() - this.start) / current) * (total - current);
    if (!Number.isFinite(remainMs) || remainMs < 0) return null;
    const s = Math.round(remainMs / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }
}
