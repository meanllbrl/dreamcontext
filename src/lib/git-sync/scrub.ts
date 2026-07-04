import { execFileSync } from 'node:child_process';
import { getStagedFiles } from '../marketing/git-guard.js';

/**
 * The mandatory pre-commit/pre-push scrub gate for the brain-repo sync engine.
 * Deterministic, no network. Called before EVERY brain content commit —
 * in-tree (S2), separate, `brain init` first commit (S3), `brain detach` (S4),
 * and after a merge (a merge can reintroduce a secret).
 *
 * Two severities:
 *  - BLOCK: a real, structured credential shape (GitHub/AWS/Google/Slack/
 *    OpenAI/Anthropic/Stripe API keys, private-key headers, 3-part JWTs).
 *    Aborts the commit/push loudly, everywhere.
 *  - WARN: a generic pattern that's OFTEN sensitive but sometimes legitimate
 *    prose (a home-directory path, a `token = "..."` style assignment).
 *    Non-blocking in every FOREGROUND mode (a human is present to judge);
 *    headless pull-only applies effective-`--strict` (amendment 4) where the
 *    caller treats warns as blocking too.
 */

export interface ScrubHit {
  file: string;
  line: number;
  rule: string;
  severity: 'block' | 'warn';
  /** Redacted — the rule name + line context, NEVER the secret itself. */
  excerpt: string;
}

interface ScrubPattern {
  rule: string;
  severity: 'block' | 'warn';
  re: RegExp;
}

const PATTERNS: ScrubPattern[] = [
  { rule: 'github-pat', severity: 'block', re: /ghp_[A-Za-z0-9]{36}/ },
  { rule: 'github-pat-fine-grained', severity: 'block', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { rule: 'github-oauth-token', severity: 'block', re: /gh[ousr]_[A-Za-z0-9]{36,}/ },
  { rule: 'aws-access-key', severity: 'block', re: /AKIA[0-9A-Z]{16}/ },
  { rule: 'google-api-key', severity: 'block', re: /AIza[0-9A-Za-z\-_]{35}/ },
  { rule: 'slack-token', severity: 'block', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'anthropic-key', severity: 'block', re: /sk-ant-[A-Za-z0-9\-_]{20,}/ },
  { rule: 'stripe-live-key', severity: 'block', re: /sk_live_[A-Za-z0-9]{10,}/ },
  { rule: 'openai-key', severity: 'block', re: /sk-[A-Za-z0-9]{20,}/ },
  { rule: 'private-key-header', severity: 'block', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { rule: 'jwt', severity: 'block', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: 'home-path', severity: 'warn', re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\// },
  { rule: 'windows-home-path', severity: 'warn', re: /C:\\Users\\[A-Za-z0-9._-]+\\/ },
  {
    rule: 'generic-secret-assignment',
    severity: 'warn',
    re: /(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i,
  },
];

function redactLine(line: string, match: string, rule: string): string {
  const redacted = line.split(match).join('[REDACTED]');
  const trimmed = redacted.length > 140 ? `${redacted.slice(0, 137)}...` : redacted;
  return `${rule}: ${trimmed.trim()}`;
}

/** Scrub in-memory content for one file. Pure — no I/O. */
export function scrubContent(relPath: string, content: string): ScrubHit[] {
  const hits: ScrubHit[] = [];
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        hits.push({
          file: relPath,
          line: idx + 1,
          rule: p.rule,
          severity: p.severity,
          excerpt: redactLine(line, m[0], p.rule),
        });
      }
    }
  });
  return hits;
}

/**
 * Scrub every currently-staged file, reading each from the git INDEX (what's
 * actually about to be committed, not just the working tree) via
 * `git show :<path>`. Binary/unreadable/deleted entries are skipped.
 *
 * `pathPrefix`, when given, scopes scrubbing to staged paths under that prefix
 * (in-tree mode stages `_dream_context/` only, but other unrelated files may
 * already be staged in the code repo — scrub must not report on those).
 */
export function scrubStagedFiles(cwd: string, opts?: { pathPrefix?: string }): ScrubHit[] {
  const staged = getStagedFiles(cwd).filter((p) => !opts?.pathPrefix || p.startsWith(opts.pathPrefix));
  const hits: ScrubHit[] = [];
  for (const relPath of staged) {
    let content: string;
    try {
      content = execFileSync('git', ['show', `:${relPath}`], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue; // binary / deleted / unreadable — skip
    }
    hits.push(...scrubContent(relPath, content));
  }
  return hits;
}

export function summarizeScrub(hits: ScrubHit[]): { blocks: ScrubHit[]; warns: ScrubHit[] } {
  return {
    blocks: hits.filter((h) => h.severity === 'block'),
    warns: hits.filter((h) => h.severity === 'warn'),
  };
}
