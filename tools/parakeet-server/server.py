"""
Parakeet-TDT 0.6B MLX server — OpenAI-compatible /v1/audio/transcriptions endpoint.
Also exposes /asr?output=txt for backward compatibility with whisper-asr-webservice.

Run: uvicorn server:app --host 0.0.0.0 --port 9003
"""

import os
import tempfile
import time
import logging

from fastapi import FastAPI, File, Form, UploadFile, Query
from fastapi.responses import PlainTextResponse, JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger(__name__)

MODEL_ID = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
CHUNK_DURATION = int(os.environ.get("PARAKEET_CHUNK_DURATION", "120"))
OVERLAP_DURATION = int(os.environ.get("PARAKEET_OVERLAP_DURATION", "15"))

app = FastAPI(title="Parakeet MLX Server", version="1.0.0")

# Lazy-load model on first request (avoids startup cost if health-checking)
_model = None

def get_model():
    global _model
    if _model is None:
        logger.info(f"Loading model {MODEL_ID}...")
        from parakeet_mlx import from_pretrained
        _model = from_pretrained(MODEL_ID)
        logger.info("Model loaded.")
    return _model


def transcribe_file(path: str) -> dict:
    """Run transcription, return {text, segments, elapsed_ms}."""
    model = get_model()
    t0 = time.time()
    result = model.transcribe(
        path,
        chunk_duration=CHUNK_DURATION,
        overlap_duration=OVERLAP_DURATION,
    )
    elapsed_ms = int((time.time() - t0) * 1000)

    segments = []
    if hasattr(result, "sentences") and result.sentences:
        segments = [
            {"text": s.text, "start": s.start, "end": s.end}
            for s in result.sentences
        ]

    return {
        "text": result.text,
        "segments": segments,
        "elapsed_ms": elapsed_ms,
    }


async def _save_upload(upload: UploadFile) -> str:
    """Save uploaded file to a temp path, return path."""
    suffix = os.path.splitext(upload.filename or ".wav")[1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await upload.read()
        tmp.write(content)
        return tmp.name


# ---------- OpenAI-compatible endpoint ----------

@app.post("/v1/audio/transcriptions")
async def openai_transcribe(
    file: UploadFile = File(...),
    model: str = Form("parakeet-tdt-0.6b-v3"),
    response_format: str = Form("json"),
    language: str = Form("en"),
):
    tmp_path = await _save_upload(file)
    try:
        result = transcribe_file(tmp_path)
        size_mb = os.path.getsize(tmp_path) / (1024 * 1024)
        logger.info(
            f"Transcribed {upload_name(file)} ({size_mb:.1f}MB) in {result['elapsed_ms']}ms "
            f"-> {len(result['text'])} chars"
        )
        if response_format == "text":
            return PlainTextResponse(result["text"])
        return JSONResponse(result)
    finally:
        os.unlink(tmp_path)


# ---------- whisper-asr-webservice compatible endpoint ----------

@app.post("/asr")
async def whisper_compat(
    audio_file: UploadFile = File(...),
    output: str = Query("txt"),
    initial_prompt: str = Form(None),
):
    """
    Drop-in replacement for whisper-asr-webservice POST /asr?output=txt
    Same form field name (audio_file) and query param (output).
    """
    tmp_path = await _save_upload(audio_file)
    try:
        result = transcribe_file(tmp_path)
        size_mb = os.path.getsize(tmp_path) / (1024 * 1024)
        logger.info(
            f"Transcribed {upload_name(audio_file)} ({size_mb:.1f}MB) in {result['elapsed_ms']}ms "
            f"-> {len(result['text'])} chars"
        )
        if output == "txt" or output == "text":
            return PlainTextResponse(result["text"])
        if output == "vtt":
            return PlainTextResponse(_to_vtt(result), media_type="text/vtt")
        # Default: JSON
        return JSONResponse(result)
    finally:
        os.unlink(tmp_path)


def _to_vtt(result: dict) -> str:
    """Convert segments to WebVTT format."""
    lines = ["WEBVTT", ""]
    for seg in result.get("segments", []):
        start = _fmt_time(seg["start"])
        end = _fmt_time(seg["end"])
        lines.append(f"{start} --> {end}")
        lines.append(seg["text"].strip())
        lines.append("")
    if not result.get("segments"):
        # Fallback: single cue with full text
        lines.append("00:00:00.000 --> 99:59:59.000")
        lines.append(result.get("text", ""))
        lines.append("")
    return "\n".join(lines)


def _fmt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def upload_name(f: UploadFile) -> str:
    return f.filename or "unknown"


# ---------- Health ----------

@app.get("/health")
async def health():
    loaded = _model is not None
    return {"status": "ok", "model": MODEL_ID, "model_loaded": loaded}


@app.get("/")
async def root():
    return {"service": "parakeet-mlx", "model": MODEL_ID}
