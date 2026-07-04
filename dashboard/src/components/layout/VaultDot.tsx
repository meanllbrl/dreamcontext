import './VaultDot.css';

/**
 * The green/yellow/red status dot for a vault, shared by every surface that
 * renders launcher status (the Launcher cards and the ⌘P project switcher) so
 * the ok/stale/gone → colour mapping lives in exactly one place.
 */
export function VaultDot({
  exists,
  needsUpdate,
  title,
  className,
}: {
  exists: boolean;
  needsUpdate: boolean;
  title?: string;
  className?: string;
}) {
  const state = !exists ? 'gone' : needsUpdate ? 'stale' : 'ok';
  return (
    <span
      className={`vault-dot vault-dot--${state}${className ? ` ${className}` : ''}`}
      title={title}
      aria-hidden="true"
    />
  );
}
