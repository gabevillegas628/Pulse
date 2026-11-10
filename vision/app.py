"""
Quiz grader vision service: PDF pages out, aligned pages and answer-box crops back.

Pulse's backend is the only caller (Railway private network), and every request must carry
the shared secret in X-Vision-Token. Holds nothing permanently: uploaded documents sit in a
temp directory until Pulse deletes them or they expire, and no student work is logged.

  GET    /health
  POST   /documents                     multipart `file` (PDF or image) → {id, pages}
  GET    /documents/{id}/pages/{n}      page n (0-based): PNG for a PDF page, JPEG for a photo
  DELETE /documents/{id}
  POST   /process                       multipart: `page` image, `form` PDF, `spec` JSON → result
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import shutil
import tempfile
import time

import cv2
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Response, UploadFile

import pipeline as P

TOKEN = os.environ.get("VISION_TOKEN", "")
DOC_DIR = os.path.join(tempfile.gettempdir(), "vision-docs")
DOC_TTL_S = 6 * 3600
MAX_UPLOAD = 300 * 1024 * 1024

app = FastAPI(title="Pulse quiz grader vision", docs_url=None, redoc_url=None, openapi_url=None)


def authorised(x_vision_token: str = Header(default="")) -> None:
    if not TOKEN:
        raise HTTPException(503, "VISION_TOKEN is not set on the vision service")
    if not hmac.compare_digest(x_vision_token, TOKEN):
        raise HTTPException(401, "Bad or missing X-Vision-Token")


def sweep() -> None:
    """Drop documents nobody came back for."""
    if not os.path.isdir(DOC_DIR):
        return
    cutoff = time.time() - DOC_TTL_S
    for d in os.listdir(DOC_DIR):
        p = os.path.join(DOC_DIR, d)
        if os.path.getmtime(p) < cutoff:
            shutil.rmtree(p, ignore_errors=True)


def doc_path(doc_id: str) -> str:
    if not doc_id.isalnum():
        raise HTTPException(400, "Bad document id")
    p = os.path.join(DOC_DIR, doc_id)
    if not os.path.isdir(p):
        raise HTTPException(404, "No such document (expired?)")
    return p


async def read_limited(f: UploadFile) -> bytes:
    data = await f.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File too large")
    return data


@app.get("/health")
def health() -> dict:
    return {"ok": True, "configured": bool(TOKEN)}


@app.post("/documents", dependencies=[Depends(authorised)])
async def create_document(file: UploadFile = File(...)) -> dict:
    sweep()
    data = await read_limited(file)
    doc_id = secrets.token_hex(12)
    p = os.path.join(DOC_DIR, doc_id)
    os.makedirs(p)
    try:
        if data[:5] == b"%PDF-":
            pages = P.pdf_page_count(data)
            name = "doc.pdf"
        else:
            P.decode_image(data)  # refuse anything that is not an image now, not per page
            pages = 1
            name = "photo"
    except Exception:
        shutil.rmtree(p, ignore_errors=True)
        raise HTTPException(400, "Not a PDF or an image this service can read")
    with open(os.path.join(p, name), "wb") as fh:
        fh.write(data)
    return {"id": doc_id, "pages": pages}


@app.get("/documents/{doc_id}/pages/{n}", dependencies=[Depends(authorised)])
def document_page(doc_id: str, n: int) -> Response:
    p = doc_path(doc_id)
    pdf = os.path.join(p, "doc.pdf")
    if os.path.exists(pdf):
        data = open(pdf, "rb").read()
        if not 0 <= n < P.pdf_page_count(data):
            raise HTTPException(404, "No such page")
        ok, buf = cv2.imencode(".png", P.render_pdf_page(data, n))
        return Response(buf.tobytes(), media_type="image/png")
    if n != 0:
        raise HTTPException(404, "A photo has one page")
    img = P.decode_image(open(os.path.join(p, "photo"), "rb").read())
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return Response(buf.tobytes(), media_type="image/jpeg")


@app.delete("/documents/{doc_id}", dependencies=[Depends(authorised)])
def delete_document(doc_id: str) -> dict:
    shutil.rmtree(doc_path(doc_id), ignore_errors=True)
    return {"ok": True}


@app.post("/process", dependencies=[Depends(authorised)])
async def process(page: UploadFile = File(...), form: UploadFile = File(...), spec: str = Form(...)) -> dict:
    """
    spec: {"versions": [{"name": "A", "page": 1, "boxes": [{"id": "s1_enzyme", "box": [x, y, w, h]}]}],
           "version": "A" | null}   # version forces one instead of detecting
    """
    try:
        s = json.loads(spec)
        versions = [(v["name"], int(v["page"])) for v in s["versions"]]
        boxes = {v["name"]: v["boxes"] for v in s["versions"]}
        force = s.get("version")
        if force is not None and force not in boxes:
            raise ValueError(f"No version {force}")
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(400, f"Bad spec: {e}")
    try:
        f = P.form_for(await read_limited(form), versions)
    except Exception as e:
        raise HTTPException(400, f"Could not read the blank form: {e}")
    try:
        img = P.decode_image(await read_limited(page))
    except Exception:
        raise HTTPException(400, "Could not read the page image")
    return P.process(img, f, boxes, force)
