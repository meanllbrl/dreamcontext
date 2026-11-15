import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyCli, readAppCliRecord, appCliRecordPath, recordValid, shouldReexec,
  type AppCliRecord, type CliKind,
} from '../../src/lib/cli-precedence.js';

/**
 * Plan npmsiz-beta C3′, criterion 9: the TS classifier answers the same vector file the Rust
 * shell's `cli_choice.rs` test reads, so both halves agree byte for byte.
 */
interface ClassifyVector {
  name: string; os: 'darwin' | 'win32'; home: string; entry: string; exec: string;
  pkgName: string | null; record: AppCliRecord | null; installLocation: string | null; expect: CliKind;
}
interface DecideVector { name: string; kind: CliKind; recordValid: boolean; reexecFlag: boolean; expect: 'self' | 'reexec' }

const vectors = JSON.parse(readFileSync(join(__dirname, '..', '..', 'assets', 'cli-precedence-vectors.json'), 'utf-8')) as {
  classify: ClassifyVector[]; decide: DecideVector[];
};

describe('C3′ classify vectors', () => {
  it('has vectors to run', () => {
    expect(vectors.classify.length).toBeGreaterThan(10);
    expect(vectors.decide.length).toBeGreaterThan(5);
  });
  for (const v of vectors.classify) {
    it(v.name, () => {
      expect(classifyCli({
        windows: v.os === 'win32', home: v.home, entry: v.entry, exec: v.exec,
        pkgName: v.pkgName, record: v.record, installLocation: v.installLocation,
      })).toBe(v.expect);
    });
  }
});

describe('C2′ record vectors (the bin/rt copy, and the Mac bundle form)', () => {
  const recs = (vectors as unknown as { record: Array<{ name: string; os: string; home: string; version: string; node: string; entry: string; expect: boolean }> }).record;
  it('has record vectors', () => expect(recs.length).toBeGreaterThanOrEqual(10));
  for (const v of recs) {
    it(v.name, () => {
      expect(recordValid({ version: v.version, node: v.node, entry: v.entry }, v.home, v.os === 'win32')).toBe(v.expect);
    });
  }
});

describe('C3′ decide vectors', () => {
  for (const v of vectors.decide) {
    it(v.name, () => {
      expect(shouldReexec(v.kind, v.recordValid, v.reexecFlag) ? 'reexec' : 'self').toBe(v.expect);
    });
  }
});

describe('readAppCliRecord (C2′)', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-appcli-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });
  const good = () => ({
    version: '0.42.0',
    node: join(home, '.dreamcontext', 'bin', 'rt', '0.42.0', 'runtime', 'bin', 'node'),
    entry: join(home, '.dreamcontext', 'bin', 'rt', '0.42.0', 'dist', 'index.js'),
    appPath: '/Applications/dreamcontext-beta.app',
  });
  const write = (o: unknown) => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(appCliRecordPath(home), typeof o === 'string' ? o : JSON.stringify(o));
  };

  it('reads a valid record', () => {
    write(good());
    expect(readAppCliRecord(home, false)).toEqual(good());
  });

  it('no file, malformed JSON, extra keys, wrong types and paths outside bin/rt are absent', () => {
    expect(readAppCliRecord(home, false)).toBeNull();
    for (const bad of [
      '{not json', '[]', 'null',
      { ...good(), extra: 1 },
      { ...good(), version: 42 },
      { ...good(), version: 'latest' },
      { ...good(), node: '/tmp/evil/node' },
      { ...good(), entry: join(home, '.dreamcontext', 'bin', 'rt', '0.42.0', '..', '..', 'x.js') },
      { ...good(), appPath: 7 },
    ]) {
      write(bad);
      expect(readAppCliRecord(home, false)).toBeNull();
    }
  });

  it('a symlinked record or ~/.dreamcontext is absent', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'dc-appcli-x-'));
    try {
      writeFileSync(join(elsewhere, 'r.json'), JSON.stringify(good()));
      mkdirSync(join(home, '.dreamcontext'), { recursive: true });
      symlinkSync(join(elsewhere, 'r.json'), appCliRecordPath(home));
      expect(readAppCliRecord(home, false)).toBeNull();
      rmSync(join(home, '.dreamcontext'), { recursive: true, force: true });
      mkdirSync(join(elsewhere, 'dc'));
      writeFileSync(join(elsewhere, 'dc', 'app-cli.json'), JSON.stringify(good()));
      symlinkSync(join(elsewhere, 'dc'), join(home, '.dreamcontext'));
      expect(readAppCliRecord(home, false)).toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
