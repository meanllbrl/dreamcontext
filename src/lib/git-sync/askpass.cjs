#!/usr/bin/env node
'use strict';

/*
 * GIT_ASKPASS helper for the dreamcontext brain-repo sync engine (decision F).
 *
 * git invokes this as `askpass.cjs "<prompt>"`. It never logs anything and
 * never reads the token from an environment variable or argv — only the PATH
 * to a 0600 tmp file (env DREAMCONTEXT_ASKPASS_TOKEN_FILE) is passed in, and
 * that file is written/unlinked per-invocation by credentials.ts.
 */

const fs = require('node:fs');

const prompt = process.argv[2] || '';

if (/username/i.test(prompt)) {
  process.stdout.write('x-access-token');
  process.exit(0);
}

const tokenFile = process.env.DREAMCONTEXT_ASKPASS_TOKEN_FILE;
if (!tokenFile) {
  process.exit(1);
}

try {
  process.stdout.write(fs.readFileSync(tokenFile, 'utf-8').trim());
} catch {
  process.exit(1);
}
