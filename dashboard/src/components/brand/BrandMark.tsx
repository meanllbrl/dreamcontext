interface BrandMarkProps {
  /** Rendered pixel size (square). */
  size?: number;
  /** Soft violet drop-shadow halo around the mark. */
  glow?: boolean;
  className?: string;
  title?: string;
}

/**
 * The dreamcontext mark — the violet folded-diamond "dream gem". This is the
 * single brand icon (rail lockup, constellation centre, favicon, app icon),
 * served from the same master PNG used to generate the desktop app icon so the
 * brand stays pixel-identical everywhere. The artwork already carries its own
 * soft halo; `glow` adds a touch more lift when the mark sits on a flat surface.
 */
export function BrandMark({ size = 34, glow = false, className, title }: BrandMarkProps) {
  return (
    <img
      src="/logo.png"
      width={size}
      height={size}
      className={className}
      alt={title ?? 'dreamcontext'}
      draggable={false}
      style={{
        objectFit: 'contain',
        ...(glow ? { filter: 'drop-shadow(0 6px 16px rgba(123,104,238,0.35))' } : {}),
      }}
    />
  );
}
