/**
 * An app's settings (paylasilan-app-ler plan r2 K2): the TEMPLATE travels in the manifest
 * (`config: [...]`), the VALUES stay on this Mac in `~/.dreamcontext/apps/config/<configId>.json`
 * (0600, temp+rename, a symlink refused). Never in the app's repo, never in its data folder.
 * A `secret` field holds no value here: it names a key of the app's own untracked `.env`.
 *
 * The app reads its values as `DC_CONFIG` (JSON, the backend's env), `GET /__dc/config` and the
 * SDK's `dc.config()`. A required field left empty keeps the backend from starting.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDotenv } from './redact.js';
import type { ConfigField } from './manifest.js';
import { appsHome } from './registry.js';

export type ConfigValue = string | number;
export type ConfigValues = Record<string, ConfigValue>;

const CONFIG_ID_RE = /^[0-9a-f]{16,64}$/;

export function newConfigId(): string {
  return randomBytes(16).toString('hex');
}

export function appConfigDir(home: string = homedir()): string {
  return join(appsHome(home), 'config');
}

export function appConfigPath(home: string, configId: string): string {
  if (!CONFIG_ID_RE.test(configId)) throw new Error('bad config id');
  return join(appConfigDir(home), `${configId}.json`);
}

/** The stored values (an unreadable or missing file is no values). */
export function readAppConfig(home: string, configId: string | undefined): ConfigValues {
  if (!configId) return {};
  try {
    const p = appConfigPath(home, configId);
    if (lstatSync(p).isSymbolicLink()) return {};
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: ConfigValues = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) continue;
      if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeRaw(home: string, configId: string, values: ConfigValues): void {
  mkdirSync(appConfigDir(home), { recursive: true, mode: 0o700 });
  const p = appConfigPath(home, configId);
  try { if (lstatSync(p).isSymbolicLink()) throw new Error('the config file is a symlink; refusing it'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
}

export class ConfigError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/**
 * Validate `patch` against the template and merge it into the stored values. A secret field is
 * refused here (its value goes to `.env` through the secret card). An empty string clears a key.
 */
export function setAppConfig(home: string, configId: string, fields: readonly ConfigField[], patch: Record<string, unknown>): ConfigValues {
  const current = readAppConfig(home, configId);
  for (const [key, raw] of Object.entries(patch)) {
    const f = fields.find((x) => x.key === key);
    if (!f) throw new ConfigError('unknown_key', `"${key}" is not a setting of this app.`);
    if (f.type === 'secret') throw new ConfigError('secret_key', `"${key}" is a key: it is entered in the secret card (or \`dreamcontext apps secret\`), never here.`);
    if (raw === '' || raw === null || raw === undefined) { delete current[key]; continue; }
    if (f.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new ConfigError('bad_value', `"${key}" takes a number.`);
      current[key] = n;
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') throw new ConfigError('bad_value', `"${key}" takes text.`);
    // eslint-disable-next-line no-control-regex
    const v = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
    if (f.type === 'choice' && !(f.choices ?? []).includes(v)) throw new ConfigError('bad_value', `"${key}" is one of: ${(f.choices ?? []).join(', ')}.`);
    if (['insight', 'objective', 'agent', 'task-tag'].includes(f.type) && !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(v)) throw new ConfigError('bad_value', `${f.label || key} takes its short name (letters, numbers, dashes), with no spaces.`);
    current[key] = v;
  }
  writeRaw(home, configId, current);
  return current;
}

/** The secret keys present in the app's `.env` (names only, never values). */
export function presentSecretKeys(appRoot: string): Set<string> {
  try {
    return new Set(parseDotenv(readFileSync(join(appRoot, '.env'), 'utf-8')).filter((e) => e.value !== '').map((e) => e.key));
  } catch {
    return new Set();
  }
}

/** The required settings still empty: values from the config file, secrets from `.env`. */
export function missingRequired(fields: readonly ConfigField[], values: ConfigValues, appRoot: string): string[] {
  const secrets = fields.some((f) => f.type === 'secret' && f.required) ? presentSecretKeys(appRoot) : new Set<string>();
  return fields.filter((f) => f.required && (f.type === 'secret' ? !secrets.has(f.key) : values[f.key] === undefined || values[f.key] === '')).map((f) => f.key);
}

/** The values the app sees (`DC_CONFIG`, `/__dc/config`): template keys only, never a secret. */
export function publicConfig(fields: readonly ConfigField[], values: ConfigValues): ConfigValues {
  const out: ConfigValues = {};
  for (const f of fields) if (f.type !== 'secret' && values[f.key] !== undefined) out[f.key] = values[f.key];
  return out;
}
