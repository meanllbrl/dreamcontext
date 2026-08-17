import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Wrapper keys an array file has been seen scaffolded under by hand or by
 * pre-0.9 tooling: `{"entries": [...]}` for `core/CHANGELOG.json`,
 * `{"releases": []}` for `core/RELEASES.json`. Today's `init` writes a bare
 * `[]` for both, so these only ever appear in vaults created some other way.
 */
const KNOWN_WRAPPER_KEYS = ['entries', 'releases'] as const;

export type JsonArrayShape =
  | { kind: 'array'; array: unknown[] }
  | { kind: 'wrapped'; array: unknown[]; wrapperKey: string }
  | { kind: 'invalid'; actual: string };

/**
 * Classify a parsed JSON value against "should be an array".
 *
 * A bare array is `array`. A wrapper object around one — a known wrapper key,
 * or any single-key object whose only value is an array — is `wrapped`, and
 * carries the array out so the caller can read *through* the wrapper. Anything
 * else is `invalid`.
 *
 * The unwrap is what lets a wrongly-scaffolded vault self-heal: reads succeed
 * (the snapshot's recent-changelog section and `memory recall --types
 * changelog` return real entries instead of silently nothing), and the next
 * write through `writeJsonArray`/`insertToJsonArray` normalises the file to a
 * bare array in place. `doctor` reports the non-canonical shape meanwhile, so
 * tolerating it is never the same as hiding it.
 */
export function inspectJsonArray(parsed: unknown): JsonArrayShape {
  if (Array.isArray(parsed)) return { kind: 'array', array: parsed };
  if (parsed === null) return { kind: 'invalid', actual: 'null' };
  if (typeof parsed !== 'object') return { kind: 'invalid', actual: typeof parsed };

  const obj = parsed as Record<string, unknown>;
  for (const key of KNOWN_WRAPPER_KEYS) {
    // hasOwnProperty, not `in` — an inherited key must never read as a wrapper.
    if (Object.prototype.hasOwnProperty.call(obj, key) && Array.isArray(obj[key])) {
      return { kind: 'wrapped', array: obj[key] as unknown[], wrapperKey: key };
    }
  }

  // A single-key object whose only value is an array is unambiguously a
  // wrapper, whatever its key happens to be called.
  const keys = Object.keys(obj);
  if (keys.length === 1 && Array.isArray(obj[keys[0]])) {
    return { kind: 'wrapped', array: obj[keys[0]] as unknown[], wrapperKey: keys[0] };
  }

  return { kind: 'invalid', actual: 'object' };
}

/**
 * Read a JSON file as an array. Reads through a wrapper object
 * (`{"entries": [...]}`, `{"releases": [...]}`) rather than throwing — see
 * `inspectJsonArray`.
 */
export function readJsonArray<T = Record<string, unknown>>(filePath: string): T[] {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const shape = inspectJsonArray(parsed);
  if (shape.kind === 'invalid') {
    throw new Error(
      `Expected JSON array in ${filePath}, got ${shape.actual}`
      + ' — rewrite the file as a bare JSON array ([...]), not a wrapper object',
    );
  }
  return shape.array as T[];
}

/**
 * Write an array to a JSON file with pretty formatting.
 */
export function writeJsonArray<T>(filePath: string, data: T[]): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Insert an entry into a JSON array file.
 * 'top' = unshift (LIFO), 'bottom' = push.
 */
export function insertToJsonArray<T>(
  filePath: string,
  entry: T,
  position: 'top' | 'bottom' = 'top',
): void {
  const arr = readJsonArray<T>(filePath);
  if (position === 'top') {
    arr.unshift(entry);
  } else {
    arr.push(entry);
  }
  writeJsonArray(filePath, arr);
}

/**
 * Read a JSON file as an object.
 */
export function readJsonObject<T = Record<string, unknown>>(filePath: string): T {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }
  return parsed as T;
}

/**
 * Write an object to a JSON file with pretty formatting.
 */
export function writeJsonObject<T>(filePath: string, data: T): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
