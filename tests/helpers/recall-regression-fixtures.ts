/**
 * Synthetic turns for the standing recall regression set (tests/unit|integration/recall-regression-scenarios).
 * A fictional "Northwind" invoicing project: no real owner words, no real project. Each framed turn is built
 * exactly as the surfaces write it (src/lib/super/types.ts ABOUT_AGENDA_RE, ABOUT_CARD_RE, ABOUT_TASK_RE,
 * REPLY_TO_RE): the SUBJECT lives only in the frame, the owner's own words never name it.
 */
export const FRAMED = {
  agenda: '[About agenda line note=n101 section=waiting]\nline: "Northwind invoice export: monthly CSV columns for the ledger (screens ready)"\n\nis this tested, can we move on to the video?',
  reply: '[Reply to message ref=k3f9q0 from=super]\nquote: "The Northwind invoice export now writes one ledger CSV per month"\n\nok ship it',
  card: '[About card @card:c7]\nquote: "Northwind invoice export: ledger CSV columns"\n\nwhat is left here?',
  task: '[About task northwind-invoice-export-ledger-csv]\n\nwhere are we on this?',
} as const;

/** The subject word each frame carries and the owner's own words never do. */
export const SUBJECT = /invoice|ledger/i;

/** The knowledge file a framed turn must reach. */
export const SUBJECT_DOC = {
  rel: 'knowledge/northwind-invoice-export.md',
  body: '---\nname: northwind-invoice-export\ndescription: how the Northwind invoice export writes the monthly ledger CSV\ntags: [invoice, ledger, csv]\n---\nThe Northwind invoice export writes one ledger CSV per month with fixed invoice columns.\n',
};

/** A number-only owner turn (a phone number and a short ask), and the skill that covers it. */
export const NUMBER_TURN = '+1 555 0142 kontrol eder misin';
export const CONTACT_SKILL = {
  name: 'contact-inbox',
  md: '---\nname: contact-inbox\ndescription: Look up a contact\'s message history by phone number. Use when a message is only a phone number (+1 555 0142) with a short ask to check it, look it up or inform them (kontrol eder misin, bakar misin).\n---\nResolve the number to the contact first, then read every thread of that contact.\n',
};

/** A skill that strongly matches a later turn of a long session. */
export const VIDEO_SKILL = {
  name: 'promo-reel',
  md: '---\nname: promo-reel\ndescription: Make a product promo video reel for a feature (script, voice-over, screen capture, captions, render).\n---\nEvery product video goes through this reel pipeline.\n',
};
export const VIDEO_TURN = 'make the promo video reel for the feature with voice-over and captions';

/** Unrelated skills, so the catalogue has the size a real install has (BM25 over one doc scores nothing). */
export const FILLER_SKILLS = [
  { name: 'db-migrate', md: '---\nname: db-migrate\ndescription: Write and run a database schema migration with a rollback step.\n---\nMigrations run in order.\n' },
  { name: 'release-notes', md: '---\nname: release-notes\ndescription: Draft the release notes of a version from the merged pull requests.\n---\nOne line per change.\n' },
  { name: 'design-review', md: '---\nname: design-review\ndescription: Review a screen against the design system (spacing, contrast, states).\n---\nMeasure the rendered screen.\n' },
  { name: 'test-runner', md: '---\nname: test-runner\ndescription: Run the unit and integration tests and report the failures.\n---\nRed first, then fix.\n' },
  { name: 'pdf-export', md: '---\nname: pdf-export\ndescription: Turn a markdown report into a printable PDF with a cover page.\n---\nA4 by default.\n' },
];
