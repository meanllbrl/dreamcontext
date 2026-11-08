import { useState } from 'react';
import { appIconUrl } from './notchModel';

/** A dreamcontext App's icon. No raster to show draws its first letter. */
export function AppIcon({ vault, slug, name, className }: { vault: string; slug: string; name: string; className: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className={className} aria-hidden>{name.slice(0, 1).toUpperCase()}</span>;
  return <img className={className} src={appIconUrl(vault, slug)} alt="" onError={() => setBroken(true)} />;
}
