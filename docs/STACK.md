# Stack

Every dependency, why it is here, and how to verify it.
Versions recorded on **2026-08-30**, Windows 11 (26200), 12 cores, 16 GB, RTX 5060.

Run `ve capabilities` for the live version of this table.

---

## Installed and in use

| Tool | Role in this project | Verify | Version found |
|---|---|---|---|
| **FFmpeg** | All deterministic media processing: cutting, encoding, filters, audio. The workhorse. | `ffmpeg -version` | `8.1.1-full_build-www.gyan.dev` |
| **FFprobe** | All media inspection and, critically, independent verification of our own output in tests. | `ffprobe -version` | `8.1.1` |
| **Node.js** | Tool/CLI layer and orchestration. Chosen over Python for the tool layer because Remotion (phase 5) requires it, JSON is native, and there is no build step. | `node --version` | `v20.19.0` |
| **npm** | Package management for the Node layer and Remotion. | `npm --version` | `11.17.0` |

No npm packages are installed. The entire Node layer is stdlib + FFmpeg; the only third-party
dependencies in the project are the Python sidecar packages listed below.

---

## The FFmpeg build matters

This is a `gyan.dev` full build, which is unusually complete and shapes several design decisions:

- **Encoders**: `h264_nvenc`, `hevc_nvenc`, `av1_nvenc`, `h264_qsv`, `h264_amf`, `libx264`, `libx265`
- **Hardware accel**: cuda, vaapi, dxva2, qsv, d3d11va, opencl, vulkan, d3d12va, amf
- **Subtitle rendering**: `libass` → `ass` and `subtitles` filters available, which means
  styled captions can be burned in without Remotion when animation is not needed.
- **Audio**: `loudnorm` (EBU R128), `sidechaincompress` (music ducking), `afftdn` / `arnndn`
  (denoise), `rubberband` (pitch-preserving speed), `silencedetect`
- **Video**: `zoompan`, `scdet` (scene change), `cropdetect`, `vidstabdetect`
- **`whisper` filter** — compiled in via `--enable-whisper`. Evaluated in phase 2 and
  **rejected**: no word-level timestamps, times snap to its processing window, and it dropped a
  whole sentence at a chunk boundary. See `ROADMAP.md`.

### Encoder selection is verified, not assumed

`lib/ffmpeg.mjs` runs a real 3-frame encode against each candidate before choosing one, because
being *listed* by `ffmpeg -encoders` is not proof it runs. On this machine that check matters:

| Candidate | Listed | Actually works |
|---|---|---|
| `h264_nvenc` | yes | **yes** — selected |
| `h264_qsv` | yes | no (no Intel iGPU) |
| `h264_amf` | yes | no (no AMD GPU) |

Result cached in `cache/hw.json`, keyed on the FFmpeg version. Delete that file to re-detect.

---

## GPU

| | |
|---|---|
| Device | NVIDIA GeForce RTX 5060 (Blackwell, `sm_120`) |
| VRAM | 8 GB |
| Driver | 610.47 |
| Used for | NVENC encoding, and Whisper transcription at ~30x realtime |

CPU fallback is always available: pass `--hw off` to any tool that encodes.

---

## Python — project-local venv only

There is a Python 3.11.15 on `PATH`, **but it belongs to another application**:

```
C:\Users\deric\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe
```

Installing project packages there would pollute an unrelated venv, so nothing was ever installed
into it. All sidecars run from `./.venv` (Python 3.11.15), created from the standalone
interpreter at `%APPDATA%\uv\python\cpython-3.11.15-windows-x86_64-none\python.exe`.

`lib/python.mjs` resolves the interpreter explicitly and never falls back to `PATH`.

### Setup

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r pysrc/requirements.txt
# optional, for GPU Whisper:
.venv/Scripts/python.exe -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

### Installed packages

| Package | Version | Why |
|---|---|---|
| `faster-whisper` | 1.2.1 | Transcription with word-level timestamps |
| `ctranslate2` | 4.8.1 | Inference engine behind faster-whisper — **no torch needed** |
| `onnxruntime` | 1.29.0 | Silero VAD (the optional `--vad` pre-filter) |
| `av` | 18.1.0 | Audio decoding inside faster-whisper |
| `nvidia-cublas-cu12` | 12.9.2.10 | CUDA BLAS runtime (GPU path, optional) |
| `nvidia-cudnn-cu12` | 9.25.1.1 | cuDNN runtime (GPU path, optional) |

Total ~2.3 GB, of which ~1.1 GB is the optional CUDA runtime.

### Why faster-whisper and not WhisperX

WhisperX was the stated first choice. faster-whisper was selected instead because it provides the
required word-level timestamps via CTranslate2 with **no torch dependency** (~200 MB of packages
instead of several GB), and reached **0.0 % word error rate** on the ground-truth fixture without
WhisperX's extra wav2vec2 alignment pass. Revisit if speaker diarisation is needed.

### GPU note (RTX 5060 / Blackwell)

CTranslate2 4.8.1 predates Blackwell, so `sm_120` kernels are JIT-compiled from PTX on first use.
The **first** GPU run is therefore slower than CPU (11.7 s vs 3.2 s on a 25 s clip); once CUDA has
cached the compiled kernels it is several times faster:

| Clip | CPU | GPU (warm) | Speedup |
|---|---|---|---|
| 24.7 s | 3.2 s (7.8x realtime) | 0.83 s (29.8x) | 3.8x |
| 198 s | 37.1 s (5.3x realtime) | 6.1 s (32.7x) | 6.1x |

The pip-installed CUDA DLLs live in `site-packages/nvidia/*/bin`, which is not on the Windows
loader path; `pysrc/transcribe.py` registers them with `os.add_dll_directory()`. Without that,
CTranslate2 raises `Library cublas64_12.dll is not found` even though the file is present.

The GPU path fails **lazily** — not at model load, but when the first segment is pulled from the
generator — so the CPU fallback wraps generator consumption, not just construction.

---

## Models

| File | Size | Used by |
|---|---|---|
| `models/models--Systran--faster-whisper-small/` | ~480 MB | `transcribe` (downloaded on first run) |
| `models/ggml-small.bin` | 465 MB | **unused** — downloaded to evaluate FFmpeg's `whisper` filter, which was rejected. Safe to delete. |

---

## Evaluated, deferred, or rejected

| Tool | Decision | Reason |
|---|---|---|
| **FFmpeg `whisper` filter** | **Rejected** (phase 2) | Evaluated first because it needed no install. No word timestamps; times snap to the 10 s window; lost a full sentence at a chunk boundary. |
| **faster-whisper** | **Adopted** (phase 2) | Word-level timestamps via CTranslate2, no torch. 0.0 % WER on the ground-truth fixture. |
| **WhisperX** | **Not installed** | faster-whisper already reaches 0 % WER with word timestamps at a fraction of the install size. Revisit only for speaker diarisation. |
| **PySceneDetect** | **Not installed** | FFmpeg `scdet` found every hard cut exactly, with no dependency. Its gradual-transition advantage is recorded as a known limitation instead. |
| **Auto-Editor** | **Not installed** | Duplicates `detect-silence` + `cut-video`, which are working and validated. |
| **OpenCV** | Phase 7 | Needed for face tracking / smart crop. Not before. |
| **yt-dlp** | Not installed | No current need. |
| **Remotion** | Phase 5 | Animated captions and motion graphics. A heavy dependency that phases 1-4 do not need. |

The rule: **check whether FFmpeg already does it before adding a dependency.** This build does
a surprising amount.

---

## Added in later phases

| Package | Where | Why | Size |
|---|---|---|---|
| `opencv-python-headless` | `.venv` | YuNet face detection for `smart-crop`, `track-faces`, `blur-region --faces`. OpenCV 5 dropped the bundled Haar cascades; YuNet is smaller and better anyway. | ~40 MB |
| `mediapipe` | `.venv` | Person segmentation for `background --mode blur/darken/replace`. `--mode vignette` needs none of it. | ~100 MB |
| `remotion` + `react` | `node_modules` | The motion-graphics component library. Renders transparent overlays that ffmpeg composites; never part of the render pipeline itself. | ~236 MB |

### Models

| File | Size | Used by |
|---|---|---|
| `models/models--Systran--faster-whisper-small/` | ~480 MB | `transcribe` |
| `models/face_detection_yunet.onnx` | 230 KB | `smart-crop`, `track-faces`, `blur-region --faces` |
| `models/selfie_segmenter.tflite` | 250 KB | `background --mode blur/darken/replace` |

Both small models are downloaded once; the URLs are in the tools' error messages when missing.

### Two platform traps worth remembering

**`drawtext` has no fonts on Windows.** It resolves font names through fontconfig, which Windows
does not ship, so every `drawtext` call fails with `Fontconfig error: Cannot load default config
file` unless given an explicit `fontfile=`. `lib/ffmpeg.mjs:findFont()` locates one and callers
degrade gracefully. libass (used for captions) has its own font handling and was never affected
— which is why captions worked while contact-sheet labels did not.

**Remotion transparency needs two settings, not one.** ProRes 4444 alone still rendered
`yuv422p12le` and composited as a solid rectangle. It needs `proResProfile: '4444'` AND
`pixelFormat: 'yuva444p10le'` AND `imageFormat: 'png'` — Remotion rejects an alpha pixel format
without PNG frames.

---

## Portability

| Platform | Status |
|---|---|
| Windows 11 | Verified — all 196 tests pass |
| Linux / WSL | Expected to work; not yet run. `findFont()` and the SAPI speech fixture have platform fallbacks. |
| macOS | Expected to work; NVENC would fall back to CPU or VideoToolbox (not yet wired) |

Portability measures already taken:
- No shell interpolation anywhere — `spawn` with an argv array, so spaces in paths are safe.
- All paths built with `node:path`.
- `escapeFilterPath()` handles the Windows `C:` colon inside FFmpeg filtergraphs.
- Hardware encoding is detected at runtime and falls back to `libx264`.
