import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_RC_MARKER } from '../../src/lib/claude-path.js';

/**
 * install.sh is fetched on its own (curl from the npm CDN), so it cannot read
 * `assets/runtime-pins.json` at run time: it carries a COPY of the private Node.js pins.
 * The desktop app reads the JSON itself. If the two drift, the app and the CLI install
 * different Nodes into the same `~/.dreamcontext/node`, or install.sh verifies against a
 * checksum nobody pinned. This test is the guard: change the JSON, and install.sh must
 * change with it in the same commit.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const script = readFileSync(join(REPO_ROOT, 'install.sh'), 'utf-8');

interface NodePinFile { file: string; sha256: string; size: number }
interface Pins { node: { version: string; minMacos: string; base: string; files: Record<string, NodePinFile> } }
const pins = JSON.parse(readFileSync(join(REPO_ROOT, 'assets', 'runtime-pins.json'), 'utf-8')) as Pins;

function scalar(name: string): string | undefined {
  return new RegExp(`^${name}="([^"]*)"$`, 'm').exec(script)?.[1];
}

/** Every `key) NODE_PIN_FILE="…"; NODE_PIN_SHA256="…"; NODE_PIN_SIZE=… ;;` row of node_pin_for. */
function pinRows(): Record<string, NodePinFile> {
  const rows: Record<string, NodePinFile> = {};
  const re = /^\s*([a-z0-9-]+)\)\s*NODE_PIN_FILE="([^"]+)";\s*NODE_PIN_SHA256="([0-9a-f]{64})";\s*NODE_PIN_SIZE=(\d+)\s*;;/gm;
  for (let m = re.exec(script); m; m = re.exec(script)) {
    rows[m[1]] = { file: m[2], sha256: m[3], size: Number(m[4]) };
  }
  return rows;
}

describe('install.sh mirrors assets/runtime-pins.json', () => {
  it('names the same Node.js version, download base and macOS floor', () => {
    expect(scalar('NODE_VERSION')).toBe(pins.node.version);
    expect(scalar('NODE_BASE_URL')).toBe(pins.node.base);
    expect(scalar('NODE_MIN_MACOS')).toBe(pins.node.minMacos);
  });

  it('pins the same file, checksum and size for every platform, and no others', () => {
    expect(pinRows()).toEqual(pins.node.files);
  });

  it('downloads only over https', () => {
    expect(pins.node.base.startsWith('https://')).toBe(true);
  });

  it('writes the same shell-profile marker as the app', () => {
    expect(scalar('NODE_RC_MARKER')).toBe(NODE_RC_MARKER);
  });
});
