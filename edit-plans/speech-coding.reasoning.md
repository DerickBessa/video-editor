# Edit decisions — tests/fixtures/speech.mp4

**Style:** `coding` — Technical demos. Keeps the screen readable, highlights tool and command names.
**Source:** 1280x720, 24.743s, pt
**Result:** ~18.0s after cuts (27% shorter)
**Stages:** cuts → crop → zoom → captions → audio → sfx

---

## silence

removed 4 silent stretch(es), 6.723s

```
00:02.96-00:05.26  removed 2.30s of silence
00:10.98-00:13.07  removed 2.09s of silence
00:17.64-00:19.31  removed 1.67s of silence
00:23.96-00:24.62  removed 0.66s of silence
```

## crop

reframed 1280x720 to 1080x1920 (contain)

```
used contain with a blurred fill so screen content stays readable
```

## zoom

2 zoom(s) at 1.1x

```
00:06.87  zoom 1.1x — emphasis on "Claude"
00:14.27  zoom 1.1x — emphasis on "terminal"
```

## captions

bold captions, up to 4 words per cue, highlighting 4 keyword(s)

```
highlighted: Claude, terminal, npm, install
```

## audio

normalised to -16 LUFS

## sfx

1 effect(s) at 3/min

```
00:07.22  click — beat on "Claude"
```

---

Timestamps refer to the ORIGINAL recording, not the edited result.
Edit the plan JSON beside this file and re-run `ve render-edit` to change any of it.