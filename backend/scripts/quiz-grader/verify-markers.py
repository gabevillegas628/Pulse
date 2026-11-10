"""
Check that printed quiz pages' corner markers work: OpenCV finds all four, on the
flat page and on simulated phone photos (tilt, perspective, uneven light, blur, JPEG),
and flattening from the markers alone puts the page back on the original form.

Dev tool, not part of the app. Needs: pip install opencv-contrib-python-headless; poppler.

Usage (from backend/):
  C=$(npx tsx -e "import { markerCentres } from './src/quizGrader/print.ts'; console.log(JSON.stringify(markerCentres(8.5, 11)))")
  python3 scripts/quiz-grader/verify-markers.py <work dir> "$C" <original one-page form.pdf> <printed page.pdf>

"form lines matched" is the share of the original form's ink that lands on ink after
flattening; ~98-100% means the marker geometry in print.ts is right.
"""
import sys, json, subprocess, numpy as np, cv2
S = sys.argv[1]; centres = json.loads(sys.argv[2])   # source fractions per id
src_pdf, printed_pdf = sys.argv[3], sys.argv[4]
W, H = 1700, 2200
def render(pdf, out):
    subprocess.run(['pdftoppm','-r','200','-gray','-png','-singlefile',pdf,out], check=True)
    return cv2.imread(out + '.png', cv2.IMREAD_GRAYSCALE)
printed = render(printed_pdf, f'{S}/p_print'); source = render(src_pdf, f'{S}/p_src')
det = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), cv2.aruco.DetectorParameters())

def phone(img, seed):
    rng = np.random.default_rng(seed); h, w = img.shape
    # a 3000x2400 "photo": page smaller in frame, tilted and in perspective, on a grey desk
    out_w, out_h = 2400, 3000
    m = 220
    dst = np.float32([[m+rng.uniform(0,200), m+rng.uniform(0,150)], [out_w-m-rng.uniform(0,200), m+rng.uniform(80,260)],
                      [out_w-m-rng.uniform(80,300), out_h-m-rng.uniform(0,200)], [m+rng.uniform(100,320), out_h-m-rng.uniform(60,260)]])
    Mx = cv2.getPerspectiveTransform(np.float32([[0,0],[w,0],[w,h],[0,h]]), dst)
    photo = cv2.warpPerspective(img, Mx, (out_w, out_h), borderValue=110).astype(np.float32)
    yy, xx = np.mgrid[0:out_h, 0:out_w]
    photo *= (0.75 + 0.25 * xx / out_w) * (0.85 + 0.15 * yy / out_h)          # uneven light
    photo = cv2.GaussianBlur(photo, (5,5), 1.4) + rng.normal(0, 6, photo.shape)  # focus + noise
    photo = np.clip(photo, 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode('.jpg', photo, [cv2.IMWRITE_JPEG_QUALITY, 80])       # phone JPEG
    return cv2.imdecode(enc, cv2.IMREAD_GRAYSCALE)

def flatten(img):
    corners, ids, _ = det.detectMarkers(img)
    found = sorted(int(i) for i in ids.flatten()) if ids is not None else []
    if found != [0,1,2,3]: return found, None
    srcpts = np.float32([c[0].mean(axis=0) for c in corners])
    dstpts = np.float32([[centres[str(int(i))][0]*W, centres[str(int(i))][1]*H] for i in ids.flatten()])
    Hm = cv2.getPerspectiveTransform(srcpts, dstpts)
    return found, cv2.warpPerspective(img, Hm, (W, H), borderValue=255)

def agreement(flat):
    # share of the original form's ink that lands on ink in the flattened image (±2 px)
    t = source < 128; f = cv2.dilate((flat < 140).astype(np.uint8), np.ones((5,5),np.uint8)) > 0
    inner = np.zeros_like(t); inner[60:-60, 60:-60] = True   # ignore page edge
    return float((t & f & inner).sum() / max(1,(t & inner).sum()))

found, flat = flatten(printed)
print('flat print: markers', found, 'form lines matched %.1f%%' % (100*agreement(flat)))
for seed in range(5):
    found, flat = flatten(phone(printed, seed))
    print(f'phone photo {seed}: markers', found, ('form lines matched %.1f%%' % (100*agreement(flat))) if flat is not None else 'NOT FLATTENED')
    if seed == 0 and flat is not None: cv2.imwrite(f'{S}/flattened0.png', flat[::2, ::2])
