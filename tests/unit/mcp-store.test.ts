/**
 * dreamcontext's own MCP stores (task mcp-management W1, criteria 3 + 4): Claude Code's configs
 * are COPIED in and never written; an unedited copy follows its source, an edited one is frozen
 * and flagged, a removed one stays removed; untrusted store files are never handed to a spawn.
 * Every test runs on an injected HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computerStorePath, defHash, legacyMirrorPath, mcpStoreFiles, projectStorePath, readStore,
  removeStoreServer, saveStoreServer, storeFileProblem, storeServers, syncImports, storeFileRefs,
} from '../../src/lib/mcp-store.js';

let home: string;
let project: string;
const sandbox = () => join(home, '.dreamcontext', 'claude-accounts', 'work');

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function claudeJson(value: unknown): void { writeJson(join(home, '.claude.json'), value); }
function sandboxJson(value: unknown): void { writeJson(join(sandbox(), '.claude.json'), value); }
const computer = () => readStore(computerStorePath(home))!;
const projectStore = () => readStore(projectStorePath(project, home))!;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-mcp-store-home-'));
  project = mkdtempSync(join(tmpdir(), 'dc-mcp-store-proj-'));
  writeJson(join(home, '.dreamcontext', 'claude-accounts.json'), {
    accounts: [{ id: 'work', email: 'work@example.test', configDir: sandbox() }],
  });
  claudeJson({
    mcpServers: {
      posthog: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer user-secret-1' } },
      'bad name!': { command: 'x' },
    },
    projects: { [project]: { mcpServers: { supabase: { type: 'http', url: 'https://db.example.test/mcp?key=local-secret' } } } },
  });
  // A literal `"__proto__"` key, as JSON.parse makes it (an object literal would set the prototype).
  const raw = readFileSync(join(home, '.claude.json'), 'utf-8').replace('"mcpServers": {', '"mcpServers": {\n    "__proto__": { "command": "evil" },');
  if (!raw.includes('"__proto__"')) throw new Error('fixture: no __proto__ key');
  writeFileSync(join(home, '.claude.json'), raw);
  sandboxJson({ mcpServers: { stitch: { type: 'stdio', command: 'stitch-mcp', env: { TOKEN: 'sandbox-secret' } } } });
  writeJson(legacyMirrorPath(home), { mcpServers: { posthog: { headers: { Authorization: 'stale' } } } });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('syncImports — copy, never move', () => {
  it('puts every server in the right store and leaves every Claude config byte-identical', () => {
    const before = [join(home, '.claude.json'), join(sandbox(), '.claude.json')].map((p) => readFileSync(p));
    const r = syncImports(home, project);
    expect(Object.keys(computer().mcpServers).sort()).toEqual(['posthog', 'stitch']);
    expect(Object.keys(projectStore().mcpServers)).toEqual(['supabase']);
    expect(computer().ledger.posthog).toMatchObject({ source: 'user', editedInApp: false });
    expect(computer().ledger.stitch).toMatchObject({ source: 'sandbox:work' });
    expect(projectStore().ledger.supabase).toMatchObject({ source: 'local:user' });
    expect(projectStore().projectRoot).toBeTruthy();
    const after = [join(home, '.claude.json'), join(sandbox(), '.claude.json')].map((p) => readFileSync(p));
    expect(after).toEqual(before);
    // 0600 files, 0700 project dir, the legacy mirror gone.
    expect(statSync(computerStorePath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(projectStorePath(project, home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.dreamcontext', 'mcp', 'projects')).mode & 0o777).toBe(0o700);
    expect(existsSync(legacyMirrorPath(home))).toBe(false);
    // `__proto__` never became a key; a bad name is listed as "found outside".
    expect(Object.hasOwn(computer().mcpServers, '__proto__')).toBe(false);
    expect(readFileSync(computerStorePath(home), 'utf-8')).not.toContain('evil');
    expect(r.outside).toContainEqual({ name: 'bad name!', source: 'user', reason: 'bad-name' });
    // Nothing is written inside the project folder.
    expect(existsSync(join(project, '.mcp.json'))).toBe(false);
  });

  it('an unedited copy follows its source (a header changed in ~/.claude.json)', () => {
    syncImports(home, project);
    const blob = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'));
    blob.mcpServers.posthog.headers.Authorization = 'Bearer rotated';
    claudeJson(blob);
    syncImports(home, project);
    expect((computer().mcpServers.posthog.headers as Record<string, string>).Authorization).toBe('Bearer rotated');
    expect(computer().ledger.posthog.importedHash).toBe(defHash(blob.mcpServers.posthog));
  });

  it('an entry saved from Settings is frozen and listed as differing', () => {
    syncImports(home, project);
    saveStoreServer('computer', 'posthog', { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'x' } }, { home, projectRoot: project, keep: ['headers.Authorization'] });
    // `keep` held the stored value although the form sent another.
    expect((computer().mcpServers.posthog.headers as Record<string, string>).Authorization).toBe('Bearer user-secret-1');
    const blob = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'));
    blob.mcpServers.posthog.url = 'https://elsewhere.example.test/mcp';
    claudeJson(blob);
    const r = syncImports(home, project);
    expect(computer().mcpServers.posthog.url).toBe('https://mcp.example.test/mcp');
    expect(computer().ledger.posthog.editedInApp).toBe(true);
    expect(r.outside).toContainEqual({ name: 'posthog', source: 'user', reason: 'differs' });
  });

  it('a server removed in Settings is not re-imported', () => {
    syncImports(home, project);
    expect(removeStoreServer('computer', 'stitch', { home, projectRoot: project })).toBe(true);
    const r = syncImports(home, project);
    expect(Object.hasOwn(computer().mcpServers, 'stitch')).toBe(false);
    expect(r.outside).toContainEqual({ name: 'stitch', source: 'sandbox:work', reason: 'removed-in-app' });
  });

  it('a name removed at its source: an unedited copy is dropped, an edited one kept and flagged', () => {
    syncImports(home, project);
    saveStoreServer('computer', 'stitch', { type: 'stdio', command: 'stitch-mcp', env: { TOKEN: 'mine' } }, { home, projectRoot: project });
    claudeJson({ mcpServers: {}, projects: {} });
    sandboxJson({ mcpServers: {} });
    syncImports(home, project);
    expect(Object.hasOwn(computer().mcpServers, 'posthog')).toBe(false);
    expect(Object.hasOwn(projectStore().mcpServers, 'supabase')).toBe(false);
    expect(Object.hasOwn(computer().mcpServers, 'stitch')).toBe(true);
    expect(computer().ledger.stitch.goneAtSource).toBe(true);
  });

  it('an unreadable source (mid-write) removes nothing', () => {
    syncImports(home, project);
    writeFileSync(join(home, '.claude.json'), '{ half a file');
    syncImports(home, project);
    expect(Object.hasOwn(computer().mcpServers, 'posthog')).toBe(true);
  });

  it('a ledgered name never moves to another source: unreadable own source + a conflicting second one (W1 review)', () => {
    sandboxJson({ mcpServers: { posthog: { type: 'http', url: 'https://old.example.test/mcp', headers: { Authorization: 'OLD-sandbox-key' } } } });
    syncImports(home, project);
    expect(computer().ledger.posthog.source).toBe('user');
    const good = readFileSync(join(home, '.claude.json'), 'utf-8');
    writeFileSync(join(home, '.claude.json'), '{ mid-write');
    syncImports(home, project);
    expect(computer().ledger.posthog.source).toBe('user');
    expect((computer().mcpServers.posthog.headers as Record<string, string>).Authorization).toBe('Bearer user-secret-1');
    writeFileSync(join(home, '.claude.json'), good);
    syncImports(home, project);
    expect(computer().ledger.posthog.source).toBe('user');
    expect((computer().mcpServers.posthog.headers as Record<string, string>).Authorization).toBe('Bearer user-secret-1');
  });

  it('removed at its own source while another source has it: dropped, never re-homed in the same sync', () => {
    sandboxJson({ mcpServers: { posthog: { type: 'http', url: 'https://old.example.test/mcp' } } });
    syncImports(home, project);
    const blob = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'));
    delete blob.mcpServers.posthog;
    claudeJson(blob);
    syncImports(home, project);
    expect(Object.hasOwn(computer().mcpServers, 'posthog')).toBe(false);
    // The next sync sees a name no ledger holds: a plain copy from the source that has it.
    syncImports(home, project);
    expect(computer().ledger.posthog.source).toBe('sandbox:work');
  });

  it('the same name with two definitions: the first source wins, the other is a conflict', () => {
    sandboxJson({ mcpServers: { posthog: { type: 'http', url: 'https://other.example.test/mcp' } } });
    const r = syncImports(home, project);
    expect(computer().mcpServers.posthog.url).toBe('https://mcp.example.test/mcp');
    expect(r.outside).toContainEqual({ name: 'posthog', source: 'sandbox:work', reason: 'conflict' });
  });

  it('`__proto__` is refused as a Settings name and never pollutes a prototype', () => {
    expect(() => saveStoreServer('computer', '__proto__', { command: 'x' }, { home })).toThrow();
    syncImports(home, project);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });
});

describe('mcpStoreFiles — only trusted files reach a spawn', () => {
  it('hands both stores, computer first, after a sync', () => {
    const r = mcpStoreFiles({ home, projectRoot: project });
    expect(r.files).toEqual([computerStorePath(home), projectStorePath(project, home)]);
    expect(r.problems).toEqual([]);
    expect([...storeServers(project, home).keys()].sort()).toEqual(['posthog', 'stitch', 'supabase']);
  });

  it('skips a project store that is a symlink', () => {
    mcpStoreFiles({ home, projectRoot: project });
    const p = projectStorePath(project, home);
    const elsewhere = join(home, 'planted.json');
    writeFileSync(elsewhere, JSON.stringify({ mcpServers: { evil: { command: 'rm' } } }), { mode: 0o600 });
    rmSync(p);
    symlinkSync(elsewhere, p);
    const r = mcpStoreFiles({ home, projectRoot: project });
    expect(r.files).toEqual([computerStorePath(home)]);
    expect(r.problems).toContainEqual({ scope: 'project', reason: 'it is a symlink' });
    expect(storeServers(project, home).has('evil')).toBe(false);
  });

  it('skips a project store that is not 0600', () => {
    mcpStoreFiles({ home, projectRoot: project });
    chmodSync(projectStorePath(project, home), 0o644);
    const r = mcpStoreFiles({ home, projectRoot: project });
    expect(r.files).toEqual([computerStorePath(home)]);
    expect(r.problems).toContainEqual({ scope: 'project', reason: 'its permissions are not 0600' });
  });

  it('skips a store owned by another uid', () => {
    mcpStoreFiles({ home, projectRoot: project });
    const p = projectStorePath(project, home);
    const realGetuid = process.getuid;
    process.getuid = () => (realGetuid!.call(process) + 1);
    try {
      expect(storeFileProblem(p)).toBe('it is owned by another user');
      const r = mcpStoreFiles({ home, projectRoot: project, sync: false });
      expect(r.files).toEqual([]);
    } finally {
      process.getuid = realGetuid;
    }
  });

  it('storeFileRefs names env variables, never the paths', () => {
    const r = storeFileRefs(['/a b/$(x)/mcp.json', '/p.json']);
    expect(r.refs).toEqual(['$DREAMCONTEXT_MCP_CFG_0', '$DREAMCONTEXT_MCP_CFG_1']);
    expect(r.env).toEqual({ DREAMCONTEXT_MCP_CFG_0: '/a b/$(x)/mcp.json', DREAMCONTEXT_MCP_CFG_1: '/p.json' });
  });
});
