# Architecture & stack

Defer to the host project's stack if this lives inside an existing app. Otherwise:

| Concern | Choice | Notes |
|---|---|---|
| Web app | Node/TypeScript (Next.js or the host's framework) | PWA manifest so it installs on a phone |
| DB | PostgreSQL + Prisma | instructor already runs Prisma/Postgres elsewhere |
| Jobs | pg-boss (queue in Postgres) | no Redis needed |
| Vision worker | Python + FastAPI + OpenCV (`opencv-contrib-python` for ArUco, `QRCodeDetector`) + PyMuPDF for PDF → page images | separate Railway service; Node calls it over private networking. OpenCV in Node is painful; keep it in Python |
| In-browser framing | opencv.js or `js-aruco2` for live marker detection | framing feedback only; final alignment happens server-side |
| PDF stamping | pdf-lib (Node) | add markers + QR to the blank template |
| Model | Anthropic Claude API, vision + tool-use structured output | model names via env; verify current model IDs in docs.claude.com |
| Files | object storage (S3-compatible bucket) or a Railway volume | page images and crops; set a retention policy (see OPEN_QUESTIONS) |
| Auth | host app's auth; standalone: single-instructor login | |

## Railway layout
- `web` (Node): UI, API, job orchestration, pg-boss workers that call the model.
- `vision` (Python): `POST /pages` (PDF/image → page images), `POST /align` (image +
  layout markers → warped image, QR payload, confidence), `POST /crop` (aligned image +
  boxes → crops + ink density). Private network only.
- `postgres`: Railway plugin.
- Storage: bucket or volume.

## Env vars (example)
```
DATABASE_URL=
ANTHROPIC_API_KEY=
MODEL_TEXT=claude-haiku-5-5        # verify current IDs
MODEL_STRUCTURE=claude-sonnet-5-5
VISION_URL=http://vision.railway.internal:8000
STORAGE_*=
FUZZY_THRESHOLD=0.2
CONFIDENCE_THRESHOLD=0.8
```

## Pipeline
```
upload (PDF/photo) → vision:/pages → per page job:
  vision:/align → version from QR → vision:/crop (all slots)
  → blank? score 0 : model read (batched per page, cached)
  → deterministic scoring → slot_results → answer_groups update
→ review UI → overrides → export CSV
```
