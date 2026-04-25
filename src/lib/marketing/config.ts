import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseEnv } from './env-loader.js';
import { MARKETING_PATHS, marketingRoot } from './paths.js';

export interface MarketingProfile {
  ad_account_id: string;
  page_id: string;
  ig_actor_id?: string;
  whatsapp_id?: string;
  pixel_id?: string;
  api_version: string;
}

export interface MarketingConfig {
  default_profile: string | null;
  profiles: Record<string, MarketingProfile>;
  feature_flags: {
    creative_director_enabled: boolean;
  };
}

// Latest Graph API + Marketing API as of 2026-04. v25.0 released 2026-02-18.
// v20.0 expires 2026-09-24; we target the current release.
export const DEFAULT_API_VERSION = 'v25.0';

const EMPTY_CONFIG: MarketingConfig = {
  default_profile: null,
  profiles: {},
  feature_flags: { creative_director_enabled: false },
};

let _envCache: { mtime: number; values: Record<string, string> } | null = null;

function readEnvFile(): Record<string, string> {
  const path = MARKETING_PATHS.envFile();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  const parsed = parseEnv(raw);
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      process.stderr.write(`[marketing] .env parse error (line ${e.line}): ${e.message}\n`);
    }
  }
  return parsed.values;
}

/** process.env overrides file (CI safety, rule 8). */
export function loadEnv(): Record<string, string> {
  const fileValues = readEnvFile();
  const merged: Record<string, string> = { ...fileValues };
  for (const k of Object.keys(fileValues)) {
    if (process.env[k] !== undefined) merged[k] = process.env[k] as string;
  }
  // Also expose env vars present in process.env even if not in file
  const wellKnownKeys: readonly string[] = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
  for (const wellKnown of wellKnownKeys) {
    if (process.env[wellKnown] !== undefined && !(wellKnown in merged)) {
      merged[wellKnown] = process.env[wellKnown] as string;
    }
  }
  return merged;
}

export const REQUIRED_KEYS = ['META_SYSTEM_USER_TOKEN', 'META_AD_ACCOUNT_ID', 'META_PAGE_ID'] as const;
export const OPTIONAL_KEYS = [
  'META_PIXEL_ID', 'META_IG_ACTOR_ID', 'META_WHATSAPP_ID',
  'GOOGLE_API_KEY', 'OPENAI_VISION_API_KEY', 'OPENAI_IMAGE_API_KEY',
  'REINFLUENCE_BIN',
] as const;

/** Throws with a setup walkthrough if any required key is missing. */
export function requireEnv(keys: readonly string[] = REQUIRED_KEYS): Record<string, string> {
  const env = loadEnv();
  const missing = keys.filter((k) => !env[k] || env[k].trim() === '');
  if (missing.length > 0) {
    const lines = [
      `Missing required env keys: ${missing.join(', ')}`,
      '',
      `Edit ${MARKETING_PATHS.envFile()} and set:`,
      ...missing.map((k) => `  ${k}=...`),
      '',
      'Then re-run the command. Run `mk init` to scaffold a template.',
    ];
    const err = new Error(lines.join('\n'));
    (err as Error & { code?: string }).code = 'ENV_MISSING';
    throw err;
  }
  return env;
}

export function loadConfig(): MarketingConfig {
  const path = MARKETING_PATHS.configFile();
  if (!existsSync(path)) return { ...EMPTY_CONFIG, feature_flags: { ...EMPTY_CONFIG.feature_flags } };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<MarketingConfig>;
    return {
      default_profile: parsed.default_profile ?? null,
      profiles: parsed.profiles ?? {},
      feature_flags: {
        creative_director_enabled:
          parsed.feature_flags?.creative_director_enabled ?? false,
      },
    };
  } catch (e) {
    throw new Error(`Failed to read ${path}: ${(e as Error).message}`);
  }
}

export function writeConfig(cfg: MarketingConfig): void {
  const path = MARKETING_PATHS.configFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** Bootstrap a default config.json with no profiles set. */
export function ensureConfigFile(): MarketingConfig {
  const path = MARKETING_PATHS.configFile();
  if (existsSync(path)) return loadConfig();
  const cfg: MarketingConfig = { ...EMPTY_CONFIG, feature_flags: { ...EMPTY_CONFIG.feature_flags } };
  writeConfig(cfg);
  return cfg;
}

export const ENV_TEMPLATE = `# Meta Marketing — credentials (gitignored)
META_SYSTEM_USER_TOKEN=
META_AD_ACCOUNT_ID=
META_PAGE_ID=
META_PIXEL_ID=
META_IG_ACTOR_ID=          # optional
META_WHATSAPP_ID=          # optional
GOOGLE_API_KEY=            # optional — vision pass
OPENAI_VISION_API_KEY=     # optional — vision pass
OPENAI_IMAGE_API_KEY=      # optional — v1 CreativeDirector
REINFLUENCE_BIN=           # optional override; default uses .venv
`;

export function ensureEnvFile(): void {
  const path = MARKETING_PATHS.envFile();
  if (existsSync(path)) return;
  mkdirSync(marketingRoot(), { recursive: true });
  writeFileSync(path, ENV_TEMPLATE, { encoding: 'utf8', mode: 0o600 });
}
