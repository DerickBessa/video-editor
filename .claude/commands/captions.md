---
description: Generate or burn in word-timed captions.
---

Caption `$ARGUMENTS`.

```bash
# generate the .ass only, so styling can be iterated without re-transcribing
node bin/ve.mjs captions <video> --style clean --language <lang> --prompt "<vocabulary>"

# burn them in once the style is right
node bin/ve.mjs captions <video> --style viral --burn --language <lang>
```

Styles: `clean`, `minimal`, `viral` (word-by-word), `bold`, `karaoke`.

To highlight the words that matter, generate keywords first and pass them in:

```bash
node bin/ve.mjs detect-keywords <video> --per-minute 6 --out temp/kw.json
node bin/ve.mjs captions <video> --style viral --keywords temp/kw.json --burn
```

Font sizes are fractions of frame height, so a style looks the same on 1080x1920 and 720p.
