import { describe, it, expect } from 'vitest';
import { Router } from '../../src/server/router.js';

const noop = async () => {};

describe('Router param matching', () => {
  it(':param matches a single path segment only', () => {
    const r = new Router();
    r.get('/api/knowledge/:slug', noop);
    expect(r.match('GET', '/api/knowledge/auth-system')?.params).toEqual({ slug: 'auth-system' });
    // A slash-bearing slug must NOT match a single-segment param.
    expect(r.match('GET', '/api/knowledge/data-structures/lina')).toBeNull();
  });

  it('*param is a rest param matching across slashes', () => {
    const r = new Router();
    r.get('/api/knowledge/*slug', noop);
    expect(r.match('GET', '/api/knowledge/data-structures/lina')?.params).toEqual({
      slug: 'data-structures/lina',
    });
    expect(r.match('GET', '/api/knowledge/products/lina')?.params).toEqual({
      slug: 'products/lina',
    });
    // Still matches a bare single-segment slug.
    expect(r.match('GET', '/api/knowledge/top-level')?.params).toEqual({ slug: 'top-level' });
  });

  it('rest param does not swallow the list route', () => {
    const r = new Router();
    r.get('/api/knowledge', noop);
    r.get('/api/knowledge/*slug', noop);
    expect(r.match('GET', '/api/knowledge')).not.toBeNull();
    expect(r.match('GET', '/api/knowledge')?.params).toEqual({});
  });

  it('decodes percent-encoded params', () => {
    const r = new Router();
    r.get('/api/knowledge/*slug', noop);
    expect(r.match('GET', '/api/knowledge/data-structures%2Flina')?.params).toEqual({
      slug: 'data-structures/lina',
    });
  });

  it('respects the HTTP method', () => {
    const r = new Router();
    r.patch('/api/knowledge/*slug', noop);
    expect(r.match('GET', '/api/knowledge/data-structures/lina')).toBeNull();
    expect(r.match('PATCH', '/api/knowledge/data-structures/lina')).not.toBeNull();
  });
});
