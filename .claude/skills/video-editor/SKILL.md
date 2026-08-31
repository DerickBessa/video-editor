---
name: video-editor
description: Edit videos with this project's toolkit — analyse, plan, cut silence, reframe to vertical, caption, add effects, render and QA. Use whenever the user wants to edit, trim, caption, reframe, or analyse a video in this repository, or asks to turn raw footage into a Short/Reel. Also use for changing an existing edit plan by description ("remove the zoom at 17s", "a legenda está muito baixa").
---

# Editing video in this project

37 independent tools, one JSON contract, one orchestrator. `ve capabilities` shows what is
working right now, backed by the test report — never claim a capability it does not list.

## The one thing to understand first

Everything routes through an **edit plan**: a JSON document describing the whole edit.
`edit-video` writes one, `render-edit` executes it. **Every timestamp in a plan is in SOURCE
time** — the original recording's timeline, before cutting. The renderer remaps events through
the cuts. That is why "remove the zoom at 17 seconds" refers to something stable, and why you
can change one number and re-render only what it touched.

## Start here

```bash
node bin/ve.mjs capabilities      # what works, and what is only planned
node bin/ve.mjs modes             # the editing styles and what each decides
node bin/ve.mjs <tool> --help     # every tool documents itself
```

## The usual job

```bash
node bin/ve.mjs edit-video raw/video.mp4 --style clean --language pt \
  --prompt "Claude Code, npm install, Docker"
```

That analyses, decides, writes `edit-plans/<name>-<style>.json` plus a `.reasoning.md`,
renders, and runs QA. Read the reasoning log and summarise it — it lists every decision with a
timestamp and a reason.

**Always pass `--prompt` with domain vocabulary.** On this project's own fixture it moved the
word error rate from 8.3% to 0.0%. Names and tool names are exactly what Whisper gets wrong, and
a mis-heard word propagates into captions, keywords and B-roll matching.

Styles: `clean`, `educational`, `viral`, `podcast`, `coding`, `landscape`.
`coding` deliberately does NOT crop to 9:16 — it letterboxes with a blurred fill, because
cropping a screen recording makes the code unreadable.

## Iterating on a result

Do not re-run the whole edit to change one thing. Change the plan:

```bash
node bin/ve.mjs nl-edit edit-plans/x-viral.json "remove the zoom between 17 and 20 seconds"
node bin/ve.mjs nl-edit edit-plans/x-viral.json --set 'captions.style="karaoke"'
node bin/ve.mjs render-edit edit-plans/x-viral.json
```

`nl-edit` pattern-matches common phrasings in English and Portuguese. For anything else,
**you** understand the sentence and express it precisely with `--set` / `--add` / `--remove`;
that is the intended division of labour, not a fallback. Every change is validated before it is
written, so a bad instruction cannot break a render.

Only the affected stage and those after it re-run — cuts and transcription stay cached.

## Individual tools

| Job | Tool |
|---|---|
| Understand | `probe-video` `transcribe` `detect-silence` `detect-scenes` `extract-frames` `analyze-visual` `track-faces` |
| Cut | `cut-video` `remove-silence` `remove-fillers` `change-speed` `freeze-frame` |
| Reframe | `crop-video` `smart-crop` `zoom-video` |
| Dress | `captions` `detect-keywords` `add-overlay` `add-broll` `add-sfx` `transitions` `blur-region` `background` |
| Audio | `normalize-audio` `denoise-audio` `compress-voice` `add-music` `duck-music` |
| Ship | `validate-edit-plan` `preview-edit` `render-edit` `qa-video` `contact-sheet` |

Every tool prints JSON on stdout and logs on stderr, so they pipe into `jq` and into each other.

## Rules that are not negotiable

1. **Never write into `raw/`.** It holds originals and the code refuses.
2. **Never claim something works because the code looks right.** Run it, check the output, then
   say so. `ve capabilities` reads the test report for exactly this reason.
3. **Report what the measurements show**, not what you assume. You have a transcript and
   numbers; you have not watched the video.
4. **When a tool warns, pass the warning on.** `smart-crop` reporting 0% face coverage, or
   `add-sfx` dropping effects over budget, is information the user needs.
5. **Preview before a long final render**, and prefer `--dry-run` on anything destructive.

## When something fails

Exit codes are meaningful: `2` bad usage, `3` bad input, `4` missing dependency, `5` process
failed, `6` output failed its own validation, `7` unsupported.

Code `6` means a tool checked its own output and refused to hand it over — for example
`background` finding no subject rather than blurring the whole frame. That is the system working;
report the reason rather than retrying blindly.

Transcription and face detection need the Python venv (`.venv`). If it is missing, the error
says how to create it. Everything else runs on FFmpeg alone.

## Known limits — state these rather than working around them silently

- **Scene detection misses crossfades.** It compares consecutive frames; a gradual transition
  never crosses the threshold at any single one. Verified at every threshold down to 0.5.
- **Whisper normalises disfluencies.** A spoken "ahn" often comes back as an invented
  low-confidence token, and stutters are silently collapsed. Filler removal is best-effort.
- **Face-detection accuracy is untested here.** There is no real footage of a person in the
  repo. The tracking, smoothing and framing maths are tested; the model's hit rate is not.
- **Caption position cannot be read back from a reference video.** That was tried and failed in
  both directions; `analyze-style` deliberately no longer claims it.

`ROADMAP.md` records every approach that was tried and rejected, with the measurements.
