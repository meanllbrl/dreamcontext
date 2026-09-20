/**
 * Unit tests for the team-shared MCP scope (src/lib/mcp-project.ts).
 *
 * The load-bearing assertions here are the REFUSALS. `.mcp.json` is committed, and on this
 * product a brain repo is synced across a team, so a literal key written into it is a key
 * handed to every teammate and to the remote's history — where deleting it later does not
 * unpublish it. Every test that proves something is NOT written is guarding that.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import {
  envVarNameFor, isSafeToCommit, maskTarget, planAdoption, projectMcpBroken, projectMcpPath,
  rawProjectServers, readProjectMcp, writeProjectMcp,
} from '../../src/lib/mcp-project.js';

let repo: string;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'dc-mcp-repo-')); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

const writeFile = (body: unknown) =>
  writeFileSync(projectMcpPath(repo), typeof body === 'string' ? body : JSON.stringify(body));

describe('isSafeToCommit', () => {
  it('a ${VAR} reference is safe — the value lives in each person\'s environment', () => {
    expect(isSafeToCommit('${FAL_API_KEY}')).toBe(true);
    expect(isSafeToCommit('  ${FAL_API_KEY}  ')).toBe(true);
    expect(isSafeToCommit('${FAL_API_KEY:-}')).toBe(true);
  });

  it('a literal is NOT safe, however innocent it looks', () => {
    // Deliberately not an entropy guess: a value placed under env/headers is being passed as
    // a credential whether or not it reads like one.
    expect(isSafeToCommit('sk-live-abc123')).toBe(false);
    expect(isSafeToCommit('test')).toBe(false);
    expect(isSafeToCommit('')).toBe(false);
  });

  it('a value that merely CONTAINS a reference is not a reference', () => {
    // `Bearer ${TOKEN}` would publish the word Bearer plus whatever else is around it, and
    // more importantly is a shape this writer has never validated — so it is refused.
    expect(isSafeToCommit('Bearer ${TOKEN}')).toBe(false);
    expect(isSafeToCommit('${A}${B}')).toBe(false);
  });
});

describe('maskTarget', () => {
  it('hides a token that is wearing a URL\'s clothes', () => {
    // Three servers on the machine this was written for are exactly this shape: the path
    // segment IS the credential.
    expect(maskTarget('https://fal-mcp.example.workers.dev/mcp/a328cb1bbe64782ae766a1430750b2f9'))
      .toBe('https://fal-mcp.example.workers.dev/mcp/••••');
  });

  it('leaves an ordinary URL alone', () => {
    expect(maskTarget('https://mcp.figma.com/mcp')).toBe('https://mcp.figma.com/mcp');
    expect(maskTarget('https://calendarmcp.googleapis.com/mcp/v1'))
      .toBe('https://calendarmcp.googleapis.com/mcp/v1');
  });

  it('masks every opaque segment, not just the first — the regex is global and stateless', () => {
    // A `g` regex reused for `.test()` carries lastIndex between calls; this asserts the
    // shared constant is only ever used for replacement.
    const twice = 'https://x.test/aaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(maskTarget(twice)).toBe('https://x.test/••••/••••');
    expect(maskTarget(twice)).toBe('https://x.test/••••/••••');
  });
});

describe('planAdoption', () => {
  it('turns every literal env value into a reference and names what must be set', () => {
    const plan = planAdoption('designer-pack', {
      command: 'npx', args: ['designer-pack-mcp'], env: { API_KEY: 'sk-live-secret' },
    });
    expect((plan.definition.env as Record<string, string>).API_KEY).toBe('${DESIGNER_PACK_API_KEY}');
    expect(plan.requires).toEqual(['DESIGNER_PACK_API_KEY']);
  });

  it('the secret itself never survives into the definition', () => {
    const plan = planAdoption('x', { env: { TOKEN: 'sk-live-do-not-publish' } });
    expect(JSON.stringify(plan.definition)).not.toContain('sk-live-do-not-publish');
  });

  it('headers are treated exactly like env — an Authorization header is a credential', () => {
    const plan = planAdoption('corridor', {
      type: 'http', url: 'https://app.example.dev/api/mcp', headers: { Authorization: 'Bearer abc' },
    });
    expect((plan.definition.headers as Record<string, string>).Authorization)
      .toBe('${CORRIDOR_AUTHORIZATION}');
    expect(plan.requires).toEqual(['CORRIDOR_AUTHORIZATION']);
  });

  it('a value ALREADY a reference is left alone and adds no new requirement', () => {
    const plan = planAdoption('x', { env: { API_KEY: '${MY_KEY}' } });
    expect((plan.definition.env as Record<string, string>).API_KEY).toBe('${MY_KEY}');
    expect(plan.requires).toEqual([]);
  });

  it('reports — never silently rewrites — a URL that carries its own token', () => {
    // Splitting a URL into a reference changes what the server points at. Only the user can
    // make that call, so the route refuses and says why.
    const plan = planAdoption('fal', {
      type: 'http', url: 'https://fal-mcp.example.workers.dev/mcp/a328cb1bbe64782ae766a1430750b2f9',
    });
    expect(plan.urlCarriedSecret).toBe(true);
    expect(plan.definition.url).toBe('https://fal-mcp.example.workers.dev/mcp/a328cb1bbe64782ae766a1430750b2f9');
  });

  it('an ordinary server needs nothing and is clean to share', () => {
    const plan = planAdoption('playwright', { command: 'npx', args: ['-y', '@playwright/mcp@latest'] });
    expect(plan.requires).toEqual([]);
    expect(plan.urlCarriedSecret).toBe(false);
  });
});

describe('envVarNameFor', () => {
  it('prefixes the server so two servers\' keys cannot collide', () => {
    expect(envVarNameFor('designer-pack', 'API_KEY')).toBe('DESIGNER_PACK_API_KEY');
    expect(envVarNameFor('nativeminds-kb', 'token')).toBe('NATIVEMINDS_KB_TOKEN');
  });

  it('does not stutter when the key already carries the server name', () => {
    expect(envVarNameFor('sentry', 'SENTRY_TOKEN')).toBe('SENTRY_TOKEN');
  });
});

describe('writeProjectMcp', () => {
  it('writes a clean definition and reads back the same server', () => {
    const written = writeProjectMcp(repo, { playwright: { command: 'npx', args: ['-y', 'x'] } });
    expect(written).toEqual({ ok: true });
    expect(readProjectMcp(repo).map((s) => s.name)).toEqual(['playwright']);
  });

  it('REFUSES to write a literal secret, and names every offending field', () => {
    const written = writeProjectMcp(repo, {
      a: { env: { KEY: 'literal-secret' } },
      b: { headers: { Authorization: 'Bearer nope' } },
      c: { env: { KEY: '${FINE}' } },
    });
    expect(written.ok).toBe(false);
    expect(written.ok === false && written.unsafe.sort()).toEqual(['a.env.KEY', 'b.headers.Authorization']);
  });

  it('…and writes NOTHING when it refuses — not even the safe servers', () => {
    // A partial write would publish nothing but would leave the team file half-built; worse,
    // a caller could take "some of it landed" as success.
    writeProjectMcp(repo, { bad: { env: { KEY: 'literal' } } });
    expect(readProjectMcp(repo)).toEqual([]);
  });

  it('the refused secret never reaches the disk', () => {
    writeProjectMcp(repo, { bad: { env: { KEY: 'sk-live-do-not-publish' } } });
    let onDisk = '';
    try { onDisk = readFileSync(projectMcpPath(repo), 'utf-8'); } catch { onDisk = ''; }
    expect(onDisk).not.toContain('sk-live-do-not-publish');
  });
});

describe('readProjectMcp', () => {
  it('reports key NAMES and a masked target, never a value', () => {
    // A hand-written file CAN hold a literal (someone edited it directly). Reading it must not
    // carry that value out to the client, which is a browser surface and a log away from it.
    writeFile({ mcpServers: { s: {
      type: 'http', url: 'https://x.test/mcp',
      headers: { Authorization: 'Bearer sk-live-do-not-publish' },
      env: { OTHER: '${T}' },
    } } });
    const [server] = readProjectMcp(repo);
    expect(server.headerKeys).toEqual(['Authorization']);
    expect(server.envKeys).toEqual(['OTHER']);
    expect(server.requires).toEqual(['T']);
    expect(JSON.stringify(server)).not.toContain('sk-live-do-not-publish');
  });

  it('derives the kind when the file did not name it', () => {
    writeFile({ mcpServers: { a: { url: 'https://x.test/mcp' }, b: { command: 'npx' } } });
    const kinds = Object.fromEntries(readProjectMcp(repo).map((s) => [s.name, s.kind]));
    expect(kinds).toEqual({ a: 'http', b: 'stdio' });
  });

  it('a missing file is an empty list and NOT "broken"', () => {
    expect(readProjectMcp(repo)).toEqual([]);
    expect(projectMcpBroken(repo)).toBe(false);
  });

  it('a malformed file is EMPTY but flagged broken — silence would hide a dead team config', () => {
    writeFile('{ this is not json');
    expect(readProjectMcp(repo)).toEqual([]);
    expect(projectMcpBroken(repo)).toBe(true);
    expect(rawProjectServers(repo)).toEqual({});
  });
});
