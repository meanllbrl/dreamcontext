# Voice garble guard — local eval on real takes

Run 2026-10-24T21:11:40.339Z · 12 takes · model large-v3-turbo · whisper-server -nlp · lexicon yes · UI language tr.
The audio is the owner's and is never committed; this file holds only the numbers and the texts.

| take | s | old (app before) | new verdict | passes | new ms | json ms | pass 1 | pass 2 | sent |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-24T17-58-39-696Z | 25.5 | İlk soruya cevabım görev başlamasın çünkü komple bu sistem r (2192 ms) | clean | 1 | 2172 | 2220 | auto:tr clean -0.118 |  | İlk soruya cevabım görev başlamasın çünkü komple bu sistem read-only olsun ilk a |
| 2026-10-24T18-00-18-616Z | 57 | Mesela görevlere de. Üçüncü sorun da bunu ajan yapabilsin ya (3122 ms) | clean | 1 | 4485 | 4428 | auto:tr clean -0.137 |  | Mesela görevlere de, üçüncü sorun da bunu ajan yapabilsin yani göndermesi gereki |
| 2026-10-24T18-07-02-130Z | 8.3 | Móbili değil mi görmüyorum şu anda? Bilmüyorum yani sorunu a (976 ms) | garbled | 2 | 2849 | 963 | pin:tr garbled -0.567 | auto:is garbled -0.621 | **not sent** (Anlayamadım) |
| 2026-10-24T18-07-55-005Z | 3.7 | Tamam o pilan limitindi a mitri megozun baiska borsla esapli (1098 ms) | clean | 1 | 1105 | 1064 | pin:tr clean -0.124 |  | Tamam o pilan limitindi a mitri megozun baiska borsla esapli yok mu? |
| 2026-10-24T18-08-21-768Z | 13.2 | Diyorum ki başka boşta hesap yok mu? Plan oturumunu o şekild (1272 ms) | clean | 1 | 1291 | 1198 | pin:tr clean -0.143 |  | Diyorum ki başka boşta hesap yok mu? Plan oturumunu o şekilde devam ettir. Devam |
| 2026-10-24T18-09-58-931Z | 33.9 | Yani şifreli yapsam bile belki onun kılagıda okur. O yüzden  (2654 ms) | clean | 1 | 2618 | 2753 | pin:tr clean -0.064 |  | Yani şifreli yapsam bile belki onun kulağıda okur. O yüzden karmaşıklaştırmayalı |
| 2026-10-24T18-32-58-359Z | 2.2 | Ne durumda iskan ki nasıl gidiyor? (844 ms) | suspect | 2 | 2549 | 842 | pin:tr suspect -0.443 | auto:is garbled -0.674 | Ne durumdayız kanki nasıl gidiyor? |
| 2026-10-24T18-33-46-589Z | 2.6 | Diyorum ki ne durumdayız nasıl gidiyor (856 ms) | clean | 1 | 853 | 861 | pin:tr clean -0.022 |  | Diyorum ki ne durumdayız nasıl gidiyor |
| 2026-10-24T18-36-00-910Z | 6.5 | Menn bir süredir hensi frimodunlarında ne olja ne biti ve ne (1025 ms) | garbled | 2 | 3064 | 1041 | pin:tr garbled -0.716 | auto:is garbled -0.734 | **not sent** (Anlayamadım) |
| 2026-10-24T18-36-18-596Z | 9.5 | Ben bir süredir hands free modundayım da ne oluyor ne bitiyo (988 ms) | clean | 1 | 1003 | 993 | pin:tr clean -0.085 |  | Ben bir süredir hands free modundayım da ne oluyor ne bitiyor soruların neler he |
| 2026-10-24T18-36-50-686Z | 16.9 | Tamam sana yeni bir iş. Bu ses bazen bozuk algılıyor beni. A (1167 ms) | clean | 1 | 1162 | 1167 | pin:tr clean -0.099 |  | Tamam sana yeni bir iş. Bu ses bazen bozuk algılıyor beni. Ama yeniden tekrarlad |
| 2026-10-24T18-37-05-273Z | 9.9 | Mesela diyelim ki sen bunu algılayamadın. Agent bunu tekrar  (1083 ms) | clean | 1 | 1093 | 1088 | pin:tr clean -0.084 |  | Mesela diyelim ki sen bunu algılayamadın. Agent bunu tekrar deney yapabilsin bar |

- Texts sent containing þ, ð or æ: **0**
- Not sent (garbled): 2026-10-24T18-07-02-130Z, 2026-10-24T18-36-00-910Z
- Median overhead on clean one-pass takes (ladder − json, same language): **5 ms** over 9 takes
- Retried takes: 2026-10-24T18-07-02-130Z +1886 ms, 2026-10-24T18-32-58-359Z +1707 ms, 2026-10-24T18-36-00-910Z +2023 ms
- First take after a pause: pass 1 was auto:tr (context empty at the start of the run).
## Reading (2026-10-24, the four takes the plan names as bad)

- **18-07-02, 18-36-00**: both passes weak (logprob ≤ -0.57): not sent, "Anlayamadım". The old app sent Icelandic-spelled / broken Turkish.
- **18-32-58**: pass 1 pinned to tr was suspect (-0.44), the `auto` retry heard Icelandic (garbled); the pinned pass won: "Ne durumdayız kanki nasıl gidiyor?" — recovered (the owner said "ne durumdayız nasıl gidiyor").
- **18-07-55**: now decoded as Turkish ("Tamam o pilan limitindi … başka boşta hesap yok mu?"; the old app sent "Það var á pílan…"), at logprob -0.12, inside the good takes' range. Recovered to Turkish but with misheard words; no score separates it from a good take without false alarms on the 8 good ones. This is the case the agent-side rule (`dreamcontext voice retry`, then ask) exists for.
- All 8 good takes were sent, clean, one pass, with no false alarm.
