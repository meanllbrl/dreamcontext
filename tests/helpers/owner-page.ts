/**
 * The headers the app's own page sends on a write: its Origin, matching the Host it dialed.
 * Every route that writes an approval answers only these (`src/server/owner-page.ts`); a test
 * that drives one as the owner sends them, a test of the refusal leaves them out.
 */
export const OWNER_PAGE_HEADERS: Readonly<Record<string, string>> = {
  host: '127.0.0.1:4173',
  origin: 'http://127.0.0.1:4173',
};
