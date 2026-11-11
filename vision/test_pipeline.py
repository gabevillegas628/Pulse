"""
Tests for pipeline.py, on pages built from the real sample quiz PDFs:

  - a copier scan of an old print (no markers): shrunk, tilted and shifted
  - a phone photo of a page printed by Pulse (markers): perspective, uneven light, blur, JPEG
  - a phone photo of an old print (no markers): the paper's edges must do the work
  - each of versions A, B and C, with "handwriting" in some boxes and others left empty

Each must line up with the form's lines matching well, be called the right version, and
find writing exactly where it was put. The Phase 3 acceptance check.

Run from the repo root:  python3 -m unittest vision/test_pipeline.py -v
"""
from __future__ import annotations

import os
import re
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import pipeline as P  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")
GLY_PDF = open(os.path.join(ROOT, "docs/quiz-grader/samples/glycolysis-quiz-versions-ABC.pdf"), "rb").read()
LAYOUT = open(os.path.join(ROOT, "docs/quiz-grader/seed/layouts/glycolysis-template-v1.yaml")).read()
BOXES = {
    m.group(1): [float(v) for v in m.group(2).split(",")]
    for m in re.finditer(r"id: (\w+),.*?box: \[([^\]]+)\]", LAYOUT)
}
VERSIONS = [("A", 1), ("B", 2), ("C", 3)]
STRUCTURES = {"A": ["int_bpg13", "int_pg2", "int_pep"], "B": ["int_bpg13", "int_pg3", "int_f16bp"], "C": ["int_f6p", "int_pg2", "int_pyruvate"]}
ENZYMES = [f"s{n}_enzyme" for n in range(1, 11)]


def boxes_for(version: str) -> list[dict]:
    ids = ["name", "netid"] + ENZYMES + STRUCTURES[version]
    return [{"id": i, "box": BOXES[i]} for i in ids]


def write(img: np.ndarray, box: list[float], text: str, grey: int = 70) -> None:
    """Pencil-ish 'handwriting' near the top-left of a box."""
    h, w = img.shape
    x, y, bw, bh = box
    cv2.putText(img, text, (int((x + 0.03) * w), int((y + bh * 0.45) * h)), cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, 1.1, grey, 2, cv2.LINE_AA)


def filled(version: str, empty: set[str]) -> np.ndarray:
    page = P.render_pdf_page(GLY_PDF, dict(VERSIONS)[version] - 1).copy()
    for i in ["name", "netid"] + ENZYMES + STRUCTURES[version]:
        if i not in empty:
            write(page, BOXES[i], "C-O-P" if i.startswith("int_") else "abc kinase")
    return page


def printed_with_markers(page: np.ndarray) -> np.ndarray:
    """What printing from Pulse puts on paper: the form at 90% about the centre, markers in the corners."""
    h, w = page.shape
    out = np.full_like(page, 255)
    small = cv2.resize(page, (round(w * P.PRINT_SCALE), round(h * P.PRINT_SCALE)), interpolation=cv2.INTER_AREA)
    y0, x0 = (h - small.shape[0]) // 2, (w - small.shape[1]) // 2
    out[y0:y0 + small.shape[0], x0:x0 + small.shape[1]] = small
    d = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    size = round(P.MARKER_SIZE_IN * P.DPI)
    inset = round(P.MARKER_INSET_IN * P.DPI)
    spots = {0: (inset, inset), 1: (w - inset - size, inset), 2: (w - inset - size, h - inset - size), 3: (inset, h - inset - size)}
    for mid, (x, y) in spots.items():
        out[y:y + size, x:x + size] = cv2.aruco.generateImageMarker(d, mid, size)
    return out


def copier(page: np.ndarray) -> np.ndarray:
    """Shrunk 96%, tilted 0.8°, shifted: a careless copier scan."""
    h, w = page.shape
    M = cv2.getRotationMatrix2D((w / 2, h / 2), 0.8, 0.96)
    M[:, 2] += (25, -18)
    return cv2.warpAffine(page, M, (w, h), borderValue=255)


def phone(page: np.ndarray, seed: int) -> np.ndarray:
    """A 2400×3000 photo: perspective, on a grey desk, uneven light, blur, noise, JPEG."""
    rng = np.random.default_rng(seed)
    h, w = page.shape
    ow, oh, m = 2400, 3000, 220
    dst = np.float32([[m + rng.uniform(0, 200), m + rng.uniform(0, 150)], [ow - m - rng.uniform(0, 200), m + rng.uniform(80, 260)],
                      [ow - m - rng.uniform(80, 300), oh - m - rng.uniform(0, 200)], [m + rng.uniform(100, 320), oh - m - rng.uniform(60, 260)]])
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), dst)
    photo = cv2.warpPerspective(page, M, (ow, oh), borderValue=95).astype(np.float32)
    yy, xx = np.mgrid[0:oh, 0:ow]
    photo *= (0.78 + 0.22 * xx / ow) * (0.88 + 0.12 * yy / oh)
    photo = cv2.GaussianBlur(photo, (5, 5), 1.3) + rng.normal(0, 5, photo.shape)
    ok, enc = cv2.imencode(".jpg", np.clip(photo, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 82])
    return P.decode_image(enc.tobytes())


class Pipeline(unittest.TestCase):
    form: P.Form

    @classmethod
    def setUpClass(cls):
        cls.form = P.form_for(GLY_PDF, VERSIONS)
        cls.boxes = {v: boxes_for(v) for v, _ in VERSIONS}
        os.makedirs(os.environ.get("VISION_TEST_OUT", "/tmp/vision-test"), exist_ok=True) if os.environ.get("VISION_TEST_OUT") else None

    def check(self, name: str, img: np.ndarray, version: str, empty: set[str], method: str):
        r = P.process(img, self.form, self.boxes)
        out = os.environ.get("VISION_TEST_OUT")
        if out:
            flat = cv2.imdecode(np.frombuffer(__import__("base64").b64decode(r["aligned"]), np.uint8), cv2.IMREAD_GRAYSCALE)
            over = cv2.cvtColor(flat, cv2.COLOR_GRAY2BGR)
            for b in self.boxes[version]:
                l, t, rr, bt = P.box_rect(b["box"], flat.shape[1], flat.shape[0])
                cv2.rectangle(over, (l, t), (rr, bt), (200, 80, 0), 3)
            cv2.imwrite(os.path.join(out, f"{name}.png"), over[::2, ::2])
        blank = {c["id"] for c in r["crops"] if c["blank"]}
        summary = f"{name}: {r['method']} markers={r['markers']} match={r['match']:.3f} version={r['version']} fits={r['fits']} blank={sorted(blank)}"
        print(summary)
        self.assertEqual(r["method"], method, summary)
        self.assertGreater(r["match"], 0.9, summary)
        self.assertEqual(r["version"], version, summary)
        # Never skip writing: every box something was written in is read.
        written = {b["id"] for b in self.boxes[version]} - empty
        self.assertFalse(blank & written, summary)
        # Empty boxes are found empty, unless a generous box reaches a neighbour's writing
        # (structure boxes overlap the step boxes beside them, on purpose).
        self.assertEqual({e for e in empty if not e.startswith("int_")}, blank - {i for i in blank if i.startswith("int_")}, summary)

    def test_copier_scan_old_print(self):
        empty = {"s4_enzyme", "int_pep"}
        self.check("copier-A", copier(filled("A", empty)), "A", empty, "lines")

    def test_copier_scan_of_marker_print(self):
        empty = {"s9_enzyme"}
        self.check("copier-markers-B", copier(printed_with_markers(filled("B", empty))), "B", empty, "markers")

    def test_phone_photo_of_marker_print(self):
        for seed, v in enumerate("ABC"):
            empty = {"s2_enzyme", STRUCTURES[v][1]}
            with self.subTest(version=v):
                self.check(f"phone-markers-{v}", phone(printed_with_markers(filled(v, empty)), seed), v, empty, "markers")

    def test_phone_photo_of_old_print(self):
        empty = {"s7_enzyme"}
        self.check("phone-old-C", phone(filled("C", empty), 7), "C", empty, "paper edges")

    def test_unclear_version_is_not_guessed(self):
        # A page with every version's stars scribbled out can't be told apart.
        page = filled("A", set())
        for v in "ABC":
            for s in STRUCTURES[v]:
                x, y, w, h = BOXES[s]
                cv2.rectangle(page, (int(x * 1700), int(y * 2200)), (int((x + 0.06) * 1700), int((y + h) * 2200)), 0, -1)
        r = P.process(page, self.form, self.boxes)
        self.assertIsNone(r["version"], r["fits"])
        self.assertEqual(r["crops"], [])

    def test_forced_version(self):
        r = P.process(filled("B", set()), self.form, self.boxes, force_version="A")
        self.assertEqual(r["version"], "A")
        self.assertEqual(r["version_detected"], "B")



class Handwriting(unittest.TestCase):
    """Boxes marked `read` go to the reader, cleaned of the printed form; others never do."""

    def test_reader_hook(self):
        flat = np.full((400, 600), 255, np.uint8)
        printed = np.zeros_like(flat, bool)
        printed[80:84, 20:580] = True              # a printed line to write on
        flat[80:84, 20:580] = 0
        cv2.putText(flat, "ab123", (60, 75), cv2.FONT_HERSHEY_SIMPLEX, 1.5, 0, 3)  # the "handwriting"
        seen = []

        def reader(img):
            seen.append(img)
            return ("ab123", 0.9)

        boxes = [
            {"id": "netid", "box": [0.0, 0.0, 1.0, 0.25], "read": True},
            {"id": "s1_enzyme", "box": [0.0, 0.0, 1.0, 0.25]},
            {"id": "empty", "box": [0.0, 0.6, 1.0, 0.3], "read": True},
        ]
        out = {c["id"]: c for c in P.crop_boxes(flat, printed, boxes, 200, reader)}
        self.assertEqual(out["netid"]["text"], "ab123")
        self.assertEqual(out["netid"]["text_score"], 0.9)
        self.assertNotIn("text", out["s1_enzyme"])
        self.assertNotIn("text", out["empty"])     # blank: nothing to read
        self.assertEqual(len(seen), 1)
        # The printed line is painted out, and the crop is trimmed to the writing.
        self.assertLess(seen[0].shape[1], 600)
        self.assertFalse((seen[0] < 60).all(axis=1).any())

    def test_no_reader_no_text(self):
        flat = np.full((100, 100), 255, np.uint8)
        flat[40:60, 20:80] = 0
        c = P.crop_boxes(flat, np.zeros_like(flat, bool), [{"id": "netid", "box": [0, 0, 1, 1], "read": True}], 200)[0]
        self.assertNotIn("text", c)


if __name__ == "__main__":
    unittest.main()
