import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeCredential,
  readCredentials,
  listCredentialNames,
  resolvePlaceholders,
  redactSecrets,
} from '../../src/lib/lab/credentials.js';
import { LabError } from '../../src/lib/lab/types.js';

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-lab-cred-project-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('readCredentials', () => {
  it('returns {} on a missing file', () => {
    expect(readCredentials(contextRoot)).toEqual({});
  });

  it('returns {} on a malformed file (never throws)', () => {
    mkdirSync(join(contextRoot, 'lab'), { recursive: true });
    writeFileSync(join(contextRoot, 'lab', 'credentials.json'), 'not json', 'utf-8');
    expect(readCredentials(contextRoot)).toEqual({});
  });
});

describe('writeCredential — gitignore-first ordering + 0600', () => {
  it('writes the credential, mode 0600, and both gitignores contain the lab entries', () => {
    writeCredential(projectRoot, contextRoot, 'apiKey', 'sk-test-123');
    expect(readCredentials(contextRoot)).toEqual({ apiKey: 'sk-test-123' });

    const credPath = join(contextRoot, 'lab', 'credentials.json');
    const mode = statSync(credPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const contextIgnore = readFileSync(join(contextRoot, '.gitignore'), 'utf-8');
    expect(contextIgnore).toContain('lab/credentials.json');
    expect(contextIgnore).toContain('lab/credentials.*');

    const rootIgnore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(rootIgnore).toContain('_dream_context/lab/credentials.json');
    expect(rootIgnore).toContain('_dream_context/lab/credentials.*');
  });

  it('STUB-REGRESSION GUARD: with NO pre-existing _dream_context/.gitignore, produces the FULL canonical brain gitignore (not a 2-line stub) with lab entries appended', () => {
    expect(existsSync(join(contextRoot, '.gitignore'))).toBe(false);
    writeCredential(projectRoot, contextRoot, 'apiKey', 'sk-test-123');

    const contextIgnore = readFileSync(join(contextRoot, '.gitignore'), 'utf-8');
    // Canonical brain-gitignore entries (buildBrainGitignore) must be present —
    // NOT just the two lab lines a naive stub-writer would produce.
    expect(contextIgnore).toContain('state/.secrets.json');
    expect(contextIgnore).toContain('state/.sleep.json');
    expect(contextIgnore).toContain('**/.env');
    expect(contextIgnore).toContain('lab/credentials.json');
    expect(contextIgnore).toContain('lab/credentials.*');
  });

  it('refuses to write (throws, creates no file) when the _dream_context/.gitignore cannot be ensured (exists as a directory)', () => {
    mkdirSync(join(contextRoot, '.gitignore')); // path exists but is a directory, not a file
    expect(() => writeCredential(projectRoot, contextRoot, 'apiKey', 'sk-test-123')).toThrow(LabError);
    expect(existsSync(join(contextRoot, 'lab', 'credentials.json'))).toBe(false);
  });

  it('refuses to write (throws, creates no file) when the root .gitignore cannot be ensured', () => {
    mkdirSync(join(projectRoot, '.gitignore')); // exists but is a directory
    expect(() => writeCredential(projectRoot, contextRoot, 'apiKey', 'sk-test-123')).toThrow(LabError);
    expect(existsSync(join(contextRoot, 'lab', 'credentials.json'))).toBe(false);
  });

  it('rejects an empty key/value', () => {
    expect(() => writeCredential(projectRoot, contextRoot, '', 'v')).toThrow(LabError);
    expect(() => writeCredential(projectRoot, contextRoot, 'k', '')).toThrow(LabError);
  });
});

describe('listCredentialNames — names only, never values', () => {
  it('lists key names sorted, and never the secret values', () => {
    writeCredential(projectRoot, contextRoot, 'zKey', 'secret-z');
    writeCredential(projectRoot, contextRoot, 'aKey', 'secret-a');
    const names = listCredentialNames(contextRoot);
    expect(names).toEqual(['aKey', 'zKey']);
    expect(JSON.stringify(names)).not.toContain('secret');
  });
});

describe('resolvePlaceholders', () => {
  it('resolves {{cred:*}} and {{tweak:*}}, redacts cred when asked', () => {
    const resolved = resolvePlaceholders('key={{cred:apiKey}}&range={{tweak:range}}', {
      cred: { apiKey: 'sk-live' }, tweak: { range: '30d' },
    });
    expect(resolved).toBe('key=sk-live&range=30d');

    const redacted = resolvePlaceholders('key={{cred:apiKey}}&range={{tweak:range}}', {
      cred: { apiKey: 'sk-live' }, tweak: { range: '30d' },
    }, { redact: true });
    expect(redacted).toBe('key=***&range=30d');
    expect(redacted).not.toContain('sk-live');
  });

  it('leaves unknown placeholder keys unchanged', () => {
    const resolved = resolvePlaceholders('x={{cred:missing}}', { cred: {}, tweak: {} });
    expect(resolved).toBe('x={{cred:missing}}');
  });
});

describe('redactSecrets — end-to-end final net', () => {
  it('replaces every literal occurrence of a secret value with ***', () => {
    const out = redactSecrets('Error calling https://x?key=sk-live-abc failed for sk-live-abc', ['sk-live-abc']);
    expect(out).not.toContain('sk-live-abc');
    expect(out.match(/\*\*\*/g)?.length).toBe(2);
  });
});
