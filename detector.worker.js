/* global loadPyodide */

self.importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

const PYTHON_DETECTOR_CODE = String.raw`
import json
import math
import itertools
import numpy as np
from skimage import color, exposure, feature, filters, measure, morphology, transform


def _polygon_area(points):
    pts = np.asarray(points, dtype=float)
    x = pts[:, 0]
    y = pts[:, 1]
    return abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) * 0.5


def _order_quad(points):
    pts = np.asarray(points, dtype=float)
    center = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - center[1], pts[:, 0] - center[0])
    pts = pts[np.argsort(angles)]
    start = np.argmin(pts[:, 0] + pts[:, 1])
    pts = np.roll(pts, -start, axis=0)
    if pts[1, 1] > pts[3, 1]:
        pts = np.array([pts[0], pts[3], pts[2], pts[1]])
    return pts


def _quad_angles(quad):
    values = []
    for idx in range(4):
        prev_vec = quad[idx - 1] - quad[idx]
        next_vec = quad[(idx + 1) % 4] - quad[idx]
        denom = np.linalg.norm(prev_vec) * np.linalg.norm(next_vec)
        if denom <= 1e-9:
            return None
        cosine = np.clip(np.dot(prev_vec, next_vec) / denom, -1.0, 1.0)
        values.append(math.degrees(math.acos(cosine)))
    return np.asarray(values)


def _edge_support(edge_map, quad):
    frame_h, frame_w = edge_map.shape
    values = []
    for idx in range(4):
        p0 = quad[idx]
        p1 = quad[(idx + 1) % 4]
        count = max(36, int(np.linalg.norm(p1 - p0) * 0.65))
        xs = np.linspace(p0[0], p1[0], count)
        ys = np.linspace(p0[1], p1[1], count)
        xi = np.clip(np.rint(xs).astype(int), 0, frame_w - 1)
        yi = np.clip(np.rint(ys).astype(int), 0, frame_h - 1)
        values.append(float(np.mean(edge_map[yi, xi])))
    return float(np.mean(values))


def _score_quad(points, frame_w, frame_h, min_area_ratio, edge_map):
    quad = _order_quad(points)
    quad[:, 0] = np.clip(quad[:, 0], 0, frame_w - 1)
    quad[:, 1] = np.clip(quad[:, 1], 0, frame_h - 1)

    area = _polygon_area(quad)
    frame_area = max(frame_w * frame_h, 1)
    area_ratio = area / frame_area
    if area_ratio < min_area_ratio or area_ratio > 0.98:
        return None

    side_lengths = np.linalg.norm(np.roll(quad, -1, axis=0) - quad, axis=1)
    diagonal = float(np.hypot(frame_w, frame_h))
    min_side = float(np.min(side_lengths))
    max_side = float(np.max(side_lengths))
    if min_side < diagonal * 0.08:
        return None
    if max_side / max(min_side, 1e-7) > 12.0:
        return None

    angles = _quad_angles(quad)
    if angles is None:
        return None
    angle_error = float(np.mean(np.abs(angles - 90.0)))
    if angle_error > 44.0:
        return None

    bbox_w = float(np.max(quad[:, 0]) - np.min(quad[:, 0]))
    bbox_h = float(np.max(quad[:, 1]) - np.min(quad[:, 1]))
    bbox_area = max(bbox_w * bbox_h, 1.0)
    fill_ratio = area / bbox_area
    if fill_ratio < 0.31:
        return None

    pair_0 = min(side_lengths[0], side_lengths[2]) / max(max(side_lengths[0], side_lengths[2]), 1e-7)
    pair_1 = min(side_lengths[1], side_lengths[3]) / max(max(side_lengths[1], side_lengths[3]), 1e-7)
    opposite_similarity = float(min(pair_0, pair_1))

    edge_score = float(np.clip(_edge_support(edge_map, quad), 0.0, 1.0))
    area_score = float(np.clip((area_ratio - min_area_ratio) / max(0.75 - min_area_ratio, 1e-7), 0.0, 1.0))
    angle_score = float(np.clip(1.0 - (angle_error / 45.0), 0.0, 1.0))
    fill_score = float(np.clip((fill_ratio - 0.31) / 0.59, 0.0, 1.0))
    side_score = float(np.clip(opposite_similarity, 0.0, 1.0))

    confidence = (
        (area_score * 0.35)
        + (angle_score * 0.24)
        + (fill_score * 0.11)
        + (side_score * 0.11)
        + (edge_score * 0.19)
    )

    return {
        "confidence": float(np.clip(confidence, 0.0, 1.0)),
        "area_ratio": float(area_ratio),
        "corners": quad,
    }


def _candidate_from_contours(contours, frame_w, frame_h, min_area_ratio, edge_map):
    tolerances = sorted({
        1.8,
        3.0,
        4.5,
        6.0,
        8.0,
        10.0,
        13.0,
        round(max(frame_w, frame_h) * 0.02, 2),
        round(max(frame_w, frame_h) * 0.03, 2),
    })

    best = None
    for contour in sorted(contours, key=lambda item: item.shape[0], reverse=True)[:70]:
        if contour.shape[0] < 35:
            continue

        for tolerance in tolerances:
            approx = measure.approximate_polygon(contour, tolerance=tolerance)
            if len(approx) > 1 and np.linalg.norm(approx[0] - approx[-1]) < 4.0:
                approx = approx[:-1]
            if len(approx) != 4:
                continue

            quad = np.column_stack((approx[:, 1], approx[:, 0]))
            scored = _score_quad(quad, frame_w, frame_h, min_area_ratio, edge_map)
            if scored is None:
                continue

            if best is None or scored["confidence"] > best["confidence"]:
                best = scored

    return best


def _candidate_from_hough(edge_mask, frame_w, frame_h, min_area_ratio):
    if np.count_nonzero(edge_mask) < frame_w * frame_h * 0.004:
        return None

    hspace, angles, distances = transform.hough_line(edge_mask)
    if hspace.size == 0:
        return None

    peak_threshold = max(float(np.max(hspace)) * 0.36, 1.0)
    accums, thetas, rhos = transform.hough_line_peaks(
        hspace,
        angles,
        distances,
        num_peaks=12,
        threshold=peak_threshold,
    )
    if len(accums) < 4:
        return None

    vertical = []
    horizontal = []
    for accum, theta, rho in zip(accums, thetas, rhos):
        line = (float(theta), float(rho), float(accum))
        if abs(math.cos(theta)) >= abs(math.sin(theta)):
            vertical.append(line)
        else:
            horizontal.append(line)

    vertical = sorted(vertical, key=lambda item: item[2], reverse=True)[:5]
    horizontal = sorted(horizontal, key=lambda item: item[2], reverse=True)[:5]
    if len(vertical) < 2 or len(horizontal) < 2:
        return None

    support = morphology.binary_dilation(edge_mask, morphology.disk(1)).astype(float)
    best = None

    for line_left, line_right in itertools.combinations(vertical, 2):
        if abs(line_left[1] - line_right[1]) < frame_w * 0.1:
            continue

        for line_top, line_bottom in itertools.combinations(horizontal, 2):
            if abs(line_top[1] - line_bottom[1]) < frame_h * 0.1:
                continue

            points = []
            valid = True
            for vertical_line in (line_left, line_right):
                for horizontal_line in (line_top, line_bottom):
                    theta_a, rho_a = vertical_line[0], vertical_line[1]
                    theta_b, rho_b = horizontal_line[0], horizontal_line[1]
                    cos_a, sin_a = math.cos(theta_a), math.sin(theta_a)
                    cos_b, sin_b = math.cos(theta_b), math.sin(theta_b)
                    det = (cos_a * sin_b) - (sin_a * cos_b)
                    if abs(det) < 1e-8:
                        valid = False
                        break
                    x = (rho_a * sin_b - sin_a * rho_b) / det
                    y = (cos_a * rho_b - rho_a * cos_b) / det
                    points.append([x, y])
                if not valid:
                    break

            if not valid:
                continue

            quad = np.asarray(points, dtype=float)
            if np.any(quad[:, 0] < -frame_w * 0.2) or np.any(quad[:, 0] > frame_w * 1.2):
                continue
            if np.any(quad[:, 1] < -frame_h * 0.2) or np.any(quad[:, 1] > frame_h * 1.2):
                continue

            scored = _score_quad(quad, frame_w, frame_h, min_area_ratio, support)
            if scored is None:
                continue
            if best is None or scored["confidence"] > best["confidence"]:
                best = scored

    return best


def _detect_quad(gray, mode):
    frame_h, frame_w = gray.shape
    min_area_ratio = 0.07 if mode == "upload" else 0.1

    blur_sigma = 1.1 if mode == "camera" else 1.25
    base = filters.gaussian(gray, sigma=blur_sigma, preserve_range=True)
    
    variants = [
        exposure.equalize_adapthist(base, clip_limit=0.018 if mode == "camera" else 0.016),
    ]
    if mode != "camera":
        variants.append(exposure.adjust_sigmoid(base, cutoff=0.5, gain=9))

    best = None
    strongest_edges = None
    strongest_density = 0.0

    for variant in variants:
        gradient = filters.scharr(variant)
        high = float(np.quantile(gradient, 0.92))
        low = float(np.quantile(gradient, 0.7))
        if high <= 1e-7:
            continue

        edge_source = feature.canny(
            variant,
            sigma=1.1 if mode == "camera" else 1.35,
            low_threshold=max(low * 0.7, 0.002),
            high_threshold=max(high, 0.01),
        )

        edge_mask = morphology.binary_dilation(edge_source, morphology.disk(1))
        edge_mask = morphology.binary_closing(edge_mask, morphology.disk(3))
        edge_mask = morphology.remove_small_objects(edge_mask, min_size=max(70, int(frame_w * frame_h * 0.0015)))

        density = float(np.count_nonzero(edge_mask)) / max(frame_w * frame_h, 1)
        if density > strongest_density:
            strongest_density = density
            strongest_edges = edge_mask

        support = morphology.binary_dilation(edge_mask, morphology.disk(1)).astype(float)
        candidate = _candidate_from_contours(
            measure.find_contours(edge_mask.astype(float), 0.5),
            frame_w,
            frame_h,
            min_area_ratio,
            support,
        )
        if candidate is not None and (best is None or candidate["confidence"] > best["confidence"]):
            best = candidate

        bright_threshold = min(max(max(float(filters.threshold_otsu(variant)), float(np.quantile(variant, 0.6)) * 0.94), 0.25), 0.95)
        paper_mask = variant >= bright_threshold
        paper_mask = morphology.binary_closing(paper_mask, morphology.disk(5))
        paper_mask = morphology.binary_opening(paper_mask, morphology.disk(2))
        paper_mask = morphology.remove_small_holes(paper_mask, area_threshold=max(200, int(frame_w * frame_h * 0.006)))
        paper_mask = morphology.remove_small_objects(paper_mask, min_size=max(220, int(frame_w * frame_h * 0.01)))

        if np.any(paper_mask):
            support2 = np.maximum(support, np.clip(filters.scharr(variant) * 4.0, 0.0, 1.0))
            candidate2 = _candidate_from_contours(
                measure.find_contours(paper_mask.astype(float), 0.5),
                frame_w,
                frame_h,
                min_area_ratio,
                support2,
            )
            if candidate2 is not None and (best is None or candidate2["confidence"] > best["confidence"]):
                best = candidate2

    if mode != "camera" and (best is None or best["confidence"] < 0.5) and strongest_edges is not None:
        hough_candidate = _candidate_from_hough(strongest_edges, frame_w, frame_h, min_area_ratio)
        if hough_candidate is not None and (best is None or hough_candidate["confidence"] > best["confidence"]):
            best = hough_candidate

    return best


def detect_document_json(pixels, width, height, mode="upload"):
    image = np.asarray(pixels, dtype=np.uint8).reshape((height, width, 4))
    rgb = image[..., :3].astype(np.float32) / 255.0
    gray = color.rgb2gray(rgb)
    gray = exposure.rescale_intensity(gray, in_range="image", out_range=(0.0, 1.0))

    candidate = _detect_quad(gray, mode)
    min_confidence = 0.34 if mode == "upload" else 0.4

    if candidate is None or candidate["confidence"] < min_confidence:
        return json.dumps({
            "found": False,
            "confidence": 0.0 if candidate is None else round(float(candidate["confidence"]), 4),
            "area_ratio": 0.0 if candidate is None else round(float(candidate["area_ratio"]), 4),
            "corners": [],
            "frame_width": int(width),
            "frame_height": int(height),
        })

    corners = [[round(float(x), 3), round(float(y), 3)] for x, y in candidate["corners"]]
    return json.dumps({
        "found": True,
        "confidence": round(float(candidate["confidence"]), 4),
        "area_ratio": round(float(candidate["area_ratio"]), 4),
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
		const rawResult = detector(pixels, message.width, message.height, message.mode || "upload");
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
