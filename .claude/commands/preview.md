---
description: Fast low-resolution render of an edit plan, to check decisions before committing.
---

Render a quick preview of `$ARGUMENTS`.

If given a VIDEO, first build a plan without rendering:
```bash
node bin/ve.mjs edit-video <video> --style <style> --plan-only --language <lang>
```

If given a PLAN, preview it directly:
```bash
node bin/ve.mjs preview-edit <plan> --scale 0.5
```

A preview runs the same pipeline as the final render, only smaller and faster — so anything it
shows is real. Report the duration, the stages that ran, and how many were served from cache.
