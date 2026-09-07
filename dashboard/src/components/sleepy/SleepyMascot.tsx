import type { ChatMode } from '../../lib/chatModes';
import './SleepyMascot.css';

export type SleepyMood = 'idle' | 'sleepy' | 'sleeps' | 'thinking' | 'working' | 'waving' | 'asking';

/**
 * The chat modes Sleepy WEARS something for. Basic maps to `null` — the bare face,
 * byte-for-byte the look every surface had before modes existed.
 *
 * Mode is a SHAPE channel on purpose, never a colour one: mood already owns every hue and
 * animation in this file (green scanning = working, magenta wide-eyed = asking …), and a
 * second colour channel would make the two fight over the same 26px chip. Gear layers on top,
 * so a Develop agent that is asking still reads as asking — in a hard hat.
 *
 * Each mode is an ACTION ON A LOOP, not a costume — that was the owner's call after three
 * costume drafts (spectacles/visor, brows, sheet+hard hat) all read as wardrobe rather than
 * character. Plan writes on paper with a pencil; Develop welds a joint and then hammers it.
 * The loop is what carries at every size: at 26px the detail is gone but the MOTION still
 * says which of the two you are looking at.
 *
 * The mouth is hidden while a mode is worn: the work happens where the smile was, and mood
 * still speaks through the eyes (plus, in the dock, the chip's own colour and "?" bubble).
 */
export type SleepyGear = 'plan' | 'develop' | 'jarvis';

/** Which gear a mode wears, if any. Total over `ChatMode` so a new mode is a silent bare face
 *  rather than a crash.
 *
 *  J.A.R.V.I.S joined the set when the voice work landed. It mapped to `null` before that,
 *  alongside Basic, because the mode was announced and unpickable — and because the test
 *  pinning this passed either way, the choice would otherwise have shipped silently
 *  undecided. It is the owner's call that it gets one: Plan and Develop each have one, and a
 *  mode you TALK to is at least as distinct as a mode that plans. */
export function gearForMode(mode: ChatMode | undefined): SleepyGear | null {
  return mode === 'plan' || mode === 'develop' || mode === 'jarvis' ? mode : null;
}

/** Base design size the mascot is drawn at; `size` scales the whole thing. */
const BASE = 92;

interface SleepyMascotProps {
  /** Mood, driven by the project's sleep debt: idle (<8) · sleepy (8–9) · sleeps (≥10). */
  mood?: SleepyMood;
  /** Rendered width in px (everything scales from the 92px base). */
  size?: number;
  /** Tight mode for the notch perch: drops the halo + Zzz so nothing overflows
   *  the menu-bar-height tab — just the face. */
  compact?: boolean;
  /** The chat mode this face belongs to. Basic (the default, and anything absent) draws the
   *  bare face; Plan writes on paper, Develop works the forge, J.A.R.V.I.S listens and
   *  answers. See {@link gearForMode}. */
  mode?: ChatMode;
}

/**
 * Sleepy — the dreamcontext companion. The SAME face as the dashboard's "Ask
 * Sleepy anything" surface (soft violet eyes + a curved smile over a glow), so
 * the notch and the app feel like one character. Mood follows sleep debt. The
 * whole face is drawn at a 92px base and uniformly scaled, so it's crisp at the
 * big in-panel size and the small on-perch size alike.
 */
export function SleepyMascot({ mood = 'idle', size = BASE, compact = false, mode }: SleepyMascotProps) {
  const scale = size / BASE;
  const gear = gearForMode(mode);
  return (
    <div
      className={`smascot smascot-${mood}${compact ? ' smascot-compact' : ''}${gear ? ` smascot-wears smascot-wears-${gear}` : ''}`}
      style={{ width: size, height: size * 0.82 }}
      aria-hidden
    >
      <div className="smascot-scale" style={{ transform: `scale(${scale})` }}>
        {!compact && <div className="smascot-halo" />}
        {mood === 'sleeps' && !compact && (
          <div className="smascot-zzz">
            <span>z</span>
            <span>z</span>
            <span>z</span>
          </div>
        )}
        {/* Floating "?" — asking only, full-size only (the dock chip's tight clip box
            draws its own corner bubble instead, so nothing gets cut off). */}
        {mood === 'asking' && !compact && <div className="smascot-q"><span>?</span></div>}
        <div className="smascot-face">
          <div className="smascot-eyes">
            <span className="smascot-eye" />
            <span className="smascot-eye" />
          </div>
          <svg className="smascot-smile" width="62" height="22" viewBox="0 0 96 34" fill="none">
            <path d="M12 8 Q48 42 84 8" stroke="#9d8cff" strokeWidth="5" strokeLinecap="round" />
          </svg>
          {gear && <Gear kind={gear} />}
        </div>
        {/* A little waving hand — only when Sleepy is done and saying hi. */}
        {mood === 'waving' && <span className="smascot-hand" aria-hidden />}
      </div>
    </div>
  );
}


/**
 * The mode gear, drawn inside `.smascot-face` so it bobs and tilts with the head while the
 * eyes go on scanning underneath it.
 *
 * COORDINATES ARE FACE COORDINATES. The `translate(15,32)` group puts the origin at the top-
 * left of the face's own 62×61 layout box, so: the left eye is (3,0)–(21,26), the right eye
 * is (41,0)–(59,26), the smile spans (0,39)–(62,61), and NEGATIVE y is above the head. Every
 * number below is measured off that — move an eye and the gear must move with it.
 */
function Gear({ kind }: { kind: SleepyGear }) {
  return (
    <svg className="smascot-gear" width="92" height="112" viewBox="0 0 92 112" fill="none" aria-hidden>
      <g transform="translate(15,32)" className="smascot-gear-line" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'jarvis' ? (
          /* J.A.R.V.I.S — listen, then answer. A microphone on the left and a row of level
             bars across the mouth. The bars ripple RIGHT-TO-LEFT and stay low while it is
             listening, then swell and sweep LEFT-TO-RIGHT out of the mic while it answers;
             two arcs bloom off the capsule on the reply. That reversal is the whole loop, and
             it is what still reads at 26px when the mic itself is three pixels wide: the
             direction and the height of the motion say which half of a conversation you are
             looking at. Same discipline as the other two — an action, not a costume, and
             drawn in the theme's ink so mood keeps every hue in this file. */
          <g className="smascot-scene">
            {/* Microphone — capsule, yoke, stand. Sits where the left corner of the smile was. */}
            <g className="smascot-mic">
              <rect className="smascot-gear-fill-soft" x="4" y="39" width="11" height="16" rx="5.5" />
              <path d="M0.5 50 a9 9 0 0 0 18 0" strokeWidth="2.4" />
              <path d="M9.5 59 V63" strokeWidth="2.4" />
              <path d="M4.5 63 H14.5" strokeWidth="2.4" />
            </g>
            {/* The two arcs that bloom off the capsule when it speaks. */}
            <path className="smascot-say smascot-say--1" d="M21 43 a10 10 0 0 1 0 14" strokeWidth="2.4" fill="none" />
            <path className="smascot-say smascot-say--2" d="M26 39 a16 16 0 0 1 0 22" strokeWidth="2.4" fill="none" />
            {/* Level bars. Centred on y=50 and scaled about their own middles, so a bar grows
                in BOTH directions like a real meter rather than sprouting from a baseline. */}
            <g className="smascot-vu">
              <rect className="smascot-vu-bar smascot-vu-bar--1" x="31" y="44" width="4" height="12" rx="2" />
              <rect className="smascot-vu-bar smascot-vu-bar--2" x="38" y="44" width="4" height="12" rx="2" />
              <rect className="smascot-vu-bar smascot-vu-bar--3" x="45" y="44" width="4" height="12" rx="2" />
              <rect className="smascot-vu-bar smascot-vu-bar--4" x="52" y="44" width="4" height="12" rx="2" />
              <rect className="smascot-vu-bar smascot-vu-bar--5" x="59" y="44" width="4" height="12" rx="2" />
            </g>
          </g>
        ) : kind === 'plan' ? (
          /* PLAN — a sheet of paper and a big cartoon pencil. Two lines are already written;
             the pencil writes the third as a handwriting SQUIGGLE that appears under its tip,
             then hops right and dots the full stop. That loop IS the mode — thinking on
             paper, not shipping. Everything lives inside the sheet's own -4° tilt so the
             pencil can never drift off its ruled line. */
          <g className="smascot-scene" transform="rotate(-4 31 46)">
            <rect className="smascot-gear-sheet" x="-8" y="26.5" width="78" height="40" rx="5" />
            <path d="M4 36 H50" strokeWidth="2.4" opacity="0.4" />
            <path d="M4 45.5 H42" strokeWidth="2.4" opacity="0.28" />
            {/* The live line — five humps of joined-up writing, revealed by dashoffset. */}
            <path className="smascot-ink" d="M4 56 q4 -4.5 8 0 t8 0 t8 0 t8 0 t8 0" strokeWidth="2.6" />
            {/* The full stop, pressed in at the end of the line. */}
            <circle className="smascot-ink-dot" cx="50" cy="56.5" r="2.3" stroke="none" />
            {/* Pencil — tip at the squiggle's start; the group animates ALONG the line. Local
                coords put the tip at the origin with the body along +x, then rotate(-45)
                stands it up the way a hand holds it. */}
            <g transform="translate(4,56)">
              <g className="smascot-pencil">
                <g transform="rotate(-45)">
                  {/* body · wood collar · graphite point */}
                  <path d="M8 0 H25" strokeWidth="7" />
                  <path className="smascot-pencil-tip" d="M0.6 0 L8.6 -3.6 L8.6 3.6 Z" />
                  <path className="smascot-gear-fill" d="M0 0 L3.2 -1.5 L3.2 1.5 Z" stroke="none" />
                </g>
              </g>
            </g>
          </g>
        ) : (
          /* DEVELOP — the smithy. One iconic anvil silhouette (horn to the right), a torch
             from the upper-left, a chunky hammer pivoting from the right. It welds a little
             (the flame flickers, the joint glows, sparks fizz), the torch pulls back, the
             hammer strikes — flash, burst, the anvil dips — taps once more, and it all
             starts again. Forever, because that is what this mode does. */
          <g className="smascot-scene">
            {/* Anvil — a single closed path: plate, horn, waist, flared base. */}
            <g className="smascot-anvil">
              <path className="smascot-gear-fill-soft" d="M-6 40 H33 C44 40 52 42 57 46 C51 50 42 51 34 51 L27 51 L24 57 L31 59 L31 64 L3 64 L3 59 L10 57 L7 51 L-6 51 Z" />
            </g>
            {/* Torch — handle, nozzle, teardrop flame aimed at the joint. The whole group
                moves: on the joint while welding, pulled back up-left for the blow. */}
            <g className="smascot-torch">
              <path d="M-15 13 L1 27" strokeWidth="5.2" />
              <path d="M1 27 L7.5 32.5" strokeWidth="3" opacity="0.8" />
              <path className="smascot-flame" d="M8.5 33.5 Q15.5 34.5 14.5 40.5 Q9.5 39 8 34.5 Z" stroke="none" />
            </g>
            {/* The joint on the anvil's plate: glows under the torch, flashes for the blow. */}
            <circle className="smascot-weld" cx="14" cy="38" r="4" stroke="none" />
            <circle className="smascot-spark smascot-spark--w1" cx="14" cy="37" r="1.8" stroke="none" />
            <circle className="smascot-spark smascot-spark--w2" cx="13" cy="37" r="1.4" stroke="none" />
            <circle className="smascot-spark smascot-spark--w3" cx="15" cy="37" r="2" stroke="none" />
            {/* Hammer — pivots at the unseen hand on the right; parked between the eyes,
                winds up, and comes down onto the joint. */}
            <g transform="translate(57,33)">
              <g className="smascot-hammer">
                <path d="M0 0 L-26 -1" strokeWidth="4.6" />
                <rect className="smascot-gear-fill-soft" x="-41" y="-9" width="14" height="18" rx="3.5" />
              </g>
            </g>
            {/* Impact burst — only on the blow. */}
            <circle className="smascot-spark smascot-spark--h1" cx="16" cy="35" r="2.4" stroke="none" />
            <circle className="smascot-spark smascot-spark--h2" cx="16" cy="35" r="1.9" stroke="none" />
            <circle className="smascot-spark smascot-spark--h3" cx="16" cy="35" r="1.6" stroke="none" />
          </g>
        )}
      </g>
    </svg>
  );
}
