import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readJsonArray,
  writeJsonArray,
  insertToJsonArray,
  readJsonObject,
  writeJsonObject,
  inspectJsonArray,
} from '../../src/lib/json-file.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('json-file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readJsonArray', () => {
    it('reads a JSON array file', () => {
      const file = join(tmpDir, 'arr.json');
      writeFileSync(file, '[{"id": 1}, {"id": 2}]');
      const result = readJsonArray(file);
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('reads an empty array', () => {
      const file = join(tmpDir, 'empty.json');
      writeFileSync(file, '[]');
      expect(readJsonArray(file)).toEqual([]);
    });

    it('throws on non-array JSON (object)', () => {
      const file = join(tmpDir, 'obj.json');
      writeFileSync(file, '{"key": "value"}');
      expect(() => readJsonArray(file)).toThrow('Expected JSON array');
    });

    // A vault scaffolded by hand (or by pre-0.9 tooling) wrapped these files in
    // an object. Reading through the wrapper is what stops that from failing
    // loudly for RELEASES.json and SILENTLY for CHANGELOG.json.
    it('reads through the {"entries": [...]} wrapper (CHANGELOG.json shape)', () => {
      const file = join(tmpDir, 'changelog.json');
      writeFileSync(file, '{"entries": [{"id": 1}, {"id": 2}]}');
      expect(readJsonArray(file)).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('reads through the {"releases": []} wrapper (RELEASES.json shape)', () => {
      const file = join(tmpDir, 'releases.json');
      writeFileSync(file, '{"releases": []}');
      expect(readJsonArray(file)).toEqual([]);
    });

    it('prefers the known wrapper key over other keys in the object', () => {
      const file = join(tmpDir, 'wrapped-meta.json');
      writeFileSync(file, '{"version": 1, "entries": [{"id": 1}], "notes": ["x"]}');
      expect(readJsonArray(file)).toEqual([{ id: 1 }]);
    });

    it('reads through a single-key wrapper under any key name', () => {
      const file = join(tmpDir, 'history.json');
      writeFileSync(file, '{"history": [{"id": 7}]}');
      expect(readJsonArray(file)).toEqual([{ id: 7 }]);
    });

    it('still throws on a multi-key object with no known wrapper key', () => {
      const file = join(tmpDir, 'ambiguous.json');
      writeFileSync(file, '{"history": [1], "archive": [2]}');
      expect(() => readJsonArray(file)).toThrow('Expected JSON array');
    });

    it('does not read an inherited key as a wrapper', () => {
      const file = join(tmpDir, 'proto.json');
      // `constructor` and `toString` live on Object.prototype; neither may
      // satisfy the wrapper lookup, and neither is an own array.
      writeFileSync(file, '{"a": 1, "b": 2}');
      expect(() => readJsonArray(file)).toThrow('Expected JSON array');
    });

    it('names the shape and the repair in the error message', () => {
      const file = join(tmpDir, 'num.json');
      writeFileSync(file, '42');
      expect(() => readJsonArray(file)).toThrow(/got number.*bare JSON array/s);
    });

    it('throws on non-array JSON (string)', () => {
      const file = join(tmpDir, 'str.json');
      writeFileSync(file, '"hello"');
      expect(() => readJsonArray(file)).toThrow('Expected JSON array');
    });

    it('throws on invalid JSON', () => {
      const file = join(tmpDir, 'bad.json');
      writeFileSync(file, 'not json at all');
      expect(() => readJsonArray(file)).toThrow();
    });

    it('throws on non-existent file', () => {
      expect(() => readJsonArray(join(tmpDir, 'nope.json'))).toThrow();
    });

    it('reads array of primitives', () => {
      const file = join(tmpDir, 'prims.json');
      writeFileSync(file, '[1, "two", true, null]');
      expect(readJsonArray(file)).toEqual([1, 'two', true, null]);
    });
  });

  describe('writeJsonArray', () => {
    it('writes pretty-formatted JSON with trailing newline', () => {
      const file = join(tmpDir, 'write.json');
      writeJsonArray(file, [{ a: 1 }]);
      const raw = readFileSync(file, 'utf-8');
      expect(raw).toBe('[\n  {\n    "a": 1\n  }\n]\n');
    });

    it('writes empty array', () => {
      const file = join(tmpDir, 'empty.json');
      writeJsonArray(file, []);
      const raw = readFileSync(file, 'utf-8');
      expect(raw).toBe('[]\n');
    });

    it('overwrites existing file', () => {
      const file = join(tmpDir, 'over.json');
      writeFileSync(file, '[1,2,3]');
      writeJsonArray(file, [4, 5]);
      expect(readJsonArray(file)).toEqual([4, 5]);
    });
  });

  describe('insertToJsonArray', () => {
    it('inserts at top (LIFO) by default', () => {
      const file = join(tmpDir, 'insert.json');
      writeFileSync(file, '[{"id": 1}]');
      insertToJsonArray(file, { id: 2 });
      const result = readJsonArray(file);
      expect(result).toEqual([{ id: 2 }, { id: 1 }]);
    });

    it('inserts at bottom when position=bottom', () => {
      const file = join(tmpDir, 'insert.json');
      writeFileSync(file, '[{"id": 1}]');
      insertToJsonArray(file, { id: 2 }, 'bottom');
      const result = readJsonArray(file);
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('inserts into empty array', () => {
      const file = join(tmpDir, 'empty.json');
      writeFileSync(file, '[]');
      insertToJsonArray(file, { id: 1 });
      expect(readJsonArray(file)).toEqual([{ id: 1 }]);
    });

    it('inserts multiple items maintaining order', () => {
      const file = join(tmpDir, 'multi.json');
      writeFileSync(file, '[]');
      insertToJsonArray(file, { id: 1 });
      insertToJsonArray(file, { id: 2 });
      insertToJsonArray(file, { id: 3 });
      expect(readJsonArray(file)).toEqual([{ id: 3 }, { id: 2 }, { id: 1 }]);
    });

    // The self-heal: a wrongly-scaffolded file is normalised to a bare array by
    // the first write through it, losing nothing that was inside the wrapper.
    it('normalises a wrapper object to a bare array on write, preserving entries', () => {
      const file = join(tmpDir, 'wrapped.json');
      writeFileSync(file, '{"entries": [{"id": 1}]}');
      insertToJsonArray(file, { id: 2 });

      const raw = readFileSync(file, 'utf-8');
      expect(raw.trimStart().startsWith('[')).toBe(true);
      expect(JSON.parse(raw)).toEqual([{ id: 2 }, { id: 1 }]);
    });
  });

  describe('inspectJsonArray', () => {
    it('classifies a bare array', () => {
      expect(inspectJsonArray([1, 2])).toEqual({ kind: 'array', array: [1, 2] });
    });

    it('classifies a wrapper object, naming the key it unwrapped', () => {
      expect(inspectJsonArray({ releases: [{ v: 1 }] })).toEqual({
        kind: 'wrapped', array: [{ v: 1 }], wrapperKey: 'releases',
      });
    });

    it('classifies unreadable shapes with the actual type', () => {
      expect(inspectJsonArray(null)).toEqual({ kind: 'invalid', actual: 'null' });
      expect(inspectJsonArray('hi')).toEqual({ kind: 'invalid', actual: 'string' });
      expect(inspectJsonArray(42)).toEqual({ kind: 'invalid', actual: 'number' });
      expect(inspectJsonArray({ a: 1 })).toEqual({ kind: 'invalid', actual: 'object' });
    });

    it('does not treat an inherited key as a wrapper', () => {
      const inherited = Object.create({ entries: [{ id: 1 }] }) as Record<string, unknown>;
      inherited.other = 1;
      expect(inspectJsonArray(inherited)).toEqual({ kind: 'invalid', actual: 'object' });
    });
  });

  describe('readJsonObject', () => {
    it('reads a JSON object file', () => {
      const file = join(tmpDir, 'obj.json');
      writeFileSync(file, '{"name": "test", "value": 42}');
      const result = readJsonObject(file);
      expect(result).toEqual({ name: 'test', value: 42 });
    });

    it('reads a nested object', () => {
      const file = join(tmpDir, 'nested.json');
      writeFileSync(file, '{"a": {"b": [1, 2]}}');
      const result = readJsonObject(file);
      expect(result).toEqual({ a: { b: [1, 2] } });
    });

    it('throws on array JSON', () => {
      const file = join(tmpDir, 'arr.json');
      writeFileSync(file, '[1, 2, 3]');
      expect(() => readJsonObject(file)).toThrow('Expected JSON object');
    });

    it('throws on string JSON', () => {
      const file = join(tmpDir, 'str.json');
      writeFileSync(file, '"hello"');
      expect(() => readJsonObject(file)).toThrow('Expected JSON object');
    });

    it('throws on null JSON', () => {
      const file = join(tmpDir, 'null.json');
      writeFileSync(file, 'null');
      expect(() => readJsonObject(file)).toThrow('Expected JSON object');
    });

    it('throws on invalid JSON', () => {
      const file = join(tmpDir, 'bad.json');
      writeFileSync(file, 'not json');
      expect(() => readJsonObject(file)).toThrow();
    });

    it('throws on non-existent file', () => {
      expect(() => readJsonObject(join(tmpDir, 'nope.json'))).toThrow();
    });
  });

  describe('writeJsonObject', () => {
    it('writes pretty-formatted JSON with trailing newline', () => {
      const file = join(tmpDir, 'write.json');
      writeJsonObject(file, { a: 1, b: 'two' });
      const raw = readFileSync(file, 'utf-8');
      expect(raw).toBe('{\n  "a": 1,\n  "b": "two"\n}\n');
    });

    it('overwrites existing file', () => {
      const file = join(tmpDir, 'over.json');
      writeFileSync(file, '{"old": true}');
      writeJsonObject(file, { new: true });
      const result = readJsonObject(file);
      expect(result).toEqual({ new: true });
    });

    it('writes empty object', () => {
      const file = join(tmpDir, 'empty.json');
      writeJsonObject(file, {});
      const raw = readFileSync(file, 'utf-8');
      expect(raw).toBe('{}\n');
    });
  });
});
