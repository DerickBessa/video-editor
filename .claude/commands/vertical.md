---
description: Convert a video to vertical 9:16.
---

Make `$ARGUMENTS` vertical.

Choose the right tool for the content — this is the decision that matters:

- **Talking head, person moves around** → `smart-crop`, which tracks the face:
  ```bash
  node bin/ve.mjs smart-crop <video> --resolution 1080x1920
  ```
  Check the reported `faceCoverage`. Below ~20% it is not really tracking; say so.

- **Static framing** → `crop-video`, a plain centre crop:
  ```bash
  node bin/ve.mjs crop-video <video> --aspect 9:16 --resolution 1080x1920
  ```

- **Screen recording or anything with text** → NEVER crop; the text becomes unreadable. Fit the
  whole frame with a blurred fill:
  ```bash
  node bin/ve.mjs crop-video <video> --resolution 1080x1920 --fit contain --background blur
  ```

Report the source and target geometry, and which approach you chose and why.
