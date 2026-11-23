export interface Donation { donor: string; date: string; itemId: string; quantity: number }
export function recordDonation(log: Donation[], d: Donation): Donation[] {
  if (!(d.quantity > 0)) throw new Error('quantity must be positive');
  return [...log, d];
}
export function donationsBetween(log: Donation[], from: string, to: string): Donation[] {
  return log.filter((d) => d.date >= from && d.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.donor.localeCompare(b.donor));
}
