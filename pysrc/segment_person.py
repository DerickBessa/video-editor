"""Person/background matte generation for `background`.

Writes a grayscale MASK VIDEO (white = person, black = background) that FFmpeg
then uses with `maskedmerge`. Keeping the matte as a separate video file means
the compositing stays in FFmpeg where it belongs, and the mask can be inspected
or cached like any other intermediate.

Two things matter for the result not looking cheap:

  feather   A hard mask edge reads as a cut-out sticker. The mask is blurred
            slightly so the composite has a soft edge.
  temporal  Per-frame segmentation flickers at the boundary. Each mask is
            blended with the previous one, which costs a little responsiveness
            and removes almost all of the shimmer.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def fail(msg: str, code: int = 5, hint: str | None = None):
    log(f"[error] {msg}")
    if hint:
        log(f"        {hint}")
    sys.exit(code)


def main() -> None:
    p = argparse.ArgumentParser(description="Generate a person/background mask video")
    p.add_argument("--video", required=True)
    p.add_argument("--model", required=True, help="selfie_segmenter.tflite")
    p.add_argument("--output", required=True, help="Mask video to write")
    p.add_argument("--feather", type=int, default=9, help="Mask edge blur, in px (odd)")
    p.add_argument("--temporal", type=float, default=0.6,
                   help="0..1 — how much of the previous mask to keep, to stop flicker")
    p.add_argument("--threshold", type=float, default=0.5)
    args = p.parse_args()

    if not os.path.isfile(args.video):
        fail(f"video not found: {args.video}", 3)
    if not os.path.isfile(args.model):
        fail(f"segmentation model not found: {args.model}", 4,
             "Download selfie_segmenter.tflite from storage.googleapis.com/mediapipe-models into models/")

    try:
        import cv2
        import numpy as np
        import mediapipe as mp
        from mediapipe.tasks import python as mpp
        from mediapipe.tasks.python import vision
    except ImportError as exc:
        fail(f"missing dependency: {exc}", 4,
             "Run: .venv/Scripts/python.exe -m pip install -r pysrc/requirements.txt")

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        fail(f"OpenCV could not open {args.video}", 3)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    # FFV1 in MKV is lossless: a lossy mask would introduce ringing at exactly
    # the edge we are trying to keep clean.
    writer = cv2.VideoWriter(args.output, cv2.VideoWriter_fourcc(*"FFV1"), fps, (width, height), isColor=False)
    if not writer.isOpened():
        fail(f"could not open the mask writer for {args.output}", 5)

    opts = vision.ImageSegmenterOptions(
        base_options=mpp.BaseOptions(model_asset_path=args.model),
        running_mode=vision.RunningMode.VIDEO,
        output_category_mask=False,
        output_confidence_masks=True,
    )

    feather = args.feather if args.feather % 2 == 1 else args.feather + 1
    prev = None
    frames = 0
    covered = 0
    t0 = time.time()

    with vision.ImageSegmenter.create_from_options(opts) as segmenter:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            ts = int(frames * 1000 / fps)
            result = segmenter.segment_for_video(image, ts)

            # confidence_masks[0] is background, [1] is foreground for this model;
            # fall back to the only mask when a build returns a single one.
            masks = result.confidence_masks
            conf = masks[-1].numpy_view() if masks else None
            if conf is None:
                mask = np.zeros((height, width), dtype=np.uint8)
            else:
                mask = (np.clip(conf, 0.0, 1.0) * 255).astype(np.uint8)

            if feather > 1:
                mask = cv2.GaussianBlur(mask, (feather, feather), 0)

            if prev is not None and args.temporal > 0:
                mask = cv2.addWeighted(mask, 1.0 - args.temporal, prev, args.temporal, 0)
            prev = mask

            covered += float((mask > 127).mean())
            writer.write(mask)
            frames += 1

    cap.release()
    writer.release()

    if frames == 0:
        fail("no frames were read from the video", 3)

    result = {
        "video": args.video,
        "mask": args.output,
        "width": width,
        "height": height,
        "fps": round(fps, 3),
        "frames": frames,
        "expectedFrames": total,
        "feather": feather,
        "temporal": args.temporal,
        # Mean fraction of each frame classified as foreground. Near 0 means
        # nothing person-shaped was found, which the caller should report
        # rather than silently blurring the whole picture.
        "foregroundRatio": round(covered / frames, 4),
        "elapsedMs": int((time.time() - t0) * 1000),
    }
    log(f"[info]  {frames} frames, foreground {result['foregroundRatio'] * 100:.1f}% "
        f"in {result['elapsedMs']}ms")
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
