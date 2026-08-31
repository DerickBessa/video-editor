# CLAUDE.md

Instructions for any future Claude Code session working in this repository.

---

## What this project is

A modular toolkit for automatic video editing. **Not** one big script — a set of small,
independent, individually tested tools that can be composed. Claude is the *orchestrator and
decision layer*; the tools do the deterministic work.

```
LLM        decides            (what to cut, where to zoom, which B-roll)
Algorithms detect             (silence, scenes, faces, keywords)
FFmpeg     processes          (cut, encode, filter, mix)
Remotion   animates           (code, terminals, cards — as transparent overlays)
Whisper    understands speech (transcript, word timestamps)
```

---

## Architecture

Five layers, kept strictly separate:

| Layer | Job | Lives in |
|---|---|---|
| 1 Analysis | Understand the material. Read-only, produces JSON. | `tools/probe-video`, `detect-*`, `transcribe` |
| 2 Decision | Decide how to edit. This is where Claude works. | Produces an **edit plan** |
| 3 Execution | Apply changes. Pure functions of (input, params). | `tools/cut-video`, `zoom-video`, `captions` |
| 4 Render | Produce the final file. | `tools/render-edit` |
| 5 QA | Validate the result. | `tools/qa-video` |

Analysis tools must never mutate video. Execution tools must never make editorial decisions.
If a tool needs to *decide* something, that decision belongs in the edit plan instead.

---

## Layout

```
bin/ve.mjs         dispatcher: `ve <command>`
lib/               shared core — no editing logic here
  cli.mjs          arg parsing, stdout/stderr contract, exit codes
  ffmpeg.mjs       ffprobe/ffmpeg access, encoder detection, keyframes
  proc.mjs         child process runner
  ranges.mjs       time-interval algebra (used by nearly every tool)
  paths.mjs        project paths + the raw/ write guard
  hash.mjs         content fingerprinting for the cache
  errors.mjs       typed errors + exit codes
  log.mjs          stderr logging
  registry.mjs     the capability list
  edit-plan.mjs    the plan schema, validation and SOURCE-time remapping
  styles.mjs       the editing modes
  ass.mjs          subtitle generation
  python.mjs       bridge to the pysrc/ sidecars (always the project .venv)
tools/             one file per capability
pysrc/             Python sidecars: transcribe, detect_faces, segment_person
remotion/          motion-graphics components (transparent overlays only)
scripts/           one-off generators (the SFX catalogue)
models/            downloaded model files, not in git
tests/             one *.test.mjs per tool + fixtures.mjs + run.mjs
raw/               source videos — NEVER WRITTEN TO
output/            final renders
temp/              intermediates, safe to delete
cache/             content-hashed reusable artifacts
edit-plans/        edit plans + reasoning logs
styles/            style presets, separate from logic
assets/            sfx/ music/ broll/ overlays/ fonts/ — with catalog/manifest JSON
references/        videos to analyse for style
.claude/           slash commands and the Skill
```

---

## Non-negotiable rules

1. **Never write into `raw/`.** `prepareOutput()` enforces this; use it for every output path.
2. **stdout is JSON only.** All human output goes to stderr via `lib/log.mjs`. This is what
   makes tools pipeable and callable by the orchestrator.
3. **Verify output, do not trust it.** Every tool that produces media re-probes the file it
   wrote and fails if it does not match what was promised. `cut-video` checks duration drift;
   `extract-audio` checks sample rate and channels.
4. **A capability is not done until a test proves it.** `ve capabilities` reads
   `tests/.results/latest.json` and downgrades anything unproven. Do not mark something working
   in `lib/registry.mjs` without a passing suite.
5. **Never fake a test.** No mocks standing in for real media. Tests run real FFmpeg against
   real generated fixtures and assert on real ffprobe output.
6. **Record failures.** If an approach does not work, add it to `ROADMAP.md` under
   FAILED/REJECTED with the reason. Do not silently try something else.
7. **Cache expensive work.** Key on `cacheKey(file, config)` from `lib/hash.mjs`. Never
   re-transcribe or re-decode unchanged input.
8. **Check FFmpeg before adding a dependency.** This build is unusually complete
   (see `docs/STACK.md`). It has libass, loudnorm, sidechaincompress, zoompan, scdet, and
   even a built-in `whisper` filter.

---

## Adding a new capability

1. Create `tools/<name>.mjs`. Export a pure `async function <name>(input, opts)` **and** a
   `tool` descriptor, then call `runIfMain(tool, import.meta.url)`.
2. Take input as a path or JSON; return a plain object. Never `console.log` — return the data.
3. Throw typed errors from `lib/errors.mjs` so the exit code is meaningful.
4. Add an entry to `lib/registry.mjs` (status `planned` until tests pass).
5. Write `tests/<name>.test.mjs` that runs the real thing and verifies the real output.
6. Run `npm test`. Only then set the status to `working`.

Skeleton:

```js
import { runIfMain } from '../lib/cli.mjs';
import { resolveInput, prepareOutput, relToRoot } from '../lib/paths.mjs';

export async function myThing(input, opts = {}) {
  const abs = resolveInput(input, 'video');
  const out = prepareOutput(opts.out || 'output/thing.mp4');
  // ... do the work, then verify `out` before returning
  return { source: relToRoot(abs), output: relToRoot(out) };
}

export const tool = {
  name: 'my-thing',
  summary: 'One line.',
  args: { input: { positional: 0, required: true, help: '...' } },
  run: opts => myThing(opts.input, opts),
  pretty: r => `wrote ${r.output}`,
};

runIfMain(tool, import.meta.url);
```


---

## The edit plan (phase 6 onwards)

This is the centre of the system. An edit plan is one JSON document describing an entire edit,
and `edit-video` writes one before rendering anything.

**Every timestamp in a plan is in SOURCE time** — the original recording's timeline, before any
cutting. Cutting runs first in the pipeline, so `render-edit` remaps every other event through
the cuts (via `ranges.mapToCut`) at render time.

This matters more than it looks. If events were stored post-cut, changing one cut would silently
move every zoom, caption and sound effect. Because they are stored in source time:

- a human (or Claude) can read the plan against the original video and it makes sense
- "remove the zoom at 17 seconds" refers to something stable
- an event that ends up inside removed footage is **dropped and reported**, never slid somewhere
  else

### Working with plans

```bash
ve edit-video raw/x.mp4 --style viral --plan-only   # decide, write the plan, render nothing
$EDITOR edit-plans/x-viral.json                     # change one number
ve validate-edit-plan edit-plans/x-viral.json       # catch mistakes before spending GPU time
ve preview-edit edit-plans/x-viral.json             # fast, small, same pipeline
ve render-edit edit-plans/x-viral.json              # only the changed stage re-runs
```

### Stage order is fixed and not negotiable

```
cuts -> speed -> crop -> zoom -> overlays -> captions -> audio -> sfx
```

`cuts` first because everything downstream lives in the cut timeline. `captions` late because
text burned before a crop would be cropped. `audio` after all retiming, because loudness of a
retimed track is not the loudness of the original.

### Caching

Intermediates go to `temp/render/<sourceId>/<n>-<stage>-<hash>.mp4`, keyed on **the source**, not
the plan. Per-stage identity comes from that stage's settings plus its input file's fingerprint.
Keying the directory on the plan was tried and was wrong: it orphaned every intermediate whenever
any part of the plan changed, defeating the point.

### Adding a stage

1. Build the tool first, with its own tests. `render-edit` must contain no editing logic.
2. Add the stage name to `STAGES` in `lib/edit-plan.mjs`, in the correct position.
3. Teach `activeStages()` when it has work, and `pickStage()` what settings it hashes on.
4. Add a `case` to `runStage()` in `render-edit.mjs` that calls the tool.
5. Add validation for its plan fields in `validatePlan()`.
6. If it carries timestamps, remap them in `toCutTimeline()`.

---

## Styles

`lib/styles.mjs` holds the editorial opinions: `clean`, `educational`, `viral`, `podcast`,
`coding`, `landscape`. A style is defaults plus limits, never new capability. A JSON file in
`styles/<name>.json` overrides the built-in of the same name, so a user's house style lives
outside the code.

Notable choices, each with a reason:
- **coding** uses `crop.mode: contain` with a blurred fill — cropping a screen recording to 9:16
  makes the code unreadable.
- **podcast** is the only style using `crop.mode: smart` (face tracking), because it is the only
  one where the cost is justified.
- **viral** is not "more features", it is a different attention budget: shorter cues, tighter
  silence, zooms and effects rationed per minute.

---

## Where each dependency is allowed

The project is FFmpeg-first on purpose. Before adding anything, check whether this FFmpeg build
already does it — it does a surprising amount (libass, loudnorm, sidechaincompress, zoompan,
scdet, xfade, maskedmerge, vignette, even a `whisper` filter).

| Layer | May depend on | Must NOT depend on |
|---|---|---|
| `lib/` | Node stdlib, FFmpeg | Python, npm packages |
| `tools/` analysis + edit | FFmpeg; Python via `lib/python.mjs` | Remotion |
| `tools/render-edit` | the other tools | Remotion, browsers |
| `remotion/` | React, Remotion | anything in `tools/` |

`render-edit` calling into a headless browser would make every render slow and uncacheable.
Remotion produces an overlay FILE; `add-overlay` composites it. Keep it that way.

---

## Things that were true and cost time to discover

Recorded here because they are invisible until they bite:

- **`ffmpeg -loglevel error` hides detector output.** `silencedetect`, `volumedetect`, `scdet`
  and `astats` all report at INFO. A detector wrapped in the default log level silently returns
  nothing.
- **`ametadata=print:file=-` writes to STDOUT**, not the log. Scanning stderr finds nothing.
- **`drawtext` needs an explicit `fontfile=` on Windows.** Use `findFont()`.
- **`amix` normalises by default**, quietly halving the voice when you add one quiet effect.
  Always `normalize=0`.
- **`fade=t=out` holds its final state forever.** Chaining out-then-in without `enable` leaves
  the rest of the video black.
- **`afftdn`'s `nf` is a noise-floor ESTIMATE, not a strength dial.** Setting it too low makes
  the filter do almost nothing. Measure the floor.
- **Whisper marks word separation with a LEADING SPACE** on each token. Strip it and
  "bem-vindo" becomes "bem -vindo".
- **A cached result must have the same SHAPE as a fresh one.** Cached render stages and mask
  files persist their metadata for exactly this reason; a field that only exists on a cold run
  is a contract bug.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | bad usage / arguments |
| 3 | missing or unreadable input |
| 4 | required external tool not installed |
| 5 | external process failed |
| 6 | output failed its own validation |
| 7 | unsupported / not implemented |

---

## Commands

```bash
node bin/ve.mjs                       # list commands
node bin/ve.mjs capabilities          # what works, backed by the test report
node bin/ve.mjs <tool> --help         # per-tool usage
npm test                              # full suite
node tests/run.mjs cut                # one suite
node tools/cut-video.mjs --help       # tools run standalone too
```

---

## Working style expected here

Build one capability at a time. Implement it, run it against real media, show the actual
output, and only then move on. Do not build five tools and test them at the end. When
something does not work, say so and write it down — a documented failure is worth more than
a silent workaround.
