---
description: Remove silent pauses from a video without clipping speech.
---

Remove silences from `$ARGUMENTS`.

Always start with `--dry-run` and report what WOULD be cut before cutting anything:

```bash
node bin/ve.mjs remove-silence <video> --intensity normal --dry-run
```

Intensities: `soft` (keeps most pauses), `normal`, `aggressive`. Add `--snap words --language <lang>`
to use word-level timestamps so a cut can never land inside a word — it costs one cached
transcription and is worth it for anything you will publish.

After rendering, report seconds saved and the percentage shorter. If the source is quiet or
noisy, `--method auto` measures the noise floor instead of assuming -35 dB.
