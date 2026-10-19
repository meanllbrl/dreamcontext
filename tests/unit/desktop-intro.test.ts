import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEM_PATHS } from '../../dashboard/src/components/brand/gemPieces.js';

/**
 * THE ONE-TIME INTRO PLAYS ONCE PER MAC, WAITS FOR ITS CLICK, AND HANDS OVER TO THE CLIP.
 *
 * Until the `intro-played` marker exists in the app's data folder, the opening screen opens on
 * intro.html: the mark upside down, a button that sets it right through a ramp ride, then the
 * clip played on from the intro's last frame. Three things fail silently if a link is missing:
 * - a command not registered or not granted is refused, and the page cannot tell: without
 *   `intro_hold` the 8s splash deadline cuts the intro while the person reads the button, and
 *   without `intro_seen` the intro plays on every launch;
 * - a deadline that is not re-armed by generation lets the FIRST 8s timer fire mid-ride;
 * - a page whose gem drifts from the mark, or whose hand-over frame is not the clip's, shows a
 *   jump at the one moment meant to look like a single shot.
 * So this pins the links by reading the files the app is built from.
 */

const REPO = join(__dirname, '..', '..');
const TAURI = join(REPO, 'desktop/src-tauri');
const read = (rel: string) => readFileSync(join(TAURI, rel), 'utf-8');

/** The body of the first `{ ... }` block opening at or after `from`. */
function blockAt(src: string, from: number): string {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i);
  }
  throw new Error('unbalanced braces');
}

const RS = read('src/splash.rs');
const fnBody = (name: string) => {
  const at = RS.indexOf(`fn ${name}(`);
  expect(at, `${name} not defined`).toBeGreaterThan(-1);
  return blockAt(RS, at);
};

describe('desktop intro: the shell side', () => {
  it('registers intro_hold and intro_seen in lib.rs generate_handler!', () => {
    const m = read('src/lib.rs').match(/generate_handler!\[([\s\S]*?)\]/);
    const commands = m![1].split(',').map((s) => s.trim()).filter(Boolean);
    expect(commands).toContain('splash::intro_hold');
    expect(commands).toContain('splash::intro_seen');
  });

  it('both are commands that only the splash window may use', () => {
    for (const name of ['intro_hold', 'intro_seen']) {
      const at = RS.indexOf(`pub(crate) fn ${name}`);
      expect(RS.slice(0, at).trimEnd().endsWith('#[tauri::command]'), `${name} is not a command`).toBe(true);
      expect(fnBody(name)).toMatch(/if window\.label\(\) != LABEL \{\s*return;\s*\}/);
    }
  });

  it('opens intro.html, on the larger stage, only while the marker is missing', () => {
    const open = fnBody('open');
    expect(open).toMatch(/let intro = intro_due\(app\);/);
    expect(open).toMatch(/if intro \{ \("intro\.html", INTRO_SIZE\) \} else \{ \("splash\.html", SPLASH_SIZE\) \}/);
    expect(open).toContain('arm_deadline(app, SPLASH_DEADLINE);');
    expect(RS).toMatch(/const INTRO_MARKER: &str = "intro-played";/);
    // Missing means due; anything there (a link too) means played; no folder means no intro.
    const due = fnBody('intro_due');
    expect(due).toMatch(/symlink_metadata\(\), Err\(e\) if e\.kind\(\) == ErrorKind::NotFound/);
    expect(due).toMatch(/None => false/);
  });

  it('every deadline is generation-checked, so a re-arm spends the older timers', () => {
    const arm = fnBody('arm_deadline_unless');
    expect(arm).toMatch(/k\.deadline_arm = k\.deadline_arm\.wrapping_add\(1\);/);
    expect(arm).toMatch(/if k\.deadline_arm == arm \{\s*k\.splash_done = true;/);
    // No other path turns the first key on a timer.
    expect(RS.match(/thread::sleep\(SPLASH_DEADLINE\)/g) ?? []).toEqual([]);
  });

  it('intro_hold steps the deadline back to INTRO_WAIT, unless the click already came', () => {
    const hold = fnBody('intro_hold');
    expect(hold).toContain('arm_deadline_unless(window.app_handle(), INTRO_WAIT, |k| k.intro_clicked);');
    // The skip is decided under the lock that bumps the arm, not before it.
    const unless = fnBody('arm_deadline_unless');
    expect(unless).toMatch(/let Ok\(mut k\) = gate\.0\.lock\(\) else \{ return \};\s*if skip\(&k\) \{\s*return;\s*\}\s*k\.deadline_arm = k\.deadline_arm\.wrapping_add\(1\);/);
  });

  it('intro_seen records the click, writes the marker and re-arms for the ride and the clip', () => {
    const seen = fnBody('intro_seen');
    expect(seen).toContain('k.intro_clicked = true;');
    expect(seen).toContain('write_marker(&marker)');
    expect(seen.trimEnd().endsWith('arm_deadline(app, INTRO_TAIL);')).toBe(true);
    // create_new: a link planted at the marker path is never written through.
    expect(fnBody('write_marker')).toContain('.create_new(true)');
  });

  it('the permission file allows exactly intro_hold and intro_seen, each described', () => {
    const toml = read('permissions/intro.toml');
    const perms = toml.split('[[permission]]').slice(1).map((block) => ({
      id: block.match(/identifier\s*=\s*"([^"]+)"/)?.[1],
      allow: block.match(/commands\.allow\s*=\s*\[([^\]]*)\]/)?.[1].match(/"[^"]+"/g)?.map((s) => s.slice(1, -1)),
      description: block.match(/description\s*=\s*"([^"]+)"/)?.[1],
    }));
    expect(perms.map((p) => [p.id, p.allow])).toEqual([
      ['allow-intro-hold', ['intro_hold']],
      ['allow-intro-seen', ['intro_seen']],
    ]);
    for (const p of perms) expect(p.description, `${p.id} has no description`).toBeTruthy();
  });

  it('only the splash capability grants them', () => {
    const dir = join(TAURI, 'capabilities');
    for (const file of ['default.json', 'checklist.json', 'viewer.json', 'assistant.json', 'node-setup.json']) {
      const cap = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      const perms = (cap.permissions as unknown[]).map((p) => (typeof p === 'string' ? p : (p as { identifier: string }).identifier));
      expect(perms.filter((p) => p.startsWith('allow-intro-')), file).toEqual([]);
    }
  });
});

describe('desktop intro: intro.html', () => {
  const PAGE = read('frontend-placeholder/intro.html');
  const SCRIPT = PAGE.slice(PAGE.indexOf('<script>'), PAGE.indexOf('</script>'));
  const NODE_SETUP = read('frontend-placeholder/node-setup.html');

  it('draws the gem from the same paths gemPieces.ts carries', () => {
    for (const d of Object.values(GEM_PATHS)) expect(PAGE).toContain(`d="${d}"`);
  });

  it('carries the same gem colours as node-setup.html (itself checked against GEM_COLORS)', () => {
    const block = (html: string) => {
      const at = html.indexOf('tokens: gem colours mirrored from');
      expect(at).toBeGreaterThan(-1);
      return blockAt(html, at).replace(/\s+/g, ' ');
    };
    expect(block(PAGE)).toBe(block(NODE_SETUP));
  });

  it('calls exactly intro_hold and intro_seen, and never splash_done (the clip page reports that)', () => {
    const calls = new Set([...SCRIPT.matchAll(/invoke\('([a-z_]+)'\)/g)].map((m) => m[1]));
    expect([...calls].sort()).toEqual(['intro_hold', 'intro_seen']);
    expect(SCRIPT).not.toContain('splash_done');
  });

  it('records the intro on the click and on Skip, before anything else can go wrong', () => {
    const go = blockAt(SCRIPT, SCRIPT.indexOf('function go()'));
    expect(go).toMatch(/started = true;\s*invoke\('intro_seen'\);/);
    const skip = blockAt(SCRIPT, SCRIPT.indexOf("skip.addEventListener('click'"));
    expect(skip).toMatch(/started = true;\s*invoke\('intro_seen'\);\s*leave\(false\);/);
  });

  it('hands over to the clip from its frame after the ride, and to the plain clip after Skip', () => {
    expect(SCRIPT).toContain("location.replace(after ? 'splash.html?after=intro' : 'splash.html');");
    expect(SCRIPT).toMatch(/if \(t >= T_LEAVE\) return leave\(true\);/);
    expect(SCRIPT).toMatch(/handoff\.src = 'intro-handoff-light\.jpg';/);
    for (const f of ['intro-handoff.jpg', 'intro-handoff-light.jpg']) {
      expect(existsSync(join(TAURI, 'frontend-placeholder', f)), `${f} is missing`).toBe(true);
    }
  });

  it('frames the mark where the clip shows it at the hand-over (406 x 343 px at 721, 404.5 in 1440 x 810)', () => {
    const fit = blockAt(SCRIPT, SCRIPT.indexOf('function fitEndCamera'));
    expect(fit).toContain('var S = 1600 / 1440;');
    expect(fit).toContain('var z = (406 * S) / w;');
    expect(fit).toContain('((721 * S) - 800) / z');
    expect(fit).toContain('((404.5 * S) - 450) / z');
  });

  it('defines the exit hook the shell calls when its long wait runs out', () => {
    expect(SCRIPT).toMatch(/window\.__dcSplashExit = function/);
  });

  it('rides nothing under reduced motion', () => {
    const go = blockAt(SCRIPT, SCRIPT.indexOf('function go()'));
    expect(go).toMatch(/if \(reduced\) \{[\s\S]*?leave\(false\);[\s\S]*?return;/);
    expect(SCRIPT).toMatch(/if \(!reduced\) \{ idleStart = performance\.now\(\); idleRaf = requestAnimationFrame\(idle\); \}/);
  });

  it('builds its markup without innerHTML and has no em dash in its copy', () => {
    expect(PAGE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(PAGE.slice(PAGE.indexOf('<body>'))).not.toMatch(/—|&mdash;|\\u2014/);
  });

  it('plays no media and loads nothing remote', () => {
    expect(SCRIPT).not.toMatch(/\.play\(/);
    // The SVG namespace is a name, not a load.
    expect(PAGE.replaceAll('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//);
    expect(SCRIPT).not.toMatch(/\bfetch\(/);
  });
});

describe('desktop intro: splash.html continues from the intro', () => {
  const HTML = read('frontend-placeholder/splash.html');
  const PLAY = blockAt(HTML, HTML.indexOf('window.__dcSplashPlay = function'));
  const READY = blockAt(HTML, HTML.indexOf('function ready()'));

  it('recognises ?after=intro and moves the clip to the hand-over frame before asking to play', () => {
    expect(HTML).toContain('var INTRO_FRAME = 1.35;');
    expect(HTML).toMatch(/var fromIntro = \/\[\?&\]after=intro\\b\/\.test\(location\.search\);/);
    // Seeked first, asked after: played first, WebKit shows the clip's opening during the seek.
    expect(READY).toMatch(/clip\.addEventListener\('seeked', askShell, \{ once: true \}\);\s*try \{ clip\.currentTime = startAt; \}/);
    expect(HTML).toMatch(/addEventListener\('canplay', ready, \{ once: true \}\)/);
    // Nothing touches the volume after play(): raising it without a gesture makes WebKit pause.
    expect(PLAY).not.toContain('currentTime');
    expect(PLAY.match(/clip\.volume =/g)).toEqual(['clip.volume =']);
  });

  it('shows the intro frame at once and keeps it until the clip plays', () => {
    expect(HTML).toMatch(/\.from-intro \.card:not\(\.out\) \{ opacity: 1; transition: none; \}/);
    expect(HTML).toMatch(/getElementById\('bridge'\)\.src = 'intro-handoff' \+ suffix \+ '\.jpg';/);
    expect(HTML).toMatch(/addEventListener\('playing'[\s\S]*?if \(fromIntro\) setTimeout\(function \(\) \{ card\.classList\.remove\('bridged'\); \}/);
  });
});
