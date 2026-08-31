# Edit decisions — tests/fixtures/speech.mp4

**Style:** `viral` — Fast and loud. Aggressive trimming, word-by-word captions, punch zooms, sparing effects.
**Source:** 1280x720, 24.743s, pt
**Result:** ~17.3s after cuts (30% shorter)
**Stages:** cuts → speed → crop → zoom → captions → audio → sfx

---

## silence

removed 5 silent stretch(es), 7.418s

```
00:02.90-00:05.33  removed 2.42s of silence
00:10.93-00:13.14  removed 2.21s of silence
00:13.85-00:14.06  removed 0.21s of silence
00:17.59-00:19.38  removed 1.79s of silence
00:23.91-00:24.69  removed 0.78s of silence
```

## crop

reframed 1280x720 to 1080x1920 (static)

```
centre crop
```

## speed

1.05x overall pace

## zoom

2 zoom(s) at 1.14x

```
00:12.63  zoom 1.14x — emphasis on "Primeiro"
00:15.49  zoom 1.14x — emphasis on "npm"
```

## captions

viral captions, up to 4 words per cue, highlighting 4 keyword(s)

```
highlighted: Primeiro, terminal, npm, install
```

## audio

normalised to -14 LUFS

## sfx

2 effect(s) at 5/min

```
00:12.98  pop — beat on "Primeiro"
00:15.84  pop — beat on "npm"
```

---

Timestamps refer to the ORIGINAL recording, not the edited result.
Edit the plan JSON beside this file and re-run `ve render-edit` to change any of it.