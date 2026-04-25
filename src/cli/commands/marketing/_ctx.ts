/**
 * Shared helper for marketing CLI commands — build MetaCtx from env + flags.
 *
 * The CLI is the only place that constructs a ctx; library code accepts one.
 * `--no-dry-run` is the only flag that flips ctx.dryRun=false.
 */
import { error } from '../../../lib/format.js';
import { isBootstrapped } from '../../../lib/marketing/bootstrap.js';
import { loadEnv, requireEnv, REQUIRED_KEYS, loadConfig } from '../../../lib/marketing/config.js';
import { liveCtxFromEnv, dryRunCtx, type MetaCtx } from '../../../lib/marketing/meta-fetch.js';

export interface CtxFlags {
  /** When true, force dry-run regardless of caller intent. */
  dryRun?: boolean;
  /** When true (i.e. --no-dry-run flag passed), allow live writes. */
  noDryRun?: boolean;
}

/**
 * Build a ctx for a command that reads from / writes to the Graph API.
 * Default is dry-run unless caller explicitly passes --no-dry-run.
 *
 * Exits the process if bootstrap is missing or required env keys absent.
 */
export function buildCtx(flags: CtxFlags = {}): MetaCtx {
  if (!isBootstrapped()) {
    error('Marketing not bootstrapped. Run `dreamcontext marketing init` first.');
    process.exit(1);
  }

  let env: Record<string, string>;
  try {
    env = requireEnv(REQUIRED_KEYS);
  } catch (e) {
    error((e as Error).message);
    process.exit(1);
  }

  const dryRun = flags.noDryRun ? false : true;

  if (dryRun) {
    // Dry-run still loads real env so the URL builder produces realistic logs,
    // but no network calls happen.
    return {
      ...dryRunCtx(),
      adAccountId: env.META_AD_ACCOUNT_ID.startsWith('act_')
        ? env.META_AD_ACCOUNT_ID
        : `act_${env.META_AD_ACCOUNT_ID}`,
      pageId: env.META_PAGE_ID,
      igActorId: env.META_IG_ACTOR_ID,
      pixelId: env.META_PIXEL_ID,
    };
  }

  return liveCtxFromEnv(env);
}

/** Read-only ctx builder for commands that only do GETs (config check, today, etc.) */
export function buildReadCtx(): MetaCtx {
  if (!isBootstrapped()) {
    error('Marketing not bootstrapped. Run `dreamcontext marketing init` first.');
    process.exit(1);
  }
  let env: Record<string, string>;
  try {
    env = requireEnv(REQUIRED_KEYS);
  } catch (e) {
    error((e as Error).message);
    process.exit(1);
  }
  // Reads always go live — they're idempotent and don't mutate.
  return liveCtxFromEnv(env);
}

export function getActiveProfile(): string | null {
  const cfg = loadConfig();
  return cfg.default_profile;
}

export function loadEnvSilent(): Record<string, string> {
  return loadEnv();
}
