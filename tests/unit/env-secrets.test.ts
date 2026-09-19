/**
 * Unit tests for `lib/env-secrets.ts` — the ONE path where a credential the user typed is
 * written to disk without passing through the agent.
 *
 * What is pinned hardest here is not the happy path but the four refusals, because each one
 * is a way the feature could publish or overwrite something it must not:
 *   • a TRACKED `.env` (a secret one `git commit -a` away from being pushed)
 *   • a SYMLINKED `.env` (an arbitrary-file overwrite wearing a dotenv name)
 *   • a path that resolves OUTSIDE the project
 *   • a `.gitignore` that could not be written (the ordering guarantee: ignore, then write)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecretWriteError, formatEnvValue, normalizeSecretEntries, normalizeSecretFile,
  secretReceipt, upsertEnvContent, writeEnvSecrets,
} from '../../src/lib/env-secrets.js';

let root = '';
const nothingTracked = () => [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-envsecret-'));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ }
});

describe('formatEnvValue', () => {
  it('leaves a boring token bare — a real CI token needs no quoting', () => {
    const token = '1//0gAbCdEf-_.xyz+=:,/';
    expect(formatEnvValue(token)).toBe(token);
  });

  it('quotes anything with a space, a quote or a #', () => {
    expect(formatEnvValue('two words')).toBe('"two words"');
    expect(formatEnvValue('has"quote')).toBe('"has\\"quote"');
    expect(formatEnvValue('trailing # comment')).toBe('"trailing # comment"');
  });

  it('escapes newlines so a PEM survives as one assignment', () => {
    expect(formatEnvValue('-----BEGIN-----\nabc\n-----END-----'))
      .toBe('"-----BEGIN-----\\nabc\\n-----END-----"');
  });

  it('escapes a backslash before it can escape something else', () => {
    expect(formatEnvValue('a\\b c')).toBe('"a\\\\b c"');
  });
});

describe('upsertEnvContent', () => {
  it('appends to an empty file and reports it as added', () => {
    const { content, written } = upsertEnvContent('', [{ key: 'A', value: '1' }]);
    expect(content).toBe('A=1\n');
    expect(written[0]).toMatchObject({ key: 'A', action: 'added', chars: 1 });
    expect(written[0].fingerprint).toHaveLength(8);
  });

  it('replaces an existing assignment in place, leaving every other line alone', () => {
    const before = '# comment\nA=old\nB=keep\n';
    const { content, written } = upsertEnvContent(before, [{ key: 'A', value: 'new' }]);
    expect(content).toBe('# comment\nA=new\nB=keep\n');
    expect(written[0].action).toBe('updated');
  });

  it('preserves indentation and a leading `export`', () => {
    const { content } = upsertEnvContent('  export A=old\n', [{ key: 'A', value: 'new' }]);
    expect(content).toBe('  export A=new\n');
  });

  it('rewrites the LAST duplicate (the one dotenv ends up using) and says so', () => {
    const { content, written } = upsertEnvContent('A=first\nB=x\nA=second\n', [{ key: 'A', value: 'new' }]);
    expect(content).toBe('A=first\nB=x\nA=new\n');
    expect(written[0].duplicate).toBe(true);
  });

  it('does not treat a commented-out key as an assignment', () => {
    const { content, written } = upsertEnvContent('# A=old\n', [{ key: 'A', value: 'new' }]);
    expect(content).toBe('# A=old\nA=new\n');
    expect(written[0].action).toBe('added');
  });

  it('does not mistake a key that merely starts the same', () => {
    const { content } = upsertEnvContent('API_KEY_OLD=x\n', [{ key: 'API_KEY', value: 'new' }]);
    expect(content).toBe('API_KEY_OLD=x\nAPI_KEY=new\n');
  });

  it('keeps CRLF files on CRLF', () => {
    const { content } = upsertEnvContent('A=old\r\n', [{ key: 'A', value: 'new' }]);
    expect(content).toBe('A=new\r\n');
  });

  it('fingerprints the same value the same way and a different value differently', () => {
    const a = upsertEnvContent('', [{ key: 'A', value: 'same' }]).written[0].fingerprint;
    const b = upsertEnvContent('', [{ key: 'B', value: 'same' }]).written[0].fingerprint;
    const c = upsertEnvContent('', [{ key: 'C', value: 'other' }]).written[0].fingerprint;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('normalizeSecretFile', () => {
  it('defaults to .env', () => {
    expect(normalizeSecretFile(undefined)).toBe('.env');
    expect(normalizeSecretFile('')).toBe('.env');
  });

  it('accepts the .env family, including one in a subdirectory', () => {
    expect(normalizeSecretFile('.env.local')).toBe('.env.local');
    expect(normalizeSecretFile('functions/.env')).toBe('functions/.env');
    expect(normalizeSecretFile('./.env.production')).toBe('.env.production');
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a traversal', '../.env'],
    ['a traversal in the middle', 'a/../../.env'],
    ['a non-dotenv name', 'config.json'],
    ['a dotenv-ish prefix', '.environment'],
    ['too deep', 'a/b/c/d/.env'],
  ])('refuses %s', (_label, path) => {
    expect(() => normalizeSecretFile(path)).toThrow(SecretWriteError);
  });
});

describe('normalizeSecretEntries', () => {
  it('trims the ends of a value (a pasted token carries a newline) but not its middle', () => {
    const [entry] = normalizeSecretEntries([{ key: 'A', value: '  a\nb  \n' }]);
    expect(entry.value).toBe('a\nb');
  });

  it.each([
    ['no entries', []],
    ['a non-array', 'A=1'],
    ['an empty value', [{ key: 'A', value: '   ' }]],
    ['a key starting with a digit', [{ key: '1A', value: 'x' }]],
    ['a key with a dash', [{ key: 'A-B', value: 'x' }]],
    ['too many entries', Array.from({ length: 9 }, (_, i) => ({ key: `K${i}`, value: 'x' }))],
  ])('refuses %s', (_label, entries) => {
    expect(() => normalizeSecretEntries(entries)).toThrow(SecretWriteError);
  });

  it('never puts the value in the refusal message', () => {
    try {
      normalizeSecretEntries([{ key: 'A', value: 'x'.repeat(9000) }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('xxxx');
    }
  });
});

describe('writeEnvSecrets', () => {
  it('writes the value, ignores the file first, and locks it to 0600', () => {
    const res = writeEnvSecrets(root, '.env', [{ key: 'FIREBASE_TOKEN', value: 'abc def' }], { gitTracked: nothingTracked });

    expect(readFileSync(join(root, '.env'), 'utf-8')).toBe('FIREBASE_TOKEN="abc def"\n');
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toContain('.env');
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
    expect(res.written[0]).toMatchObject({ key: 'FIREBASE_TOKEN', action: 'added', chars: 7 });
    expect(res.gitignoreAdded).toBe('.env');
  });

  it('tightens an existing world-readable .env to 0600 on write', () => {
    writeFileSync(join(root, '.env'), 'A=1\n');
    chmodSync(join(root, '.env'), 0o644);
    writeEnvSecrets(root, '.env', [{ key: 'B', value: '2' }], { gitTracked: nothingTracked });
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
  });

  it('writes into a subdirectory that exists', () => {
    mkdirSync(join(root, 'functions'));
    writeEnvSecrets(root, 'functions/.env', [{ key: 'A', value: '1' }], { gitTracked: nothingTracked });
    expect(readFileSync(join(root, 'functions/.env'), 'utf-8')).toBe('A=1\n');
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toContain('functions/.env');
  });

  it('refuses a directory that does not exist rather than creating one', () => {
    expect(() => writeEnvSecrets(root, 'nope/.env', [{ key: 'A', value: '1' }], { gitTracked: nothingTracked }))
      .toThrow(/does not exist/);
    expect(existsSync(join(root, 'nope'))).toBe(false);
  });

  it('REFUSES a .env that git tracks, and writes nothing at all', () => {
    writeFileSync(join(root, '.env'), 'A=1\n');
    expect(() => writeEnvSecrets(root, '.env', [{ key: 'B', value: '2' }], { gitTracked: () => ['.env'] }))
      .toThrow(/tracked by git/);
    expect(readFileSync(join(root, '.env'), 'utf-8')).toBe('A=1\n');
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('REFUSES a symlinked .env — the arbitrary-file overwrite this guard exists for', () => {
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'do not touch\n');
    symlinkSync(outside, join(root, '.env'));
    expect(() => writeEnvSecrets(root, '.env', [{ key: 'A', value: '1' }], { gitTracked: nothingTracked }))
      .toThrow(/symlink/);
    expect(readFileSync(outside, 'utf-8')).toBe('do not touch\n');
  });

  it('REFUSES a subdirectory that symlinks out of the project', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'dc-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(root, 'escape'));
      expect(() => writeEnvSecrets(root, 'escape/.env', [{ key: 'A', value: '1' }], { gitTracked: nothingTracked }))
        .toThrow(/outside the project/);
      expect(existsSync(join(elsewhere, '.env'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('REFUSES when .gitignore cannot be written — ignore first, or not at all', () => {
    mkdirSync(join(root, '.gitignore')); // a directory where the file must go
    expect(() => writeEnvSecrets(root, '.env', [{ key: 'A', value: '1' }], { gitTracked: nothingTracked }))
      .toThrow(/gitignore/i);
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('does not add a second .gitignore line when one already covers the file', () => {
    writeFileSync(join(root, '.gitignore'), '.env\n');
    const res = writeEnvSecrets(root, '.env', [{ key: 'A', value: '1' }], { gitTracked: nothingTracked });
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe('.env\n');
    expect(res.gitignoreAdded).toBeUndefined();
  });
});

describe('secretReceipt — what the agent is told', () => {
  const result = {
    file: '.env',
    written: [{ key: 'FIREBASE_TOKEN', chars: 64, fingerprint: 'deadbeef', action: 'added' as const }],
  };

  it('names the key, the file, the size and the fingerprint', () => {
    const msg = secretReceipt(result, 'Firebase CI token');
    expect(msg).toContain('FIREBASE_TOKEN');
    expect(msg).toContain('.env');
    expect(msg).toContain('64 chars');
    expect(msg).toContain('sha256:deadbeef');
    expect(msg).toContain('Firebase CI token');
  });

  it('tells the agent it cannot see the value and must not read it back', () => {
    const msg = secretReceipt(result);
    expect(msg).toMatch(/NOT sent to you/);
    expect(msg).toMatch(/never read the file back/);
  });
});
