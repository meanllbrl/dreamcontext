import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DownloadError, downloadVerified, fetchWithSafeRedirects, isAllowedDownloadUrl,
} from '../../src/lib/onboarding/download.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-download-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A fetch that answers from a table of url → Response factory, and records every url asked. */
function fakeFetch(table: Record<string, () => Response>): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const make = table[url];
    if (!make) throw new TypeError('fetch failed');
    return make();
  }) as typeof fetch;
  return { fetchImpl, asked };
}

/** A body with no content-length, delivered in chunks. */
function streamed(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  }));
}

const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

describe('isAllowedDownloadUrl', () => {
  it('accepts https and refuses everything else unless the loopback seam is allowed', () => {
    expect(isAllowedDownloadUrl('https://example.com/a')).toBe(true);
    expect(isAllowedDownloadUrl('http://example.com/a')).toBe(false);
    expect(isAllowedDownloadUrl('http://127.0.0.1:4000/a')).toBe(false);
    expect(isAllowedDownloadUrl('http://127.0.0.1:4000/a', true)).toBe(true);
    expect(isAllowedDownloadUrl('http://127.0.0.1.evil.example/a', true)).toBe(false);
    expect(isAllowedDownloadUrl('http://127.0.0.1@evil.example/a', true)).toBe(false);
    expect(isAllowedDownloadUrl('https://user:pw@example.com/a')).toBe(false);
    expect(isAllowedDownloadUrl('file:///etc/passwd', true)).toBe(false);
    expect(isAllowedDownloadUrl('not a url')).toBe(false);
  });
});

describe('downloadVerified', () => {
  it('writes the file when the checksum matches and leaves no temp file', async () => {
    const body = 'hello archive';
    const { fetchImpl } = fakeFetch({ 'https://dl.example/a.zip': () => new Response(body) });
    const dest = join(dir, 'a.zip');
    const progress: number[] = [];
    const r = await downloadVerified('https://dl.example/a.zip', {
      sha256: sha(body), maxBytes: 1000, dest, fetchImpl, onProgress: (n) => progress.push(n),
    });
    expect(r.bytes).toBe(body.length);
    expect(readFileSync(dest, 'utf-8')).toBe(body);
    expect(readdirSync(dir)).toEqual(['a.zip']);
    expect(progress.at(-1)).toBe(body.length);
  });

  it('a checksum mismatch throws `checksum` and removes the temp file', async () => {
    const { fetchImpl } = fakeFetch({ 'https://dl.example/a.zip': () => new Response('tampered') });
    const dest = join(dir, 'a.zip');
    await expect(downloadVerified('https://dl.example/a.zip', { sha256: sha('original'), maxBytes: 1000, dest, fetchImpl }))
      .rejects.toMatchObject({ reason: 'checksum' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('follows an https redirect but refuses one that lands on http', async () => {
    const ok = fakeFetch({
      'https://a.example/x': redirect('https://b.example/x'),
      'https://b.example/x': () => new Response('fine'),
    });
    await expect(downloadVerified('https://a.example/x', { maxBytes: 100, dest: join(dir, 'x'), fetchImpl: ok.fetchImpl }))
      .resolves.toMatchObject({ bytes: 4 });

    const bad = fakeFetch({
      'https://a.example/y': redirect('http://b.example/y'),
      'http://b.example/y': () => new Response('evil'),
    });
    await expect(downloadVerified('https://a.example/y', { maxBytes: 100, dest: join(dir, 'y'), fetchImpl: bad.fetchImpl }))
      .rejects.toMatchObject({ reason: 'refused' });
    expect(bad.asked).toEqual(['https://a.example/y']);
    expect(existsSync(join(dir, 'y'))).toBe(false);
  });

  it('refuses a body over the cap, by declared length and while streaming', async () => {
    const declared = fakeFetch({ 'https://dl.example/big': () => new Response('x'.repeat(50)) });
    await expect(downloadVerified('https://dl.example/big', { maxBytes: 10, dest: join(dir, 'big'), fetchImpl: declared.fetchImpl }))
      .rejects.toMatchObject({ reason: 'refused' });

    const chunked = fakeFetch({ 'https://dl.example/big2': () => streamed(['aaaaaa', 'bbbbbb']) });
    await expect(downloadVerified('https://dl.example/big2', { maxBytes: 10, dest: join(dir, 'big2'), fetchImpl: chunked.fetchImpl }))
      .rejects.toMatchObject({ reason: 'refused' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a non-https URL outright and a network failure reads as offline', async () => {
    const { fetchImpl, asked } = fakeFetch({});
    await expect(downloadVerified('http://dl.example/a', { maxBytes: 10, dest: join(dir, 'a'), fetchImpl }))
      .rejects.toMatchObject({ reason: 'refused' });
    expect(asked).toEqual([]);
    await expect(downloadVerified('https://dl.example/a', { maxBytes: 10, dest: join(dir, 'a'), fetchImpl }))
      .rejects.toMatchObject({ reason: 'offline' });
  });

  it('accepts the loopback seam only when the caller allows it', async () => {
    const { fetchImpl } = fakeFetch({ 'http://127.0.0.1:4000/install.sh': () => new Response('#!/bin/sh\n') });
    await expect(downloadVerified('http://127.0.0.1:4000/install.sh', { maxBytes: 100, dest: join(dir, 's'), fetchImpl }))
      .rejects.toBeInstanceOf(DownloadError);
    await expect(downloadVerified('http://127.0.0.1:4000/install.sh', { maxBytes: 100, dest: join(dir, 's'), fetchImpl, allowLoopback: true }))
      .resolves.toMatchObject({ bytes: 10 });
  });

  it('refuses to write into a symlinked folder', async () => {
    const real = join(dir, 'real');
    mkdirSync(real);
    const link = join(dir, 'link');
    symlinkSync(real, link);
    const { fetchImpl } = fakeFetch({ 'https://dl.example/a': () => new Response('x') });
    await expect(downloadVerified('https://dl.example/a', { maxBytes: 10, dest: join(link, 'a'), fetchImpl }))
      .rejects.toMatchObject({ reason: 'refused' });
    expect(readdirSync(real)).toEqual([]);
  });

  it('fetchWithSafeRedirects stops after too many hops', async () => {
    const table: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i++) table[`https://loop.example/${i}`] = redirect(`https://loop.example/${i + 1}`);
    const { fetchImpl } = fakeFetch(table);
    await expect(fetchWithSafeRedirects('https://loop.example/0', { fetchImpl })).rejects.toMatchObject({ reason: 'refused' });
  });
});
