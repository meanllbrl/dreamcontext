import { BrandMark } from '../brand/BrandMark';
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
          <BrandMark size={34} className="about-lockup-mark" glow />
          <span className="about-lockup-word">dream<span style={{ color: 'var(--color-accent)' }}>context</span></span>
        </a>

        <h1 className="about-title">
          The persistent brain for
          <span className="about-title-accent"> AI&nbsp;natives.</span>
        </h1>

        <p className="about-lead">
          It remembers every decision you made, knows how your project is structured, and is
          learning to act on that knowledge — so every session starts <em>ready</em> instead of
          blind. Built for founders and builders, technical or not.
        </p>

        <div className="about-compat">
          <span className="about-compat-mark" aria-hidden="true">✓</span>
          Works with <strong>Claude&nbsp;Code</strong>
        </div>

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
