"""
Read a short handwritten line (a NetID) with an open handwriting model, on this server.

Names and NetIDs never go to Claude; this keeps them here. Off unless HANDWRITING_MODEL
names a Hugging Face model (e.g. microsoft/trocr-small-handwritten). The model is
downloaded on first use and loaded once. Any failure returns None: a page is processed
the same with or without a reading.
"""

from __future__ import annotations

import logging
import os
import threading

import numpy as np

log = logging.getLogger("vision.handwriting")
MODEL = os.environ.get("HANDWRITING_MODEL", "").strip()

_lock = threading.Lock()
_loaded: tuple | None = None
_failed = False


def enabled() -> bool:
    return bool(MODEL) and not _failed


def _load() -> None:
    global _loaded, _failed
    with _lock:
        if _loaded is None and not _failed:
            try:
                import torch  # noqa: F401  (imported here so the service starts without it)
                from transformers import TrOCRProcessor, VisionEncoderDecoderModel

                proc = TrOCRProcessor.from_pretrained(MODEL)
                model = VisionEncoderDecoderModel.from_pretrained(MODEL).eval()
                _loaded = (proc, model)
                log.info("handwriting model loaded: %s", MODEL)
            except Exception as e:  # missing packages, no network, bad model name
                _failed = True
                log.error("handwriting model %s could not be loaded: %s", MODEL, e)


def start() -> None:
    """Load the model in the background, so a first download never holds up a page."""
    if MODEL:
        threading.Thread(target=_load, name="handwriting-load", daemon=True).start()


def status() -> str:
    if not MODEL:
        return "off"
    return "failed" if _failed else "ready" if _loaded else "loading"


def read(gray: np.ndarray) -> tuple[str, float] | None:
    """The text on a greyscale crop of one written line, and the model's confidence (0–1)."""
    loaded = _loaded  # None while still loading: this page goes without a reading
    if not enabled() or not loaded:
        return None
    proc, model = loaded
    try:
        import torch
        from PIL import Image

        rgb = np.stack([gray] * 3, axis=-1)
        pixels = proc(images=Image.fromarray(rgb), return_tensors="pt").pixel_values
        with torch.no_grad():
            out = model.generate(pixels, max_new_tokens=16, num_beams=4, output_scores=True, return_dict_in_generate=True)
        text = proc.batch_decode(out.sequences, skip_special_tokens=True)[0].strip()
        score = float(out.sequences_scores[0].exp()) if getattr(out, "sequences_scores", None) is not None else 0.0
        return text, round(score, 3)
    except Exception as e:
        log.warning("handwriting read failed: %s", e)
        return None
