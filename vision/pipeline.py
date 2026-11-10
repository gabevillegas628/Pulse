"""
Page processing for the quiz grader: line a scanned or photographed quiz page up with
its blank form, tell which version it is, and cut out every answer box.

Pure functions over numpy images; app.py puts HTTP around them. Nothing here knows about
glycolysis, stars or any particular quiz: forms, boxes and versions all come in as data.

Alignment, in order of preference:
  1. Corner markers (ArUco DICT_4X4_50, ids 0-3), printed by Pulse (backend/src/quizGrader/
     print.ts). Their known positions give an exact perspective correction, so a phone
     photo taken at an angle comes out flat.
  2. The form's own printed lines: a search over shift, scale and slight tilt that lays
     the blank form's thick lines over the scan. Handles copier scans of any print.
  3. The paper's edges, for an angled photo of a page printed without markers: flatten
     the sheet, then search the lines again.
The method used and how well the form's lines match afterwards are reported per page.
"""
from __future__ import annotations

import base64
import hashlib
import io
from dataclasses import dataclass, field

import cv2
import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageOps

DPI = 200

# Must match backend/src/quizGrader/print.ts. Printed pages carry these forever.
PRINT_SCALE = 0.9
MARKER_SIZE_IN = 0.4
MARKER_INSET_IN = 0.22
MARKER_IDS = {"top_left": 0, "top_right": 1, "bottom_right": 2, "bottom_left": 3}

# Box cropping and blank detection, as calibrated in the Phase 0 spike at 200 dpi.
MARGIN = 0.006
BLANK_MIN_PIXELS = 60
BLANK_MIN_SHARE = 0.0006
INK_MAX = 200

# Version calls: this good a fit, this far ahead of the next.
VERSION_MIN_FIT = 0.85
VERSION_MIN_LEAD = 0.15

# Below this share of the form's lines found after alignment, try the next method.
GOOD_MATCH = 0.8

# Phone photos are downscaled to this longest side before anything else; plenty for
# markers and 200 dpi output, and it keeps a 12-megapixel photo fast.
MAX_INPUT_SIDE = 3000


# ── Loading ──────────────────────────────────────────────────────────────────────


def pdf_page_count(pdf: bytes) -> int:
    return len(pdfium.PdfDocument(pdf))


def render_pdf_page(pdf: bytes, index: int, dpi: int = DPI) -> np.ndarray:
    """One page (0-based) as an 8-bit greyscale image."""
    doc = pdfium.PdfDocument(pdf)
    page = doc[index]
    pil = page.render(scale=dpi / 72, grayscale=True).to_pil()
    return np.array(pil.convert("L"))


def decode_image(data: bytes) -> np.ndarray:
    """A photo or scanned image as greyscale, the right way up (phone EXIF rotation applied)."""
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im).convert("L")
        side = max(im.size)
        if side > MAX_INPUT_SIDE:
            f = MAX_INPUT_SIDE / side
            im = im.resize((round(im.width * f), round(im.height * f)), Image.LANCZOS)
        return np.array(im)


def png_b64(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


# ── The blank form ───────────────────────────────────────────────────────────────


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return mask
    return cv2.dilate(mask.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)) > 0


@dataclass
class Form:
    """A quiz's blank form: one rendered page per version, and what tells them apart."""

    versions: list[str]
    pages: dict[str, np.ndarray]  # version → greyscale page at DPI
    printed: dict[str, np.ndarray] = field(default_factory=dict)  # anything printed, grown 4 px
    owner: np.ndarray | None = None  # per pixel: index of the one version printed there, else -1
    tells: int = 0

    @property
    def size(self) -> tuple[int, int]:
        h, w = next(iter(self.pages.values())).shape
        return w, h

    @staticmethod
    def build(pdf: bytes, versions: list[tuple[str, int]]) -> "Form":
        """versions: (name, 1-based page) in the assessment's order."""
        pages = {name: render_pdf_page(pdf, page - 1) for name, page in versions}
        sizes = {p.shape for p in pages.values()}
        if len(sizes) != 1:
            raise ValueError("Every version's page of the form must be the same size")
        form = Form(versions=[n for n, _ in versions], pages=pages)
        for name, img in pages.items():
            form.printed[name] = dilate(img < 230, 4)
        if len(pages) > 1:
            # Tells: printed on exactly one version, well clear of everything on the others.
            dark = [pages[n] < 128 for n in form.versions]
            near = [dilate(d, 4) for d in dark]
            owner = np.full(dark[0].shape, -1, np.int16)
            for v, d in enumerate(dark):
                others = np.zeros_like(d)
                for u, nm in enumerate(near):
                    if u != v:
                        others |= nm
                owner[d & ~others & (owner < 0)] = v
            form.owner = owner
            form.tells = int((owner >= 0).sum())
        return form


_form_cache: dict[str, Form] = {}


def form_for(pdf: bytes, versions: list[tuple[str, int]]) -> Form:
    key = hashlib.sha256(pdf).hexdigest() + repr(versions)
    if key not in _form_cache:
        if len(_form_cache) > 16:
            _form_cache.pop(next(iter(_form_cache)))
        _form_cache[key] = Form.build(pdf, versions)
    return _form_cache[key]


# ── Alignment ────────────────────────────────────────────────────────────────────


@dataclass
class Placement:
    """How the form lies on the input: input pixel = H · form pixel (3×3 homography)."""

    H: np.ndarray
    method: str
    markers: int = 0
    detail: str = ""


def printed_to_source(f: float) -> float:
    return 0.5 + (f - 0.5) / PRINT_SCALE


def marker_corners_in_form(w_in: float, h_in: float, w_px: int, h_px: int) -> dict[int, np.ndarray]:
    """Each marker's four corners (TL, TR, BR, BL, as OpenCV reports them) in form pixels."""
    s, i = MARKER_SIZE_IN, MARKER_INSET_IN
    tops = {
        MARKER_IDS["top_left"]: (i, i),
        MARKER_IDS["top_right"]: (w_in - i - s, i),
        MARKER_IDS["bottom_right"]: (w_in - i - s, h_in - i - s),
        MARKER_IDS["bottom_left"]: (i, h_in - i - s),
    }
    out = {}
    for mid, (x, y) in tops.items():
        pts = [(x, y), (x + s, y), (x + s, y + s), (x, y + s)]
        out[mid] = np.array(
            [[printed_to_source(px / w_in) * w_px, printed_to_source(py / h_in) * h_px] for px, py in pts], np.float32
        )
    return out


_detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), cv2.aruco.DetectorParameters())


def by_markers(img: np.ndarray, form_w: int, form_h: int) -> Placement | None:
    """Exact placement from the printed corner markers; needs at least two of the four."""
    corners, ids, _ = _detector.detectMarkers(img)
    if ids is None:
        return None
    known = marker_corners_in_form(form_w / DPI, form_h / DPI, form_w, form_h)
    src, dst, seen = [], [], set()
    for c, mid in zip(corners, ids.flatten()):
        mid = int(mid)
        if mid in known and mid not in seen:
            seen.add(mid)
            src.append(known[mid])
            dst.append(c[0])
    if len(seen) < 2:
        return None
    H, _ = cv2.findHomography(np.concatenate(src), np.concatenate(dst), cv2.RANSAC, 4.0)
    if H is None:
        return None
    return Placement(H=H, method="markers", markers=len(seen))


def _similarity(theta_deg: float, s: float, dx: float, dy: float, cx: float, cy: float) -> np.ndarray:
    """3×3 matrix: rotate and scale about (cx, cy), then shift."""
    t = np.deg2rad(theta_deg)
    c, si = np.cos(t) * s, np.sin(t) * s
    return np.array([[c, -si, cx - c * cx + si * cy + dx], [si, c, cy - si * cx - c * cy + dy], [0, 0, 1]], np.float64)


def _frange(a: float, b: float, step: float) -> list[float]:
    n = int(round((b - a) / step)) + 1
    return [round(a + k * step, 6) for k in range(n)]


def _line_search(form_img: np.ndarray, page: np.ndarray, base: np.ndarray, levels: list[tuple]) -> tuple[np.ndarray, float]:
    """
    Coarse-to-fine search for the similarity that lays the form's dark lines onto the page,
    composed after `base` (a homography already applied to the page, or identity).
    levels: (factor, dark threshold, thetas, scales, pad) — each level searches every
    shift within ±pad pixels at that scale, around the previous level's answer.
    """
    fw, fh = form_img.shape[1], form_img.shape[0]
    flat = cv2.warpPerspective(page, np.linalg.inv(base), (fw, fh), flags=cv2.INTER_AREA, borderValue=255)
    best_theta, best_s, best_dx, best_dy = 0.0, 1.0, 0.0, 0.0
    best = 0.0
    for factor, dark, thetas, scales, pad in levels:
        w, h = round(fw / factor), round(fh / factor)
        t = (cv2.resize(form_img, (w, h), interpolation=cv2.INTER_AREA) < dark).astype(np.float32)
        hit = dilate(cv2.resize(flat, (w, h), interpolation=cv2.INTER_AREA) < dark, 1).astype(np.float32)
        hit = cv2.copyMakeBorder(hit, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
        total = float(t.sum()) or 1.0
        cx, cy = w / 2, h / 2
        level_best = (-1.0, 0.0, 1.0, 0.0, 0.0)
        for theta in [best_theta + d for d in thetas]:
            for s in [best_s * k for k in scales]:
                M = _similarity(theta, s, best_dx / factor, best_dy / factor, cx, cy)[:2]
                warped = cv2.warpAffine(t, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
                res = cv2.matchTemplate(hit, warped, cv2.TM_CCORR)
                _, mx, _, loc = cv2.minMaxLoc(res)
                if mx / total > level_best[0] + 1e-9:
                    level_best = (mx / total, theta, s, best_dx + (loc[0] - pad) * factor, best_dy + (loc[1] - pad) * factor)
        best, best_theta, best_s, best_dx, best_dy = level_best
    S = _similarity(best_theta, best_s, best_dx, best_dy, fw / 2, fh / 2)
    return base @ S, best


# Scale range covers copier reduce/enlarge, fit-to-page (~96%), and pages printed with
# corner markers (form at 90%, or ~87% if fit-to-page shrinks them again).
_LEVELS_WIDE = [
    (8, 170, _frange(-1.5, 1.5, 0.25), _frange(0.84, 1.06, 0.02), 26),
    (2, 120, _frange(-0.25, 0.25, 0.125), _frange(0.98, 1.02, 0.005), 6),
    (1, 110, _frange(-0.1, 0.1, 0.05), _frange(0.996, 1.004, 0.002), 3),
]
# After the paper's edges or the markers have done most of the work: a small correction.
_LEVELS_NARROW = [
    (4, 150, _frange(-0.5, 0.5, 0.25), _frange(0.86, 1.04, 0.02), 12),
    (2, 120, _frange(-0.25, 0.25, 0.125), _frange(0.99, 1.01, 0.005), 4),
    (1, 110, _frange(-0.1, 0.1, 0.05), _frange(0.998, 1.002, 0.002), 2),
]


def by_lines(form_img: np.ndarray, page: np.ndarray) -> Placement:
    """Placement from the form's printed lines; the input is first fitted to the form's size."""
    fh, fw = form_img.shape
    ph, pw = page.shape
    # Start by stretching the input to the form's size, as a copier scan of a full page is.
    base = np.array([[pw / fw, 0, 0], [0, ph / fh, 0], [0, 0, 1]], np.float64)
    H, _ = _line_search(form_img, page, base, _LEVELS_WIDE)
    return Placement(H=H, method="lines")


def _order_quad(pts: np.ndarray) -> np.ndarray:
    s, d = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
    return np.array([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]], np.float32)


def by_paper_edges(form_img: np.ndarray, page: np.ndarray) -> Placement | None:
    """For an angled photo without markers: find the sheet, flatten it, then fit the lines."""
    fh, fw = form_img.shape
    small = cv2.GaussianBlur(page, (5, 5), 0)
    _, bright = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    contours, _ = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(c)
    if area < 0.25 * page.size or area > 0.98 * page.size:
        return None  # no sheet, or the sheet fills the frame (nothing to flatten)
    quad = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
    if len(quad) != 4:
        return None
    corners = _order_quad(quad.reshape(4, 2).astype(np.float32))
    base = cv2.getPerspectiveTransform(np.float32([[0, 0], [fw, 0], [fw, fh], [0, fh]]), corners)
    H, _ = _line_search(form_img, page, base, _LEVELS_NARROW)
    return Placement(H=H, method="paper edges")


def flatten(page: np.ndarray, p: Placement, size: tuple[int, int]) -> np.ndarray:
    """The input resampled into the form's coordinates."""
    return cv2.warpPerspective(page, np.linalg.inv(p.H), size, flags=cv2.INTER_LINEAR, borderValue=255)


def line_match(flat: np.ndarray, form_img: np.ndarray) -> float:
    """Share of the form's thick printed lines that land on dark pixels (±2 px)."""
    t = cv2.resize(form_img, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA) < 120
    f = dilate(cv2.resize(flat, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA) < 170, 1)
    m = 15
    t[:m], t[-m:], t[:, :m], t[:, -m:] = False, False, False, False  # ignore the page edge
    n = int(t.sum())
    return float((t & f).sum() / n) if n else 0.0


def align(page: np.ndarray, form_img: np.ndarray) -> tuple[np.ndarray, Placement, float]:
    """Best of markers, lines and paper edges; returns the flattened page, how, and the match."""
    fh, fw = form_img.shape
    tried: list[tuple[float, Placement, np.ndarray]] = []

    def attempt(p: Placement | None) -> float:
        if p is None:
            return -1.0
        flat = flatten(page, p, (fw, fh))
        m = line_match(flat, form_img)
        tried.append((m, p, flat))
        return m

    if attempt(by_markers(page, fw, fh)) < GOOD_MATCH:
        if attempt(by_lines(form_img, page)) < GOOD_MATCH:
            attempt(by_paper_edges(form_img, page))
    m, p, flat = max(tried, key=lambda x: x[0])
    return flat, p, m


# ── Version, ink, crops ──────────────────────────────────────────────────────────


def paper_level(img: np.ndarray) -> int:
    hist = np.bincount(img[::7, ::7].ravel(), minlength=256)
    return int(128 + hist[128:].argmax())


def ink_threshold(img: np.ndarray) -> int:
    """Ink is darker than this: pencil included, scanner grey excluded."""
    return min(INK_MAX, paper_level(img) - 35)


def version_fits(flat: np.ndarray, form: Form, ink_max: int) -> dict[str, float]:
    if form.owner is None:
        return {form.versions[0]: 1.0}
    inked = dilate(flat < ink_max, 1)
    tell = form.owner >= 0
    owners = form.owner[tell]
    dark = inked[tell]
    return {v: float(((owners == i) == dark).mean()) for i, v in enumerate(form.versions)}


def call_version(fits: dict[str, float]) -> str | None:
    order = sorted(fits.items(), key=lambda kv: -kv[1])
    if len(order) == 1:
        return order[0][0]
    (best, f1), (_, f2) = order[0], order[1]
    return best if f1 >= VERSION_MIN_FIT and f1 - f2 >= VERSION_MIN_LEAD else None


def box_rect(box: list[float], w: int, h: int) -> tuple[int, int, int, int]:
    x, y, bw, bh = box
    left = max(0, int(np.floor((x - MARGIN) * w)))
    top = max(0, int(np.floor((y - MARGIN) * h)))
    right = min(w, int(np.ceil((x + bw + MARGIN) * w)))
    bottom = min(h, int(np.ceil((y + bh + MARGIN) * h)))
    return left, top, right, bottom


def crop_boxes(flat: np.ndarray, printed: np.ndarray, boxes: list[dict], ink_max: int) -> list[dict]:
    """Each box's crop, its handwriting pixel count (ink away from anything printed), and whether it is blank."""
    h, w = flat.shape
    new_ink = (flat < ink_max) & ~printed
    out = []
    for b in boxes:
        l, t, r, btm = box_rect(b["box"], w, h)
        ink = int(new_ink[t:btm, l:r].sum())
        need = max(BLANK_MIN_PIXELS, BLANK_MIN_SHARE * (r - l) * (btm - t))
        out.append({"id": b["id"], "png": png_b64(flat[t:btm, l:r]), "ink": ink, "blank": ink < need})
    return out


def process(page: np.ndarray, form: Form, boxes_by_version: dict[str, list[dict]], force_version: str | None = None) -> dict:
    """Everything Pulse needs about one page."""
    ref = form.pages[force_version or form.versions[0]]  # versions share their lines
    flat, placement, match = align(page, ref)
    ink_max = ink_threshold(flat)
    fits = version_fits(flat, form, ink_max)
    called = call_version(fits)
    version = force_version or called
    result = {
        "method": placement.method,
        "markers": placement.markers,
        "match": round(match, 4),
        "fits": {k: round(v, 4) for k, v in fits.items()},
        "version": version,
        "version_detected": called,
        "aligned": png_b64(flat),
        "crops": [],
    }
    if version is not None:
        result["crops"] = crop_boxes(flat, form.printed[version], boxes_by_version.get(version, []), ink_max)
    return result
