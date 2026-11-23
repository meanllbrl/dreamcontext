import { daysUntil } from './dates.js';

export function expiryLabel(expiresOn: string | null, today: string): string {
  if (expiresOn === null) return 'no expiry';
  const d = daysUntil(expiresOn, today);
  if (d === 0) return 'expires today';
  if (d === 1) return 'expires tomorrow';
  if (d > 1) return `expires in ${d} days`;
  if (d === -1) return 'expired yesterday';
  return `expired ${-d} days ago`;
}
