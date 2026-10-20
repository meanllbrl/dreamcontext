import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE OPENING SCREEN'S CLIP IS STARTED BY THE SHELL, AND EVERY LINK OF THAT CHAIN IS WIRED.
 *
 * In macOS Low Power Mode WebKit refuses a <video> play() that no user gesture started,
 * muted or not. The splash page used to call `clip.play()` itself; both attempts were
 * refused and the owner saw only the final still, without sound. A script the shell runs
 * through `evaluateJavaScript` (wry's `eval`) counts as a gesture, so the page asks the shell
 * (`splash_play`) and the shell evaluates `window.__dcSplashPlay()`.
 *
 * That chain has four links and each fails SILENTLY when missing: a command not in
 * `generate_handler!` rejects, a command with no permission or a capability that does not
 * grant it is ACL-denied, and a page that calls play() on its own simply works everywhere
 * except Low Power Mode. The page then falls back to the still, which looks like a choice.
 * So this pins the links by reading the files the app is built from.
 */

const TAURI = join(__dirname, '../../desktop/src-tauri');
const read = (rel: string) => readFileSync(join(TAURI, rel), 'utf-8');

/** The body of the first `{ ... }` block opening at or after `from`. */
function blockAt(src: string, from: number): { start: number; end: number } {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { start: open, end: i };
  }
  throw new Error('unbalanced braces');
}

describe('desktop splash: the shell starts the clip', () => {
  it('registers splash_play in lib.rs generate_handler!', () => {
    const lib = read('src/lib.rs');
    const m = lib.match(/generate_handler!\[([\s\S]*?)\]/);
    expect(m, 'generate_handler! not found').toBeTruthy();
    const commands = m![1].split(',').map((s) => s.trim()).filter(Boolean);
    expect(commands).toContain('splash::splash_done');
    expect(commands).toContain('splash::splash_play');
  });

  it('splash.rs: splash_play is a command that evaluates __dcSplashPlay, for the splash window only', () => {
    const rs = read('src/splash.rs');
    const at = rs.indexOf('pub(crate) fn splash_play');
    expect(at, 'splash_play not defined').toBeGreaterThan(-1);
    expect(rs.slice(0, at).trimEnd().endsWith('#[tauri::command]')).toBe(true);
    const { start, end } = blockAt(rs, at);
    const body = rs.slice(start, end);
    expect(body).toMatch(/window\.label\(\)\s*!=\s*LABEL/);
    expect(body).toContain('.eval("window.__dcSplashPlay && window.__dcSplashPlay()")');
  });

  it('the permission file allows exactly splash_done and splash_play under their identifiers', () => {
    const toml = read('permissions/splash-done.toml');
    const perms = toml.split('[[permission]]').slice(1).map((block) => ({
      id: block.match(/identifier\s*=\s*"([^"]+)"/)?.[1],
      allow: block.match(/commands\.allow\s*=\s*\[([^\]]*)\]/)?.[1].match(/"[^"]+"/g)?.map((s) => s.slice(1, -1)),
      description: block.match(/description\s*=\s*"([^"]+)"/)?.[1],
    }));
    expect(perms.map((p) => [p.id, p.allow])).toEqual([
      ['allow-splash-done', ['splash_done']],
      ['allow-splash-play', ['splash_play']],
    ]);
    for (const p of perms) expect(p.description, `${p.id} has no description`).toBeTruthy();
  });

  it('the splash capability grants exactly the two permissions, to window `splash` only', () => {
    const cap = JSON.parse(read('capabilities/splash.json'));
    expect(cap.windows).toEqual(['splash']);
    expect([...cap.permissions].sort()).toEqual(['allow-splash-done', 'allow-splash-play']);
    expect(cap.remote).toBeUndefined();
  });

  describe('splash.html', () => {
    const html = read('frontend-placeholder/splash.html');
    const at = html.indexOf('window.__dcSplashPlay = function');
    const fn = at > -1 ? blockAt(html, at) : { start: -1, end: -1 };
    const fnBody = html.slice(fn.start, fn.end);

    it('defines window.__dcSplashPlay', () => {
      expect(at).toBeGreaterThan(-1);
    });

    it('never calls clip.play() outside __dcSplashPlay', () => {
      const calls = [...html.matchAll(/\.play\(/g)].map((m) => m.index!);
      expect(calls.length).toBeGreaterThan(0);
      for (const i of calls) {
        expect(i > fn.start && i < fn.end, `play() at offset ${i} is outside __dcSplashPlay`).toBe(true);
      }
      // No autoplay attribute either: that would start it without the shell too.
      expect(html).not.toMatch(/<video[^>]*\bautoplay\b/);
    });

    it('plays at most once, unmuted at half volume first', () => {
      expect(fnBody).toMatch(/if \(asked[^)]*\) return;\s*asked = true;/);
      expect(fnBody).toContain('clip.muted = false;');
      expect(fnBody).toContain('clip.volume = 0.5;');
    });

    it('keeps the fallback ladder: refused sound retries muted, refused muted shows the still', () => {
      expect(fnBody).toContain('clip.muted = true;');
      expect(fnBody).toMatch(/clip\.play\(\)\.catch\(silent\)/);
      expect(fnBody).toMatch(/clip\.play\(\)\.catch\(still\)/);
    });

    it('asks the shell with splash_play once the clip can play, and plays directly if it cannot ask', () => {
      expect(html).toContain("invoke('splash_play')");
      expect(html).toMatch(/addEventListener\('canplay', askShell/);
      const ask = html.slice(...Object.values(blockAt(html, html.indexOf('function askShell'))));
      // No shell -> play here; a rejected or throwing invoke -> play here.
      expect(ask).toMatch(/if \(!tauri[^)]*\) return window\.__dcSplashPlay\(\);/);
      expect(ask).toMatch(/function \(\) \{ window\.__dcSplashPlay\(\); \}\);/);
      expect(ask).toMatch(/catch \(e\) \{\s*window\.__dcSplashPlay\(\);/);
    });

    it('reduced motion shows the still; a clip that never starts gives way to it', () => {
      expect(html).toMatch(/prefers-reduced-motion: reduce\)'\)\.matches\) \{\s*still\(\);/);
      expect(html).toMatch(/if \(!started\) still\(\);/);
      // The only remaining timer that reports done counts from when the clip started playing.
      expect(html).toMatch(/addEventListener\('playing'[\s\S]*?setTimeout\(finished/);
      expect(html).not.toMatch(/setTimeout\(function \(\) \{ done\(\);/);
    });
  });
});
