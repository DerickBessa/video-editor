# Roadmap

Status is evidence-based. A capability is `WORKING` only when it is
**implemented + executed + validated by a passing test**. `ve capabilities` reads the test
report directly and downgrades anything the tests do not back up.

Last full test run: **196 passed, 0 failed** (~13 min; it renders real video).

---

## WORKING

### Phase 1 — foundation

| Capability | Tool | Tests | Notes |
|---|---|---|---|
| Video probe | `probe-video` | 10 | Display-matrix rotation, audio-less files, NTSC frame rates. |
| Audio extraction | `extract-audio` | 10 | 16 kHz mono PCM. Content-hash cached. |
| Cut engine | `cut-video` | 12 | Frame-accurate; verified zero A/V skew across 40 cuts. |
| Range algebra | `lib/ranges.mjs` | 11 | parse, normalise, invert, pad, shrink, validate, map-to-cut. |

### Phase 2 — understanding the video

| Capability | Tool | Tests | Notes |
|---|---|---|---|
| Transcription + word timestamps | `transcribe` | 13 | faster-whisper. **0.0% WER** on the ground-truth fixture. |
| Silence detection | `detect-silence` | 13 | Within **50 ms** of digitally-exact silence boundaries. |
| Scene detection | `detect-scenes` | 9 | Hard cuts located exactly (3.000 / 6.000 / 9.000 s). |
| Frame extraction | `extract-frames` | 13 | interval / timestamp / scene / smart, with a hard cap. |

### Phase 3 — basic editing

| Capability | Tool | Tests | Notes |
|---|---|---|---|
| Silence removal | `remove-silence` | 13 | **0.0% WER after cutting** at every intensity. |
| Crop / resize / reframe | `crop-video` | 16 | 16:9 -> 9:16 etc.; blurred-fill letterbox verified by luminance. |
| Zoom engine | `zoom-video` | 14 | Zoom factor measured optically; eased, monotonic ramps. |
| Speed change | `change-speed` | 9 | Drift < 0.02 s at 0.5x/1.25x/2x; pitch preserved. |
| Audio normalisation | `normalize-audio` | 8 | Two-pass EBU R128, lands 0.28 LU from target. |

### Phase 4 — shorts

| Capability | Tool | Tests | Notes |
|---|---|---|---|
| Captions | `captions` | 22 | 5 styles via libass; burn-in verified by pixel luminance. |
| Keyword detection | `detect-keywords` | 23* | Emphasis + rarity + word shape; no LLM call. |
| Filler-word removal | `remove-fillers` | 23* | Conservative; a sentence-initial connective is never cut. |
| Vertical smart crop | `smart-crop` | 19 | Face-tracked reframing with smoothing and a deadzone. |
| Sound effects | `add-sfx` | 19 | Density-limited, ducked under speech. |

\* `detect-keywords` and `remove-fillers` share `keywords-fillers.test.mjs`.

### Phase 5 — motion graphics

| Capability | Tool | Notes |
|---|---|---|
| Remotion component library | `remotion-render` | 16 components rendered to TRANSPARENT overlays. |
| Code / terminal / browser visuals | (same library) | CodeBlock, Terminal, BrowserWindow, CodeDiff, PhoneFrame. |

Remotion produces an overlay file; ffmpeg composites it. Remotion is never in the render
pipeline itself, so `render-edit` stays FFmpeg-only and fully cacheable, and a headless browser
starts only for the frames that genuinely need one. Anything that is merely styled text belongs
in `captions` (libass), which is far cheaper.

### Phase 6 — intelligent editing

| Capability | Tool | Tests | Notes |
|---|---|---|---|
| Edit plan + validator | `validate-edit-plan` | 31 | Source-time timeline; refuses unrenderable plans. |
| Render engine | `render-edit` | 15* | Stage-by-stage with per-stage caching. |
| Preview render | `preview-edit` | 15* | Same pipeline, smaller and faster. |
| Automatic QA | `qa-video` | 17* | Streams, geometry, A/V sync, black frames, audio, caption bounds. |
| Contact sheet | `contact-sheet` | 17* | One image of the whole video. |
| Orchestrator + reasoning log | `edit-video` | 13 | One command; writes the plan and why. |
| Overlays / images / memes | `add-overlay` | 15 | Images, GIFs, PiP with position and timing. |

\* shared suites: `render-edit.test.mjs`, `qa-video.test.mjs`.

**The design decision that matters:** every timestamp in an edit plan is in **source time**.
Cutting runs first, so the renderer remaps everything else through the cuts at render time. That
is what makes a plan readable against the original video, and what makes "remove the zoom at 17
seconds" refer to something stable. Events that end up inside removed footage are dropped and
reported, never slid elsewhere.

### Phase 7 — advanced visual

| Capability | Tool | Notes |
|---|---|---|
| Face / speaker tracking | `track-faces` | Subject track + shot classification. Speaker ID is NOT claimed. |
| Visual analysis | `analyze-visual` | Motion, brightness, faces, scenes, static stretches. |
| B-roll insertion | `add-broll` | 4 modes; `--auto` suggests placements from the transcript. |
| Style analysis | `analyze-style` | Abstract editing rhythm only; no identity is extracted. |

### Phase 8 — secondary effects and audio

| Capability | Tool | Notes |
|---|---|---|
| Denoise | `denoise-audio` | Noise floor is MEASURED (-40.4 dB vs -40.5 true), not guessed. |
| Voice compression | `compress-voice` | Crest factor 20.9 -> 16.9 dB at the broadcast preset. |
| Background music | `add-music` | Looped, faded, ducked under speech by default. |
| Music ducking | `duck-music` | Sidechained to the voice. Cannot unmix already-mixed audio, and says so. |
| Freeze frame | `freeze-frame` | Extends the video by exactly the hold. |
| Blur region | `blur-region` | blur / pixelate / black, optional face mode. Fails safe. |
| Transitions | `transitions` | xfade joins + dip/flash at a point. **Hard cut remains the default.** |
| Background | `background` | vignette (no model) + blur/darken/replace via MediaPipe segmentation. |

### Phase 9 — the interface

| Capability | Where | Notes |
|---|---|---|
| Editing modes | `lib/styles.mjs`, `ve modes` | 6 presets, overridable from `styles/*.json`. |
| Slash commands | `.claude/commands/` | /edit /preview /transcribe /cut-silence /captions /vertical |
| Natural-language editing | `nl-edit` | 9 phrasings in EN+PT, plus a precise `--set`/`--add`/`--remove` interface. |
| Claude Code Skill | `.claude/skills/video-editor/` | How to drive the toolkit, including its limits. |

### Measured behaviour

- **Cutting**: 3 cuts -> 0.000 s drift. 40 cuts -> 12.000 s output (300 frames at exactly
  30 fps), A/V skew < 0.02 s.
- **Audio**: byte-exact PCM — 16 s x 16 kHz x 2 B + 78 B header = 512 078 B.
- **Transcription WER**: **0.0 %** with an initial prompt, 8.3 % without.
- **Transcription speed** (small model, pt): CPU 5.3-7.8x realtime, **GPU 29.8-32.7x realtime**.
- **Cross-validation**: `detect-silence` (RMS energy) and `transcribe` (neural ASR) share no
  code, yet **0 of 36 transcribed words** fall inside a detected silence.
- **Zoom accuracy**: a 100 px reference box under a linear 1.0->1.8x zoom measured
  116/128/142/154/168/178 px against 113/127/140/153/167/180 expected — within cropdetect's
  own 2 px rounding.
- **Loudness**: -23.66 -> -16.28 LUFS against a -16 target; true peak -1.49 dBTP.
- **Two-pass vs one-pass loudnorm**: 0.28 LU error vs 0.83 LU — 3x more accurate.
- **Captions**: burned onto a black frame, the caption band measures YAVG 19.9 during speech
  and 16.0 (video black) during a known silence — proof they render *and* are time-synced.
- **Filler removal**: on a fixture containing a real hesitation, `safe` removed only the
  hesitation and `aggressive` also removed "tipo", while **"Então" survived both** because it
  opens a sentence.
- **Smart crop**: on a fixture where the subject crosses frame, tracking held it at x=203-207 of
  a 360px-wide output for the whole clip while a static centre crop **lost it entirely** at both
  ends. With smoothing off the subject sits at 179 px against an ideal of 180.
- **SFX ducking**: an effect landing on speech drops 3.6 dB (-17.2 -> -20.8); the same effect
  landing in silence is untouched (-18.6 -> -18.6).
- **ONE COMMAND, end to end** — `ve edit-video raw/x.mp4 --style clean`:
  24.7 s source -> **18.1 s 1080x1920 captioned Short, QA pass, in 50 s**. All five styles
  (clean, viral, coding, podcast, educational) render and pass QA.
- **Denoise**: measured floor -40.4 dB against a true -40.5 dB; noise cut by 10.5 / 16.3 /
  21.2 dB across strengths, while a clean recording moves only 0.2 dB.
- **B-roll**: PSNR 44.9 dB outside the B-roll window vs 11.5 dB inside — the picture really is
  replaced, only where asked.
- **Motion graphics alpha**: a full-frame Remotion overlay leaves the frame corner at
  76.54 -> 76.54 (video showing through) while the component area moves 125.5 -> 35.0.

---

## EXPERIMENTAL

| Capability | Tool | Why it is not "working" |
|---|---|---|
| Stream-copy cutting | `cut-video --strategy copy` | Correct and honest, but inherently keyframe-bound. On a source with an 8 s GOP two requested segments legitimately collapse into one. Reports `maxKeyframeShift` and warns. Fine for previews, never for final cuts. |

---

## KNOWN LIMITATIONS

### `detect-scenes` cannot see gradual transitions

`scdet` compares **consecutive** frames. A 1.5 s crossfade changes each frame only slightly, so
no single frame ever crosses the threshold. Measured on a fixture with one 1.5 s `xfade`:

| Threshold | Crossfade detected | Hard cuts detected (control) |
|---|---|---|
| 10 (default) | 0 | 3 |
| 5 / 2 / 1 / **0.5** | 0 | **3** |

Lowering the threshold does not help — it is structural, not a tuning problem. The control
column proves the setting is not merely insensitive.

This matters only for analysing *already-edited* reference footage (phase 7 `analyze-style`);
raw camera footage contains hard cuts or none at all. The fix, if it becomes necessary, is a
sliding-window comparison against a frame N frames back — **not** PySceneDetect, and **not** a
lower threshold. Locked in by a test that fails if the behaviour ever changes.


### Caption position cannot be read back from a video

`analyze-style` briefly claimed to detect where burned-in captions sit, from the contrast of
horizontal bands. It was tested and removed, having failed in **both** directions:

| Input | Claimed | Truth |
|---|---|---|
| Fixture with NO captions | "bottom third", confidence 0.59 | there are none |
| A genuinely captioned render | nothing, confidence 0.01 | captions are present |

The first fails because a test pattern simply has more contrast low in the frame; the second
because the underlying picture was already at maximum contrast, so text could not raise it.
Separating caption pixels from busy pixels needs text detection, not contrast statistics. The
band numbers are still reported as raw diagnostics; nothing draws a conclusion from them.

### No real footage of a person has been tested

Face detection (YuNet), person segmentation (MediaPipe) and therefore `smart-crop`,
`blur-region --faces` and `background --mode blur` are tested for their MATHS — tracking,
smoothing, framing, compositing, and their failure modes — using synthetic fixtures and supplied
mattes. Their accuracy on a real subject is the models' and is unmeasured here. Every one of
these tools reports its own confidence (`faceCoverage`, `foregroundRatio`) and refuses or warns
rather than producing a confidently wrong result.

---

## PLANNED

Nothing. All nine phases of the brief are implemented, tested and registered.
`ve capabilities` lists 42 capabilities and reports 0 planned.

What that does NOT mean: that everything is equally proven. The limitations section above is
the honest boundary, and the biggest one is that **no real footage of a person has ever been
run through this project** — face tracking, background segmentation and smart crop are tested
for their maths and their failure modes, not for how well the models perform on a real subject.

---

## FAILED / REJECTED

Approaches tried and discarded, recorded so they are not retried.

### FFmpeg's built-in `whisper` filter — **rejected as the transcription backend**

This FFmpeg build ships `--enable-whisper`, so it was evaluated first, on principle (no new
dependency). It is not usable for editing. Running it over the ground-truth fixture:

```
{"start":0,    "end":3000,  "text":"Olá, seja bem-vindo ao meu canal."}
{"start":3000, "end":10000, "text":"Hoje vamos falar sobre o clúdico de como automatizar a edição"}
{"start":9984, "end":19984, "text":"de vídeos."}
{"start":19968,"end":23928, "text":"disso, o vídeo será renderizado automaticamente."}
```

Three independent disqualifiers:

1. **No word-level timestamps at all** — segment granularity only, which rules out karaoke
   captions, keyword highlighting and word-accurate cutting.
2. **Timestamps snap to the processing window** (3000, 10000, 19984 ms), not to speech.
3. **Text is lost at chunk boundaries** — the sentence *"Primeiro, abra o terminal e execute
   npm install."* vanished entirely, and "Depois" was truncated to "disso".

It is built for live streaming subtitles, not editing. Replaced by faster-whisper, which
transcribes the same file at **0.0 % WER** with word timestamps.

### WhisperX — **not installed**

The original first choice. faster-whisper was chosen instead because it delivers the required
word-level timestamps through CTranslate2 with **no torch dependency** — about 200 MB of
packages rather than several GB — and WhisperX's extra wav2vec2 alignment pass was not needed
to reach 0 % WER. Revisit only if speaker diarisation becomes a requirement.

### PySceneDetect — **not installed**

FFmpeg's `scdet` located every hard cut in the ground-truth fixture *exactly*, with zero
dependencies. A Python scene detector would have been redundant weight. Its one advantage
(gradual transitions) is documented above as a known limitation instead.

### Auto-Editor — **not installed**

Its job is exactly `detect-silence` + `cut-video`, which are already working with output shapes
we control and validate. Adding it would duplicate the pipeline.

### `select`/`aselect` expressions for cutting — **rejected**

```
-vf "select='between(t,0,5.2)+...',setpts=N/FRAME_RATE/TB"
-af "aselect='...',asetpts=N/SR/TB"
```

`setpts=N/FRAME_RATE/TB` renumbers video by frame index and `asetpts=N/SR/TB` renumbers audio by
sample index — **independently**. Each boundary rounds by up to one video frame (33 ms) and one
audio frame (21 ms), and because the streams round separately the error is a *relative* A/V
drift that accumulates with every cut. Replaced by `trim`/`atrim` + the **`concat` filter**,
which aligns audio and video per segment. Verified: 40 cuts, skew < 0.02 s.

### Linear drift tolerance in `cut-video` — **fixed**

`0.15 + segments × 0.02` s permits 4.15 s of error at 200 segments, which let a genuine 1.65 s
stretch pass as success. Boundary rounding is signed and cancels, so the honest bound grows with
**√n**. Now `max(0.2, 1.5 × frameDuration × √n)`.

### Sub-frame cut segments — **guarded**

200 segments of 0.05 s (1.5 frames at 30 fps) made the `concat` filter emit 11.65 s instead of
10.00 s. Not worth solving — a 1.5-frame segment is a glitch, not an edit. `--min-segment`
defaults to 0.1 s and warns below 2 frames.

### Whisper normalises disfluencies away — **works around it, cannot fully solve it**

`remove-fillers` can only remove what the transcript contains, and Whisper is trained to emit
clean readable text. Measured on a fixture that deliberately said
*"Eu queria, ahn, mostrar o o terminal"*:

| Spoken | Transcribed |
|---|---|
| "ahn" (hesitation) | `eitn,` — an invented token, probability **0.45** |
| "o o" (stutter) | `o` — the repetition was silently collapsed |

So a word-list matcher alone misses most real disfluencies. The workaround is to also treat a
**short, low-probability, non-dictionary token sitting in a gap** as a hesitation, which does
catch the `eitn,` case. The collapsed stutter is unrecoverable from the transcript — detecting
it would need acoustic analysis rather than text. Documented rather than hidden: filler removal
is best-effort by construction.

### Keying the render cache on the plan hash — **fixed**

Intermediates were first stored under `temp/render/<planHash>/`. That looked tidy and destroyed
the cache: changing a single zoom changed the plan hash, changed the directory, and orphaned the
cut and crop intermediates the zoom did not affect — so every re-render did all the work again.
Now keyed on the SOURCE, with per-stage identity from `stageHash(settings) + input fingerprint`.
Measured: changing only the zoom now re-runs only the zoom.

### Computing render stages from the un-mapped plan — **fixed**

The stage list was built from the plan as written, but events inside removed footage are dropped
during timeline mapping. A zoom whose only event was cut away therefore still scheduled a `zoom`
stage, which then failed with "No zoom events given". Stages now come from the MAPPED plan.

### drawtext has no fonts on Windows — **worked around**

`drawtext` resolves font names through fontconfig, which Windows does not ship:
`Fontconfig error: Cannot load default config file`. Every drawtext call therefore fails unless
given an explicit `fontfile=`. `lib/ffmpeg.mjs:findFont()` now locates a TTF (project
`assets/fonts/` first, then platform locations) and callers degrade gracefully when none exists.
libass, used for captions, has its own font handling and was never affected — which is why
captions worked while contact-sheet labels did not.

### Filler removal deleting "Code" from "Claude Code" — **fixed**

The low-confidence-token heuristic (added to catch hesitations Whisper spells as nonsense) has an
inherent overlap with rare proper nouns: both are words the recogniser is unsure about. It
deleted "Code" at probability 0.13. Two guards: capitalised tokens are never treated as
hesitations, and anything named in `--prompt`, `--keywords` or the style's vocabulary is
protected outright. **Found by reading the reasoning log**, which is the argument for having one.

### 2x supersampling in `zoom-video` — **default turned OFF, benefit not demonstrable**

`zoompan` computes its crop origin in whole pixels, so the theory says a slow off-centre move
steps 1 px at a time, and scaling the input 2x first should halve that. Two attempts were made
to measure the improvement:

1. A centred zoom — wrong experiment, the crop origin barely moves.
2. An off-centre zoom (focal point 0.2, 0.2) with the crop origin tracked frame by frame.

The off-centre test produced an **identical step histogram** with supersampling on and off
(`{0:91, 2:15, -2:3}`, max jump 2 px), while costing **~21 % more render time** at 1080p. It does
change the output (PSNR 33.6 dB), just not measurably for the better.

Kept as `--super-sample` for footage where stepping is visible in practice, but no longer the
default: the project does not pay for benefits it cannot demonstrate. Note the measurement is
limited to 2 px resolution by `cropdetect`'s rounding, so a sub-pixel improvement would not have
been visible — the honest summary is "not demonstrated", not "does not exist".

### Silent dedupe in `extract-frames` — **fixed**

An internal 0.25 s dedupe was applied to *all* modes, so `--interval 0.2` silently collapsed 60
requested frames into 1. Dedupe now applies only to `scene`/`smart`, the modes that synthesise
timestamps from two sources; an explicit interval or timestamp list is always honoured.

### `-loglevel error` hiding detector output — **fixed**

`silencedetect`, `volumedetect` and `scdet` all report on stderr at **info** level. The shared
ffmpeg wrapper defaults to `-loglevel error`, so the first implementation of `detect-silence`
would have returned zero silences forever without failing. Detector calls now raise the level
explicitly.

### Installing Python packages into the `PATH` interpreter — **avoided**

`python` on `PATH` resolves into an unrelated application's virtualenv (`hermes-agent`).
All sidecar packages go into the project-local `.venv/`. See `docs/STACK.md`.
