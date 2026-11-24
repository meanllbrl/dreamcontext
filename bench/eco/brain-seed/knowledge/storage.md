---
name: storage
description: Why the pantry stores its data as one JSON file and not a database; the atomic write.
tags: [storage, decisions]
---

# Storage

- One JSON file (`pantry.json`), loaded and saved by `src/store.ts`.
- **Decision (January 2026): no database, SQLite rejected.** The laptop at the front desk is a donated machine whose owner group (the Thursday volunteers) wants to copy the data onto a USB stick every week and open it in a text editor when something looks wrong. A single readable file serves that; SQLite would need a viewer nobody wants to install.
- **Atomic write:** save writes `pantry.json.tmp` and renames it, after a power cut in December 2025 left a half-written file and the morning shift could not open the inventory.
- Revisit when the data passes ~5,000 items or a second site needs live sync.
