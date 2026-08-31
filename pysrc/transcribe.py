"""Speech-to-text sidecar built on faster-whisper.

Follows the same CLI contract as the Node tools:
  stdout -> JSON only
  stderr -> human-readable progress
  exit 0 -> success, non-zero -> failure

Emits word-level timestamps, which is the whole reason this exists: FFmpeg's
built-in whisper filter only produces segment times snapped to its processing
window, and drops text at chunk boundaries. See docs/ROADMAP.md.
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


def register_cuda_dlls() -> list[str]:
    """Make pip-installed CUDA runtime DLLs findable on Windows.

    The nvidia-* wheels drop their DLLs in site-packages/nvidia/<lib>/bin, which
    is not on the loader path. Without this, CTranslate2 raises
    "Library cublas64_12.dll is not found" even though the file is present.
    """
    added = []
    if not hasattr(os, "add_dll_directory"):
        return added  # not Windows

    import site

    roots = list(site.getsitepackages())
    if hasattr(site, "getusersitepackages"):
        roots.append(site.getusersitepackages())

    for root in roots:
        nvidia = os.path.join(root, "nvidia")
        if not os.path.isdir(nvidia):
            continue
        for lib in sorted(os.listdir(nvidia)):
            bindir = os.path.join(nvidia, lib, "bin")
            if os.path.isdir(bindir):
                try:
                    os.add_dll_directory(bindir)
                    os.environ["PATH"] = bindir + os.pathsep + os.environ.get("PATH", "")
                    added.append(bindir)
                except OSError:
                    pass
    return added


def pick_device(requested: str):
    """Resolve device/compute_type, verifying CUDA actually initialises.

    A GPU being present is not proof CTranslate2 can use it: the wheel must
    contain kernels for that compute capability, and the CUDA/cuDNN runtime
    must load. So we build a tiny model on the GPU and see if it throws.
    """
    if requested == "cpu":
        return "cpu", "int8"

    try:
        import ctranslate2

        count = ctranslate2.get_cuda_device_count()
    except Exception as exc:  # pragma: no cover - depends on local install
        if requested == "cuda":
            fail(f"CUDA was requested but CTranslate2 could not query it: {exc}", 7)
        log(f"[warn]  CUDA unavailable ({exc}); using CPU")
        return "cpu", "int8"

    if count < 1:
        if requested == "cuda":
            fail("CUDA was requested but no CUDA device is visible to CTranslate2", 7)
        log("[warn]  no CUDA device visible; using CPU")
        return "cpu", "int8"

    return "cuda", "float16"


def main() -> None:
    p = argparse.ArgumentParser(description="Transcribe audio with word-level timestamps")
    p.add_argument("--audio", required=True)
    p.add_argument("--model", default="small")
    p.add_argument("--language", default=None, help="ISO code, or omit to auto-detect")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument("--vad", action="store_true", help="Silero VAD pre-filter")
    p.add_argument("--vad-min-silence", type=int, default=500, help="ms")
    p.add_argument("--model-dir", default=None)
    p.add_argument("--initial-prompt", default=None)
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--output", default=None, help="Also write the JSON here")
    args = p.parse_args()

    if not os.path.isfile(args.audio):
        fail(f"audio file not found: {args.audio}", 3)

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        fail(
            f"faster-whisper is not installed in this interpreter: {exc}",
            4,
            "Run: .venv/Scripts/python.exe -m pip install -r pysrc/requirements.txt",
        )

    vad_params = {"min_silence_duration_ms": args.vad_min_silence} if args.vad else None

    def attempt(device: str, compute_type: str):
        """Load, transcribe AND drain the generator.

        Draining matters: faster-whisper is lazy, so a missing CUDA runtime
        (cublas64_12.dll, cudnn*.dll) does not surface at load time or at the
        transcribe() call — only when the first segment is pulled. A fallback
        that wraps only the load would therefore never fire.
        """
        t_load = time.time()
        model = WhisperModel(
            args.model, device=device, compute_type=compute_type, download_root=args.model_dir
        )
        load_ms = int((time.time() - t_load) * 1000)

        t_run = time.time()
        segments_iter, info = model.transcribe(
            args.audio,
            language=args.language,
            beam_size=args.beam_size,
            word_timestamps=True,
            vad_filter=args.vad,
            vad_parameters=vad_params,
            initial_prompt=args.initial_prompt,
            temperature=args.temperature,
        )

        segments = []
        word_count = 0
        for seg in segments_iter:
            # Whisper signals word separation with a LEADING SPACE on the token.
            # Stripping it loses the distinction between "bem" + " vindo" (two
            # words) and "bem" + "-vindo" (one hyphenated word), which turns
            # "bem-vindo" into "bem -vindo" downstream. Keep the flag.
            words = [
                {
                    "word": w.word.strip(),
                    "spaceBefore": w.word[:1].isspace(),
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "probability": round(float(w.probability), 4),
                }
                for w in (seg.words or [])
            ]
            word_count += len(words)
            segments.append(
                {
                    "id": seg.id,
                    "start": round(seg.start, 3),
                    "end": round(seg.end, 3),
                    "text": seg.text.strip(),
                    "words": words,
                    # avg_logprob is a log probability; exp() puts it on 0..1 so
                    # the decision layer can threshold it like any confidence.
                    "confidence": round(float(min(1.0, pow(2.718281828, seg.avg_logprob))), 4),
                    "noSpeechProb": round(float(seg.no_speech_prob), 4),
                    "compressionRatio": round(float(seg.compression_ratio), 3),
                }
            )
            log(f"[info]  [{seg.start:7.2f} -> {seg.end:7.2f}] {seg.text.strip()[:70]}")

        return segments, info, word_count, load_ms, int((time.time() - t_run) * 1000)

    dll_dirs = register_cuda_dlls()
    if dll_dirs:
        log(f"[info]  registered {len(dll_dirs)} CUDA DLL director(ies)")

    device, compute_type = pick_device(args.device)
    log(f"[info]  model={args.model} device={device} compute={compute_type}")

    try:
        segments, info, word_count, load_ms, transcribe_ms = attempt(device, compute_type)
    except Exception as exc:
        if device != "cuda" or args.device == "cuda":
            fail(f"transcription failed on {device}: {exc}", 5)
        log(f"[warn]  GPU path failed ({type(exc).__name__}: {exc})")
        log("[warn]  falling back to CPU. To enable GPU install the CUDA runtime:")
        log("        .venv/Scripts/python.exe -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12")
        device, compute_type = "cpu", "int8"
        try:
            segments, info, word_count, load_ms, transcribe_ms = attempt(device, compute_type)
        except Exception as exc2:
            fail(f"transcription failed on CPU as well: {exc2}", 5)

    result = {
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 4),
        "duration": round(float(info.duration), 3),
        "model": args.model,
        "device": device,
        "computeType": compute_type,
        "vad": bool(args.vad),
        "beamSize": args.beam_size,
        "segments": segments,
        "segmentCount": len(segments),
        "wordCount": word_count,
        "text": " ".join(s["text"] for s in segments).strip(),
        "loadMs": load_ms,
        "transcribeMs": transcribe_ms,
    }

    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
    sys.stdout.write(payload)


if __name__ == "__main__":
    main()
