import './Hero.css';

/**
 * Landing hero — two-column lockup. LEFT: the dreamcontext logo+wordmark, an
 * eyebrow, the headline (with a gradient-accent span), the positioning-safe
 * lead, and a CTA row (install command pill + npm + GitHub). RIGHT: the looping
 * brain video sitting inside an animated aura, with a poster image as the
 * graceful fallback. Entrance motion reuses the shared `slide-up-fade` keyframe
 * (defined in AboutPage.css) and is disabled under prefers-reduced-motion.
 *
 * The diamond mark is rendered inline (recolored to a token gradient) rather
 * than pulling in the favicon, so it themes and scales with the rest of the page.
 */
export function Hero() {
  return (
    <header className="about-hero">
      <div className="about-hero-copy">
        <a className="about-lockup" href="#top" aria-label="dreamcontext">
          <svg
            className="about-lockup-mark"
            width="34"
            height="34"
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path d="M16 2L28 16L16 30L4 16L16 2Z" fill="url(#hero-mark-outer)" />
            <path
              d="M16 9L22 16L16 23L10 16L16 9Z"
              fill="url(#hero-mark-inner)"
              opacity="0.75"
            />
            <defs>
              <linearGradient
                id="hero-mark-outer"
                x1="4"
                y1="2"
                x2="28"
                y2="30"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="var(--color-vivid-purple)" />
                <stop offset="1" stopColor="var(--color-electric-blue)" />
              </linearGradient>
              <linearGradient
                id="hero-mark-inner"
                x1="10"
                y1="9"
                x2="22"
                y2="23"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="var(--color-electric-blue)" />
                <stop offset="1" stopColor="var(--color-vivid-purple)" />
              </linearGradient>
            </defs>
          </svg>
          <span className="about-lockup-word">dreamcontext</span>
        </a>

        <span className="about-eyebrow">
          <span className="about-eyebrow-dot" />
          the persistent brain for AI natives
        </span>

        <h1 className="about-title">
          The persistent brain for your
          <span className="about-title-accent"> AI&nbsp;agents.</span>
        </h1>

        <p className="about-lead">
          It remembers every decision you made, knows how your project is structured, and is
          learning to act on that knowledge — so every session starts <em>ready</em> instead of
          blind. Built for founders and builders, technical or not.
        </p>

        <div className="about-cta-row">
          <code className="about-command">npm&nbsp;i&nbsp;-g&nbsp;dreamcontext</code>
          <a
            className="about-link-btn"
            href="https://www.npmjs.com/package/dreamcontext"
            target="_blank"
            rel="noreferrer"
          >
            npm ↗
          </a>
          <a
            className="about-link-btn about-link-btn--ghost"
            href="https://github.com/meanllbrl/dreamcontext"
            target="_blank"
            rel="noreferrer"
          >
            GitHub ↗
          </a>
        </div>
      </div>

      <div className="about-hero-media">
        <div className="about-hero-aura" aria-hidden="true" />
        <video
          className="about-hero-video"
          autoPlay
          muted
          loop
          playsInline
          poster="/media/brain-hero.png"
        >
          <source src="/media/brain.webm" type="video/webm" />
          <source src="/media/brain.mp4" type="video/mp4" />
        </video>
      </div>
    </header>
  );
}
