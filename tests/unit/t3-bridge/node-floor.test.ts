import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findBridgeNode, meetsBridgeFloor, nodeTooOldMessage, parseNodeVersion, versionManagerNodes } from '../../../src/lib/t3-bridge/node-floor.js';
import { codexInfo } from '../../../src/lib/t3-bridge/registry.js';
import { bridgeChatScript } from '../../../src/lib/t3-bridge/spawn.js';

let home = '';
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-node-floor-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const fakeNode = (rel: string): string => {
  const p = join(home, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '');
  return p;
};

describe('the bridge floor', () => {
  it('is a full version, not a major', () => {
    expect(meetsBridgeFloor(parseNodeVersion('v22.15.9')!)).toBe(false);
    expect(meetsBridgeFloor(parseNodeVersion('v22.16.0')!)).toBe(true);
    expect(meetsBridgeFloor(parseNodeVersion('24.1.0')!)).toBe(true);
    expect(meetsBridgeFloor(parseNodeVersion('v20.19.0')!)).toBe(false);
  });

  it('a running Node at the floor needs no search', () => {
    expect(findBridgeNode({ execPath: '/running/node', version: 'v22.16.0', home, env: {} })).toBe('/running/node');
  });

  it('finds a good Node beside an older default, newest first, starting none of the others', () => {
    fakeNode('.nvm/versions/node/v20.19.0/bin/node');
    const good = fakeNode('.nvm/versions/node/v22.16.0/bin/node');
    expect(versionManagerNodes(home)).toEqual([good]);
    const newer = fakeNode('.local/share/fnm/node-versions/v24.1.0/installation/bin/node');
    const probed: string[] = [];
    const found = findBridgeNode({ execPath: '/old', version: 'v20.19.0', home, env: {}, probe: (p) => { probed.push(p); return p === newer ? 'v24.1.0' : 'v22.16.0'; } });
    expect(found).toBe(newer);
    expect(probed).toEqual([newer]);
  });

  it('a candidate that lies about its version is not taken', () => {
    fakeNode('.nvm/versions/node/v22.16.0/bin/node');
    expect(findBridgeNode({ execPath: '/old', version: 'v20.19.0', home, env: {}, probe: () => 'v20.0.0' })).toBeNull();
  });

  it('no good Node is a readable state: Codex is not ready, and the message says why', () => {
    const info = codexInfo({ home, path: '', node: null });
    expect(info.nodeOk).toBe(false);
    expect(info.ready).toBe(false);
    expect(nodeTooOldMessage('Codex')).toContain('22.16');
    expect(nodeTooOldMessage('Codex')).toContain('default Node stays');
  });
});

describe('the bridge line', () => {
  const base = { tool: 'codex' as const, model: 'gpt-x', effort: '', mode: 'auto', pane: '', resume: '', briefingArg: [], cli: '/cli/index.js' };

  it('runs on the Node it was handed, not the server\'s', () => {
    expect(bridgeChatScript({ ...base, node: '/good/node' })).toMatch(/^exec "\/good\/node" "\/cli\/index\.js" "t3-chat"/);
  });

  it('passes linked repos as extra roots and drops one a shell could misread', () => {
    const line = bridgeChatScript({ ...base, node: '/n', extraRoots: ['/code/app', '/code/$(boom)'] })!;
    expect(line).toContain('"--extra-root" "/code/app"');
    expect(line).not.toContain('boom');
  });
});
