---
description: Edit a raw video end to end — analyse, plan, render, QA.
---

Edit `$ARGUMENTS` using this project's toolkit.

If no style was given, ask which one, showing `node bin/ve.mjs modes` output. If the video is
in Portuguese, always pass `--language pt` and a `--prompt` listing proper nouns and technical
terms that appear in it — without that, Whisper mangles them and they end up mis-captioned.

Run:

```bash
node bin/ve.mjs edit-video <video> --style <style> --language <lang> --prompt "<vocabulary>"
```

Then:

1. Read `edit-plans/<name>-<style>.reasoning.md` and summarise the decisions for the user in a
   few lines — what was cut, why, where the zooms landed.
2. Report the QA result. If QA failed, say exactly which check failed and what you propose.
3. Offer the plan for adjustment: the plan JSON is beside the reasoning log, timestamps are in
   ORIGINAL-video time, and `ve render-edit` re-runs only the stages affected by a change.

Do not describe the video's content as if you watched it. You have the transcript and
measurements; say what those show.
