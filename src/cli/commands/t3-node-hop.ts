import { spawn } from 'node:child_process';
import { findBridgeNode, meetsBridgeFloor, parseNodeVersion } from '../../lib/t3-bridge/node-floor.js';

/**
 * The bridge bundle (Codex, Antigravity) needs Node 22.16+: the vendored T3 layer imports
 * `node:sqlite` at load, which Node 20 does not have. The CLI itself runs on Node 18+, so a
 * global `dreamcontext` on an older default Node (nvm) must still run `t3-run`, `t3-chat` and
 * `t3-account`: the same command is run again on a good Node found beside it, the default left
 * as it is. No good Node anywhere: the caller says so in plain words, never a load crash.
 *
 * `here` = this Node can load the bridge; `none` = no Node can; a number = the exit code of the
 * same command run on a good Node.
 */
export type BridgeHop = 'here' | 'none' | number;

/** Set on the re-run, so a re-run never looks for another Node again. */
const HOP_ENV = 'DREAMCONTEXT_BRIDGE_HOP';

export interface HopDeps {
  readonly version?: string;
  readonly execPath?: string;
  readonly execArgv?: readonly string[];
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly find?: () => string | null;
  readonly spawn?: typeof spawn;
}

export function runOnBridgeNode(d: HopDeps = {}): Promise<BridgeHop> {
  const running = parseNodeVersion(d.version ?? process.version);
  if (running && meetsBridgeFloor(running)) return Promise.resolve('here');
  const env = d.env ?? process.env;
  if (env[HOP_ENV] === '1') return Promise.resolve('none');
  const execPath = d.execPath ?? process.execPath;
  const node = (d.find ?? (() => findBridgeNode()))();
  if (!node || node === execPath) return Promise.resolve('none');
  const args = [...(d.execArgv ?? process.execArgv), ...(d.argv ?? process.argv).slice(1)];
  return new Promise((resolve) => {
    const child = (d.spawn ?? spawn)(node, args, { stdio: 'inherit', env: { ...env, [HOP_ENV]: '1' } });
    const forward = (sig: NodeJS.Signals): void => { child.kill(sig); };
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of signals) process.on(s, forward);
    const done = (r: BridgeHop): void => {
      for (const s of signals) process.off(s, forward);
      resolve(r);
    };
    child.once('error', () => done('none'));
    child.once('exit', (code) => done(code ?? 1));
  });
}
