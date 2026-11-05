import { useState, type CSSProperties, type SyntheticEvent } from 'react';

/**
 * One icon, one mask, every size (app-paylasim-magaza r2 section 3). The picture fills the square
 * and dreamcontext rounds it (22.37 %), the same on a tile, a store row, the product page and the
 * publish screen. A picture that draws its own tile (transparent corners) is trimmed to its
 * opaque square when it loads. An app with no icon, the placeholder letter or a picture that does
 * not load gets the one fallback: a colour from its slug and its initials in the display face.
 */

/** 1-2 letters: the first letters of the first two words, or the first two of a single word. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0]);
  const a = (first[0] ?? '?').toLocaleUpperCase();
  const b = words.length > 1 ? Array.from(words[1])[0] ?? '' : first[1] ?? '';
  return `${a}${b.toLocaleLowerCase()}`;
}

/** The slug's hue: the same app keeps its colour through a rename (the server's default icon rule). */
export function slugHue(slug: string): number {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** The opaque square inside a picture with see-through corners, as fractions; null = use as is. */
function opaqueBox(img: HTMLImageElement): { x: number; y: number; w: number; h: number } | null {
  try {
    const n = 64;
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    const a = (x: number, y: number) => d[(y * n + x) * 4 + 3];
    if (![a(0, 0), a(n - 1, 0), a(0, n - 1), a(n - 1, n - 1)].every((v) => v < 16)) return null;
    let x0 = n, y0 = n, x1 = -1, y1 = -1;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (a(x, y) > 200) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 < 0 || x1 - x0 < n / 3 || y1 - y0 < n / 3) return null;
    return { x: x0 / n, y: y0 / n, w: (x1 - x0 + 1) / n, h: (y1 - y0 + 1) / n };
  } catch {
    return null;
  }
}

export function AppIcon({ src, name, slug, size, running, className }: { src?: string | null; name: string; slug: string; size: number; running?: boolean; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const style = { width: size, height: size, '--app-ic-size': `${size}px` } as CSSProperties;
  const show = !!src && failed !== src;
  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => setBox(opaqueBox(e.currentTarget));
  const hue = slugHue(slug || name);
  return (
    <span className={`app-ic${className ? ` ${className}` : ''}`} style={style} aria-hidden>
      <span className="app-ic__mask">
      {show ? (
        <img
          src={src!}
          alt=""
          draggable={false}
          onLoad={onLoad}
          onError={() => setFailed(src!)}
          style={box ? { width: `${100 / box.w}%`, height: `${100 / box.h}%`, left: `${(-100 * box.x) / box.w}%`, top: `${(-100 * box.y) / box.h}%` } : undefined}
        />
      ) : (
        <span className="app-ic__mono" style={{ background: `linear-gradient(hsl(${hue} 68% 54%), hsl(${hue} 72% 34%))`, fontSize: Math.round(size * 0.44) }}>{initials(name)}</span>
      )}
      </span>
      {running && <span className="app-ic__dot" />}
    </span>
  );
}
