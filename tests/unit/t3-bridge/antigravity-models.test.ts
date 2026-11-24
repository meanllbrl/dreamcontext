/**
 * Antigravity's model list comes from the runtime's own answer (super/gemini-modeller), never a
 * list frozen into a release. The regression: dreamcontext offered T3's bundled manifest
 * (Gemini 3.8/3.7/3.6 Flash, 3.1 Pro) while the runtime offered Gemini 3.8 Flash, Claude
 * Sonnet 4.6, Claude Opus 4.6 and GPT-OSS 120B. A fake agent stands in for the runtime here.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityProfileDir } from '../../../src/lib/antigravity-accounts.js';
import {
  _resetAntigravityRefresh, CATALOG_TTL_MS, catalogFile, catalogFromSession, managedRuntime, readAntigravityCatalog,
  refreshAntigravityModels, removeProbeFiles, sweepStaleProbes, writeAntigravityCatalog, type Spawner,
} from '../../../src/lib/antigravity-models.js';
import { antigravityInfo, manifestModels } from '../../../src/lib/t3-bridge/registry.js';
import { renderToolsBlock } from '../../../src/lib/super/tools-block.js';
import { codexState } from '../../../dashboard/src/components/sleepy/chat/model-picker/pickerModel';

/** The `session/new` answer runtime 1.4.1 gave on this owner's account, 2026-11-22 (trimmed). */
const RUNTIME_141 = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: [
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { value: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ] },
    { id: 'thinking_level', category: 'thought_level', type: 'select', currentValue: 'high', options: [
      { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' },
    ] },
  ],
  models: {
    currentModelId: 'gemini-3.8-flash-high',
    availableModels: [
      { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
      { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
      { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { modelId: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
      { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ],
  },
};

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-agy-models-')); _resetAntigravityRefresh(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function signIn(id = 'primary'): string {
  const dir = join(antigravityProfileDir(id, home), 'antigravity-acp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'acp_token.json'), '{}');
  return antigravityProfileDir(id, home);
}

const RUNTIME = { version: '1.4.1', executable: '/nonexistent/agy_acp_server.par', harness: '/nonexistent/localharness_external' };

/** A fake ACP agent: answers initialize / authenticate / session/new with `answer`, writes the
 *  session's files in GEMINI_HOME the way the real agent does, and counts its starts. */
function fakeAgent(answer: unknown, counter: { starts: number }): Spawner {
  const src = `
    const fs = require('fs'), path = require('path');
    const answer = ${JSON.stringify(answer)};
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d; let n;
      while ((n = buf.indexOf('\\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
        let result = {};
        if (m.method === 'session/new') {
          result = answer;
          const conv = path.join(process.env.GEMINI_HOME, 'antigravity-acp', 'conversations');
          fs.mkdirSync(conv, { recursive: true });
          fs.writeFileSync(path.join(conv, answer.sessionId + '.meta'), JSON.stringify({ cwd: m.params.cwd }));
          fs.writeFileSync(path.join(conv, answer.sessionId + '.db'), '');
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      }
    });
    setInterval(() => {}, 1000);`;
  return (_cmd, _args, o) => { counter.starts++; return spawn(process.execPath, ['-e', src], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }); };
}

describe('reading the runtime\'s answer', () => {
  it('runtime 1.4: the agent\'s own ids, every vendor it offers, the selected one as default', () => {
    const c = catalogFromSession(RUNTIME_141);
    expect(c.models.map((m) => m.id)).toEqual([
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
      'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
    ]);
    expect(c.defaultModel).toBe('gemini-3.8-flash-high');
  });

  it('runtime 1.4 without the legacy list: the selected family gets one id per thinking level', () => {
    const { models: _drop, ...noLegacy } = RUNTIME_141;
    const c = catalogFromSession(noLegacy);
    expect(c.models.map((m) => m.id)).toEqual([
      'gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high',
      'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
    ]);
    expect(c.models[2]!.label).toBe('Gemini 3.8 Flash (High)');
    expect(c.defaultModel).toBe('gemini-3.8-flash-high');
  });

  it('runtime 1.3: effort in the id, listed as it is', () => {
    const c = catalogFromSession({ configOptions: [{ id: 'model', type: 'select', currentValue: 'gemini-3.8-flash-medium', options: [
      { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }, { value: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    ] }] });
    expect(c.models.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium']);
    expect(c.defaultModel).toBe('gemini-3.8-flash-medium');
  });

  it('a model option is covered by its own or its level ids, never by a longer id it prefixes', () => {
    const c = catalogFromSession({
      configOptions: [{ id: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: [
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      ] }],
      models: { availableModels: [{ modelId: 'gemini-3.8-flash-high', name: 'G' }, { modelId: 'claude-sonnet-4-6-thinking', name: 'CT' }] },
    });
    expect(c.models.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'claude-sonnet-4-6-thinking', 'claude-sonnet-4-6']);
  });

  it('drops an id that is not one token; an empty answer is no models', () => {
    const c = catalogFromSession({ models: { availableModels: [{ modelId: 'bad id\nline', name: 'x' }, { modelId: 'ok-1', name: '' }] } });
    expect(c.models).toEqual([{ id: 'ok-1', label: 'ok-1' }]);
    expect(catalogFromSession(null).models).toEqual([]);
  });
});

describe('every surface reads the runtime\'s list', () => {
  it('the registry offers the cached answer, and the bundled manifest only before any answer', () => {
    expect(antigravityInfo({ home, path: '', node: '/usr/bin/node' }).models.map((m) => m.id)).toEqual(manifestModels('antigravity').map((m) => m.id));
    const c = catalogFromSession(RUNTIME_141);
    writeAntigravityCatalog({ checkedAt: Date.now(), version: '1.4.1', ...c }, home);
    const info = antigravityInfo({ home, path: '', node: '/usr/bin/node' });
    expect(info.models.map((m) => m.id)).toContain('claude-opus-4-6-thinking');
    expect(info.models.map((m) => m.id)).not.toContain('gemini-3.7-flash-high');
    expect(info.defaultModel).toBe('gemini-3.8-flash-high');
    // The Super's tools line and the picker read this same object.
    const block = renderToolsBlock([{ ...info, installed: true, signedIn: true, ready: true }]);
    expect(block).toMatch(/`antigravity`[^\n]*Models: gemini-3\.8-flash-high \(default\), gemini-3\.8-flash-medium, gemini-3\.8-flash-low, claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium;/);
    const picker = codexState({ ...info, installed: true, signedIn: true, ready: true });
    expect(picker.current.map((m) => m.id)).toEqual(info.models.map((m) => m.id));
    expect(picker.legacy).toEqual([]);
  });

  it('the picker files only an older version of the same line under legacy', () => {
    const m = (id: string) => ({ id, label: id, efforts: [] });
    const s = codexState({ tool: 'antigravity', label: 'Antigravity', ready: true, installed: true, signedIn: true, nodeOk: true, models: [
      m('gemini-3.8-flash-high'), m('gemini-3.7-flash-low'), m('gemini-3.1-pro-low'), m('gpt-oss-120b-medium'), m('gpt-oss-20b-medium'),
    ] });
    // Pro is its own line (not an old Flash); 20B and 120B are sizes, not versions.
    expect(s.current.map((x) => x.id)).toEqual(['gemini-3.8-flash-high', 'gemini-3.1-pro-low', 'gpt-oss-120b-medium', 'gpt-oss-20b-medium']);
    expect(s.legacy.map((x) => x.id)).toEqual(['gemini-3.7-flash-low']);
  });

  it('a corrupt cache is no cache', () => {
    mkdirSync(join(home, '.dreamcontext', 't3'), { recursive: true });
    writeFileSync(catalogFile(home), '{not json');
    expect(readAntigravityCatalog(home)).toBeNull();
  });
});

describe('refresh: asked, cached, re-asked when stale', () => {
  it('asks the runtime, caches its answer and removes the probe\'s session files', async () => {
    const profile = signIn();
    const n = { starts: 0 };
    const c = await refreshAntigravityModels({ home, runtime: RUNTIME, spawn: fakeAgent(RUNTIME_141, n) });
    expect(n.starts).toBe(1);
    expect(c?.models.map((m) => m.id)).toContain('gpt-oss-120b-medium');
    expect(readAntigravityCatalog(home)?.version).toBe('1.4.1');
    expect(readdirSync(join(profile, 'antigravity-acp', 'conversations'))).toEqual([]);
  });

  it('a fresh list is not re-asked; a stale one picks up a model the runtime added, with no release', async () => {
    signIn();
    const n = { starts: 0 };
    await refreshAntigravityModels({ home, runtime: RUNTIME, spawn: fakeAgent(RUNTIME_141, n) });
    await refreshAntigravityModels({ home, runtime: RUNTIME, spawn: fakeAgent(RUNTIME_141, n) });
    expect(n.starts).toBe(1);
    const added = { ...RUNTIME_141, models: { ...RUNTIME_141.models, availableModels: [{ modelId: 'gemini-4-pro-high', name: 'Gemini 4 Pro (High)' }, ...RUNTIME_141.models.availableModels] } };
    const later = Date.now() + CATALOG_TTL_MS + 1;
    const c = await refreshAntigravityModels({ home, now: later, runtime: RUNTIME, spawn: fakeAgent(added, n) });
    expect(n.starts).toBe(2);
    expect(c?.models[0]).toEqual({ id: 'gemini-4-pro-high', label: 'Gemini 4 Pro (High)' });
    expect(antigravityInfo({ home, path: '', node: '/usr/bin/node' }).models[0]!.id).toBe('gemini-4-pro-high');
  });

  it('another account or another runtime version re-asks before the list is old', async () => {
    signIn();
    const n = { starts: 0 };
    await refreshAntigravityModels({ home, runtime: RUNTIME, spawn: fakeAgent(RUNTIME_141, n) });
    expect(readAntigravityCatalog(home)?.account).toBe('primary');
    await refreshAntigravityModels({ home, runtime: { ...RUNTIME, version: '1.5.0' }, spawn: fakeAgent(RUNTIME_141, n) });
    expect(n.starts).toBe(2);
    expect(readAntigravityCatalog(home)?.version).toBe('1.5.0');
    writeAntigravityCatalog({ ...readAntigravityCatalog(home)!, account: 'acct-other' }, home);
    await refreshAntigravityModels({ home, runtime: { ...RUNTIME, version: '1.5.0' }, spawn: fakeAgent(RUNTIME_141, n) });
    expect(n.starts).toBe(3);
  });

  it('sweeps probe workspaces a dead server left, never a young one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-agy-sweep-'));
    const old = join(dir, 'dc-agy-models-old'), young = join(dir, 'dc-agy-models-young'), other = join(dir, 'other-old');
    for (const p of [old, young, other]) mkdirSync(p);
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    await sweepStaleProbes(dir);
    expect([existsSync(old), existsSync(young), existsSync(other)]).toEqual([false, true, true]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks nothing with no signed-in account or no managed runtime; a failed probe keeps the last list', async () => {
    const n = { starts: 0 };
    expect(await refreshAntigravityModels({ home, runtime: RUNTIME, spawn: fakeAgent(RUNTIME_141, n) })).toBeNull();
    signIn();
    expect(await refreshAntigravityModels({ home, runtime: null, spawn: fakeAgent(RUNTIME_141, n) })).toBeNull();
    expect(n.starts).toBe(0);
    writeAntigravityCatalog({ checkedAt: 0, version: '1.4.1', defaultModel: 'a-1', models: [{ id: 'a-1', label: 'A 1' }] }, home);
    const dead: Spawner = (_c, _a, o) => { n.starts++; return spawn(process.execPath, ['-e', 'process.exit(3)'], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }); };
    expect((await refreshAntigravityModels({ home, runtime: RUNTIME, spawn: dead }))?.models[0]!.id).toBe('a-1');
    // Not retried at once after a failure.
    await refreshAntigravityModels({ home, runtime: RUNTIME, spawn: dead });
    expect(n.starts).toBe(1);
  });

  it('removes only session files whose workspace is the probe\'s own', async () => {
    const profile = signIn();
    const conv = join(profile, 'antigravity-acp', 'conversations');
    mkdirSync(conv, { recursive: true });
    const sid = '11111111-2222-4333-8444-555555555555';
    writeFileSync(join(conv, `${sid}.meta`), JSON.stringify({ cwd: '/someone/else' }));
    const cwd = mkdtempSync(join(tmpdir(), 'dc-agy-probe-'));
    await removeProbeFiles(profile, sid, cwd);
    expect(existsSync(join(conv, `${sid}.meta`))).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it('reads T3\'s managed runtime record', () => {
    const root = join(home, '.dreamcontext', 't3', 'tools', 'antigravity-acp', 'darwin-arm64');
    const id = 'f'.repeat(64);
    mkdirSync(join(root, 'versions', id), { recursive: true });
    writeFileSync(join(root, 'active.json'), JSON.stringify({ releaseId: id }));
    writeFileSync(join(root, 'versions', id, '.install-complete.json'), JSON.stringify({ version: '1.4.1', executable: { name: 'agy_acp_server.par' }, harness: { name: 'localharness_external' } }));
    expect(managedRuntime(home, 'darwin', 'arm64')).toEqual({ version: '1.4.1', executable: join(root, 'versions', id, 'agy_acp_server.par'), harness: join(root, 'versions', id, 'localharness_external') });
    writeFileSync(join(root, 'versions', id, '.install-complete.json'), JSON.stringify({ executable: { name: '../x' }, harness: { name: 'h' } }));
    expect(managedRuntime(home, 'darwin', 'arm64')).toBeNull();
  });
});
