# Edit decisions — tests/fixtures/speech.mp4

**Style:** `educational` — Clarity first. Calm pacing, generous captions, highlights on key terms.
**Source:** 1280x720, 24.743s, pt
**Result:** ~19.1s after cuts (23% shorter)
**Stages:** cuts → crop → zoom → captions → audio

---

## silence

removed 3 silent stretch(es), 5.611s

```
00:03.02-00:05.18  removed 2.15s of silence
00:11.05-00:12.99  removed 1.94s of silence
00:17.71-00:19.23  removed 1.52s of silence
```

## crop

reframed 1280x720 to 1080x1920 (static)

```
centre crop
```

## zoom

1 zoom(s) at 1.08x

```
00:15.49  zoom 1.08x — emphasis on "npm"
```

## captions

clean captions, up to 7 words per cue, highlighting 4 keyword(s)

```
highlighted: Primeiro, terminal, npm, install
```

## audio

normalised to -16 LUFS

---

Timestamps refer to the ORIGINAL recording, not the edited result.
Edit the plan JSON beside this file and re-run `ve render-edit` to change any of it.