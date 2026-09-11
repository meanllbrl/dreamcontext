import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addConnectorList,
  connectorCachePath,
  connectorDue,
  connectorPath,
  consumeConnectorEvents,
  createConnector,
  freshCache,
  getConnector,
  isSafeConnectorSlug,
  listConnectors,
  readConnectorCache,
  removeConnector,
  removeConnectorList,
  writeConnectorCache,
} from '../../src/lib/connectors/store.js';
import {
  ConnectorError,
  DEFAULT_EVERY_CYCLES,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_EVENTS,
  type ConnectorEvent,
} from '../../src/lib/connectors/types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-connectors-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeEvent(id: string, t: string, text = 'x'): ConnectorEvent {
  return { id, t, kind: 'comment', list: 'L', task: 'T', author: null, text, link: null };
}

describe('connector slugs', () => {
  it('accepts kebab-case and rejects the rest', () => {
    expect(isSafeConnectorSlug('clickup-product-lists')).toBe(true);
    expect(isSafeConnectorSlug('UPPER')).toBe(false);
    expect(isSafeConnectorSlug('a--b')).toBe(false);
    expect(isSafeConnectorSlug('trailing-')).toBe(false);
    expect(isSafeConnectorSlug('../escape')).toBe(false);
  });
});

describe('createConnector', () => {
  it('creates a multi-list manifest with defaults and reads it back', () => {
    const m = createConnector(root, {
      slug: 'clickup-team',
      title: 'Team ClickUp',
      lists: [
        { id: '901', name: 'DietPal' },
        { id: '902', name: null },
      ],
    });
    expect(m.source.kind).toBe('clickup');
    expect(m.source.lists).toEqual([
      { id: '901', name: 'DietPal' },
      { id: '902', name: null },
    ]);
    expect(m.cadence).toEqual({ every_cycles: DEFAULT_EVERY_CYCLES, ttl_hours: null });
    expect(m.caps).toEqual({ max_events: DEFAULT_MAX_EVENTS, max_chars: DEFAULT_MAX_CHARS });
    expect(m.body).toContain('## Learn');
    expect(getConnector(root, 'clickup-team')?.source.lists).toHaveLength(2);
    expect(listConnectors(root)).toHaveLength(1);
  });

  it('requires at least one list and rejects duplicates', () => {
    expect(() => createConnector(root, { slug: 'a', title: 'A', lists: [] })).toThrow(ConnectorError);
    expect(() =>
      createConnector(root, { slug: 'a', title: 'A', lists: [{ id: '1', name: null }, { id: '1', name: null }] }),
    ).toThrow(/Duplicate/);
  });

  it('rejects an existing slug and unknown kinds', () => {
    createConnector(root, { slug: 'a', title: 'A', lists: [{ id: '1', name: null }] });
    expect(() => createConnector(root, { slug: 'a', title: 'A', lists: [{ id: '2', name: null }] })).toThrow(/already exists/);
    expect(() =>
      createConnector(root, { slug: 'b', title: 'B', kind: 'slack', lists: [{ id: '1', name: null }] }),
    ).toThrow(/kind must be/);
  });

  it('honours an explicit cadence', () => {
    const m = createConnector(root, {
      slug: 'slow',
      title: 'Slow',
      lists: [{ id: '1', name: null }],
      every_cycles: 3,
      ttl_hours: 48,
    });
    expect(m.cadence).toEqual({ every_cycles: 3, ttl_hours: 48 });
  });
});

describe('list management', () => {
  it('adds and removes lists; a removed list drops its cursor', () => {
    createConnector(root, { slug: 'c', title: 'C', lists: [{ id: '1', name: 'One' }] });
    let m = addConnectorList(root, 'c', { id: '2', name: 'Two' });
    expect(m.source.lists.map((l) => l.id)).toEqual(['1', '2']);
    expect(() => addConnectorList(root, 'c', { id: '2', name: null })).toThrow(/already on/);

    const cache = freshCache('c');
    cache.cursors = { '1': 111, '2': 222 };
    writeConnectorCache(root, cache);

    m = removeConnectorList(root, 'c', '2');
    expect(m.source.lists.map((l) => l.id)).toEqual(['1']);
    expect(readConnectorCache(root, 'c').cursors).toEqual({ '1': 111 });
    expect(() => removeConnectorList(root, 'c', '9')).toThrow(/not on/);
  });
});

describe('cache', () => {
  it('round-trips atomically and degrades to fresh on garbage', () => {
    expect(readConnectorCache(root, 'x')).toEqual(freshCache('x'));
    const cache = freshCache('x');
    cache.events = [makeEvent('e1', '2026-08-01T00:00:00.000Z')];
    cache.pulledAt = '2026-08-01T00:00:00.000Z';
    writeConnectorCache(root, cache);
    expect(readConnectorCache(root, 'x').events).toHaveLength(1);
  });

  it('gitignores the cache directory before writing pulled content', () => {
    writeConnectorCache(root, freshCache('x'));
    expect(existsSync(connectorCachePath(root, 'x'))).toBe(true);
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('connectors/cache/');
  });
});

describe('connectorDue', () => {
  const NOW = Date.parse('2026-08-07T12:00:00.000Z');

  function manifest(every: number | null, ttl: number | null) {
    const m = createConnector(root, {
      slug: `due-${Math.abs(every ?? 0)}-${Math.abs(ttl ?? 0)}`,
      title: 'D',
      lists: [{ id: '1', name: null }],
      every_cycles: every ?? undefined,
      ttl_hours: ttl ?? undefined,
    });
    return m;
  }

  it('is due when never pulled', () => {
    const m = manifest(2, null);
    expect(connectorDue(m, freshCache(m.slug), 5, NOW).due).toBe(true);
  });

  it('fires on the sleep-cycle cadence', () => {
    const m = manifest(2, null);
    const cache = freshCache(m.slug);
    cache.pulledAt = '2026-08-07T00:00:00.000Z';
    cache.pulledCycle = 5;
    expect(connectorDue(m, cache, 6, NOW).due).toBe(false);
    expect(connectorDue(m, cache, 7, NOW).due).toBe(true);
  });

  it('fires on ttl_hours independently of cycles', () => {
    const m = manifest(null, 8);
    const cache = freshCache(m.slug);
    cache.pulledCycle = 5;
    cache.pulledAt = new Date(NOW - 10 * 3_600_000).toISOString();
    expect(connectorDue(m, cache, 5, NOW).due).toBe(true);
    cache.pulledAt = new Date(NOW - 2 * 3_600_000).toISOString();
    expect(connectorDue(m, cache, 5, NOW).due).toBe(false);
  });
});

describe('consume + remove', () => {
  it('consume clears pending events and stamps consumedAt', () => {
    createConnector(root, { slug: 'c', title: 'C', lists: [{ id: '1', name: null }] });
    const cache = freshCache('c');
    cache.events = [makeEvent('e1', '2026-08-01T00:00:00.000Z'), makeEvent('e2', '2026-08-02T00:00:00.000Z')];
    writeConnectorCache(root, cache);

    expect(consumeConnectorEvents(root, 'c')).toBe(2);
    const after = readConnectorCache(root, 'c');
    expect(after.events).toEqual([]);
    expect(after.consumedAt).not.toBeNull();
    expect(() => consumeConnectorEvents(root, 'ghost')).toThrow(/not found/);
  });

  it('remove deletes manifest and cache', () => {
    createConnector(root, { slug: 'c', title: 'C', lists: [{ id: '1', name: null }] });
    writeConnectorCache(root, freshCache('c'));
    removeConnector(root, 'c');
    expect(existsSync(connectorPath(root, 'c'))).toBe(false);
    expect(existsSync(connectorCachePath(root, 'c'))).toBe(false);
  });
});
