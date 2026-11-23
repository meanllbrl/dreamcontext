import { expect, it } from 'vitest';
import { recordDonation, donationsBetween } from '../src/donations.js';
import { Inventory } from '../src/inventory.js';
import { weeklyReport } from '../src/report.js';
const d = (donor: string, date: string, quantity = 1) => ({ donor, date, itemId: 'b', quantity });
it('h6 recordDonation is immutable and validates', () => {
  const a: ReturnType<typeof d>[] = [];
  const b = recordDonation(a, d('Ivy', '2026-05-01'));
  expect(a).toHaveLength(0); expect(b).toHaveLength(1);
  expect(() => recordDonation(b, d('Ivy', '2026-05-01', 0))).toThrow();
});
it('h6 donationsBetween inclusive, sorted by date then donor', () => {
  const log = [d('Zed', '2026-05-03'), d('Amy', '2026-05-03'), d('Bob', '2026-04-30'), d('Cal', '2026-05-05')];
  expect(donationsBetween(log, '2026-04-30', '2026-05-03').map((x) => x.donor)).toEqual(['Bob', 'Amy', 'Zed']);
});
it('h6 report sums the 7 days ending today', () => {
  const log = [d('A', '2026-04-28', 5), d('B', '2026-04-27', 7), d('C', '2026-05-04', 2), d('D', '2026-05-05', 9)];
  expect(weeklyReport(new Inventory([]), { today: '2026-05-04', donations: log })).toContain('Donations this week: 7 items');
  expect(weeklyReport(new Inventory([]), { today: '2026-05-04' })).not.toContain('Donations');
});
