import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/lib/marketing/env-loader.js';

describe('marketing/env-loader', () => {
  it('parses simple KEY=value', () => {
    const r = parseEnv('FOO=bar\nBAZ=qux\n');
    expect(r.values).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(r.errors).toEqual([]);
  });

  it('strips BOM', () => {
    const r = parseEnv('﻿FOO=bar\n');
    expect(r.values.FOO).toBe('bar');
  });

  it('handles CRLF and LF', () => {
    const r = parseEnv('A=1\r\nB=2\nC=3\r\n');
    expect(r.values).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('treats # as comment outside quotes; allows inline # inside double quotes', () => {
    const r = parseEnv('# top comment\nFOO=hello # tail\nBAR="hash # inside"\n');
    expect(r.values.FOO).toBe('hello');
    expect(r.values.BAR).toBe('hash # inside');
  });

  it('trims unquoted values; preserves quoted whitespace', () => {
    const r = parseEnv('A=  spaced  \nB="  spaced  "\n');
    expect(r.values.A).toBe('spaced');
    expect(r.values.B).toBe('  spaced  ');
  });

  it('honors double-quote escapes \\n \\t \\\\ \\"', () => {
    const r = parseEnv('A="line1\\nline2\\twith\\\\backslash and \\"quotes\\""\n');
    expect(r.values.A).toBe('line1\nline2\twith\\backslash and "quotes"');
  });

  it('supports multiline only inside double-quoted values', () => {
    const r = parseEnv('A="hello\nworld"\nB=after\n');
    expect(r.values.A).toBe('hello\nworld');
    expect(r.values.B).toBe('after');
  });

  it('treats single-quoted values as literal', () => {
    const r = parseEnv("A='no \\n escape'\n");
    expect(r.values.A).toBe('no \\n escape');
  });

  it('treats = inside quoted value as literal', () => {
    const r = parseEnv('A="a=b=c"\n');
    expect(r.values.A).toBe('a=b=c');
  });

  it('rejects keys not matching [A-Z_][A-Z0-9_]*', () => {
    const r = parseEnv('lower=1\nGOOD=2\n9BAD=3\n');
    expect(r.values).toEqual({ GOOD: '2' });
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('tolerates `export` prefix', () => {
    const r = parseEnv('export FOO=bar\n');
    expect(r.values.FOO).toBe('bar');
  });
});
