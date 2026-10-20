import './liveBadge.css';

/**
 * The hands-free live badge, ONE atom for both ends of the link: the phone's header ("connected
 * to your Mac") and the Mac panel ("the phone link is live"). `tone` is the dot's colour (the
 * Mac's state: ok, or warn when its battery is low or it is cooling down, busy while it is
 * opening or closing the link); `live` is the pulse (only while the link is up; a dropped link
 * is a hollow, still dot). `quiet` keeps a live badge still (beside an open chat's title, where
 * the transcript is what is read). `sr` is read before the label and not shown.
 */
export function LiveBadge({ tone, live, label, sr, quiet = false, testId }: {
  tone: 'ok' | 'low' | 'warm' | 'busy';
  live: boolean;
  label: string;
  sr?: string;
  quiet?: boolean;
  testId?: string;
}) {
  return (
    <span className="dc-hf-chip" data-mac={tone} data-live={live ? 'true' : 'false'} data-quiet={quiet ? 'true' : undefined} role="status" data-testid={testId}>
      <span className="dc-hf-chip-dot" aria-hidden="true" />
      {sr && <span className="dc-hf-sr">{sr}</span>}
      {label}
    </span>
  );
}
