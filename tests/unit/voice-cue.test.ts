/**
 * The "Anlayamadım" cue (task sesli-giris-bozuk…, AC4/AC9): `say` with an argument list, files
 * only under `voice-cues/`, one render per language at a time, failures not cached.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cueAudio, cueDir, cueLanguage } from '../../src/lib/voice/cue.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-cue-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** A fake `say`: records its argv and writes the `-o` file. */
function fakeSay(calls: string[][], opts: { fail?: boolean; delay?: number } = {}) {
  return async (args: string[]) => {
    calls.push(args);
    if (args[0] === '-v' && args[1] === '?') return 'Yelda               tr_TR    # Merhaba\nSamantha            en_US    # Hello\n';
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (opts.fail) throw new Error('say failed');
    const out = args[args.indexOf('-o') + 1];
    writeFileSync(out, Buffer.from('RIFFfakeWAVE'));
    return '';
  };
}

describe('cue', () => {
  it('renders with an argument list, the voice for the language, under voice-cues/ only', async () => {
    const calls: string[][] = [];
    const wav = await cueAudio('turkish', { home, run: fakeSay(calls) });
    expect(wav?.toString()).toBe('RIFFfakeWAVE');
    const render = calls.find((c) => c.includes('-o'))!;
    expect(render.slice(0, 2)).toEqual(['-v', 'Yelda']);
    expect(render.at(-1)).toBe('Anlayamadım, tekrar eder misin?');
    expect(readdirSync(cueDir(home))).toEqual(['tr.wav']);
    expect(statSync(cueDir(home)).mode & 0o777).toBe(0o700);
  });

  it('an unknown or hostile language is spoken in English, never a path', async () => {
    expect(cueLanguage('../../x')).toBe('en');
    expect(cueLanguage('de')).toBe('en');
    const calls: string[][] = [];
    await cueAudio('../../x', { home, run: fakeSay(calls) });
    expect(readdirSync(cueDir(home))).toEqual(['en.wav']);
  });

  it('two concurrent requests for one language start one `say`', async () => {
    const calls: string[][] = [];
    const run = fakeSay(calls, { delay: 20 });
    const [a, b] = await Promise.all([cueAudio('en', { home, run }), cueAudio('en', { home, run })]);
    expect(a).toEqual(b);
    expect(calls.filter((c) => c.includes('-o'))).toHaveLength(1);
  });

  it('a failed render is not cached and leaves no file', async () => {
    const calls: string[][] = [];
    expect(await cueAudio('en', { home, run: fakeSay(calls, { fail: true }) })).toBeNull();
    expect(readdirSync(cueDir(home))).toEqual([]);
    expect(await cueAudio('en', { home, run: fakeSay(calls) })).not.toBeNull();
  });
});
