/**
 * The audio-focus ledger: who owns the speaker, and what was silenced to give it to them.
 *
 * Every test here is a failure that was reasoned about before it was written, and most of them
 * are the SAME class of bug seen from different sides: undoing something we did not do, or
 * failing to undo something we did. The first leaves the owner fighting the app for their own
 * music; the second leaves a machine mute with no app left on screen to explain it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hold, release, focusHolder, resetAudioFocus, setOsaRunner, duckGain, parseVolume,
  canControlAudio, restoreOnExitSync, HOLD_TTL_MS, MAX_SILENCE_MS, PLAYERS,
  type OsaResult,
} from '../../src/lib/voice/audioFocus.js';
import { voiceConfigPath, DEFAULT_MUSIC_DUCK, clampMusicDuck } from '../../src/lib/voice/config.js';

let home: string;
/** Every script the module asked the machine to run, in order. */
let scripts: string[];
/** Queued answers, by the substring of the script they answer. */
let answers: { match: RegExp; result: Partial<OsaResult> }[];
/** Scripts run through the SYNCHRONOUS path — the process-exit restore, and nothing else. */
let syncScripts: string[];

function reply(match: RegExp, result: Partial<OsaResult>): void {
  answers.push({ match, result });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-focus-'));
  mkdirSync(dirname(voiceConfigPath(home)), { recursive: true });
  scripts = [];
  syncScripts = [];
  answers = [];
  resetAudioFocus();
  setOsaRunner(async (script) => {
    scripts.push(script);
    const hit = answers.find((a) => a.match.test(script));
    return { ok: true, out: '', denied: false, ...(hit?.result ?? {}) };
  }, (script) => { syncScripts.push(script); });
});

afterEach(() => {
  resetAudioFocus();
  setOsaRunner(null, null);
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(voiceConfigPath(home), JSON.stringify(cfg), 'utf-8');
}

/** The scripts that touched the system volume, in order. */
function volumeSets(): number[] {
  return scripts
    .map((s) => /^set volume output volume (\d+)$/.exec(s.trim())?.[1])
    .filter((n): n is string => !!n)
    .map(Number);
}

describe('the speaker floor', () => {
  it('grants the speaker to the first asker and REFUSES the second', async () => {
    const first = await hold('pane-a', home);
    const second = await hold('pane-b', home);
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(false);
    // The loser is told WHO has it, not merely that it was refused: that is what lets the
    // composer say something truthful instead of "speech unavailable".
    expect(second.holder).toBe('pane-a');
  });

  it('is IDEMPOTENT for the holder, so a per-chunk heartbeat pauses the music ONCE', async () => {
    // This is the bug the heartbeat design exists to avoid: a hold taken per chunk rather
    // than per turn would pause and resume at every sentence, and music that stutters on and
    // off through a paragraph is worse than music that never stopped.
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'paused' });
    await hold('pane-a', home);
    await hold('pane-a', home);
    await hold('pane-a', home);
    const pauses = scripts.filter((s) => /if player state is playing then/.test(s));
    expect(pauses).toHaveLength(1);
  });

  it('hands the floor to the next pane once the holder releases it', async () => {
    await hold('pane-a', home);
    expect((await hold('pane-b', home)).granted).toBe(false);
    await release('pane-a');
    expect(focusHolder()).toBeNull();
    expect((await hold('pane-b', home)).granted).toBe(true);
  });

  it('IGNORES a release from a pane that does not hold the floor', async () => {
    // The refused pane still runs its own end-of-turn cleanup. Without this guard, that
    // cleanup frees the WINNER's floor and starts the music back up in the middle of the
    // winner's sentence — from a pane that was never allowed to speak in the first place.
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'paused' });
    await hold('pane-a', home);
    await hold('pane-b', home);            // refused
    await release('pane-b');
    expect(focusHolder()).toBe('pane-a');
    expect(scripts.some((s) => /if player state is paused then play/.test(s))).toBe(false);
  });

  it('reclaims a LAPSED hold rather than staying locked forever', async () => {
    // The window closed, the renderer died, the machine slept — none of which sends a
    // release. A floor that could only be freed by its holder would be permanently mute.
    await hold('pane-a', home);
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + HOLD_TTL_MS + 1;
      const taken = await hold('pane-b', home);
      expect(taken.granted).toBe(true);
      expect(focusHolder()).toBe('pane-b');
    } finally {
      Date.now = originalNow;
    }
  });

  it('does NOT re-pause the music when it inherits a lapsed holder\'s silence', async () => {
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'paused' });
    await hold('pane-a', home);
    const before = scripts.filter((s) => /if player state is playing then/.test(s)).length;
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + HOLD_TTL_MS + 1;
      const taken = await hold('pane-b', home);
      // It INHERITS the pause — the music is already stopped — and the record of it, so the
      // eventual resume still happens exactly once.
      expect(taken.paused).toEqual([...PLAYERS]);
    } finally {
      Date.now = originalNow;
    }
    const after = scripts.filter((s) => /if player state is playing then/.test(s)).length;
    expect(after).toBe(before);
  });
});

describe('pausing a player', () => {
  it('pauses a player that is PLAYING and resumes it afterwards', async () => {
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'paused' });
    const grant = await hold('pane-a', home);
    expect(grant.paused).toEqual(['Spotify']);
    await release('pane-a');
    expect(scripts.some((s) => /if player state is paused then play/.test(s))).toBe(true);
  });

  it('records NOTHING when the player was not playing, and resumes nothing', async () => {
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'no' });
    const grant = await hold('pane-a', home);
    expect(grant.paused).toEqual([]);
    await release('pane-a');
    // The whole point: a track the owner had already stopped must not be started by the end
    // of an answer. "Resume" here would be us playing music nobody asked for.
    expect(scripts.some((s) => /if player state is paused then play/.test(s))).toBe(false);
  });

  it('PROBES FIRST with a dictionary-free script, and stops there when the app is absent', async () => {
    // MEASURED, 2026-09-11: a single script that guards `player state` behind `if application
    // "Spotify" is running` DOES NOT COMPILE when Spotify is not installed — AppleScript
    // resolves another app's terms before any guard runs, so osascript answers -2741 and the
    // feature breaks on every turn for anyone without that exact app. The guard has to be a
    // SEPARATE invocation, which is what this pins.
    reply(/is running/, { out: 'false' });
    const grant = await hold('pane-a', home);
    expect(grant.paused).toEqual([]);
    const probe = scripts.find((s) => /is running/.test(s))!;
    expect(probe).toBe('return (application "Spotify" is running)');
    // No dictionary terms anywhere in a script we sent to a machine that may not have the app.
    expect(scripts.some((s) => /player state/.test(s))).toBe(false);
  });

  it('never launches the player just to ask — the probe is `is running`, not a `tell`', async () => {
    reply(/is running/, { out: 'false' });
    await hold('pane-a', home);
    // `tell application "Spotify"` on its own LAUNCHES Spotify. A mode meant to quiet the
    // machine would then open a music player because the agent said a sentence.
    expect(scripts.some((s) => /tell application/.test(s))).toBe(false);
  });

  it('skips the pause entirely when musicPause is off', async () => {
    writeConfig({ musicPause: false, musicDuck: 1 });
    const grant = await hold('pane-a', home);
    expect(grant.paused).toEqual([]);
    expect(scripts.some((s) => /player state is playing/.test(s))).toBe(false);
  });

  it('remembers a REFUSED consent and stops asking', async () => {
    // The denial lands on STEP 2, not on the probe: `application "X" is running` is answered
    // by the AppleScript runtime without sending an Apple event, so it is the `tell` that
    // needs the owner's Automation consent and the `tell` that gets refused.
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { ok: false, denied: true });
    const first = await hold('pane-a', home);
    expect(first.granted).toBe(true);           // fail open: the answer is still spoken
    expect(first.denied).toBe(true);
    await release('pane-a');
    const countAfterFirst = scripts.length;
    const second = await hold('pane-a', home);
    expect(second.granted).toBe(true);
    // A denial is a standing answer until the owner changes it in System Settings. Re-asking
    // every turn spends 120 ms and re-poses a dialog they already dismissed.
    expect(scripts.length).toBe(countAfterFirst);
  });
});

describe('ducking what cannot be paused', () => {
  it('ducks the system volume when NO known player was playing', async () => {
    writeConfig({ musicDuck: 0.5 });
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'no' });
    reply(/get volume settings/, { out: '80,false' });
    const grant = await hold('pane-a', home);
    expect(grant.ducked).toBe(true);
    expect(volumeSets()).toEqual([40]);
    // …and the compensation, without which ducking lowers OUR voice by exactly as much and
    // achieves nothing at all.
    expect(grant.gain).toBe(2);
  });

  it('does NOT touch the volume when a player was paused instead', async () => {
    writeConfig({ musicDuck: 0.5 });
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'paused' });
    const grant = await hold('pane-a', home);
    expect(grant.ducked).toBe(false);
    expect(grant.gain).toBe(1);
    expect(volumeSets()).toEqual([]);
  });

  it('restores the volume only if it is STILL the value we set', async () => {
    writeConfig({ musicDuck: 0.5 });
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'no' });
    reply(/get volume settings/, { out: '80,false' });
    await hold('pane-a', home);
    // On the way back the machine reports the value we left behind: still ours, so restore.
    answers = [{ match: /get volume settings/, result: { out: '40,false' } }];
    await release('pane-a');
    expect(volumeSets()).toEqual([40, 80]);
  });

  it('LEAVES THE VOLUME ALONE if the owner moved it during the answer', async () => {
    writeConfig({ musicDuck: 0.5 });
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'no' });
    reply(/get volume settings/, { out: '80,false' });
    await hold('pane-a', home);
    // The owner reached for the volume keys mid-answer. That is their answer; putting back a
    // number from 20 seconds ago would overwrite a deliberate act with a stale one.
    answers = [{ match: /get volume settings/, result: { out: '65,false' } }];
    await release('pane-a');
    expect(volumeSets()).toEqual([40]);
  });

  it('skips a machine that is already MUTED or at zero', async () => {
    writeConfig({ musicDuck: 0.35 });
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'no' });
    reply(/get volume settings/, { out: '0,true' });
    const grant = await hold('pane-a', home);
    // 35% of nothing is nothing — and "restoring" it afterwards would make a machine the
    // owner deliberately silenced start talking.
    expect(grant.ducked).toBe(false);
    expect(volumeSets()).toEqual([]);
  });

  it('never ducks at all when musicDuck is 1', async () => {
    writeConfig({ musicDuck: 1 });
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'no' });
    const grant = await hold('pane-a', home);
    expect(grant.ducked).toBe(false);
    expect(grant.gain).toBe(1);
    expect(scripts.some((s) => /get volume settings/.test(s))).toBe(false);
  });

  it('reads an unrecognised volume answer as "do not duck"', async () => {
    writeConfig({ musicDuck: 0.5 });
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'no' });
    reply(/get volume settings/, { out: 'missing value' });
    const grant = await hold('pane-a', home);
    expect(grant.ducked).toBe(false);
    expect(volumeSets()).toEqual([]);
  });
});

describe('the arithmetic', () => {
  it('inverts the duck, and CAPS the inversion', () => {
    expect(duckGain(0.5)).toBe(2);
    expect(duckGain(0.35)).toBeCloseTo(2.86, 2);
    // The ceiling is the honest half of the compensation: a speech signal already near full
    // scale multiplied by 5 lives in the limiter, and pumping on the voice is worse than
    // music audible underneath it.
    expect(duckGain(0.1)).toBe(3);
    expect(duckGain(1)).toBe(1);
    expect(duckGain(0)).toBe(1);
    expect(duckGain(Number.NaN)).toBe(1);
  });

  it('parses the volume answer, and refuses to guess at anything else', () => {
    expect(parseVolume('63,false')).toEqual({ level: 63, muted: false });
    expect(parseVolume(' 0 , true ')).toEqual({ level: 0, muted: true });
    expect(parseVolume('missing value')).toBeNull();
    expect(parseVolume('101,false')).toBeNull();
    expect(parseVolume('')).toBeNull();
  });

  it('clamps a hand-edited duck depth instead of refusing it', () => {
    expect(clampMusicDuck(0.5)).toBe(0.5);
    expect(clampMusicDuck(0)).toBe(0.1);
    expect(clampMusicDuck(9)).toBe(1);
    expect(clampMusicDuck(Number.NaN)).toBe(DEFAULT_MUSIC_DUCK);
  });
});

describe('platform and shutdown', () => {
  it('controls audio only on macOS', () => {
    expect(canControlAudio('darwin')).toBe(true);
    expect(canControlAudio('win32')).toBe(false);
    expect(canControlAudio('linux')).toBe(false);
  });

  it('is a complete no-op off macOS, while the FLOOR still works', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const grant = await hold('pane-a', home);
      // Nothing to pause and nothing to duck — but two panes speaking over each other is not
      // a macOS problem, so the floor is still enforced.
      expect(grant.granted).toBe(true);
      expect(scripts).toEqual([]);
      expect((await hold('pane-b', home)).granted).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('restores SYNCHRONOUSLY on process exit, and only once', async () => {
    writeConfig({ musicDuck: 0.5 });
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'no' });
    reply(/get volume settings/, { out: '80,false' });
    await hold('pane-a', home);
    // `exit` runs no microtasks, so the async restore is simply unavailable there: a promise
    // queued in an exit handler never resolves. This path is the only thing standing between
    // a shutdown mid-answer and a machine left quiet with no app on screen to explain it.
    restoreOnExitSync();
    expect(syncScripts).toEqual(['set volume output volume 80']);
    // Called twice (an `exit` after an explicit call) must not re-do it: a second restore
    // would fight whatever the owner has done since.
    restoreOnExitSync();
    expect(syncScripts).toEqual(['set volume output volume 80']);
  });

  it('resumes a PAUSED PLAYER on process exit too', async () => {
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'paused' });
    await hold('pane-a', home);
    restoreOnExitSync();
    expect(syncScripts).toHaveLength(1);
    expect(syncScripts[0]).toMatch(/if player state is paused then play/);
  });
});

describe('overlapping calls — the races the ledger is serialised against', () => {
  /**
   * A fake MACHINE rather than a fake answer sheet.
   *
   * The table-driven runner the other suites use answers every volume query identically,
   * which is fine when nothing writes the volume back — and actively misleading here, where
   * the whole question is whether a restore lands. This one holds real state: `set volume`
   * moves it, a pause flips the player, and the queries report what was actually done. It is
   * the only way these tests can tell "restored" from "never restored".
   *
   * Answers resolve on a LATER macrotask, so a second caller's synchronous prologue really
   * does run inside the first one's await — which is what happens in production, where every
   * script is a ~120 ms process.
   */
  function fakeMachine(init: { volume: number; playing: boolean }, delayMs = 5) {
    const state = { ...init };
    setOsaRunner(async (script) => {
      scripts.push(script);
      // The RESUME is deliberately the slowest script. Uniform delays let an unserialised
      // hand-off pass by luck — the two chains happen to interleave favourably — which would
      // make this suite prove nothing about the thing it exists to pin. Asymmetry matches
      // reality too: telling an app to start playing is the heaviest of these calls.
      const slow = /player state is paused then play/.test(script);
      await new Promise((r) => setTimeout(r, slow ? delayMs * 6 : delayMs));
      if (/is running/.test(script)) return { ok: true, out: 'true', denied: false };
      if (/get volume settings/.test(script)) {
        return { ok: true, out: `${state.volume},false`, denied: false };
      }
      const set = /^set volume output volume (\d+)$/.exec(script.trim());
      if (set) { state.volume = Number(set[1]); return { ok: true, out: '', denied: false }; }
      if (/player state is playing/.test(script)) {
        if (!state.playing) return { ok: true, out: 'no', denied: false };
        state.playing = false;
        return { ok: true, out: 'paused', denied: false };
      }
      if (/player state is paused then play/.test(script)) {
        state.playing = true;
        return { ok: true, out: '', denied: false };
      }
      return { ok: true, out: '', denied: false };
    }, (script) => { syncScripts.push(script); });
    return state;
  }

  it('THE HAND-OFF: B does not take the floor until A has finished resuming the music', async () => {
    // Without serialisation this is the everyday two-pane hand-off and it breaks: `release`
    // nulls the session synchronously, so B takes the fresh path, probes a Spotify that A has
    // not un-paused yet, records `paused: []`, and A's resume then lands with the music
    // playing at full volume under B's answer and nothing left that would stop it.
    const machine = fakeMachine({ volume: 80, playing: true });
    await hold('pane-a', home);
    expect(machine.playing).toBe(false);
    const releasing = release('pane-a');
    const taking = hold('pane-b', home);
    const [, grant] = await Promise.all([releasing, taking]);
    expect(grant.granted).toBe(true);
    // B PAUSED IT ITSELF — which can only be true if A's resume completed first.
    expect(grant.paused).toEqual(['Spotify']);
    const resumeAt = scripts.findIndex((x) => /player state is paused then play/.test(x));
    const secondPauseAt = scripts.map((x, i) => (/player state is playing/.test(x) ? i : -1))
      .filter((i) => i >= 0)[1];
    expect(resumeAt).toBeGreaterThanOrEqual(0);
    expect(secondPauseAt).toBeGreaterThan(resumeAt);
  });

  it('THE BARGE-IN: a release issued while the first hold is still in flight still restores', async () => {
    // `SpeechQueue.stop()` releases unconditionally, without waiting for the turn's first
    // hold. Unserialised, the release restored nothing (`ledger.paused` was not written yet)
    // and the hold's continuation then wrote it into a ledger with no session — leaving the
    // music paused until the process exited, with no live session and no path back.
    const machine = fakeMachine({ volume: 80, playing: true });
    const holding = hold('pane-a', home);
    const releasing = release('pane-a');
    await Promise.all([holding, releasing]);
    expect(focusHolder()).toBeNull();
    // The machine got its audio back, and the ledger kept no orphan record of a pause.
    expect(machine.playing).toBe(true);
    restoreOnExitSync();
    expect(syncScripts).toEqual([]);
  });

  it('a volume duck survives the same interleaving without being orphaned', async () => {
    writeConfig({ musicDuck: 0.5 });
    const machine = fakeMachine({ volume: 80, playing: false });
    const holding = hold('pane-a', home);
    const releasing = release('pane-a');
    await Promise.all([holding, releasing]);
    // Ducked to 40 and put back to 80 — not left at 40 with nobody holding the floor.
    expect(volumeSets()).toEqual([40, 80]);
    expect(machine.volume).toBe(80);
    restoreOnExitSync();
    expect(syncScripts).toEqual([]);
  });
});

describe('the gain is remembered, not re-derived', () => {
  it('reports the SAME gain on the heartbeat as on the first chunk', async () => {
    // Volume 50 with the 0.35 default rounds the target to 18, and 18/50 is not 0.35 — so a
    // recomputed gain drifts between the first sentence and the second.
    writeConfig({ musicDuck: 0.35 });
    reply(/is running/, { out: 'false' });
    reply(/get volume settings/, { out: '50,false' });
    const first = await hold('pane-a', home);
    const beat = await hold('pane-a', home);
    expect(beat.gain).toBe(first.gain);
    expect(beat.ducked).toBe(true);
  });

  it('does not collapse to gain 1 on the heartbeat at a low volume', async () => {
    // The bad case: volume 2 at a 0.1 duck rounds the target to 0, and a ratio of 0 reads as
    // "no duck at all" — so the heartbeat used to answer 1 against a first chunk told 3. A
    // ~9.5 dB drop between the first sentence and the rest.
    writeConfig({ musicDuck: 0.1 });
    reply(/is running/, { out: 'false' });
    reply(/get volume settings/, { out: '2,false' });
    const first = await hold('pane-a', home);
    const beat = await hold('pane-a', home);
    expect(first.gain).toBe(3);
    expect(beat.gain).toBe(3);
  });
});

describe('the silence ceiling', () => {
  it('gives the music back after the ceiling even though the hold is REFRESHED forever', async () => {
    // The lease only reclaims a hold nobody refreshes — the right cure for a closed window
    // and no cure at all for a caller that keeps heart-beating to keep the owner's music
    // down, which stays under any rate limit by definition.
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'paused' });
    await hold('pane-a', home);
    expect(scripts.some((x) => /player state is paused then play/.test(x))).toBe(false);
    const originalNow = Date.now;
    try {
      for (let t = 60_000; t < MAX_SILENCE_MS; t += 60_000) {
        Date.now = () => originalNow() + t;
        await hold('pane-a', home);
      }
      // Still silenced: diligent refreshing is legitimate right up to the ceiling.
      expect(scripts.some((x) => /player state is paused then play/.test(x))).toBe(false);
      Date.now = () => originalNow() + MAX_SILENCE_MS + 1;
      await hold('pane-a', home);
    } finally {
      Date.now = originalNow;
    }
    // The music is back…
    expect(scripts.some((x) => /player state is paused then play/.test(x))).toBe(true);
    // …and the FLOOR is deliberately untouched, so the one-voice invariant still holds. The
    // ceiling bounds the silence, which is the harm this route introduces; it does not
    // pretend to bound floor ownership.
    expect(focusHolder()).toBe('pane-a');
  });

  it('does not silence the machine AGAIN for the same spent hold', async () => {
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'paused' });
    await hold('pane-a', home);
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + MAX_SILENCE_MS + 1;
      await hold('pane-a', home);
      const afterCeiling = scripts.length;
      Date.now = () => originalNow() + MAX_SILENCE_MS + 2;
      await hold('pane-a', home);
      await hold('pane-a', home);
      // A spent hold stops touching the machine entirely: no re-pause, no second restore.
      expect(scripts.length).toBe(afterCeiling);
    } finally {
      Date.now = originalNow;
    }
  });

  it('hands the budget back on the NEXT fresh hold', async () => {
    reply(/is running/, { out: 'true' });
    reply(/player state is playing/, { out: 'paused' });
    await hold('pane-a', home);
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + MAX_SILENCE_MS + 1;
      await hold('pane-a', home);                 // ceiling spends the budget
      await release('pane-a');
      const before = scripts.length;
      await hold('pane-a', home);                 // a new turn silences again, as it should
      expect(scripts.length).toBeGreaterThan(before);
    } finally {
      Date.now = originalNow;
    }
  });

  it('does NOT reclaim a hold that is merely long-running but under the ceiling', async () => {
    await hold('pane-a', home);
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 60_000;
      await hold('pane-a', home);
      expect((await hold('pane-b', home)).granted).toBe(false);
    } finally {
      Date.now = originalNow;
    }
    expect(focusHolder()).toBe('pane-a');
  });
});
