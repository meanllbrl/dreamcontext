// Moved to src/lib/change-tracker.ts so the sync engine can journal
// remote-originated changes too. This shim keeps existing imports working.
export * from '../lib/change-tracker.js';
