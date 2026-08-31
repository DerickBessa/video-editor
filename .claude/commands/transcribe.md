---
description: Transcribe a video with word-level timestamps.
---

Transcribe `$ARGUMENTS`:

```bash
node bin/ve.mjs transcribe <video> --language <lang> --prompt "<proper nouns, tool names>"
```

The `--prompt` matters more than it looks: on this project's own fixture it took the word error
rate from 8.3% to 0.0%, purely by listing "Claude Code, npm install, terminal". Always supply
one when you know the domain vocabulary.

Results are cached on (file content + settings), so re-running is free. Report the language,
word count, and the realtime factor. If the text contains obvious mis-hearings of names, suggest
re-running with those names added to the prompt.
