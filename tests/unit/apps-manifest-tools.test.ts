import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkToolInput, effectOf, parseManifest, type AppAction } from '../../src/lib/apps/manifest.js';

/**
 * A tool's description (app-araclari plan r3 §2): `actions[]` grows optional fields, an old
 * manifest still opens, and ONE function decides read or change by the method alone.
 */

const base = (actions: unknown[]) => JSON.stringify({ slug: 'yuk', name: 'Yük', backend: { command: 'node s.mjs', health: '/health' }, actions });

describe('effectOf', () => {
  it.each([
    [{ method: 'GET' }, 'read'],
    [{ method: 'get' }, 'read'],
    [{ method: 'GET', danger: true }, 'change'],
    [{ method: 'POST' }, 'change'],
    [{ method: 'PUT' }, 'change'],
    [{ method: 'PATCH' }, 'change'],
    [{ method: 'DELETE' }, 'change'],
  ] as const)('%j → %s', (a, want) => expect(effectOf(a)).toBe(want));

  it('an app writing effect: "read" on a POST cannot make it a read (a warning says so)', () => {
    const m = parseManifest(base([{ id: 'q', title: 'Q', method: 'POST', path: '/q', effect: 'read', does: 'x' }]), null);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(effectOf(m.manifest.actions[0])).toBe('change');
    expect(m.warnings.some((w) => w.field === 'actions[0].effect' && w.authoring)).toBe(true);
  });
});

describe('the new fields', () => {
  it('parses does, params, output, usesAgent, topics, timeoutSec', () => {
    const m = parseManifest(base([{
      id: 'ask', title: 'Ask', method: 'POST', path: '/api/ask', does: 'Asks the assistant.\nTwo lines.', output: '{answer}',
      params: { q: { type: 'string', required: true, desc: 'the question' }, mode: { type: 'enum', choices: ['a', 'b'] } },
      usesAgent: true, topics: ['yük', 'cpu', 7], timeoutSec: 120,
    }]), null);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.manifest.actions[0]).toEqual({
      id: 'ask', title: 'Ask', method: 'POST', path: '/api/ask', does: 'Asks the assistant. Two lines.', output: '{answer}',
      params: { q: { type: 'string', required: true, desc: 'the question' }, mode: { type: 'enum', required: false, choices: ['a', 'b'] } },
      usesAgent: true, topics: ['yük', 'cpu'], timeoutSec: 120,
    });
    expect(m.warnings).toEqual([]);
  });

  it.each([
    [{ params: { q: { type: 'blob' } } }, 'actions[0].params.q'],
    [{ params: { q: { type: 'enum' } } }, 'actions[0].params.q.choices'],
    [{ params: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, { type: 'string' }])) }, 'actions[0].params'],
    [{ params: { '1bad': { type: 'string' } } }, 'actions[0].params.1bad'],
    [{ timeoutSec: 3 }, 'actions[0].timeoutSec'],
    [{ timeoutSec: 301 }, 'actions[0].timeoutSec'],
    [{ effect: 'write' }, 'actions[0].effect'],
  ])('refuses %j with a field and a fix', (extra, field) => {
    const m = parseManifest(base([{ id: 'a', title: 'A', method: 'GET', path: '/a', ...extra }]), null);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.errors[0].field).toBe(field);
    expect(m.errors[0].fix.length).toBeGreaterThan(10);
  });

  it('a tool with no does, or a free-text input, is a writing hint, never an app-card warning', () => {
    const m = parseManifest(base([{ id: 'a', title: 'A', method: 'POST', path: '/a', input: '{q}' }]), null);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.warnings.map((w) => w.field).sort()).toEqual(['actions[0].does', 'actions[0].input']);
    expect(m.warnings.every((w) => w.authoring)).toBe(true);
  });

  it("Yük İzleme's manifest as it is today still opens: snapshot reads, ask and notify-test change", () => {
    const yuk = JSON.stringify({
      slug: 'yuk-izleme', name: 'Yük İzleme', icon: null, backend: { command: 'node server.mjs', health: '/health' },
      actions: [
        { id: 'snapshot', title: 'Tek ölçüm: makine ve dreamcontext yükü', method: 'GET', path: '/api/yuk' },
        { id: 'ask', title: 'Asistana makine yükünü sor', method: 'POST', path: '/api/ask', input: '{q}' },
        { id: 'notify-test', title: 'Bildirim dene (notch|mac|both)', method: 'POST', path: '/api/notify-test', input: '{mode}' },
      ],
      agent: { member: 'ua-manager', brief: 'Yük İzleme denemesi.' },
    });
    const m = parseManifest(yuk, null);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.manifest.actions.map((a) => `${a.id}:${effectOf(a)}`)).toEqual(['snapshot:read', 'ask:change', 'notify-test:change']);
  });

  it('the template manifest describes its tool', () => {
    const t = readFileSync(join(__dirname, '..', '..', 'skill-apps', 'template', 'dreamcontext-app.json'), 'utf-8').replace(/__SLUG__/g, 'hello-app').replace(/__NAME__/g, 'Hello');
    const m = parseManifest(t, null);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.warnings.filter((w) => w.authoring)).toEqual([]);
  });
});

describe('checkToolInput', () => {
  const a: AppAction = {
    id: 't', title: 'T', method: 'POST', path: '/t',
    params: { q: { type: 'string', required: true, desc: 'what to ask' }, n: { type: 'number', required: false }, on: { type: 'boolean', required: false }, d: { type: 'date', required: false }, m: { type: 'enum', required: false, choices: ['x', 'y'] } },
  };
  it.each([
    [undefined, 'q: required (what to ask)'],
    [{}, 'q: required (what to ask)'],
    [[], '(input): give a JSON object, e.g. {"q": "…"}'],
    [{ q: 1 }, 'q: give a string'],
    [{ q: 'a', n: '3' }, 'n: give a number'],
    [{ q: 'a', on: 'yes' }, 'on: give true or false'],
    [{ q: 'a', d: 'tomorrow' }, 'd: give a date as YYYY-MM-DD'],
    [{ q: 'a', m: 'z' }, 'm: one of x, y'],
    [{ q: 'a', zz: 1 }, 'zz: not an input of this tool (inputs: q, n, on, d, m)'],
    [{ q: 'a', n: 2, on: false, d: '2026-11-07', m: 'y' }, null],
  ])('%j → %s', (input, want) => expect(checkToolInput(a, input)).toBe(want));

  it('a tool with no params takes any JSON (the app checks it)', () => {
    expect(checkToolInput({ id: 'x', title: 'X', method: 'POST', path: '/x' }, { anything: [1] })).toBeNull();
  });
});
