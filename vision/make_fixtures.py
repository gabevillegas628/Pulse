"""
Write test uploads for Pulse's scan smoke test (backend/scripts/smoke-quiz-scans.ts),
built the same way as test_pipeline.py's pages:

  copier.pdf          3 pages: a crooked copier scan of version A (old print), a copier
                      scan of a marker print of B, and a page whose version can't be told
  phone-markers.jpg   an angled phone photo of a marker print, version C
  phone-old.jpg       an angled phone photo of an old print, version A

Usage (from the repo root):  python3 vision/make_fixtures.py <out dir>
"""
import os
import sys

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import test_pipeline as T  # noqa: E402

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

unclear = T.filled("A", set())
for v in "ABC":
    for s in T.STRUCTURES[v]:
        x, y, w, h = T.BOXES[s]
        cv2.rectangle(unclear, (int(x * 1700), int(y * 2200)), (int((x + 0.06) * 1700), int((y + h) * 2200)), 0, -1)

pages = [T.copier(T.filled("A", {"s4_enzyme"})), T.copier(T.printed_with_markers(T.filled("B", {"s9_enzyme"}))), unclear]
ims = [Image.fromarray(p) for p in pages]
ims[0].save(os.path.join(out, "copier.pdf"), save_all=True, append_images=ims[1:], resolution=200)
cv2.imwrite(os.path.join(out, "phone-markers.jpg"), T.phone(T.printed_with_markers(T.filled("C", {"s2_enzyme"})), 2))
cv2.imwrite(os.path.join(out, "phone-old.jpg"), T.phone(T.filled("A", {"s7_enzyme"}), 7))
print("wrote", sorted(os.listdir(out)))
