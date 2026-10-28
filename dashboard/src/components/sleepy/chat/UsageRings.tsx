import { useMemo } from 'react';
import { useUsageLimits } from '../../../hooks/useAgentCapabilities';
import { accountLimitReading, type ContextBandKey } from '../../../lib/agentComposer';
import './composer.css';

// Apple Health's activity rings: CONCENTRIC rings, one per band, each filling its own
// 0→100% and each carrying its own tone. What makes that shape legible at this size is not
// the count of rings — it is the thickness and the air between them, plus a track tinted in
// the ring's OWN colour rather than a neutral grey, so an empty ring still says which band
// it is. Geometry is derived, not typed: `r` marches inward by exactly stroke + gap, so the
// spacing can never drift as the numbers are tuned.
const RING_W = 2.6;
const RING_GAP = 1.1;
const RING_R0 = 10.2;          // outer radius; outer edge lands at 11.5 inside a 24 box
const ringR = (i: number) => RING_R0 - i * (RING_W + RING_GAP);

/** One ring, outermost first. `band` undefined ⇒ a bare track; `'none'` ⇒ the neutral track of
 *  a reading we do not have. `notchFrac` places a threshold tick along the ring. */
export interface RingSpec {
  band: ContextBandKey | 'none' | undefined;
  frac: number;
  notchFrac?: number | null;
}

/** The ring mark both the composer's context gauge and a chat card's rate-limit ring draw. */
export function ConcentricRings({ rings, size = 24, ...aria }: {
  rings: RingSpec[];
  size?: number;
  role?: string;
  'aria-valuemin'?: number;
  'aria-valuemax'?: number;
  'aria-valuenow'?: number;
  'aria-valuetext'?: string;
  'aria-hidden'?: boolean;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...aria}>
      {rings.map((ring, i) => {
        const r = ringR(i);
        const c = 2 * Math.PI * r;
        return (
          <g key={i} transform="rotate(-90 12 12)">
            <circle className="chat-cmp-usagering-track" data-band={ring.band} cx="12" cy="12" r={r} strokeWidth={RING_W} />
            {ring.band && ring.band !== 'none' && ring.frac > 0 && (
              <circle
                className="chat-cmp-usagering-fill"
                data-band={ring.band}
                cx="12" cy="12" r={r} strokeWidth={RING_W} strokeLinecap="round"
                strokeDasharray={`${(c * Math.min(1, ring.frac)).toFixed(2)} ${c.toFixed(2)}`}
              />
            )}
            {ring.notchFrac != null && (
              <circle
                className="chat-cmp-usagering-notch"
                cx="12" cy="12" r={r} strokeWidth={RING_W}
                strokeDasharray={`1 ${c.toFixed(2)}`}
                strokeDashoffset={`${(-c * ring.notchFrac).toFixed(2)}`}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * A chat card's rate-limit ring: the account that chat runs on, its 5-hour window as the outer
 * ring and its weekly window as the inner one, toned by the usage popover's own rule (calm, or
 * caution from CONTEXT_TIGHT_PCT). Reads the SAME query the composer does (`useUsageLimits`,
 * keyed by account), so every card and composer on one account share ONE poll.
 *
 * `accountId === null` (no live session to ask) and a reading `usageLimits` refuses (none,
 * stale, rolled over) both draw the UNKNOWN mark: neutral empty tracks, worded as unknown.
 */
export function AccountLimitRing({ accountId, size = 18 }: { accountId: string | null; size?: number }) {
  const res = useUsageLimits(accountId !== null, accountId ?? '').data ?? null;
  // The reset countdown and the staleness rules read the clock: re-derive every 30 s.
  const tick = Math.floor(Date.now() / 30_000);
  const reading = useMemo(
    () => accountLimitReading(accountId === null ? null : res, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` stands in for the clock
    [accountId, res, tick],
  );
  const known = reading.rings.length > 0;
  const rings: RingSpec[] = (['session', 'weekly'] as const).map((key) => {
    const ring = reading.rings.find((r) => r.key === key);
    return ring ? { band: ring.tight ? 'caution' : 'calm', frac: ring.percent / 100 } : { band: 'none', frac: 0 };
  });
  const top = reading.rings.reduce((m, r) => Math.max(m, r.percent), 0);
  return (
    <span
      className="chat-limitring"
      data-testid="chat-limit-ring"
      data-known={known ? 'true' : 'false'}
      data-tight={reading.rings.some((r) => r.tight) ? 'true' : undefined}
      title={reading.label}
    >
      <ConcentricRings
        rings={rings}
        size={size}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(top) : undefined}
        aria-valuetext={reading.label}
      />
    </span>
  );
}
