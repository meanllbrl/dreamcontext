import { useEffect, useState } from 'react';
import {
  storyAssetUrl,
  type AnnouncementStory as Story,
  type StoryBlock,
  type StoryClip,
  type StoryShot,
} from '../../lib/announcementStory';
import './AnnouncementStory.css';

/**
 * Renders an announcement story: a scrollable landing page built from real app
 * screenshots and short copy, in the app's own type, spacing and colours.
 *
 * It replaced the Excalidraw board renderer in 0.22. A board was a canvas — it
 * trapped the wheel, needed panning and zooming to read, and could only ever
 * DRAW a picture of the product. This is a page: it scrolls like every other
 * page in the app, and the screenshots are the product itself.
 *
 * Layout is deliberately fixed per block kind (no geometry in the document): an
 * author supplies copy and a screenshot path, and every announcement comes out
 * looking like the same product.
 */
export function AnnouncementStory({ story, onShotClick }: {
  story: Story;
  /** Open a screenshot in a lightbox. Omit to make shots inert. */
  onShotClick?: (shot: StoryShot) => void;
}) {
  return (
    <article className="ann-story">
      <header className="ann-story-hero">
        {story.hero.eyebrow && <p className="ann-story-eyebrow">{story.hero.eyebrow}</p>}
        <h1 className="ann-story-headline">{story.hero.headline}</h1>
        {story.hero.sub && <p className="ann-story-sub">{story.hero.sub}</p>}
        {story.hero.clip
          ? <Clip clip={story.hero.clip} hero />
          : story.hero.shot && <Shot shot={story.hero.shot} hero onClick={onShotClick} />}
      </header>

      {story.blocks.map((block, i) => (
        <Block key={i} block={block} onShotClick={onShotClick} />
      ))}

      {story.closer && (
        <footer className="ann-story-closer">
          <h2 className="ann-story-closer-title">{story.closer.title}</h2>
          <p className="ann-story-closer-body">{story.closer.body}</p>
        </footer>
      )}
    </article>
  );
}

function Block({ block, onShotClick }: { block: StoryBlock; onShotClick?: (shot: StoryShot) => void }) {
  switch (block.kind) {
    case 'stats':
      return (
        <section className="ann-story-stats">
          {block.items.map((s, i) => (
            <div key={i} className="ann-story-stat">
              <span className="ann-story-stat-value">{s.value}</span>
              <span className="ann-story-stat-label">{s.label}</span>
              {s.note && <span className="ann-story-stat-note">{s.note}</span>}
            </div>
          ))}
        </section>
      );

    // `side` is deliberately ignored. It used to float the shot left or right of a
    // ~380px copy column; alternating that down the page is what made the story
    // unreadable, so both kinds now render as one centred column — heading, copy,
    // then the picture full width. The field stays in the schema so already-written
    // stories keep parsing.
    case 'split':
      return (
        <section className="ann-story-split">
          <div className="ann-story-split-copy">
            <h2 className="ann-story-block-title">{block.title}</h2>
            <p className="ann-story-block-body">{block.body}</p>
          </div>
          <Shot shot={block.shot} onClick={onShotClick} />
        </section>
      );

    case 'shot':
      return (
        <section className="ann-story-shotblock">
          {block.title && <h2 className="ann-story-block-title">{block.title}</h2>}
          {block.body && <p className="ann-story-block-body">{block.body}</p>}
          <Shot shot={block.shot} onClick={onShotClick} />
        </section>
      );

    case 'video':
      return (
        <section className="ann-story-shotblock">
          {block.title && <h2 className="ann-story-block-title">{block.title}</h2>}
          {block.body && <p className="ann-story-block-body">{block.body}</p>}
          <Clip clip={block.clip} />
        </section>
      );

    case 'points':
      return (
        <section className="ann-story-points">
          {block.title && <h2 className="ann-story-block-title">{block.title}</h2>}
          <div className="ann-story-points-grid">
            {block.items.map((p, i) => (
              <div key={i} className="ann-story-point">
                <h3 className="ann-story-point-title">{p.title}</h3>
                <p className="ann-story-point-text">{p.text}</p>
              </div>
            ))}
          </div>
        </section>
      );

    case 'terminal':
      return (
        <section className="ann-story-terminal">
          {block.title && <h2 className="ann-story-block-title">{block.title}</h2>}
          <pre className="ann-story-terminal-box">
            {block.lines.map((line, i) => (
              <span key={i} className={'ann-story-terminal-line' + (line.startsWith('$ ') ? ' input' : '')}>
                {line || ' '}
              </span>
            ))}
          </pre>
        </section>
      );

    case 'note':
      return (
        <section className="ann-story-note">
          <p>{block.text}</p>
        </section>
      );
  }
}

/**
 * True while the viewer has asked their OS for reduced motion. Read live (not
 * once at mount) so toggling the setting takes effect without a reload.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * One clip, framed exactly like a screenshot so a story mixing the two reads as
 * one page.
 *
 * A silent clip behaves like the GIF it replaces: muted, looping, autoplaying,
 * no controls — motion that explains itself while you read the copy beside it.
 * Two things override that. A clip declaring `sound` gets controls and never
 * autoplays, because audio that starts on its own is a hostile surprise in an
 * app you left open. And a viewer who asked for reduced motion gets the poster
 * with controls instead of anything that moves by itself — the caption and alt
 * text carry the same claim, so nothing is lost by not playing it.
 *
 * `preload="metadata"` keeps a release page from pulling every clip's bytes on
 * open; a failed decode collapses the figure to the poster rather than leaving a
 * black rectangle, and if the poster is gone too the block disappears entirely
 * (the same contract as a broken screenshot).
 */
function Clip({ clip, hero }: { clip: StoryClip; hero?: boolean }) {
  const [failed, setFailed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const url = storyAssetUrl(clip.src);
  const posterUrl = storyAssetUrl(clip.poster);
  if (!url || !posterUrl) return null;

  const autoplays = !clip.sound && !reducedMotion;

  return (
    <figure className={`ann-story-shot ann-story-clip${hero ? ' hero' : ''}${clip.frame === 'plain' ? ' plain' : ''}`}>
      <div className="ann-story-shot-frame">
        {clip.frame !== 'plain' && (
          <div className="ann-story-shot-chrome" aria-hidden="true">
            <span /><span /><span />
          </div>
        )}
        {failed ? (
          <img className="ann-story-shot-img" src={posterUrl} alt={clip.alt} loading="lazy" decoding="async" />
        ) : (
          <video
            className="ann-story-shot-img"
            src={url}
            poster={posterUrl}
            aria-label={clip.alt}
            preload="metadata"
            playsInline
            muted={!clip.sound}
            autoPlay={autoplays}
            loop={autoplays}
            controls={!autoplays}
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {clip.caption && <figcaption className="ann-story-shot-caption">{clip.caption}</figcaption>}
    </figure>
  );
}

/**
 * One screenshot. `window` framing (the default) wraps it in app-window chrome
 * so a cropped screenshot still reads as a picture of the app; `plain` is for
 * shots that already carry their own edges.
 *
 * The image is lazy + `decoding=async` because a story can hold a dozen full-
 * width PNGs, and a broken/missing file collapses the whole frame rather than
 * leaving a torn-image placeholder mid-page.
 */
function Shot({ shot, hero, onClick }: { shot: StoryShot; hero?: boolean; onClick?: (shot: StoryShot) => void }) {
  const [broken, setBroken] = useState(false);
  const url = storyAssetUrl(shot.src);
  if (!url || broken) return null;

  const framed = (
    <figure className={`ann-story-shot${hero ? ' hero' : ''}${shot.frame === 'plain' ? ' plain' : ''}`}>
      <div className="ann-story-shot-frame">
        {shot.frame !== 'plain' && (
          <div className="ann-story-shot-chrome" aria-hidden="true">
            <span /><span /><span />
          </div>
        )}
        <img
          className="ann-story-shot-img"
          src={url}
          alt={shot.alt}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      </div>
      {shot.caption && <figcaption className="ann-story-shot-caption">{shot.caption}</figcaption>}
    </figure>
  );

  if (!onClick) return framed;
  return (
    <button
      type="button"
      className="ann-story-shot-btn"
      onClick={() => onClick(shot)}
      aria-label={`${shot.alt} — open larger`}
    >
      {framed}
    </button>
  );
}
