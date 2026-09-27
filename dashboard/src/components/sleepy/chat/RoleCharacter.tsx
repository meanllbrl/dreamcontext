import type { ReactNode } from 'react';
import type { AgentRoleId } from '../../../lib/agentRoles';
import './RoleCharacter.css';

/**
 * EVERY ROLE IS A CHARACTER (owner, 2026-09-26: "the faces still have no character; tell them
 * apart with dreamcontext's colours and character"). A face on a shared tint did not do it at
 * 20-28px, so each role gets THREE channels that survive a small size, in order of strength:
 *
 *   1. a BODY of its own (round, gumdrop, square, spike, shield, screen, gem), so the outline
 *      alone separates a Security from a Pragmatist;
 *   2. a HUE of its own, one slot each around the brand wheel (tokens.css `--role-c-*`, light
 *      and dark), so the reviewers sitting side by side never share a colour;
 *   3. a PROP big enough to break the outline (the Planner's pencil, the Builder's hard hat, the
 *      Reviewer's crown, the Scout's safari hat), so the role reads before the face does.
 *
 * The family is Sleepy's: pill eyes and a curved smile. The lead IS Sleepy, the only one with
 * the mascot's glowing lavender eyes on a deep violet body.
 *
 * Identity is static chrome, never a status (★★★ colour = mood, movement = mode): nothing here
 * changes at runtime. Running is carried by the avatar's motion, outside this drawing.
 *
 * Drawn on a 32-unit grid, bottom-anchored, every part a class (RoleCharacter.css) so the theme
 * decides the paint. Decorative: the row that owns it names the role.
 */

/** Pill eyes, the Sleepy family trait. `h` shortens them for a sleepier or narrower look. */
function Eyes({ y = 16, h = 5, gap = 7, cx = 16 }: { y?: number; h?: number; gap?: number; cx?: number }) {
  const w = 3;
  return (
    <>
      {[cx - gap / 2, cx + gap / 2].map((x) => (
        <g key={x}>
          <rect className="rc-ink" x={x - w / 2} y={y - h / 2} width={w} height={h} rx={w / 2} />
          <circle className="rc-glint" cx={x - 0.45} cy={y - h / 2 + 1.1} r={0.55} />
        </g>
      ))}
    </>
  );
}

function Smile({ d = 'M13 20.5q3 2.4 6 0' }: { d?: string }) {
  return <path className="rc-line" d={d} />;
}

// ─── Bodies ─────────────────────────────────────────────────────────────────────────

const ROUND = 'M16 5C23.5 5 28 10.5 28 17.8C28 25 23 29.5 16 29.5C9 29.5 4 25 4 17.8C4 10.5 8.5 5 16 5Z';
const LOW_ROUND = 'M16 8.5C23.2 8.5 27.5 13 27.5 19.5C27.5 26 22.8 29.5 16 29.5C9.2 29.5 4.5 26 4.5 19.5C4.5 13 8.8 8.5 16 8.5Z';
const GUMDROP = 'M5 29C5 16.5 8.5 7.5 16 7.5C23.5 7.5 27 16.5 27 29Q16 30.6 5 29Z';
const SQUARE = 'M10.5 7.5H21.5Q27 7.5 27 13V24Q27 29.5 21.5 29.5H10.5Q5 29.5 5 24V13Q5 7.5 10.5 7.5Z';
const SPIKE = 'M16 2.5C18.2 2.5 27.5 19 27.5 24.5C27.5 28.5 24 29.5 16 29.5C8 29.5 4.5 28.5 4.5 24.5C4.5 19 13.8 2.5 16 2.5Z';
const SHIELD = 'M16 3L27 7V15C27 22 22.6 26.6 16 29.8C9.4 26.6 5 22 5 15V7Z';

function Body({ d, hi = 'M9.5 11.5q2.5-3 6-3.4' }: { d: string; hi?: string }) {
  return (
    <>
      <path className="rc-body" d={d} />
      <path className="rc-hi" d={hi} />
    </>
  );
}

// ─── The cast ───────────────────────────────────────────────────────────────────────

const CAST: Readonly<Record<AgentRoleId, () => ReactNode>> = {
  // The lead is Sleepy: deep violet, the mascot's glowing lavender eyes, a little spark.
  lead: () => (
    <>
      <Body d={ROUND} />
      {[12.5, 19.5].map((x) => <rect key={x} className="rc-glow" x={x - 1.7} y={12.6} width={3.4} height={6.2} rx={1.7} />)}
      <path className="rc-line rc-line--glow" d="M12.5 22q3.5 2.6 7 0" />
      <path className="rc-gold" d="M26 1.5l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z" />
    </>
  ),
  // Planner: a gumdrop with a pencil behind its ear and a notebook to write in.
  planner: () => (
    <>
      <g transform="rotate(40 24.5 7)">
        <rect className="rc-pencil" x="22.5" y="-1" width="4" height="12" rx="0.6" />
        <rect className="rc-eraser" x="22.5" y="-2.6" width="4" height="2.4" rx="1" />
        <path className="rc-wood" d="M22.5 11h4l-2 3.8z" />
        <path className="rc-ink" d="M23.9 13.5h1.2l-.6 1.3z" />
      </g>
      <Body d={GUMDROP} />
      <Eyes y={15.5} />
      <Smile d="M13.4 20q2.6 1.8 5.2 0" />
      <g transform="rotate(-8 11 25)">
        <rect className="rc-paper" x="6.5" y="21.5" width="9" height="8" rx="1" />
        <path className="rc-rule" d="M8.3 24.2h5.4M8.3 26.7h4" />
      </g>
    </>
  ),
  // Critic: one eye narrowed, one brow up, the other eye huge behind a magnifying glass.
  critic: () => (
    <>
      <Body d={ROUND} />
      <path className="rc-line" d="M9.6 16.6h3.4" />
      <path className="rc-line" d="M9.4 13.4l3.6-.9" />
      <path className="rc-line" d="M12.5 23.2l4.5-1.2" />
      <path className="rc-handle" d="M24 20.5l4.6 5.4" />
      <circle className="rc-glass" cx="20.5" cy="15.8" r="5.4" />
      <rect className="rc-ink" x="18.6" y="12.6" width="3.8" height="6.4" rx="1.9" />
      <circle className="rc-glint" cx="19.8" cy="14" r="0.7" />
    </>
  ),
  // Pragmatist: a square, unimpressed, heavy lids and a flat mouth, holding open scissors
  // off to its side, clear of the face, so the V of the blades reads at 20px.
  pragmatist: () => (
    <>
      <Body d={SQUARE} hi="M9.5 11q2-1.4 5-1.5" />
      {[10, 16.4].map((x) => <path key={x} className="rc-ink" d={`M${x - 1.5} 15.2h3v1.8a1.5 1.5 0 0 1-3 0z`} />)}
      <path className="rc-line" d="M7.9 14.2h4.2M14.3 14.2h4.2" />
      <path className="rc-line" d="M10.8 21.4h4.4" />
      <circle className="rc-ring" cx="22.6" cy="26.6" r="2.1" />
      <circle className="rc-ring" cx="28.4" cy="26.6" r="2.1" />
      <path className="rc-blade" d="M24.6 22.4L20.6 11.6L26.8 21.2Z" />
      <path className="rc-blade" d="M26.4 22.4L30.4 11.6L24.2 21.2Z" />
      <circle className="rc-ink" cx="25.5" cy="21.9" r="0.9" />
    </>
  ),
  // Edge hunter: a spike of a body, eyes wide open, a small "o": it found the case nobody did.
  'edge-cases': () => (
    <>
      <Body d={SPIKE} hi="M12.2 12.5q1.5-3.2 3-5.2" />
      {[12.3, 19.7].map((x) => (
        <g key={x}>
          <circle className="rc-paper" cx={x} cy="18.2" r="3" />
          <circle className="rc-ink" cx={x + 0.3} cy="18.5" r="1.5" />
        </g>
      ))}
      <ellipse className="rc-ink" cx="16" cy="24.4" rx="1.3" ry="1.6" />
      <path className="rc-line" d="M9.6 13.6l2.8-.8M22.4 13.6l-2.8-.8" />
    </>
  ),
  // Security: a shield with a knight's visor; the eyes watch through the slit.
  security: () => (
    <>
      <Body d={SHIELD} hi="M8.4 9.5l6-2.4" />
      <rect className="rc-metal" x="7.4" y="12.6" width="17.2" height="6" rx="3" />
      <rect className="rc-ink" x="10.6" y="14.6" width="3.8" height="2" rx="1" />
      <rect className="rc-ink" x="17.6" y="14.6" width="3.8" height="2" rx="1" />
      <path className="rc-crest" d="M16 3.4V11" />
      <path className="rc-line" d="M13.6 23.2h4.8" />
    </>
  ),
  // Plan reviewer: round spectacles, reading the plan closely.
  'plan-reviewer': () => (
    <>
      <Body d={ROUND} />
      <Eyes y={17} h={3.8} />
      <circle className="rc-specs" cx="12.5" cy="17" r="3.4" />
      <circle className="rc-specs" cx="19.5" cy="17" r="3.4" />
      <path className="rc-specs" d="M15.9 16.4q.1-.8.1-.8q0 0 .1.8" />
      <Smile d="M13.6 23q2.4 1.6 4.8 0" />
    </>
  ),
  // Builder: a hard hat, a grin and a hammer.
  implementer: () => (
    <>
      <Body d={GUMDROP} />
      <path className="rc-gold" d="M7.2 10.6C7.6 5.8 11.2 3 16 3S24.4 5.8 24.8 10.6Z" />
      <rect className="rc-gold-deep" x="4.4" y="9.8" width="23.2" height="2.6" rx="1.3" />
      <path className="rc-hatline" d="M16 3.6V10" />
      <Eyes y={17} h={4.6} />
      <path className="rc-ink" d="M12.4 21.2h7.2q-.4 3.4-3.6 3.4t-3.6-3.4Z" />
      <path className="rc-handle" d="M20.8 29.4l6.2-11" />
      <rect className="rc-metal" x="23.2" y="15.2" width="8.4" height="4.4" rx="1" transform="rotate(30.6 27.4 17.4)" />
    </>
  ),
  // Reviewer (the boss gate): a crown, calm, content.
  reviewer: () => (
    <>
      <Body d={LOW_ROUND} hi="M9 14q2.4-2.6 5.6-3" />
      <path className="rc-gold" d="M7.5 11.5V3.5L11.8 7.2L16 2L20.2 7.2L24.5 3.5V11.5Z" />
      <circle className="rc-gem" cx="16" cy="8.8" r="1.2" />
      <path className="rc-line" d="M10.6 18.4q1.9-1.8 3.8 0M17.6 18.4q1.9-1.8 3.8 0" />
      <Smile d="M13.4 22.8q2.6 1.8 5.2 0" />
    </>
  ),
  // Validator: a wink and a big tick on its chest: it checked, and it holds.
  validator: () => (
    <>
      <Body d={GUMDROP} />
      <path className="rc-line" d="M10.6 15.4q1.9-1.6 3.8 0" />
      <rect className="rc-ink" x="18" y="12.8" width="3" height="5" rx="1.5" />
      <circle className="rc-glint" cx="18.95" cy="13.9" r="0.55" />
      <Smile d="M13 19.6q3 2.2 6 0" />
      <circle className="rc-paper" cx="16" cy="25.2" r="3.8" />
      <path className="rc-tick" d="M14.2 25.3l1.3 1.3l2.4-2.7" />
    </>
  ),
  // Scout: a safari hat and binoculars for eyes, already looking further out.
  explorer: () => (
    <>
      <Body d={GUMDROP} />
      <ellipse className="rc-khaki-deep" cx="16" cy="10.2" rx="13.2" ry="2.4" />
      <path className="rc-khaki" d="M9.4 10.2C9.4 5.6 12.2 3.4 16 3.4S22.6 5.6 22.6 10.2Z" />
      <path className="rc-band" d="M9.6 8.8h12.8" />
      <rect className="rc-binoc" x="15" y="15.4" width="2" height="2.4" />
      {[12.3, 19.7].map((x) => (
        <g key={x}>
          <circle className="rc-binoc" cx={x} cy="16.6" r="3.1" />
          <circle className="rc-lens" cx={x} cy="16.6" r="1.7" />
          <circle className="rc-glint" cx={x - 0.6} cy="16" r="0.55" />
        </g>
      ))}
      <Smile d="M13.6 22.6q2.4 1.6 4.8 0" />
    </>
  ),
  // Another project: the dream gem itself, looking out of its facets.
  peer: () => (
    <>
      <path className="rc-body" d="M9 5H23L29 12.5L16 29.5L3 12.5Z" />
      <path className="rc-facet" d="M3 12.5H29L16 29.5Z" />
      <path className="rc-hi" d="M9 5L6.6 9.8" />
      <Eyes y={16.2} h={4.2} />
      <Smile d="M14 21.4q2 1.4 4 0" />
    </>
  ),
  // Command-line helper: a little screen on a stand, its face a prompt.
  headless: () => (
    <>
      <path className="rc-body" d="M13 26h6l1.4 3.4h-8.8Z" />
      <rect className="rc-body" x="3.5" y="6" width="25" height="20" rx="4.5" />
      <rect className="rc-screen" x="6.5" y="9" width="19" height="14" rx="2.5" />
      <path className="rc-prompt" d="M10 13l3.2 3l-3.2 3" />
      <path className="rc-prompt" d="M15.6 19.6h5" />
    </>
  ),
  // A plain teammate: Sleepy's cousin in grey, no prop.
  agent: () => (
    <>
      <Body d={ROUND} />
      <Eyes y={16.5} />
      <Smile d="M12.8 21.8q3.2 2.4 6.4 0" />
    </>
  ),
};

/** A role's character. `size` is the square box in px; the drawing fills it. */
export function RoleCharacter({ role, size = 32 }: { role: AgentRoleId; size?: number }) {
  return (
    <svg className="rc" data-role={role} viewBox="0 0 32 32" width={size} height={size} aria-hidden>
      {CAST[role]()}
    </svg>
  );
}
