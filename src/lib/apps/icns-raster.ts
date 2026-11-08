import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type IconExec = (cmd: string, args: string[]) => Promise<unknown>;

/**
 * A web view cannot draw an `.icns`, and the icon route serves rasters only. Keyed by content,
 * so a new icon converts once and an old one is never served. Null, never a throw: the row then
 * draws the app's letter.
 */
export async function icnsToPng(src: string, home: string = homedir(), exec: IconExec = (c, a) => run(c, a, { timeout: 15_000 })): Promise<string | null> {
  if (extname(src).toLowerCase() !== '.icns') return null;
  try {
    const dir = join(home, '.dreamcontext', 'cache', 'app-icons');
    const out = join(dir, `${createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 32)}.png`);
    if (existsSync(out)) return out;
    mkdirSync(dir, { recursive: true });
    await exec('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '128', src, '--out', out]);
    return existsSync(out) ? out : null;
  } catch {
    return null;
  }
}
