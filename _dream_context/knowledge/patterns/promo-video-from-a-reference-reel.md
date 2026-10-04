---
name: patterns/promo-video-from-a-reference-reel
description: >-
  When the owner sends a reel and says "make a dreamcontext promo in this style": take the
  reference's STRUCTURE (never its pixels), re-capture the CURRENT app from the fictional demo
  vault, and cut text scenes against captionless product scenes shown big from inside a screen.
  Gate every capture for privacy and truth, keep the lockup crisp and measured, prove sync, sound
  and alignment by measurement, and deliver an SFX cut plus an optional music cut. Fires on: promo
  video, tanıtım videosu, reel, bu tarzda video, demo video, intro video, Remotion, light mode video.
triggers:
  - tanıtım videosu
  - tanitim videosu
  - promo video
  - reel
  - bu tarzda
  - intro video
  - demo video
  - remotion
tags:
  - 'kind:pattern'
  - 'domain:design'
  - 'topic:branding'
  - 'topic:announcements'
pinned: false
date: '2026-10-04'
---

# Promo video from a reference reel (tanıtım videosu)

## Why this exists

The owner has asked for the same thing three times: OsReel (2026-09-29/30), LightReel
(2026-10-03) and IntroV4 (2026-10-04). Each time it was "watch this reel, make a dreamcontext promo
in this style". Each time the pipeline was rebuilt from zero and the same failures came back. v3
was rejected outright ("Yapılmış diğer videoları beğenmedim, yapabileceğin en iyisi yap, ekran
görüntülerini de güncel al"). v4 landed only after three more owner corrections: the lockup
proportion, the logo quality and the alignment. Every rule below was paid for by one of those
rejections. The step-by-step production line (VO, Remotion, SFX, QA, archive) lives in the local
`dreamcontext-reel` skill. This pattern is the decision layer that must not be re-learned.

## The rule

1. **Take the reference's structure, never its pixels.** Download it into `/tmp` (`yt-dlp`), read
   it as 4 fps contact sheets, and take word timestamps (`whisper-cli`). Write down five things:
   the scene order, the text model (how many words are on screen, how they enter and leave), the
   product-scene model (captioned or not, device, zoom), the sound (is there a music bed?) and the
   close. Use nothing from it on screen, and delete the scratch afterwards.
2. **Summarise first, then produce.** Tell the owner in a few lines what you took from the reel and
   what the plan is, then build. "Özetle, sonra üret" means do not wait for approval.
3. **Text scenes and product scenes alternate. A product scene carries NO caption.** v3 put a
   caption over a small whole window in every product shot: unreadable, and it reads as a
   slideshow. Show the product big, from inside a screen the camera dives into. The VO carries the
   meaning.
4. **Re-capture the CURRENT app every time.** Build the fictional `orbit` demo vault in a fake HOME.
   Run its server from a COPY of `dist`, because another session may rebuild the checkout
   mid-capture. Drive Playwright at DPR 2, light. Clip real cards to their own box instead of
   hand-cropping. Type a question at DPR 3 and never send it (no Claude turn, no cost). Record one
   live chat turn as frames.
5. **Gate every capture for privacy and truth before it reaches `public/`.**
   - Grep each chat frame's page text for `@`: an account-change banner printed the owner's
     email on every live-chat frame. Reload to drop it, or crop below it.
   - Read the WHOLE live answer before choosing what goes on screen. The agent correctly pointed
     at the demo vault's staging ("the Lab script returns a hardcoded array"), so that part stays
     off screen.
   - VO = screen text, word for word. Every claim must trace to verified behaviour, and nothing
     may claim autonomy.
6. **The lockup is crisp, proportional and measured.**
   - The source is `desktop/src-tauri/icon-source.png`, keyed by flood-filling the white field
     from the EDGES only, so the white ring inside the outline survives.
   - Never use `logo.png` (its glow is baked onto a grey field, so the keyed gem is blurry) and
     never `favicon.svg` (an older drawing).
   - The visible gem is 1.18 × the wordmark size, centred on the wordmark's ink box (ascender top
     to baseline). Verify by measuring ink rows on a rendered still: the eye let it sit 18 px high.
7. **Rolling kinetic text has three laws** (the first draft broke all of them):
   - A joining word is born next to its neighbour's CURRENT position, never at its final target.
   - A leaving word frees its slot about 3 frames into its fade.
   - A group fades out completely before the next group's first word.
8. **Sound: VO first, SFX always, music as an offered variant.**
   - Read the VO in one take with a throwaway pad sentence at the end, so the last word is never
     clipped. Measure every line's tail.
   - Use the stock SFX under the grammar, with decaying triplets. A synthesised set was rejected
     by ear.
   - Music stays off by default. When the reference runs on a bed, ALSO deliver a MUSIC cut:
     generate takes from a composition plan, reject a flat take by analysis, align the lift to the
     reveal word by offset, and set the bed about 13 dB under the VO by LUFS.
9. **Prove it by measurement, cheaply first.**
   - Start with a half-scale silent draft (about 40 s), read it as contact sheets, fix, and only
     then render full size with `--timeout=300000 --concurrency=4` (a load average of 150 timed
     out one frame at 123 s).
   - Check frames 2 frames after every cut and the word-sync frames.
   - Isolate the SFX by subtracting WAV renders: AAC against WAV does not cancel and reports a
     fake 0 dB.
10. **Deliver both cuts, archive and write back.** Archive to `_dream_context/marketing/videos/<id>.md`
    (scene table, claims, experiment), fold lessons into the skill and the laws file, add a
    changelog line, then ask which cut ships. Nothing is published without the owner's pick.

## How to apply it

When a message carries a reel link plus "bu tarzda / in this style / tanıtım videosu", load the
`dreamcontext-reel` skill and run its production line with the rules above as the acceptance bar.
For an owner note in the middle of the run ("logo orantılı olsun", "hiza düzgün olsun"), apply it
to EVERY instance of the thing, measure it, re-render, and write it back here.

## Sources

- Production records (gitignored): `_dream_context/marketing/videos/dreamcontext-intro-v4.md`
  (and v2, v3 for the rejected shapes).
- Composition: `marketing/remotion/src/reels/ReelV4.tsx` (KLine engine, StaticLockup, ProductRun).
- Captures: `e2e/reel-shots-v4.mjs`, `-chatstill`, `-frags`, `-composer`. Demo vault builder:
  `marketing/build-demo-vault-v2.sh`.
- Related: `patterns/runtime-measurement-verification`,
  `patterns/synthetic-fixtures-for-published-artifacts`, `patterns/proof-of-looking-gate`.

## Last verified

2026-10-04: IntroV4-SFX / IntroV4-MUSIC, 49.4 s. The gem centre sits 1.5 px from the ink centre,
the mix peaks at −3.9 dB, the music bed sits 13.7 dB under the VO, and the decaying SFX triplet
measured −19 / −22 / −26 dB.
