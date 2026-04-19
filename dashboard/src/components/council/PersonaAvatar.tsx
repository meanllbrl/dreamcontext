import { slugHue, slugGlyph } from './lib/councilStats';

interface Props {
  slug: string;
  size?: number;
  title?: string;
  onClick?: () => void;
}

export function PersonaAvatar({ slug, size = 36, title, onClick }: Props) {
  const hue = slugHue(slug);
  const bg = `linear-gradient(135deg, hsl(${hue} 72% 52%), hsl(${(hue + 36) % 360} 72% 44%))`;
  const glyph = slugGlyph(slug);

  return (
    <span
      className="council-avatar"
      onClick={onClick}
      title={title ?? slug}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        background: bg,
        cursor: onClick ? 'pointer' : 'default',
      }}
      aria-label={slug}
    >
      {glyph}
    </span>
  );
}
