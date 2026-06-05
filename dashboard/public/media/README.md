# Landing page media

Files in `dashboard/public/` are served at the site root, so a file here at
`dashboard/public/media/brain.mp4` is reachable at `/media/brain.mp4`.

The **"What is this?"** page (`dashboard/src/pages/AboutPage.tsx`) looks for the
files below. Every one is **optional** — if a file is missing, the page falls
back gracefully (the hero shows an animated SVG brain instead of the video, and
missing screenshots are hidden). Drop in real assets to light them up.

| File                         | Used as                                   | Suggested size            |
| ---------------------------- | ----------------------------------------- | ------------------------- |
| `brain.webm` / `brain.mp4`   | Hero — looping "our brain" video          | ≤ 1920×1080, a few MB max |
| `brain-hero.png`             | Hero fallback poster (ships by default)   | ~1400px                   |
| `shot-brain.png`             | Gallery — Brain graph screenshot          | ~1600×1000                |
| `shot-tasks.png`             | Gallery — Kanban board screenshot         | ~1600×1000                |
| `shot-sleep.png`             | Gallery — Sleep cycle screenshot          | ~1600×1000                |
| `shot-enabled.png`           | Gallery — "with dreamcontext" (ships)     | ~1160×826                 |
| `shot-disabled.png`          | Gallery — "without dreamcontext" (ships)  | ~1150×870                 |

## Adding the looping brain video

1. Export a short (5–15s) seamless loop. `webm` (VP9) first, `mp4` (H.264) as
   the fallback — the page lists both `<source>`s.
2. Drop them here as `brain.webm` and `brain.mp4`.
3. Keep `brain-hero.png` as the poster (shown before the video loads and if the
   browser can't play it).

No code change needed — the page picks them up on next load.
