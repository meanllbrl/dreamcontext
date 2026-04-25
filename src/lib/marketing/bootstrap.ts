import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { MARKETING_PATHS, marketingRoot } from './paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Locate the dreamcontext-bundled tools/reinfluence/ source. Looks two layers
 * up from the compiled module (dist/index.js -> ../tools/reinfluence) and
 * falls back to the dev-tree tools/reinfluence/. Throws if neither exists.
 */
export function findBundledReinfluence(): string {
  const candidates = [
    // Installed npm package: dist/<chunk>.js -> ../tools/reinfluence
    resolve(__dirname, '..', 'tools', 'reinfluence'),
    resolve(__dirname, '..', '..', 'tools', 'reinfluence'),
    // Dev tree: src/lib/marketing -> ../../../tools/reinfluence
    resolve(__dirname, '..', '..', '..', 'tools', 'reinfluence'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, '__main__.py'))) return c;
  }
  throw new Error(
    'Bundled reinfluence not found. Reinstall dreamcontext or set REINFLUENCE_BIN.',
  );
}

function runBlocking(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}):
  { code: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function findPython3(): string | null {
  for (const cmd of ['python3', 'python']) {
    const r = runBlocking(cmd, ['--version']);
    if (r.code === 0) return cmd;
  }
  return null;
}

export interface BootstrapOptions {
  /** Whisper model to pre-pull. Set to null to skip. */
  whisperModel?: string | null;
  /** Print progress lines to stderr. */
  verbose?: boolean;
}

export interface BootstrapResult {
  toolsDir: string;
  venvDir: string;
  pythonBin: string;
  whisperPrimed: boolean;
}

export async function bootstrapMarketing(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const { whisperModel = 'medium', verbose = true } = opts;
  const log = (msg: string): void => { if (verbose) process.stderr.write(`[mk init] ${msg}\n`); };

  // 1. Ensure marketing root exists
  mkdirSync(marketingRoot(), { recursive: true });

  // 2. Copy bundled reinfluence → .tools/reinfluence/ (idempotent)
  const bundled = findBundledReinfluence();
  const target = MARKETING_PATHS.reinfluenceDir();
  log(`copying tools → ${target}`);
  mkdirSync(MARKETING_PATHS.toolsDir(), { recursive: true });
  cpSync(bundled, target, { recursive: true });

  // 3. Locate python3
  const py = findPython3();
  if (!py) {
    throw new Error('python3 not found on PATH. Install Python 3.10+ and retry.');
  }

  // 4. Create venv
  const venv = MARKETING_PATHS.venvDir();
  if (!existsSync(MARKETING_PATHS.venvPython())) {
    log(`creating venv → ${venv}`);
    const r = runBlocking(py, ['-m', 'venv', venv]);
    if (r.code !== 0) {
      throw new Error(`venv creation failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  } else {
    log('venv already exists');
  }

  const venvPy = MARKETING_PATHS.venvPython();

  // 5. Upgrade pip + install requirements
  log('upgrading pip');
  let r = runBlocking(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet']);
  if (r.code !== 0) log(`pip upgrade warning: ${r.stderr.trim().slice(0, 200)}`);

  const reqs = join(target, 'requirements.txt');
  log('installing python deps (whisper / yt-dlp / instaloader) — first run can take several minutes');
  r = runBlocking(venvPy, ['-m', 'pip', 'install', '-r', reqs, '--quiet']);
  if (r.code !== 0) {
    throw new Error(`pip install failed:\n${r.stderr.trim() || r.stdout.trim()}`);
  }

  // 6. Pre-pull Whisper model into in-project cache (optional)
  let whisperPrimed = false;
  if (whisperModel) {
    log(`pre-pulling whisper model "${whisperModel}" into ${MARKETING_PATHS.whisperCacheDir()}`);
    mkdirSync(MARKETING_PATHS.whisperCacheDir(), { recursive: true });
    whisperPrimed = await primeWhisper(whisperModel);
    if (!whisperPrimed) log('whisper pre-pull failed (will retry on first ingest)');
  }

  return {
    toolsDir: target,
    venvDir: venv,
    pythonBin: venvPy,
    whisperPrimed,
  };
}

function primeWhisper(model: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const env = subprocessEnv();
    const proc = spawn(MARKETING_PATHS.venvPython(), [
      '-c',
      `import whisper; whisper.load_model(${JSON.stringify(model)})`,
    ], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      if (code !== 0 && stderr) {
        process.stderr.write(`[mk init] whisper prime stderr: ${stderr.slice(0, 400)}\n`);
      }
      resolveP(code === 0);
    });
    proc.on('error', () => resolveP(false));
  });
}

/** Env vars to pin all caches inside _dream_context/marketing/.cache/. */
export function subprocessEnv(): NodeJS.ProcessEnv {
  const cache = MARKETING_PATHS.cacheDir();
  return {
    ...process.env,
    XDG_CACHE_HOME: cache,
    HF_HOME: join(cache, 'hf'),
    TRANSFORMERS_CACHE: join(cache, 'hf', 'transformers'),
    WHISPER_CACHE_DIR: MARKETING_PATHS.whisperCacheDir(),
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: MARKETING_PATHS.toolsDir(),
  };
}

export function isBootstrapped(): boolean {
  return existsSync(MARKETING_PATHS.venvPython())
    && existsSync(join(MARKETING_PATHS.reinfluenceDir(), '__main__.py'));
}
