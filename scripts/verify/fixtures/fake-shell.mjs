#!/usr/bin/env node
/**
 * Generate `fake-shell.app`: the smallest stand-in for the dreamcontext desktop shell, with
 * its own bundle id, for the runner's shell-liveness branches (dreamcontext-apps plan r19,
 * W1). It is a stay-open AppleScript applet, so it checks in with LaunchServices like a real
 * app and `NSRunningApplication` sees it. Launched, it starts fake-desktop-server.mjs behind
 * itself (so `open -g -b <id> --args --background` from a runner brings a server up); quit,
 * it stops that server.
 *
 *   node scripts/verify/fixtures/fake-shell.mjs --out <dir> --home <scratch home> \
 *        [--bundle-id com.dreamcontext.fakeshell] [--server-args "--theme dark"]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const out = resolve(opt('out', '.'));
const home = resolve(opt('home', process.env.HOME));
const bundleId = opt('bundle-id', 'com.dreamcontext.fakeshell');
const serverArgs = opt('server-args', '');
const node = process.execPath;
const server = join(here, 'fake-desktop-server.mjs');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const pidFile = join(home, 'fake-shell-server.pid');
const start = `${q(node)} ${q(server)} --home ${q(home)} --app-bundle-id ${q(bundleId)} ${serverArgs} > ${q(join(home, 'fake-shell-server.log'))} 2>&1 & echo $! > ${q(pidFile)}`;
const stop = `[ -f ${q(pidFile)} ] && kill $(cat ${q(pidFile)}) 2>/dev/null; rm -f ${q(pidFile)}`;
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const script = `on run
  do shell script "${esc(start)}"
end run
on idle
  return 30
end idle
on quit
  do shell script "${esc(stop)}"
  continue quit
end quit
`;
mkdirSync(out, { recursive: true });
mkdirSync(home, { recursive: true });
const app = join(out, 'fake-shell.app');
rmSync(app, { recursive: true, force: true });
const src = join(out, '.fake-shell.applescript');
writeFileSync(src, script);
execFileSync('osacompile', ['-s', '-o', app, src]);
rmSync(src, { force: true });
const plist = join(app, 'Contents', 'Info.plist');
const plistSet = (key, type, value) => {
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' }); }
  catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]); }
};
plistSet('CFBundleIdentifier', 'string', bundleId);
plistSet('CFBundleName', 'string', 'fake-shell');
try { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', plist]); } catch { /* already there */ }
execFileSync('codesign', ['--force', '--deep', '-s', '-', app]);
execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app]);
console.log(JSON.stringify({ app, bundleId, home }));
