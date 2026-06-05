import './ArchitectureSection.css';

/**
 * "Memory, organized like a mind." — the architecture map, redesigned as a
 * cinematic CORTICAL STACK: each brain-region file is a translucent stratum
 * laid into a tilted cross-section, like slicing through a mind and seeing the
 * layers it's made of. The strata sit in a faux-3D plate (CSS perspective);
 * each carries a token-gradient edge, a glyph chip, its region/brain analogue,
 * a one-line description, and — where it applies — the capabilities that ride
 * on top of it (skills, sub-agents).
 *
 * Everything is built from design tokens (no hardcoded colors), themes in both
 * light and dark, and all depth/glow/breathe motion is removed under
 * prefers-reduced-motion. No external diagram dependency — bespoke CSS only.
 *
 * Hover a stratum and the stack "splays": that layer lifts toward you, its edge
 * lights up, and the neighbours ease back — so the static picture becomes a
 * thing you can reach into.
 */

interface Stratum {
  file: string;
  glyph: string;
  region: string;
  brain: string;
  desc: string;
  rides?: { label: string; desc: string };
}

// The seven strata, top (surface / identity) → bottom (working / in-flight).
// This data is owned here; it intentionally extends the old flat map with the
// data-structures→Schema layer and the skills / sub-agents capabilities.
const STRATA: Stratum[] = [
  {
    file: '0.soul',
    glyph: '◆',
    region: 'Identity',
    brain: 'sense of self',
    desc: 'Who it is — purpose, principles, and the rules it must never break.',
  },
  {
    file: '1.user',
    glyph: '◉',
    region: 'Episodic',
    brain: 'lived history',
    desc: 'What you did and decided, session over session.',
  },
  {
    file: '2.memory',
    glyph: '✦',
    region: 'Semantic',
    brain: 'durable facts',
    desc: "What's true about the project — facts that hold across every session.",
  },
  {
    file: 'data-structures/',
    glyph: '▤',
    region: 'Schema',
    brain: 'mental models',
    desc: 'The shapes of your data — the structures everything else is built on.',
  },
  {
    file: 'knowledge/',
    glyph: '⚙',
    region: 'Procedural',
    brain: 'learned skill',
    desc: 'How to do things here — patterns, recipes, and hard-won know-how.',
    rides: { label: 'skills', desc: 'capabilities it can pick up and apply' },
  },
  {
    file: 'state/',
    glyph: '▦',
    region: 'Working',
    brain: 'in attention',
    desc: "What's in flight right now — tasks, features, and the sleep cycle.",
    rides: { label: 'sub-agents', desc: 'workers it directs under your steer' },
  },
];

export function ArchitectureSection() {
  return (
    <section className="about-section arch" aria-labelledby="arch-heading">
      <p className="about-kicker">The architecture</p>
      <h2 className="about-h2" id="arch-heading">
        Memory, organized like a mind.
      </h2>
      <p className="about-section-lead">
        Knowledge isn't one flat file. It's laid down in strata — each a
        purpose-built region that mirrors a part of the brain — so the agent
        reaches for the right kind of memory at the right moment.
      </p>

      <div className="arch-stage" role="img" aria-label="A cross-section of the project's memory, stacked as layered brain regions.">
        <div className="arch-glow" aria-hidden="true" />
        <ol className="arch-stack">
          {STRATA.map((s, i) => (
            <li
              key={s.file}
              className="arch-stratum"
              style={{ '--i': i, '--n': STRATA.length } as React.CSSProperties}
            >
              <div className="arch-edge" aria-hidden="true" />
              <div className="arch-face">
                <span className="arch-glyph" aria-hidden="true">
                  {s.glyph}
                </span>
                <div className="arch-meta">
                  <div className="arch-meta-top">
                    <code className="arch-file">{s.file}</code>
                    <span className="arch-region">{s.region}</span>
                    <span className="arch-brain">{s.brain}</span>
                  </div>
                  <p className="arch-desc">{s.desc}</p>
                </div>
                {s.rides ? (
                  <div className="arch-rides">
                    <span className="arch-rides-plus" aria-hidden="true">
                      +
                    </span>
                    <span className="arch-rides-label">{s.rides.label}</span>
                    <span className="arch-rides-desc">{s.rides.desc}</span>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <p className="arch-foot">
        Six strata, one mind — read top-down, the agent goes from{' '}
        <em>who it is</em> to <em>what it's doing right now</em>.
      </p>
    </section>
  );
}
