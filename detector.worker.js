/* global loadPyodide */

self.importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

const PYTHON_DETECTOR_CODE = String.raw`
import json
import numpy as np
from skimage import color, feature, filters, measure, morphology


def _polygon_area(points_xy):
    pts = np.asarray(points_xy, dtype=float)
    x = pts[:, 0]
    y = pts[:, 1]
    return abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) * 0.5


def _reorder(points_xy):
    pts = np.asarray(points_xy, dtype=float).reshape((4, 2))
    add = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)

    ordered = np.zeros((4, 2), dtype=float)
    ordered[0] = pts[np.argmin(add)]
    ordered[3] = pts[np.argmax(add)]
    ordered[1] = pts[np.argmin(diff)]
    ordered[2] = pts[np.argmax(diff)]
    return ordered


def _perimeter(points_xy):
    pts = np.asarray(points_xy, dtype=float)
    nxt = np.roll(pts, -1, axis=0)
    return float(np.sum(np.linalg.norm(nxt - pts, axis=1)))


def _largest_quad_from_contours(contours, min_area_px):
    biggest = None
    max_area = 0.0

    for contour_rc in contours:
        if contour_rc.shape[0] < 25:
            continue

        contour_xy = np.column_stack((contour_rc[:, 1], contour_rc[:, 0]))
        area = _polygon_area(contour_xy)
        if area <= min_area_px:
            continue

        peri = _perimeter(contour_xy)
        approx = measure.approximate_polygon(contour_xy, tolerance=max(2.0, 0.02 * peri))
        if len(approx) > 1 and np.linalg.norm(approx[0] - approx[-1]) < 3.0:
            approx = approx[:-1]

        if len(approx) == 4 and area > max_area:
            biggest = _reorder(approx)
            max_area = area

    return biggest, max_area


def _opencv_style_detect(gray, mode):
    frame_h, frame_w = gray.shape

    # Downsample in camera mode for lower latency and then scale corners back.
    stride = 2 if mode == "camera" and max(frame_w, frame_h) >= 540 else 1
    if stride > 1:
        work_gray = gray[::stride, ::stride]
    else:
        work_gray = gray

    work_h, work_w = work_gray.shape
    min_area_ratio = 5000.0 / (640.0 * 480.0)
    min_area_px = max(900.0, (work_w * work_h) * min_area_ratio)

    img_blur = filters.gaussian(work_gray, sigma=1.0, preserve_range=True)

    # OpenCV tutorial uses trackbars around 200/200; this calibrated pair behaves similarly in normalized domain.
    canny_low = 0.10 if mode == "camera" else 0.12
    canny_high = 0.24 if mode == "camera" else 0.28
    img_threshold = feature.canny(img_blur, sigma=1.0, low_threshold=canny_low, high_threshold=canny_high)

    kernel = np.ones((5, 5), dtype=bool)
    img_dilate = morphology.binary_dilation(img_threshold, kernel)
    img_dilate = morphology.binary_dilation(img_dilate, kernel)
    img_threshold = morphology.binary_erosion(img_dilate, kernel)

    contours = measure.find_contours(img_threshold.astype(float), 0.5)
    biggest, max_area = _largest_quad_from_contours(contours, min_area_px)
    if biggest is None:
        return None

    if stride > 1:
        biggest *= stride

    biggest[:, 0] = np.clip(biggest[:, 0], 0, frame_w - 1)
    biggest[:, 1] = np.clip(biggest[:, 1], 0, frame_h - 1)

    area_ratio = float(max_area) / max((work_w * work_h), 1)
    confidence = float(np.clip((area_ratio - 0.015) / 0.42, 0.0, 1.0))

    return {
        "corners": biggest,
        "area_ratio": float(np.clip(area_ratio, 0.0, 1.0)),
        "confidence": confidence,
    }


def _tracked_roi_candidate(gray, prev_corners):
    frame_h, frame_w = gray.shape
    quad = np.asarray(prev_corners, dtype=float)
    if quad.shape != (4, 2):
        return None

    quad[:, 0] = np.clip(quad[:, 0], 0, frame_w - 1)
    quad[:, 1] = np.clip(quad[:, 1], 0, frame_h - 1)
    center = np.mean(quad, axis=0)
    expanded = center + ((quad - center) * 1.28)
    expanded[:, 0] = np.clip(expanded[:, 0], 0, frame_w - 1)
    expanded[:, 1] = np.clip(expanded[:, 1], 0, frame_h - 1)

    min_x = int(max(0, np.floor(np.min(expanded[:, 0]))))
    max_x = int(min(frame_w, np.ceil(np.max(expanded[:, 0])) + 1))
    min_y = int(max(0, np.floor(np.min(expanded[:, 1]))))
    max_y = int(min(frame_h, np.ceil(np.max(expanded[:, 1])) + 1))
    if (max_x - min_x) < 80 or (max_y - min_y) < 80:
        return None

    roi_gray = gray[min_y:max_y, min_x:max_x]
    candidate = _opencv_style_detect(roi_gray, "camera")
    if candidate is None:
        return None

    candidate["corners"][:, 0] += float(min_x)
    candidate["corners"][:, 1] += float(min_y)
    area = _polygon_area(candidate["corners"])
    candidate["area_ratio"] = float(np.clip(area / max((frame_w * frame_h), 1), 0.0, 1.0))
    candidate["confidence"] = float(np.clip(candidate.get("confidence", 0.0) + 0.08, 0.0, 1.0))
    return candidate


def _detect_with_tracking(gray, mode, hints_json):
    if mode != "camera" or not hints_json:
        return _opencv_style_detect(gray, mode)

    try:
        hints = json.loads(hints_json)
    except Exception:
        hints = {}

    prev_corners = hints.get("prev_corners") if isinstance(hints, dict) else None
    if isinstance(prev_corners, list) and len(prev_corners) == 4:
        tracked = _tracked_roi_candidate(gray, prev_corners)
        if tracked is not None:
            return tracked

    return _opencv_style_detect(gray, mode)


def detect_document_json(pixels, width, height, mode="upload", hints_json=""):
    image = np.asarray(pixels, dtype=np.uint8).reshape((height, width, 4))
    rgb = image[..., :3].astype(np.float32) / 255.0
    gray = color.rgb2gray(rgb)
    candidate = _detect_with_tracking(gray, mode, hints_json)

    min_confidence = 0.18 if mode == "upload" else 0.16
    if candidate is None or (mode != "camera" and float(candidate["confidence"]) < min_confidence):
        return json.dumps({
            "found": False,
            "confidence": 0.0 if candidate is None else round(float(candidate.get("confidence", 0.0)), 4),
            "area_ratio": 0.0 if candidate is None else round(float(candidate.get("area_ratio", 0.0)), 4),
            "corners": [],
            "frame_width": int(width),
            "frame_height": int(height),
        })

    corners = [[round(float(x), 3), round(float(y), 3)] for x, y in candidate["corners"]]
    return json.dumps({
        "found": True,
        "confidence": round(float(candidate.get("confidence", 0.0)), 4),
        "area_ratio": round(float(candidate.get("area_ratio", 0.0)), 4),
        "corners": corners,
        "frame_width": int(width),
        "frame_height": int(height),
    })
`;

let pyodide = null;
let detector = null;
let ready = false;
let bootPromise = null;

function postStatus(message) {
	self.postMessage({ type: "status", message });
}

function postError(error, id = null) {
	const message = error instanceof Error ? error.message : String(error);
	self.postMessage({ type: "error", id, error: message });
}

async function boot() {
	if (bootPromise) {
		return bootPromise;
	}

	bootPromise = (async () => {
		postStatus("Pokrecem Pyodide runtime u worker-u...");
		pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/" });

		postStatus("Preuzimam numpy + scikit-image...");
		await pyodide.loadPackage(["numpy", "scikit-image"]);

		postStatus("Kompajliram Python detektor...");
		await pyodide.runPythonAsync(PYTHON_DETECTOR_CODE);
		detector = pyodide.globals.get("detect_document_json");
		ready = true;
		self.postMessage({ type: "ready" });
	})();

	return bootPromise;
}

self.onmessage = async (event) => {
	const message = event.data;
	if (!message || typeof message !== "object") {
		return;
	}

	if (message.type !== "detect") {
		return;
	}

	try {
		if (!ready) {
			await boot();
		}

		const pixels = new Uint8ClampedArray(message.pixels);
        const hintsJson = message.hints ? JSON.stringify(message.hints) : "";
        const rawResult = detector(pixels, message.width, message.height, message.mode || "upload", hintsJson);
		const jsonText = typeof rawResult === "string" ? rawResult : rawResult.toString();
		if (rawResult && typeof rawResult.destroy === "function") {
			rawResult.destroy();
		}

		const parsed = JSON.parse(jsonText);
		self.postMessage({ type: "result", id: message.id, result: parsed });
	} catch (error) {
		postError(error, message.id ?? null);
	}
};

boot().catch((error) => {
	postError(error);
});
