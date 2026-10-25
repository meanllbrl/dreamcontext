import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * This machine's identity, `~/.dreamcontext/machine.json` `{id, name}`: created once, never synced.
 *
 * The id names the machine in what DOES sync (an agent's `.active` file, its per-machine thread
 * day files `<day>-<id>.md`, an owner fallback `machine:<id>` before anyone signs in), so it is
 * random rather than derived from anything a teammate could predict. The name is the host name,
 * for the "Running on <name>" line only; nothing decides on it.
 */
export interface MachineIdentity {
  id: string;
  name: string;
}

const ID_RE = /^[0-9a-f]{12}$/;

export function machineIdentityPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'machine.json');
}

function cleanName(raw: string): string {
  const name = raw.replace(/\.local$/i, '').replace(/[^\w .-]/g, '').trim().slice(0, 64);
  return name || 'this machine';
}

function readExisting(path: string): MachineIdentity | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<MachineIdentity>;
    if (typeof parsed.id !== 'string' || !ID_RE.test(parsed.id)) return null;
    return { id: parsed.id, name: typeof parsed.name === 'string' && parsed.name.trim() ? cleanName(parsed.name) : cleanName(hostname()) };
  } catch {
    return null;
  }
}

/** This machine's identity, created on first read. Never throws: an unwritable home still gets a
 *  stable-for-this-process id (and writes it next time it can). */
let fallback: MachineIdentity | null = null;
export function readMachineIdentity(home: string = homedir()): MachineIdentity {
  const path = machineIdentityPath(home);
  const existing = readExisting(path);
  if (existing) return existing;
  const fresh: MachineIdentity = { id: randomBytes(6).toString('hex'), name: cleanName(hostname()) };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    // `wx` on the tmp only; the rename is atomic, and a racing creator's file wins below.
    writeFileSync(tmp, JSON.stringify(fresh, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    const raced = readExisting(path);
    if (raced) return raced;
    renameSync(tmp, path);
    return readExisting(path) ?? fresh;
  } catch {
    fallback ??= fresh;
    return fallback;
  }
}
