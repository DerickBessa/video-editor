# Motion graphics (Remotion)

Components render on a **transparent background** and are composited onto the video by ffmpeg.
Remotion produces an overlay; it does not own the render pipeline.

```bash
node bin/ve.mjs remotion-render Terminal --props '{"lines":["$ npm install","added 402 packages"]}' --duration 3
node bin/ve.mjs add-overlay video.mp4 --overlays "output/overlays/terminal.mov@12-15"
```

`ve remotion-render --list` shows every available component.

## Adding one

Export it from `components.jsx` and add it to `COMPONENTS` at the bottom. Nothing else needs
changing — `Root.jsx` looks components up by name at render time.

Keep the rule in mind: if it is only styled text, it belongs in `captions` (libass), which is far
cheaper than a headless browser. Use this for code, terminals, browser and phone frames, cards,
and anything that needs real layout.
