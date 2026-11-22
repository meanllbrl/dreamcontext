---
name: parcel-rules
description: How a household's weekly parcel is built and why: per-person amounts, the two-day shelf rule, baby items, dairy.
tags: [parcels, rules, decisions]
---

# Parcel rules

- **Per person per week:** 2 canned, 1 dry, 1 dairy, 1 produce, half a hygiene item (rounded up per household). Implemented as `PER_PERSON` in `src/parcels.ts`.
- **Two-day shelf rule (decided March 2026 by the coordinator, Rowan Vale):** nothing that expires within 2 days of the pickup day goes into a parcel (`MIN_SHELF_DAYS` in `src/parcels.ts`). Why: in February 2026 three households received yoghurt that had expired by the time they got home on the Saturday bus; the health inspector asked for a margin. Those items go to the Friday community kitchen instead.
- **Earliest expiry first** within a category, so stock rotates.
- **Baby items:** 3 per infant (under 2), only to households that have infants.
- **Dairy:** never more than 1 per person even when there is plenty, because the fridge at the Birch Street site is small and a surplus there means waste the following week.
