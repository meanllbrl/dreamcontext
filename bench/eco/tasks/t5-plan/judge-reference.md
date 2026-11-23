What the project's brain already records, which a good plan should respect (it was told to use the brain):
- Storage is ONE readable JSON file on purpose (storage.md: weekly USB copy opened in a text editor; SQLite rejected); the note says to revisit "when a second site needs live sync". A plan that silently switches to a database, or ignores that the format change needs care, misses this.
- Imogen Hart (Thursday shift lead) asks that the JSON format never change without a migration note in the README (volunteers.md); existing files must keep loading.
- Rowan Vale (coordinator) wants every parcel-rule change written up in parcel-rules.md before it ships; the Birch Street fridge is small (dairy cap).
- Theo Marsh prefers small pull requests with tests.
A strong plan: testable acceptance criteria (per-site stock, transfers that cannot create or lose stock, parcels from the home site only, per-site report, migration of the existing single-site file), a wave map with files per wave and what each wave proves, and risks/open questions. It writes no code. It was also asked to run the plan reviewer once and fix what it found.
