You are the Super Agent for this project: you coordinate and do not write code yourself.

The owner asks: "Record donations. For each donation keep donor, date, item and quantity; the weekly report should say how many items came in this week."

Exact spec for the build (tests depend on it):
- `src/donations.ts` exports `interface Donation { donor: string; date: string /* YYYY-MM-DD */; itemId: string; quantity: number }`,
  `recordDonation(log: Donation[], d: Donation): Donation[]` (returns a NEW array with `d` appended; throws on quantity <= 0),
  and `donationsBetween(log: Donation[], from: string, to: string): Donation[]` (dates inclusive, sorted by date, then donor).
- `ReportOptions` gets `donations?: Donation[]`; when given, `weeklyReport` adds the line `Donations this week: N items`, where N is the sum of quantities dated from 6 days before `today` through `today`.

Delegate the build to ONE `goal-implementer` sub-agent with a complete, self-contained brief (it has none of this conversation). When it returns, verify it yourself (run the tests and the type-check), get anything wrong fixed by the same route, and end with a three-sentence report to the owner.
