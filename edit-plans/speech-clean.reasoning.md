# Edit decisions — tests/fixtures/speech.mp4

**Style:** `clean` — Minimal intervention. Tighten pauses, fix loudness, readable captions.
**Source:** 1280x720, 24.743s, pt
**Result:** ~18.0s after cuts (27% shorter)
**Stages:** cuts → crop → captions → audio

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

reframed 1280x720 to 1080x1920 (static)

```
centre crop
```

## captions

clean captions, up to 6 words per cue

## audio

normalised to -16 LUFS

---

Timestamps refer to the ORIGINAL recording, not the edited result.
Edit the plan JSON beside this file and re-run `ve render-edit` to change any of it.