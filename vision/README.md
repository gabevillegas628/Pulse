# Quiz grader vision service

A small Python service that does the image work for Pulse's quiz grader: splits scanned
PDFs into pages, lines each page up with its blank form (corner markers, else the form's
printed lines, else the paper's edges), works out the version, and crops every answer box
with a flag for empty ones. Pulse's backend is its only caller.

It keeps nothing: uploads sit in a temp folder until Pulse deletes them (or 6 hours pass),
and requests are not logged. Student work lives in Pulse, not here.

## Deploy on Railway (one-time)

1. In the Pulse project, **New → GitHub Repo →** this repo. Name the service `vision`.
2. Service **Settings → Source → Root Directory:** `vision`. Railway builds the Dockerfile.
3. **Settings → Networking:** no public domain. Pulse reaches it on the private network.
4. **Variables:** `VISION_TOKEN` = a long random string (`openssl rand -hex 32`).
5. On the **Pulse** service, add variables:
   - `VISION_URL` = `http://vision.railway.internal:${{vision.PORT}}` (or the port shown
     in the vision service's settings)
   - `VISION_TOKEN` = the same string as above
6. Redeploy Pulse. Its scans screen says "not set up" until both variables are present.

Memory: ~300 MB idle, more while processing a page; the smallest plan with 1 GB is plenty.

## Run locally

    pip install -r requirements.txt
    VISION_TOKEN=devtoken HOST=0.0.0.0 PORT=8100 uvicorn app:app --host 0.0.0.0 --port 8100

and run Pulse's backend with `VISION_URL=http://localhost:8100 VISION_TOKEN=devtoken`.

## Tests

    python3 -m unittest vision/test_pipeline.py -v      # from the repo root

Builds test pages from the real sample quizzes: a crooked copier scan, a copier scan of a
marker print, angled phone photos of marker prints (versions A, B, C), and an angled
phone photo of an old print. Each must line up (>90% of the form's lines matching), get
its version right, and never mark a box with writing in it as empty. Set
`VISION_TEST_OUT=<dir>` to save each aligned page with its boxes drawn on.

## Must match Pulse

`PRINT_SCALE`, `MARKER_SIZE_IN` and `MARKER_INSET_IN` in `pipeline.py` must equal the
values in `backend/src/quizGrader/print.ts`. Printed quizzes depend on them forever.
