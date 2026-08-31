# video-editor

A modular toolkit for automatic video editing, designed to be driven by Claude Code.

Every capability is an independent, individually tested tool with a defined input, a defined
JSON output, and a CLI. They compose; none of them is a monolith.

**Status:** phases 1-3 complete, phase 4 mostly done — 15 capabilities, 196 tests passing.
Run `node bin/ve.mjs capabilities` for the live picture.

---

## Requirements

- **FFmpeg + FFprobe** on `PATH` (a full build is strongly recommended — see `docs/STACK.md`)
- **Node.js ≥ 20**

Optional, each unlocking specific tools:

- **Python venv** — transcription, captions, keywords, face tracking, background segmentation
- **npm packages** — motion graphics (Remotion)

Everything else is Node stdlib + FFmpeg.

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r pysrc/requirements.txt   # Windows
# .venv/bin/python -m pip install -r pysrc/requirements.txt         # Linux/macOS

# optional: GPU Whisper (~6x faster)
.venv/Scripts/python.exe -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

```bash
npm install    # only needed for `remotion-render` (motion graphics)
```

---

## Quick start

```bash
node bin/ve.mjs capabilities          # what works right now
node bin/ve.mjs <tool> --help         # per-tool usage
```

### Understand a video

```bash
ve probe-video      raw/test.mp4                  # duration, resolution, codecs
ve transcribe       raw/test.mp4 --language pt    # text + word-level timestamps
ve detect-silence   raw/test.mp4                  # silent stretches + speech regions
ve detect-scenes    raw/test.mp4                  # hard cuts -> shots
ve extract-frames   raw/test.mp4 --mode smart     # representative stills
```

### Edit it

```bash
ve remove-silence   raw/test.mp4 --intensity normal --snap words --language pt
ve remove-fillers   raw/test.mp4 --level safe --language pt --dry-run
ve cut-video        raw/test.mp4 --keep "0-5.2,6.1-13.4"
ve crop-video       raw/test.mp4 --aspect 9:16 --resolution 1080x1920
ve zoom-video       raw/test.mp4 --events "5-7@1.12;12-14@1.25:0.3,0.4"
ve change-speed     raw/test.mp4 --rate 1.25
ve normalize-audio  raw/test.mp4 --target-lufs -16
```

### Reframe, effects, audio

```bash
ve smart-crop       raw/talk.mp4 --resolution 1080x1920   # face-tracked vertical
ve freeze-frame     raw/test.mp4 --freezes "8.4:1.2"
ve blur-region      raw/demo.mp4 --regions "0.55,0.72,0.4,0.12" --mode pixelate
ve transitions      raw/a.mp4 --clips b.mp4 --type crossfade
ve background       raw/talk.mp4 --mode blur
ve denoise-audio    raw/test.mp4 --strength 0.5
ve compress-voice   raw/test.mp4 --preset voice
ve add-music        raw/test.mp4 --music bed --volume 0.1
ve add-broll        raw/test.mp4 --auto --language pt --dry-run
```

### Motion graphics

```bash
ve remotion-render --list
ve remotion-render Terminal --props '{"lines":["$ npm install"]}' --duration 3
ve add-overlay video.mp4 --overlays "output/overlays/terminal.mov@12-15"
```

16 components — Title, LowerThird, Callout, Arrow, CircleHighlight, ProgressBar, Notification,
CodeBlock, Terminal, BrowserWindow, PhoneFrame, TweetCard, ImageCard, CodeDiff and more —
rendered as transparent overlays and composited by ffmpeg.

### Caption it

```bash
ve detect-keywords  raw/test.mp4 --language pt --per-minute 6 --out temp/kw.json
ve captions         raw/test.mp4 --style viral --burn --keywords temp/kw.json --language pt
```

Styles: `clean` `minimal` `viral` `bold` `karaoke`. Without `--burn` you get a standalone
`.ass` file you can restyle and re-burn without re-transcribing.

### One command

```bash
ve edit-video raw/video.mp4 --style clean --language pt --prompt "Claude Code, npm install"
```

Analyses, decides, writes an **edit plan** and a reasoning log, renders, and runs QA.
Styles: `clean` `educational` `viral` `podcast` `coding` `landscape` (`ve modes` explains each).

Then iterate on the plan rather than re-running everything:

```bash
ve nl-edit edit-plans/video-clean.json "remove the zoom between 17 and 20 seconds"
ve nl-edit edit-plans/video-clean.json --set 'captions.style="karaoke"'
ve render-edit edit-plans/video-clean.json     # only the changed stage re-runs
```

**Every timestamp in a plan is in source time** — the original recording's timeline. The
renderer maps events through the cuts, which is what makes an instruction like the one above
mean the obvious thing.

### Compose them by hand — raw footage to a vertical Short

```bash
ve remove-silence  raw/test.mp4         --snap words --language pt --out temp/1.mp4
ve normalize-audio temp/1.mp4                                      --out temp/2.mp4
ve crop-video      temp/2.mp4 --aspect 9:16 --resolution 1080x1920 --out temp/3.mp4
ve detect-keywords temp/3.mp4 --language pt --per-minute 8         --out temp/kw.json
ve captions        temp/3.mp4 --style viral --burn --keywords temp/kw.json                               --language pt --out output/short.mp4
```

Every tool prints JSON to stdout, so they chain through `jq` and feed each other:

```bash
ve detect-silence raw/test.mp4 --out temp/sil.json
ve cut-video      raw/test.mp4 --plan temp/sil.json     # silence JSON is a valid cut plan
ve probe-video    raw/test.mp4 | jq .duration
```

### Tests

```bash
npm test                       # everything (~13 min: it renders real video)
node tests/run.mjs zoom crop   # just the suites whose filename matches
```

---

## Design

```
raw video → ANALYSE → DECIDE → EDIT PLAN → EXECUTE → RENDER → QA → final.mp4
```

- **stdout is JSON, stderr is for humans.** Tools pipe into `jq` and into each other.
- **Outputs are verified, not assumed.** Anything that writes media re-probes it and fails
  if it does not match what was promised.
- **`raw/` is never written to.** Enforced in code, not by convention.
- **Cache keys are content hashes**, so nothing expensive is recomputed for unchanged input.
- **Capabilities cannot self-certify.** `ve capabilities` reads the test report and downgrades
  anything the tests do not prove.

---

## Layout

| Path | Contents |
|---|---|
| `bin/` | `ve` dispatcher |
| `lib/` | shared core — process, ffmpeg, ranges, paths, cache, errors |
| `tools/` | one file per capability |
| `tests/` | one suite per tool, plus ffmpeg-generated fixtures |
| `raw/` | your source videos (read-only) |
| `output/` | final renders |
| `temp/` `cache/` | intermediates — safe to delete |
| `styles/` | style presets, kept out of the code |
| `pysrc/` | Python sidecars (Whisper, face detection, segmentation) |
| `remotion/` | motion-graphics components |
| `assets/` | `sfx/` `music/` `broll/` `overlays/` `fonts/` |
| `.claude/` | slash commands and the Skill |
| `edit-plans/` | edit plans and their reasoning logs |
| `docs/` | `STACK.md` — every dependency and why |

---

## Documentation

| File | What it covers |
|---|---|
| `CLAUDE.md` | Architecture, rules, and how to add a capability |
| `ROADMAP.md` | What works, what is planned, and **what was tried and rejected** |
| `docs/STACK.md` | Every tool, its role, how to verify it, and the version in use |

---

## Exit codes

`0` ok · `2` bad usage · `3` bad input · `4` missing dependency · `5` process failed ·
`6` output failed validation · `7` unsupported
