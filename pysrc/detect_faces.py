"""Face detection sidecar for smart-crop / speaker tracking.

Uses OpenCV's YuNet (FaceDetectorYN), not Haar cascades: OpenCV 5 no longer
ships the cascade XMLs at all, and YuNet is smaller, faster and considerably
more accurate on non-frontal faces. The model is a 230 KB ONNX file.

Samples at a low frame rate by default. Faces do not move fast enough to need
every frame, and sampling at 5 fps instead of 30 makes this six times cheaper
with no practical loss — the tracker smooths between samples anyway.

Contract, as with every tool here: JSON on stdout, logs on stderr.
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
    p = argparse.ArgumentParser(description="Detect faces over time")
    p.add_argument("--video", required=True)
    p.add_argument("--model", required=True, help="Path to face_detection_yunet.onnx")
    p.add_argument("--fps", type=float, default=5.0, help="Sampling rate")
    p.add_argument("--score", type=float, default=0.6, help="Detection confidence threshold")
    p.add_argument("--nms", type=float, default=0.3)
    p.add_argument("--max-side", type=int, default=640,
                   help="Downscale frames to this longest side before detecting")
    p.add_argument("--output", default=None)
    args = p.parse_args()

    if not os.path.isfile(args.video):
        fail(f"video not found: {args.video}", 3)
    if not os.path.isfile(args.model):
        fail(f"YuNet model not found: {args.model}", 4,
             "Download face_detection_yunet_2023mar.onnx from the opencv_zoo repo into models/")

    try:
        import cv2
    except ImportError as exc:
        fail(f"opencv is not installed in this interpreter: {exc}", 4,
             "Run: .venv/Scripts/python.exe -m pip install -r pysrc/requirements.txt")

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        fail(f"OpenCV could not open {args.video}", 3)

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if not width or not height:
        fail("could not read frame dimensions", 3)

    # Detect on a downscaled copy, then map boxes back to source coordinates.
    scale = min(1.0, args.max_side / max(width, height))
    dw, dh = int(round(width * scale)), int(round(height * scale))

    detector = cv2.FaceDetectorYN.create(args.model, "", (dw, dh), args.score, args.nms, 5000)
    detector.setInputSize((dw, dh))

    step = max(1, int(round(src_fps / max(0.1, args.fps))))
    log(f"[info]  {width}x{height} @{src_fps:.2f}fps, sampling every {step} frame(s) at {dw}x{dh}")

    samples = []
    frame_index = 0
    detected_frames = 0
    t0 = time.time()

    while True:
        ok = cap.grab()
        if not ok:
            break
        if frame_index % step == 0:
            ok, frame = cap.retrieve()
            if ok and frame is not None:
                small = cv2.resize(frame, (dw, dh)) if scale < 1.0 else frame
                _, faces = detector.detect(small)
                boxes = []
                if faces is not None:
                    for f in faces:
                        x, y, w, h = [float(v) / scale for v in f[:4]]
                        boxes.append({
                            "x": round(x, 1), "y": round(y, 1),
                            "w": round(w, 1), "h": round(h, 1),
                            "score": round(float(f[-1]), 4),
                            "cx": round((x + w / 2) / width, 5),
                            "cy": round((y + h / 2) / height, 5),
                            "area": round((w * h) / (width * height), 6),
                        })
                    if boxes:
                        detected_frames += 1
                samples.append({
                    "frame": frame_index,
                    "t": round(frame_index / src_fps, 3),
                    "faces": boxes,
                })
        frame_index += 1

    cap.release()

    result = {
        "video": args.video,
        "width": width,
        "height": height,
        "fps": round(src_fps, 3),
        "frameCount": total or frame_index,
        "sampleRate": round(src_fps / step, 3),
        "sampleCount": len(samples),
        "framesWithFaces": detected_frames,
        "coverage": round(detected_frames / len(samples), 4) if samples else 0,
        "detector": "yunet",
        "scoreThreshold": args.score,
        "elapsedMs": int((time.time() - t0) * 1000),
        "samples": samples,
    }

    payload = json.dumps(result, ensure_ascii=False)
    if args.output:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
    log(f"[info]  {detected_frames}/{len(samples)} samples had a face "
        f"({result['coverage'] * 100:.0f}% coverage) in {result['elapsedMs']}ms")
    sys.stdout.write(payload)


if __name__ == "__main__":
    main()
