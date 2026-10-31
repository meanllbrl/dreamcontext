#!/usr/bin/env node
/** The tail of super-unread.mjs alone: take-back kills the read record, and the console stays clean. */
process.env.ONLY = 'takeback';
await import('./super-unread.mjs');
