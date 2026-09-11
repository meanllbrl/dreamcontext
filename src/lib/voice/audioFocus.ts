/**
 * AUDIO FOCUS: who owns the speaker, and what was silenced so that owner could be heard.
 *
 * Two problems that look unrelated and are in fact one, which is why they share a ledger:
 *
 *  1. THE MACHINE'S OTHER AUDIO. J.A.R.V.I.S answers out loud, and the machine is usually
 *     already playing something. Before this module the answer simply landed on top of the
 *     music, so the owner either missed it or reached for Spotify by hand every single turn —
 *     in a mode whose entire proposition is not touching the keyboard.
 *
 *  2. TWO PANES SPEAKING AT ONCE. Chat panes never unmount and every `jarvis` session builds
 *     its own `SpeechQueue`, so two answers could be read simultaneously into the same pair of
 *     speakers. That was already true before any of this — nothing gated the speaker the way
 *     `pushToTalkScope.ts` gates the microphone — and two voices at once is not a degraded
 *     answer, it is no answer.
 *
 * ONE LEDGER, NOT TWO. Both are the same question ("who has the speaker right now, and what
 * did we do to the machine to give it to them"), and two separate ownership books would find
 * two separate ways to leak: a floor released without restoring the music leaves the music
 * paused forever, and music restored without releasing the floor leaves the mode permanently
 * mute. Here, one {@link hold} takes both and one {@link release} returns both.
 *
 * ── WHY THE SERVER OWNS THIS AND NOT A MODULE SINGLETON ─────────────────────────────────
 * `pushToTalkScope.ts` elects its single owner in the client, which is correct for panes
 * inside ONE window and blind across two. The music half has no choice — a webview cannot
 * pause Spotify — and once the round trip exists, putting the floor on the same call makes it
 * correct across windows for free. The cost is a loopback request, and it is paid inside the
 * ~1.3 s the first chunk spends generating, so it is not on the latency path at all.
 *
 * ── THE RULE THAT GOVERNS EVERY BRANCH BELOW ────────────────────────────────────────────
 * NEVER UNDO SOMETHING WE DID NOT DO. We resume only players we ourselves paused, and only
 * while they are still paused; we restore the volume only if it is still the value we set. A
 * turn during which the owner reached over and pressed play is a turn where they have said
 * what they want, and this module's job is then to keep its hands off. The inverse failure —
 * leaving the machine silenced because the app crashed mid-answer — is covered by a watchdog
 * and by a synchronous best-effort restore on process exit, because a silenced machine with
 * nothing on screen to explain it is the worst outcome in the whole feature.
 */

import { execFile, spawnSync } from 'node:child_process';
import { readVoiceConfig, DEFAULT_MUSIC_DUCK, type VoiceConfig } from './config.js';

// ─── The one-line-per-player table ─────────────────────────────────────────────────────

/**
 * The players we can control PRECISELY — query the state, pause only what is playing, resume
 * only what we paused.
 *
 * Apple Music is deliberately ABSENT. It is one entry away, and that is the point of the
 * table's shape, but adding a player is not free: the first `tell application` fires a macOS
 * Automation consent dialog naming that app, and prompting the owner about an app they do not
 * use is a cost with no benefit. The owner named Spotify; Spotify is what is here.
 */
export const PLAYERS: readonly string[] = ['Spotify'];

/**
 * Step 1: is `app` running? Dictionary-free, and that is the whole point.
 *
 * ── THE TRAP THIS TWO-STEP PROBE EXISTS TO AVOID, MEASURED ──────────────────────────────
 * The obvious single script — `if application "Spotify" is running then tell application
 * "Spotify" … player state …` — DOES NOT COMPILE when Spotify is not installed. `player state`
 * and `playing` are terms from Spotify's own dictionary, AppleScript resolves them at COMPILE
 * time, and compilation happens before a single line runs. So the `is running` guard, which
 * looks like it makes the whole thing safe, cannot save a script that never got as far as
 * running: osascript answers `-2741: Expected "then" but found identifier` and the feature
 * fails on every turn for anyone without that exact app installed.
 *
 * Verified both ways on 2026-09-11: the same script against `Music` (installed) compiles and
 * answers `no`; against `Spotify` (not installed) it is a syntax error.
 *
 * `application "X" is running` needs no dictionary, so it compiles everywhere, answers
 * `false` for an app that is absent, and — this is why it is not merely a nicety — does not
 * launch the app to find out.
 *
 * The second spawn only happens when the answer is `true`, i.e. exactly when there is work to
 * do anyway. The common case (no music player open) stays at one ~120 ms probe.
 *
 * **The rule that generalises: an AppleScript guard cannot protect the script it is in.** A
 * term from another app's dictionary is resolved before any guard executes, so anything
 * conditional on an app EXISTING has to be in a separate invocation.
 */
function runningScript(app: string): string {
  return `return (application "${app}" is running)`;
}

/**
 * Step 2: pause `app` if it is playing. Uses the app's dictionary, so it is only ever run
 * after {@link runningScript} answered `true` — at which point the app is installed by
 * definition and the terms below resolve.
 *
 * Still ONE script rather than a query followed by a pause: it closes the window between
 * them, where a track that ended on its own would be recorded as "we paused this" and later
 * started again for an owner who had stopped listening.
 */
function pauseScript(app: string): string {
  return [
    `tell application "${app}"`,
    '  if player state is playing then',
    '    pause',
    '    return "paused"',
    '  end if',
    'end tell',
    'return "no"',
  ].join('\n');
}

/** Resume `app`, but ONLY if it is still paused — see the module note on not undoing what we
 *  did not do. If the owner pressed play during the answer, this script does nothing. Guarded
 *  by {@link runningScript} for the same compile-time reason as the pause. */
function resumeScript(app: string): string {
  return [
    `tell application "${app}"`,
    '  if player state is paused then play',
    'end tell',
  ].join('\n');
}

/** Read the output volume and the mute flag as `"63,false"`. Standard Additions, NOT an Apple
 *  event to another app — measured on this machine, it answers with no consent prompt at all,
 *  which is why the ducking half works even when the pause half is refused. */
const VOLUME_SCRIPT = [
  'set s to (get volume settings)',
  'return ((output volume of s) as text) & "," & ((output muted of s) as text)',
].join('\n');

function setVolumeScript(level: number): string {
  return `set volume output volume ${Math.max(0, Math.min(100, Math.round(level)))}`;
}

// ─── Running osascript ─────────────────────────────────────────────────────────────────

export interface OsaResult {
  ok: boolean;
  out: string;
  /** The macOS Automation consent was refused (-1743), or the app refused the event. Remembered
   *  process-wide: a denial is a standing answer, not a transient failure to retry every turn. */
  denied: boolean;
}

export type OsaRunner = (script: string) => Promise<OsaResult>;

/** True for the errors that mean "you may not ask this app anything, ever, until the owner
 *  changes it in System Settings". -1743 is the consent refusal; the text form appears when
 *  the request was never even presented. */
function isDenial(stderr: string): boolean {
  return /-1743|Not authori[sz]ed|not allowed to send Apple events/i.test(stderr);
}

const realOsa: OsaRunner = (script) => new Promise((resolve) => {
  // A single multi-line `-e`: osascript accepts embedded newlines, so there is no temp file
  // and no shell. `shell: false` is the default for execFile and is the property that makes
  // an app name from a table safe to interpolate.
  execFile('osascript', ['-e', script], { timeout: 4000 }, (err, stdout, stderr) => {
    const errText = String(stderr || (err as Error | null)?.message || '');
    resolve({ ok: !err, out: String(stdout || '').trim(), denied: isDenial(errText) });
  });
});

let osa: OsaRunner = realOsa;

/**
 * The SYNCHRONOUS runner, used by exactly one caller: {@link restoreOnExitSync}.
 *
 * Separate from {@link OsaRunner} because it cannot be a promise — see that function for why.
 * Injectable for the same reason the async one is, and with one extra: a test that reached the
 * real `spawnSync` would run AppleScript against the developer's own machine, and the resume
 * script's whole job is to start music.
 */
export type OsaSyncRunner = (script: string) => void;

const realOsaSync: OsaSyncRunner = (script) => {
  spawnSync('osascript', ['-e', script], { timeout: 2000, stdio: 'ignore' });
};

let osaSync: OsaSyncRunner = realOsaSync;

/** Swap the runners. Tests only — nothing in the app calls this. */
export function setOsaRunner(runner: OsaRunner | null, sync?: OsaSyncRunner | null): void {
  osa = runner ?? realOsa;
  osaSync = sync ?? realOsaSync;
}

/** Whether this platform has any music control at all. The SPEAKER FLOOR is cross-platform —
 *  two voices at once is not a macOS problem — but everything that touches the machine's own
 *  audio is AppleScript, so on Windows and Linux that half is simply absent. */
export function canControlAudio(platform: string = process.platform): boolean {
  return platform === 'darwin';
}

// ─── The ledger ────────────────────────────────────────────────────────────────────────

/** How long a hold survives without being refreshed. Long enough for any single answer, short
 *  enough that a crashed window's music comes back while the owner is still wondering why it
 *  stopped. The client refreshes on every chunk, so a live turn never reaches it. */
export const HOLD_TTL_MS = 120_000;

/** How often expired holds are swept. */
const SWEEP_MS = 5_000;

/**
 * The longest one CONTINUOUS hold may keep the machine silenced, however diligently it is
 * refreshed.
 *
 * {@link HOLD_TTL_MS} only reclaims a hold nobody refreshes, which is the right cure for a
 * closed window and no cure at all for a caller that keeps heart-beating — that one can keep
 * the owner's music paused and the real UI off the speaker for as long as it likes, at a
 * request rate far under any rate limit. No legitimate spoken answer runs for ten minutes, so
 * this ceiling cannot cost a real turn anything, and it bounds the damage of a stuck or
 * hostile holder to something the owner would forgive.
 */
export const MAX_SILENCE_MS = 10 * 60_000;

/**
 * ── EVERY LEDGER MUTATION RUNS IN THIS ONE CHAIN, AND THAT IS NOT BELT-AND-BRACES ───────
 *
 * `hold` and `release` each `await` several ~120 ms `osascript` round trips, and both write
 * shared module state on BOTH sides of those awaits. Node being single-threaded does not help
 * here — it is exactly what lets a second request run its synchronous prologue in the gap.
 * Two real, everyday interleavings came out of review:
 *
 *  1. THE HAND-OFF. Pane A's turn ends and `release('A')` starts resuming Spotify. Pane B
 *     starts its turn in the same breath; `release` has already nulled `ledger.session`
 *     synchronously, so B takes the fresh path, probes a Spotify that is still paused (A's
 *     resume has not landed), records `paused: []` and ducks the volume instead. A's resume
 *     then lands and the music plays at full volume under B's answer, with nothing in the
 *     ledger that would ever stop it again.
 *
 *  2. THE BARGE-IN. `stop()` releases while the turn's FIRST `hold` is still awaiting. The
 *     release restores nothing (`ledger.paused` has not been written yet), and then `hold`'s
 *     continuation writes `ledger.paused = ['Spotify']` into a ledger with no session. The
 *     music stays paused until the process exits — the precise "machine left silenced with no
 *     app on screen to explain it" this module opens by calling its worst outcome.
 *
 * Serialising is preferred to an epoch token because the invariant is about the MACHINE, not
 * just the bookkeeping: even a perfectly-versioned ledger would still have had two
 * `osascript` conversations about the same Spotify in flight at once. One chain means the
 * resume is finished before the next pause is decided, which is the only ordering that makes
 * "never undo something we did not do" true rather than usually true.
 *
 * The cost is that a hold can wait out a slow release. That wait happens inside the ~1.3 s a
 * chunk spends generating, so it is not on the path to the first word.
 */
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  // `then(fn, fn)` rather than `then(fn)`: a rejected predecessor must not cancel everything
  // queued behind it. The chain is an ordering primitive, not an error channel.
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

interface Ledger {
  /** The session that owns the speaker, or null. */
  session: string | null;
  /** When that ownership lapses if nothing refreshes it. */
  expires: number;
  /** Players WE paused, by name. Empty means we paused nothing. */
  paused: string[];
  /** The output volume before we ducked it, or null if we did not duck. */
  duckedFrom: number | null;
  /** The volume we actually set, so we can tell "still ours" from "the owner changed it". */
  duckedTo: number | null;
  /**
   * The compensation gain COMPUTED AT DUCK TIME, carried rather than re-derived.
   *
   * It used to be recomputed on every heartbeat as `duckGain(duckedTo / duckedFrom)`, and
   * those are two integers that `Math.round` has already mangled. At ordinary volumes the
   * drift is about a quarter of a decibel — inaudible — but at low ones it is not small at
   * all: volume 2 with a 0.1 duck rounds `duckedTo` to 0, so the ratio is 0, `duckGain`
   * reads that as "no duck" and answers 1 — against a first chunk that was told 3. That is a
   * ~9.5 dB drop between the first sentence and the second. The number was known exactly
   * once; keeping it is cheaper and correct.
   */
  gain: number;
  /** When the CURRENT continuous silence began — set on a fresh take, NOT refreshed by a
   *  heartbeat. See {@link MAX_SILENCE_MS}. */
  since: number;
  /** This hold has already spent its silence budget: the machine was given its audio back at
   *  the ceiling and this hold will never silence it again. Cleared by the next fresh take. */
  silenceSpent: boolean;
}

const ledger: Ledger = {
  session: null, expires: 0, paused: [], duckedFrom: null, duckedTo: null, gain: 1, since: 0,
  silenceSpent: false,
};

/** A refused Automation consent, remembered. Fail open and STOP ASKING: retrying a denial
 *  every turn spends 120 ms and re-poses a dialog the owner already dismissed. */
let denied = false;

let sweeper: NodeJS.Timeout | null = null;

/** Full reset. Tests only. */
export function resetAudioFocus(): void {
  ledger.session = null;
  ledger.expires = 0;
  ledger.paused = [];
  ledger.duckedFrom = null;
  ledger.duckedTo = null;
  ledger.gain = 1;
  ledger.since = 0;
  ledger.silenceSpent = false;
  denied = false;
  chain = Promise.resolve();
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
}

/** Who holds the speaker right now, or null. */
export function focusHolder(): string | null {
  return ledger.session;
}

export interface FocusGrant {
  /**
   * Whether this session may speak. `false` means ANOTHER pane is already speaking — the
   * caller must fall back to text and SAY SO on screen. A silently unspoken answer is a worse
   * failure than the overlap it prevents, because nothing on screen distinguishes it from a
   * mode that quietly broke.
   */
  granted: boolean;
  /** The session that holds it, whether or not that is the caller. */
  holder: string | null;
  /** True if we lowered the machine's output volume. */
  ducked: boolean;
  /**
   * The compensation gain the CLIENT must apply to its own playback, or 1.
   *
   * Ducking the system volume lowers OUR voice too — same output device — so ducking without
   * this number is self-defeating: it makes the thing you wanted to hear exactly as quiet as
   * the thing you wanted to hear less of. See {@link duckGain} for the arithmetic and for the
   * assumption it rests on.
   */
  gain: number;
  /** Players we paused for this hold. */
  paused: string[];
  /** True when the machine's Automation consent has been refused, so the pause half is off.
   *  Reported rather than hidden: it is the only way Settings can explain a mode that speaks
   *  fine but never quiets Spotify. */
  denied: boolean;
}

const NO_GRANT = (holder: string | null): FocusGrant => (
  { granted: false, holder, ducked: false, gain: 1, paused: [], denied }
);

/**
 * The gain that cancels a duck of `factor`.
 *
 * THE ASSUMPTION, STATED RATHER THAN BURIED: this treats macOS's output-volume scalar as
 * LINEAR IN AMPLITUDE, so halving the system volume is cancelled by doubling our own. That is
 * an approximation — the scalar is closer to perceptual than to linear — and it cannot be
 * derived exactly, because the curve is not public and differs by output device. So the
 * compensation is approximate BY CONSTRUCTION and is confirmed by ear on the owner's
 * checklist, not by arithmetic.
 *
 * The 3x ceiling is the honest half of that. A speech signal already peaking near full scale,
 * multiplied by 4, is a signal that spends its life in the limiter, and pumping distortion on
 * the voice is a worse outcome than music that is audible under it. So the duck depth is
 * clamped by what we can actually give back.
 */
export function duckGain(factor: number): number {
  if (!Number.isFinite(factor) || factor >= 1 || factor <= 0) return 1;
  return Math.min(3, Math.round((1 / factor) * 100) / 100);
}

/** Parse `"63,false"`. An unrecognised shape returns null rather than a guess — reading a
 *  signal we do not own, `[[pattern-unrecognized-shape-returns]]`. */
export function parseVolume(out: string): { level: number; muted: boolean } | null {
  const m = /^\s*(\d{1,3})\s*,\s*(true|false)\s*$/i.exec(out);
  if (!m) return null;
  const level = Number(m[1]);
  if (!Number.isFinite(level) || level < 0 || level > 100) return null;
  return { level, muted: m[2].toLowerCase() === 'true' };
}

/** Pause every known player that is playing. Returns what we actually paused. */
async function pausePlayers(): Promise<string[]> {
  const out: string[] = [];
  for (const app of PLAYERS) {
    // Step 1. An app that is closed or absent costs exactly this and nothing more.
    const up = await osa(runningScript(app));
    if (up.denied) { denied = true; break; }
    if (!up.ok || up.out !== 'true') continue;
    // Step 2, reached only for an app that is demonstrably installed and open.
    const res = await osa(pauseScript(app));
    if (res.denied) { denied = true; break; }
    if (res.ok && res.out === 'paused') out.push(app);
  }
  return out;
}

/**
 * Lower the machine's output volume, and report what to give back to our own voice.
 *
 * Only reached when NO known player was playing — i.e. whatever is making noise is something
 * we cannot address precisely (a browser tab, typically). Pausing Spotify and ALSO ducking
 * would quiet a machine that is already quiet and force a pointless gain on our own playback.
 */
async function duckSystem(factor: number): Promise<{ ducked: boolean; gain: number }> {
  const read = await osa(VOLUME_SCRIPT);
  if (read.denied) { denied = true; return { ducked: false, gain: 1 }; }
  const vol = read.ok ? parseVolume(read.out) : null;
  if (!vol) return { ducked: false, gain: 1 };
  // Already silent: 35% of nothing is nothing, and "restoring" it afterwards would make a
  // machine the owner deliberately muted start talking.
  if (vol.muted || vol.level <= 0) return { ducked: false, gain: 1 };
  const target = Math.max(0, Math.round(vol.level * factor));
  if (target >= vol.level) return { ducked: false, gain: 1 };
  const set = await osa(setVolumeScript(target));
  if (!set.ok) { if (set.denied) denied = true; return { ducked: false, gain: 1 }; }
  ledger.duckedFrom = vol.level;
  ledger.duckedTo = target;
  // Stored, not re-derivable: `target` is rounded, so the ratio is not the factor.
  ledger.gain = duckGain(factor);
  return { ducked: true, gain: ledger.gain };
}

/** Everything the machine-audio half of a hold does. */
async function silenceMachine(cfg: VoiceConfig): Promise<{ ducked: boolean; gain: number; paused: string[] }> {
  if (!canControlAudio() || denied) return { ducked: false, gain: 1, paused: [] };
  const paused = cfg.musicPause === false ? [] : await pausePlayers();
  if (paused.length > 0) return { ducked: false, gain: 1, paused };
  const factor = typeof cfg.musicDuck === 'number' ? cfg.musicDuck : DEFAULT_MUSIC_DUCK;
  if (factor >= 1) return { ducked: false, gain: 1, paused };
  const { ducked, gain } = await duckSystem(factor);
  return { ducked, gain, paused };
}

/** Give the machine its audio back. Both halves are conditional on still being ours. */
async function restoreMachine(): Promise<void> {
  const paused = ledger.paused;
  const from = ledger.duckedFrom;
  const to = ledger.duckedTo;
  // Cleared BEFORE the awaits below, deliberately: a restore that fails part-way must not
  // leave a record that invites a second attempt on the next release. Safe only because every
  // caller runs inside `serialize` — nothing can observe this half-state.
  ledger.paused = [];
  ledger.duckedFrom = null;
  ledger.duckedTo = null;
  ledger.gain = 1;
  if (!canControlAudio()) return;
  for (const app of paused) {
    // Probed again rather than assumed: the app we paused can have been quit during the
    // answer, and `resumeScript` would then be a syntax error instead of a no-op.
    const up = await osa(runningScript(app));
    if (up.denied) { denied = true; continue; }
    if (!up.ok || up.out !== 'true') continue;
    const res = await osa(resumeScript(app));
    if (res.denied) denied = true;
  }
  if (from === null || to === null) return;
  const read = await osa(VOLUME_SCRIPT);
  const vol = read.ok ? parseVolume(read.out) : null;
  // STILL OURS? If the owner moved the volume during the answer, that is their answer, and
  // putting it back would overwrite a deliberate act with a stale number.
  if (!vol || vol.level !== to) return;
  await osa(setVolumeScript(from));
}

function arm(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void serialize(sweep); }, SWEEP_MS);
  // Never hold the process open for this. The exit handler below is what covers a shutdown.
  sweeper.unref?.();
}

/** Drop a hold nobody refreshed. This is what makes a closed window, a reloaded webview or a
 *  crashed renderer give the music back — none of which run an unload handler reliably. */
/**
 * Has the current hold's LEASE lapsed? A holder that stopped talking to us — a closed window,
 * a crashed renderer, a reloaded webview, none of which run an unload handler reliably.
 */
function lapsedAt(now: number): boolean {
  return ledger.expires <= now;
}

/**
 * Has this hold kept the machine silenced longer than {@link MAX_SILENCE_MS}?
 *
 * The lease cannot answer this, because the lease is REFRESHABLE: a stuck queue — or a caller
 * on the LAN heart-beating deliberately — renews forever at a request rate far under any rate
 * limit, and no rate limit can tell the two apart.
 *
 * ── WHAT THE CEILING DOES AND DOES NOT DO, STATED RATHER THAN IMPLIED ───────────────────
 * It gives the machine its audio back. It does NOT take the floor away, and the first attempt
 * here did exactly that and was worse than useless: reclaiming the floor let the same caller
 * immediately take a fresh hold, which restarted the clock — a ceiling that renews itself is
 * not a ceiling. Bounding the SILENCE is the harm this route actually introduces, and it is
 * the half that can be bounded without breaking the one-voice invariant the floor exists for.
 * A hostile authenticated peer can still deny the speaker indefinitely; that is not fixed
 * here, and pretending otherwise with a self-renewing timer would be the worse outcome.
 */
function overrunAt(now: number): boolean {
  if (ledger.silenceSpent) return false;
  return ledger.since > 0 && now - ledger.since >= MAX_SILENCE_MS;
}

/** Give the machine back, keep the floor. Called from both the sweeper and a heartbeat. */
async function spendSilence(): Promise<void> {
  ledger.silenceSpent = true;
  await restoreMachine();
}

async function sweep(): Promise<void> {
  if (!ledger.session) return;
  const now = Date.now();
  if (overrunAt(now)) { await spendSilence(); return; }
  if (!lapsedAt(now)) return;
  ledger.session = null;
  ledger.expires = 0;
  ledger.since = 0;
  await restoreMachine();
}

/**
 * Take (or refresh) the speaker.
 *
 * IDEMPOTENT for the current holder, and that is what makes the client's "call it on every
 * chunk" pattern correct: a refresh extends the lease without touching the machine again, so
 * the music is paused ONCE per turn rather than stuttering off and on at every sentence.
 */
async function holdInner(session: string, home?: string): Promise<FocusGrant> {
  if (!session) return NO_GRANT(ledger.session);
  const now = Date.now();
  if (ledger.session && ledger.session !== session && !lapsedAt(now)) {
    // Another pane is mid-answer. The loser is told, and tells the owner on screen.
    return NO_GRANT(ledger.session);
  }
  arm();
  /** The grant for a hold that changed nothing about the machine — a refresh, or a takeover
   *  that inherited an already-silenced machine. Reports the gain we STORED at duck time. */
  const carried = (): FocusGrant => ({
    granted: true,
    holder: session,
    ducked: ledger.duckedFrom !== null,
    gain: ledger.gain,
    paused: [...ledger.paused],
    denied,
  });
  if (ledger.session === session) {
    ledger.expires = now + HOLD_TTL_MS;
    // Checked on the heartbeat as well as in the sweeper: the sweeper runs every five
    // seconds, and this is the path a live caller is already on.
    if (overrunAt(now)) await spendSilence();
    return carried();
  }
  // A takeover from an EXPIRED holder inherits whatever that holder silenced rather than
  // silencing it again: the music is already paused, and re-pausing would record it twice.
  const inherited = ledger.session !== null;
  ledger.session = session;
  ledger.expires = now + HOLD_TTL_MS;
  if (inherited) return carried();
  // A genuinely fresh take: this is where the continuous-silence clock starts, and the only
  // place the budget is handed back.
  ledger.since = now;
  ledger.silenceSpent = false;
  const cfg = readVoiceConfig(home);
  const { ducked, gain, paused } = await silenceMachine(cfg);
  ledger.paused = paused;
  return { granted: true, holder: session, ducked, gain, paused, denied };
}

/**
 * Take (or refresh) the speaker.
 *
 * IDEMPOTENT for the current holder, and that is what makes the client's "call it on every
 * chunk" pattern correct: a refresh extends the lease without touching the machine again, so
 * the music is paused ONCE per turn rather than stuttering off and on at every sentence.
 *
 * Serialised against every other ledger operation — see {@link serialize} for the two real
 * interleavings that made that necessary.
 */
export function hold(session: string, home?: string): Promise<FocusGrant> {
  return serialize(() => holdInner(session, home));
}

/**
 * Hand the speaker back and un-silence the machine.
 *
 * A release from a session that does NOT hold the floor is a no-op, and that guard is not
 * defensive decoration: the pane that was refused the floor still runs its own end-of-turn
 * cleanup, and without this check its release would free the winner's floor and start the
 * music back up in the middle of the winner's sentence.
 */
export function release(session: string): Promise<void> {
  return serialize(async () => {
    if (!session || ledger.session !== session) return;
    ledger.session = null;
    ledger.expires = 0;
    ledger.since = 0;
    await restoreMachine();
  });
}

/**
 * Last-ditch restore on process exit.
 *
 * SYNCHRONOUS ON PURPOSE. `exit` runs no microtasks and awaits nothing, so the async path
 * above is simply not available here — a promise queued in an exit handler never resolves.
 * `spawnSync` is the only thing that actually runs, and a few hundred milliseconds on the way
 * out is a fair price for not leaving the owner's machine mute with no app left to explain it.
 */
export function restoreOnExitSync(): void {
  if (!canControlAudio()) return;
  const paused = ledger.paused;
  const from = ledger.duckedFrom;
  ledger.paused = [];
  ledger.duckedFrom = null;
  ledger.duckedTo = null;
  ledger.gain = 1;
  try {
    // `paused` is non-empty only because step 1 already answered `true` for these apps this
    // session, so the dictionary terms resolve and the script compiles. That is the only
    // reason a one-shot resume is safe here: this path reads no answers and cannot branch.
    for (const app of paused) osaSync(resumeScript(app));
    if (from !== null) osaSync(setVolumeScript(from));
  } catch { /* best-effort by definition */ }
}

let exitHooked = false;

/** Install the exit restore once. Called from the route module so a CLI that never serves
 *  voice does not register a handler it will never need. */
export function hookExitRestore(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', restoreOnExitSync);
}
