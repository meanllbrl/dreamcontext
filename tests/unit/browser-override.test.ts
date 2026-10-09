/**
 * The chat's Playwright MCP re-declared headless with a CDP side door (src/lib/browser-override.ts).
 *
 * The precedence and the replace-by-name behaviour these tests assume were MEASURED on
 * 2026-10-08 against the real CLI (a `--mcp-config` server named like a project one replaces
 * it; between two `--mcp-config` files the later wins). These tests pin what this module does
 * with that: which definition it finds, and what it emits in its place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findPlaywrightServer, isPlaywrightServer, mergedConfig, overrideDefinition, prepareBrowserOverride,
} from '../../src/lib/browser-override.js';

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bo-home-'));
  project = mkdtempSync(join(tmpdir(), 'bo-proj-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const PW = { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] };

function claudeJson(body: Record<string, unknown>): void {
  writeFileSync(join(home, '.claude.json'), JSON.stringify(body));
}
function mcpJson(servers: Record<string, unknown>): void {
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

describe('findPlaywrightServer', () => {
  it('finds nothing when no scope has the official package', () => {
    claudeJson({ mcpServers: { other: { command: 'node', args: ['x.js'] } } });
    expect(findPlaywrightServer(project, home)).toBeNull();
  });

  it('reads local, then project, then user, like the CLI', () => {
    claudeJson({ mcpServers: { pw: PW }, projects: { [project]: { mcpServers: { playwright: PW } } } });
    mcpJson({ playwright: PW });
    expect(findPlaywrightServer(project, home)?.scope).toBe('local');
    claudeJson({ mcpServers: { pw: PW } });
    expect(findPlaywrightServer(project, home)?.scope).toBe('project');
    rmSync(join(project, '.mcp.json'));
    expect(findPlaywrightServer(project, home)).toMatchObject({ scope: 'user', name: 'pw' });
  });

  it('a non-Playwright server in a higher scope shadows the same name below it', () => {
    claudeJson({ projects: { [project]: { mcpServers: { playwright: { command: 'node', args: ['mine.js'] } } } } });
    mcpJson({ playwright: PW });
    expect(findPlaywrightServer(project, home)).toBeNull();
  });

  it('leaves alone a server that attaches to a browser the owner launched', () => {
    claudeJson({ mcpServers: { playwright: { ...PW, args: [...PW.args, '--cdp-endpoint', 'http://127.0.0.1:9222'] } } });
    expect(findPlaywrightServer(project, home)).toBeNull();
    claudeJson({ mcpServers: { playwright: { ...PW, args: [...PW.args, '--extension'] } } });
    expect(findPlaywrightServer(project, home)).toBeNull();
  });

  it('an http server is never Playwright, whatever its name', () => {
    expect(isPlaywrightServer({ type: 'http', url: 'https://x.test/@playwright/mcp' })).toBe(false);
  });
});

describe('overrideDefinition', () => {
  it("a PROJECT server's command and env are never re-emitted: that would skip the CLI's approval", () => {
    const hostile = { type: 'stdio', command: 'sh', args: ['-c', 'evil', '@playwright/mcp'], env: { NODE_OPTIONS: '--require /tmp/x.js' } };
    const def = overrideDefinition({ name: 'playwright', scope: 'project', raw: hostile }, '/c.json');
    expect(def).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--config', '/c.json'] });
  });

  it("an owner's own server keeps its command, version, flags and env; headed and config flags are replaced", () => {
    const raw = { type: 'stdio', command: 'npx', args: ['@playwright/mcp@0.0.40', '--headed', '--config', '/mine.json', '--user-data-dir', '/p'], env: { A: '1' } };
    const def = overrideDefinition({ name: 'pw', scope: 'user', raw }, '/c.json');
    expect(def).toEqual({
      type: 'stdio', command: 'npx', env: { A: '1' },
      args: ['@playwright/mcp@0.0.40', '--user-data-dir', '/p', '--headless', '--config', '/c.json'],
    });
  });
});

describe('mergedConfig', () => {
  it('adds the port to launch args, replaces an old port, keeps everything else', () => {
    const base = { browser: { browserName: 'chromium', launchOptions: { channel: 'chrome', args: ['--lang=tr', '--remote-debugging-port=1'] } }, network: { x: 1 } };
    expect(mergedConfig(base, 4242)).toEqual({
      browser: { browserName: 'chromium', launchOptions: { channel: 'chrome', headless: true, args: ['--lang=tr', '--remote-debugging-port=4242'] } },
      network: { x: 1 },
    });
  });
});

describe('prepareBrowserOverride', () => {
  it('writes an MCP config under the found name, pointing at a playwright config with the port; dispose removes both', () => {
    claudeJson({ projects: { [project]: { mcpServers: { playwright: PW } } } });
    const o = prepareBrowserOverride(project, home, () => 45678);
    expect(o).not.toBeNull();
    expect(o!.port).toBe(45678);
    expect(o!.server).toBe('playwright');
    const mcp = JSON.parse(readFileSync(o!.configPath, 'utf-8'));
    const args: string[] = mcp.mcpServers.playwright.args;
    expect(args).toContain('--headless');
    const cfg = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf-8'));
    expect(cfg.browser.launchOptions.args).toEqual(['--remote-debugging-port=45678']);
    o!.dispose();
    expect(existsSync(o!.configPath)).toBe(false);
  });

  it('folds the owner\'s own --config into the one it writes', () => {
    const own = join(home, 'pw.json');
    mkdirSync(home, { recursive: true });
    writeFileSync(own, JSON.stringify({ browser: { launchOptions: { args: ['--lang=tr'] } } }));
    claudeJson({ mcpServers: { playwright: { ...PW, args: [...PW.args, '--config', own] } } });
    const o = prepareBrowserOverride(project, home, () => 45679)!;
    const args: string[] = JSON.parse(readFileSync(o.configPath, 'utf-8')).mcpServers.playwright.args;
    const cfg = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf-8'));
    expect(cfg.browser.launchOptions.args).toEqual(['--lang=tr', '--remote-debugging-port=45679']);
    expect(args.filter((a) => a === '--config')).toHaveLength(1);
    o.dispose();
  });

  it('no server, or no port → null, and the session runs as before', () => {
    expect(prepareBrowserOverride(project, home, () => 45680)).toBeNull();
    claudeJson({ mcpServers: { playwright: PW } });
    expect(prepareBrowserOverride(project, home, () => null)).toBeNull();
  });
});
