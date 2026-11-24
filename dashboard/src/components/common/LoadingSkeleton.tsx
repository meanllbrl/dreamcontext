import './loading-skeleton.css';

interface LoadingSkeletonProps {
  /** The shape of what is coming: a task board's columns, a whiteboard's canvas, or a list of rows. */
  shape: 'board' | 'canvas' | 'list';
  /** What a screen reader hears (the page's "Loading" string). */
  label: string;
}

/**
 * What a page shows while its content is on the way: the outline of that content, not the word
 * "Loading" in a corner (owner, 2026-11-22). It stays invisible for the first moment, so a page
 * that is ready at once shows nothing in between, and it does not pulse: nothing here runs
 * longer than its one short entrance.
 */
export function LoadingSkeleton({ shape, label }: LoadingSkeletonProps) {
  return (
    <div className={`dc-skel dc-skel--${shape}`} role="status" aria-busy="true" data-loading="" data-testid="loading-skeleton">
      <span className="dc-skel-label">{label}</span>
      {shape === 'board' ? (
        <>
          <div className="dc-skel-bar" aria-hidden="true">
            <span className="dc-skel-block dc-skel-title" />
            <span className="dc-skel-block dc-skel-chip" />
            <span className="dc-skel-block dc-skel-chip" />
          </div>
          <div className="dc-skel-cols" aria-hidden="true">
            {[3, 2, 4, 2].map((cards, col) => (
              <div className="dc-skel-col" key={col}>
                <span className="dc-skel-block dc-skel-head" />
                {Array.from({ length: cards }, (_, i) => <span className="dc-skel-block dc-skel-card" key={i} />)}
              </div>
            ))}
          </div>
        </>
      ) : shape === 'list' ? (
        <div className="dc-skel-rows" aria-hidden="true">
          {[72, 56, 64, 48, 60].map((width, i) => <span className="dc-skel-block dc-skel-row" style={{ width: `${width}%` }} key={i} />)}
        </div>
      ) : (
        <div className="dc-skel-canvas" aria-hidden="true">
          <span className="dc-skel-block dc-skel-note" />
          <span className="dc-skel-block dc-skel-note dc-skel-note--wide" />
          <span className="dc-skel-block dc-skel-note" />
        </div>
      )}
    </div>
  );
}
