import { env, AutoModel, AutoProcessor, RawImage } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0";

const DEEP_MODEL_ID = "onnx-community/BiRefNet_lite";

const PYTHON_DETECTOR_CODE = String.raw`
import json
import math
import itertools
import numpy as np
from skimage import color, draw, exposure, feature, filters, measure, morphology, transform


def _polygon_area(points):
	pts = np.asarray(points, dtype=float)
	x = pts[:, 0]
	y = pts[:, 1]
	return abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) * 0.5


def _clip_quad(points, frame_w, frame_h):
	pts = np.asarray(points, dtype=float).copy()
	pts[:, 0] = np.clip(pts[:, 0], 0, frame_w - 1)
	pts[:, 1] = np.clip(pts[:, 1], 0, frame_h - 1)
	return pts


def _is_convex_quad(quad):
	signs = []
	for idx in range(4):
		p0 = quad[idx]
		p1 = quad[(idx + 1) % 4]
		p2 = quad[(idx + 2) % 4]
		cross = ((p1[0] - p0[0]) * (p2[1] - p1[1])) - ((p1[1] - p0[1]) * (p2[0] - p1[0]))
		signs.append(cross)
	signs = np.asarray(signs)
	return np.all(signs > 0) or np.all(signs < 0)


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


def _pca_quad(points):
	pts = np.asarray(points, dtype=float)
	if pts.shape[0] < 16:
		return None

	center = pts.mean(axis=0)
	normalized = pts - center
	cov = np.cov(normalized.T)
	eigvals, eigvecs = np.linalg.eigh(cov)
	order = np.argsort(eigvals)[::-1]
	axes = eigvecs[:, order]
	projection = normalized @ axes

	min_x, max_x = np.min(projection[:, 0]), np.max(projection[:, 0])
	min_y, max_y = np.min(projection[:, 1]), np.max(projection[:, 1])
	rect = np.array([
		[min_x, min_y],
		[max_x, min_y],
		[max_x, max_y],
		[min_x, max_y],
	], dtype=float)
	return (rect @ axes.T) + center


def _line_intersection(line_a, line_b):
	theta_a, rho_a = line_a
	theta_b, rho_b = line_b
	cos_a, sin_a = math.cos(theta_a), math.sin(theta_a)
	cos_b, sin_b = math.cos(theta_b), math.sin(theta_b)
	det = (cos_a * sin_b) - (sin_a * cos_b)
	if abs(det) < 1e-8:
		return None

	x = (rho_a * sin_b - sin_a * rho_b) / det
	y = (cos_a * rho_b - rho_a * cos_b) / det
	return np.asarray([x, y], dtype=float)


def _edge_support(edge_strength, quad):
	frame_h, frame_w = edge_strength.shape
	values = []
	for idx in range(4):
		p0 = quad[idx]
		p1 = quad[(idx + 1) % 4]
		sample_count = max(60, int(np.linalg.norm(p1 - p0) * 0.8))
		xs = np.linspace(p0[0], p1[0], sample_count)
		ys = np.linspace(p0[1], p1[1], sample_count)
		xi = np.clip(np.rint(xs).astype(int), 0, frame_w - 1)
		yi = np.clip(np.rint(ys).astype(int), 0, frame_h - 1)
		values.append(float(np.mean(edge_strength[yi, xi])))
	return float(np.mean(values))


def _contrast_support(gray, quad):
	frame_h, frame_w = gray.shape
	rr, cc = draw.polygon(quad[:, 1], quad[:, 0], shape=gray.shape)
	if rr.size < 120:
		return 0.0

	inside_mean = float(np.mean(gray[rr, cc]))
	min_x = max(0, int(np.floor(np.min(quad[:, 0]))))
	max_x = min(frame_w - 1, int(np.ceil(np.max(quad[:, 0]))))
	min_y = max(0, int(np.floor(np.min(quad[:, 1]))))
	max_y = min(frame_h - 1, int(np.ceil(np.max(quad[:, 1]))))

	pad = max(4, int(max(frame_w, frame_h) * 0.035))
	x0 = max(0, min_x - pad)
	x1 = min(frame_w, max_x + pad + 1)
	y0 = max(0, min_y - pad)
	y1 = min(frame_h, max_y + pad + 1)

	window = gray[y0:y1, x0:x1]
	if window.size == 0:
		return 0.0

	local_mask = np.zeros(window.shape, dtype=bool)
	local_rr = np.clip(rr - y0, 0, local_mask.shape[0] - 1)
	local_cc = np.clip(cc - x0, 0, local_mask.shape[1] - 1)
	local_mask[local_rr, local_cc] = True
	outside = window[~local_mask]
	if outside.size < 80:
		return 0.0

	diff = abs(inside_mean - float(np.mean(outside)))
	return float(np.clip(diff / 0.22, 0.0, 1.0))


def _pick_better(best, candidate):
	if candidate is None:
		return best
	if best is None:
		return candidate

	if candidate["confidence"] > best["confidence"] + 0.01:
		return candidate
	if abs(candidate["confidence"] - best["confidence"]) <= 0.02 and candidate["area_ratio"] > best["area_ratio"] * 1.1:
		return candidate
	return best


def _score_quad(points, gray, edge_strength, frame_w, frame_h, min_area_ratio):
	quad = _order_quad(_clip_quad(points, frame_w, frame_h))
	if not _is_convex_quad(quad):
		return None

	area = _polygon_area(quad)
	frame_area = max(frame_w * frame_h, 1)
	area_ratio = area / frame_area
	if area_ratio < min_area_ratio or area_ratio > 0.97:
		return None

	side_lengths = np.linalg.norm(np.roll(quad, -1, axis=0) - quad, axis=1)
	diagonal = float(np.hypot(frame_w, frame_h))
	min_side = float(np.min(side_lengths))
	max_side = float(np.max(side_lengths))
	if min_side < diagonal * 0.08:
		return None
	if max_side / max(min_side, 1e-7) > 11.0:
		return None

	angles = _quad_angles(quad)
	if angles is None:
		return None
	angle_error = float(np.mean(np.abs(angles - 90.0)))
	if angle_error > 42.0:
		return None

	bbox_w = float(np.max(quad[:, 0]) - np.min(quad[:, 0]))
	bbox_h = float(np.max(quad[:, 1]) - np.min(quad[:, 1]))
	bbox_area = max(bbox_w * bbox_h, 1.0)
	fill_ratio = area / bbox_area
	if fill_ratio < 0.33:
		return None

	pair_0 = min(side_lengths[0], side_lengths[2]) / max(max(side_lengths[0], side_lengths[2]), 1e-7)
	pair_1 = min(side_lengths[1], side_lengths[3]) / max(max(side_lengths[1], side_lengths[3]), 1e-7)
	opposite_similarity = float(min(pair_0, pair_1))

	area_score = float(np.clip((area_ratio - min_area_ratio) / max(0.72 - min_area_ratio, 1e-7), 0.0, 1.0))
	angle_score = float(np.clip(1.0 - (angle_error / 45.0), 0.0, 1.0))
	fill_score = float(np.clip((fill_ratio - 0.33) / 0.57, 0.0, 1.0))
	side_score = float(np.clip(opposite_similarity, 0.0, 1.0))
	edge_score = float(np.clip(_edge_support(edge_strength, quad), 0.0, 1.0))
	contrast_score = float(np.clip(_contrast_support(gray, quad), 0.0, 1.0))

	confidence = (
		(area_score * 0.30)
		+ (angle_score * 0.19)
		+ (fill_score * 0.12)
		+ (side_score * 0.12)
		+ (edge_score * 0.21)
		+ (contrast_score * 0.06)
	)

	return {
		"confidence": float(np.clip(confidence, 0.0, 1.0)),
		"area_ratio": float(area_ratio),
		"corners": quad,
		"edge_score": edge_score,
		"contrast_score": contrast_score,
	}


def _auto_canny(image, sigma, low_quantile, high_quantile):
	gradient = filters.scharr(image)
	high = float(np.quantile(gradient, high_quantile))
	low = float(np.quantile(gradient, low_quantile))
	if high <= 1e-7:
		return np.zeros_like(image, dtype=bool)

	return feature.canny(
		image,
		sigma=sigma,
		low_threshold=max(low * 0.72, 0.0025),
		high_threshold=max(high, 0.009),
	)


def _paper_mask(gray_variant, saturation, frame_w, frame_h):
	otsu = float(filters.threshold_otsu(gray_variant))
	bright_q = float(np.quantile(gray_variant, 0.62))
	bright_threshold = min(max(max(otsu, bright_q * 0.94), 0.26), 0.93)

	sat_limit = float(np.quantile(saturation, 0.72))
	sat_limit = min(max(sat_limit, 0.34), 0.72)

	mask = np.logical_and(gray_variant >= bright_threshold, saturation <= sat_limit)
	mask = morphology.binary_closing(mask, morphology.disk(6))
	mask = morphology.binary_opening(mask, morphology.disk(2))
	mask = morphology.remove_small_holes(mask, area_threshold=max(220, int(frame_w * frame_h * 0.006)))
	mask = morphology.remove_small_objects(mask, min_size=max(260, int(frame_w * frame_h * 0.01)))
	return mask


def _candidate_from_contours(contours, gray, edge_strength, frame_w, frame_h, min_area_ratio, contour_limit):
	tolerances = sorted({
		1.5,
		2.5,
		4.0,
		6.0,
		8.0,
		10.0,
		12.0,
		14.0,
		18.0,
		round(max(frame_w, frame_h) * 0.016, 2),
		round(max(frame_w, frame_h) * 0.024, 2),
		round(max(frame_w, frame_h) * 0.034, 2),
	})

	best = None
	for contour in sorted(contours, key=lambda item: item.shape[0], reverse=True)[:contour_limit]:
		if contour.shape[0] < 36:
			continue

		contour_xy = np.column_stack((contour[:, 1], contour[:, 0]))
		for tolerance in tolerances:
			approx = measure.approximate_polygon(contour, tolerance=tolerance)
			if len(approx) > 1 and np.linalg.norm(approx[0] - approx[-1]) < 4.0:
				approx = approx[:-1]

			if len(approx) != 4:
				continue

			quad = np.column_stack((approx[:, 1], approx[:, 0]))
			scored = _score_quad(quad, gray, edge_strength, frame_w, frame_h, min_area_ratio)
			best = _pick_better(best, scored)

		if contour_xy.shape[0] >= 90:
			pca_quad = _pca_quad(contour_xy)
			if pca_quad is not None:
				scored = _score_quad(pca_quad, gray, edge_strength, frame_w, frame_h, min_area_ratio)
				best = _pick_better(best, scored)

	return best


def _candidate_from_regions(mask, gray, edge_strength, frame_w, frame_h, min_area_ratio):
	labels = measure.label(mask)
	regions = sorted(measure.regionprops(labels), key=lambda region: region.area, reverse=True)[:12]
	best = None
	min_region_area = frame_w * frame_h * min_area_ratio * 0.55

	for region in regions:
		if region.area < min_region_area:
			continue

		points = np.column_stack((region.coords[:, 1], region.coords[:, 0])).astype(float)
		quad = _pca_quad(points)
		if quad is None:
			continue

		scored = _score_quad(quad, gray, edge_strength, frame_w, frame_h, min_area_ratio)
		best = _pick_better(best, scored)

	return best


def _candidate_from_hough(edge_mask, gray, frame_w, frame_h, min_area_ratio):
	if np.count_nonzero(edge_mask) < frame_w * frame_h * 0.0035:
		return None

	hspace, angles, distances = transform.hough_line(edge_mask)
	if hspace.size == 0:
		return None

	peak_threshold = max(float(np.max(hspace)) * 0.34, 1.0)
	accums, thetas, rhos = transform.hough_line_peaks(
		hspace,
		angles,
		distances,
		num_peaks=14,
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

	vertical = sorted(vertical, key=lambda item: item[2], reverse=True)[:6]
	horizontal = sorted(horizontal, key=lambda item: item[2], reverse=True)[:6]
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
					point = _line_intersection(
						(vertical_line[0], vertical_line[1]),
						(horizontal_line[0], horizontal_line[1]),
					)
					if point is None:
						valid = False
						break
					points.append(point)
				if not valid:
					break

			if not valid:
				continue

			quad = np.asarray(points, dtype=float)
			if np.any(quad[:, 0] < -frame_w * 0.22) or np.any(quad[:, 0] > frame_w * 1.22):
				continue
			if np.any(quad[:, 1] < -frame_h * 0.22) or np.any(quad[:, 1] > frame_h * 1.22):
				continue

			scored = _score_quad(quad, gray, support, frame_w, frame_h, min_area_ratio)
			best = _pick_better(best, scored)

	return best


def _prepare_modalities(image, mode):
	if image.ndim == 2:
		rgb = np.stack([image, image, image], axis=-1)
	else:
		rgb = image[..., :3]

	rgb = rgb.astype(np.float32) / 255.0
	gray = color.rgb2gray(rgb)
	gray = exposure.rescale_intensity(gray, in_range="image", out_range=(0.0, 1.0))
	saturation = color.rgb2hsv(rgb)[..., 1]

	blur_sigma = 1.0 if mode == "camera" else 1.2
	base = filters.gaussian(gray, sigma=blur_sigma, preserve_range=True)

	variants = [
		exposure.equalize_adapthist(base, clip_limit=0.02 if mode == "camera" else 0.018),
		exposure.adjust_sigmoid(base, cutoff=0.5, gain=9),
	]
	if mode == "upload":
		variants.append(exposure.adjust_gamma(base, gamma=0.84))

	return gray, saturation, variants


def _detect_quad(gray, saturation, variants, mode):
	frame_h, frame_w = gray.shape
	min_area_ratio = 0.065 if mode == "upload" else 0.10
	contour_limit = 55 if mode == "camera" else 80

	best = None
	strongest_edge_mask = None
	strongest_density = 0.0

	for variant in variants:
		edges_primary = _auto_canny(
			variant,
			sigma=1.15 if mode == "camera" else 1.35,
			low_quantile=0.56,
			high_quantile=0.9,
		)
		edges_secondary = _auto_canny(
			exposure.equalize_adapthist(variant, clip_limit=0.012),
			sigma=1.0,
			low_quantile=0.5,
			high_quantile=0.88,
		)

		for edge_source in (edges_primary, edges_secondary):
			if not np.any(edge_source):
				continue

			edge_mask = morphology.binary_dilation(edge_source, morphology.disk(1))
			edge_mask = morphology.binary_closing(edge_mask, morphology.disk(3))
			edge_mask = morphology.remove_small_objects(edge_mask, min_size=max(70, int(frame_w * frame_h * 0.0016)))

			density = float(np.count_nonzero(edge_mask)) / max(frame_w * frame_h, 1)
			if density > strongest_density:
				strongest_density = density
				strongest_edge_mask = edge_mask

			support_map = morphology.binary_dilation(edge_mask, morphology.disk(1)).astype(float)
			contour_candidate = _candidate_from_contours(
				measure.find_contours(edge_mask.astype(float), 0.5),
				gray,
				support_map,
				frame_w,
				frame_h,
				min_area_ratio,
				contour_limit=contour_limit,
			)
			best = _pick_better(best, contour_candidate)

		paper_mask = _paper_mask(variant, saturation, frame_w, frame_h)
		if np.any(paper_mask):
			paper_edges = morphology.binary_dilation(feature.canny(variant, sigma=1.05), morphology.disk(1))
			support_map = np.maximum(
				paper_edges.astype(float),
				np.clip(filters.scharr(variant) * 5.0, 0.0, 1.0),
			)

			contour_candidate = _candidate_from_contours(
				measure.find_contours(paper_mask.astype(float), 0.5),
				gray,
				support_map,
				frame_w,
				frame_h,
				min_area_ratio,
				contour_limit=30,
			)
			region_candidate = _candidate_from_regions(
				paper_mask,
				gray,
				support_map,
				frame_w,
				frame_h,
				min_area_ratio,
			)

			best = _pick_better(best, contour_candidate)
			best = _pick_better(best, region_candidate)

	should_try_hough = best is None or best["confidence"] < (0.53 if mode == "camera" else 0.47)
	if should_try_hough and strongest_edge_mask is not None:
		hough_candidate = _candidate_from_hough(strongest_edge_mask, gray, frame_w, frame_h, min_area_ratio)
		best = _pick_better(best, hough_candidate)

	return best


def detect_document_json(pixels, width, height, mode="upload"):
	image = np.asarray(pixels, dtype=np.uint8).reshape((height, width, 4))
	gray, saturation, variants = _prepare_modalities(image, mode)
	candidate = _detect_quad(gray, saturation, variants, mode)

	min_confidence = 0.35 if mode == "upload" else 0.41
	found = False
	if candidate is not None:
		confidence = float(candidate["confidence"])
		area_ratio = float(candidate["area_ratio"])
		edge_score = float(candidate.get("edge_score", 0.0))
		found = confidence >= min_confidence or (
			confidence >= (min_confidence - 0.06)
			and area_ratio >= 0.22
			and edge_score >= 0.2
		)

	if not found:
		return json.dumps({
			"found": False,
			"confidence": 0.0 if candidate is None else round(float(candidate["confidence"]), 4),
			"area_ratio": 0.0 if candidate is None else round(float(candidate["area_ratio"]), 4),
			"edge_score": 0.0 if candidate is None else round(float(candidate.get("edge_score", 0.0)), 4),
			"contrast_score": 0.0 if candidate is None else round(float(candidate.get("contrast_score", 0.0)), 4),
			"corners": [],
			"frame_width": int(width),
			"frame_height": int(height),
		})

	corners = [[round(float(x), 3), round(float(y), 3)] for x, y in candidate["corners"]]
	return json.dumps({
		"found": True,
		"confidence": round(float(candidate["confidence"]), 4),
		"area_ratio": round(float(candidate["area_ratio"]), 4),
		"edge_score": round(float(candidate.get("edge_score", 0.0)), 4),
		"contrast_score": round(float(candidate.get("contrast_score", 0.0)), 4),
		"corners": corners,
		"frame_width": int(width),
		"frame_height": int(height),
	})
`;

const state = {
	pyodide: null,
	detector: null,
	aiModel: null,
	aiProcessor: null,
	aiReady: false,
	aiDevice: "wasm",
	pyodideReady: false,
	activeMode: "upload",
	cameraStream: null,
	cameraLoopId: null,
	detectionInFlight: false,
	lastCameraDetectionAt: 0,
	cameraDetectionInterval: 150,
	lastDetectionDurationMs: 0,
	cameraOutlierFrames: 0,
	smoothedCameraCorners: null,
	lastCameraResult: null,
	lastUploadResult: null,
	uploadObjectUrl: null,
	pendingUploadDetection: false,
	uploadImageLoaded: false,
	lastCameraSeenAt: 0,
};

const refs = {
	fileInput: document.querySelector("#fileInput"),
	fileMeta: document.querySelector("#fileMeta"),
	cameraToggle: document.querySelector("#cameraToggle"),
	cameraHint: document.querySelector("#cameraHint"),
	uploadPreview: document.querySelector("#uploadPreview"),
	cameraPreview: document.querySelector("#cameraPreview"),
	uploadOverlay: document.querySelector("#uploadOverlay"),
	cameraOverlay: document.querySelector("#cameraOverlay"),
	uploadFrame: document.querySelector("#uploadFrame"),
	cameraFrame: document.querySelector("#cameraFrame"),
	uploadPlaceholder: document.querySelector("#uploadPlaceholder"),
	cameraPlaceholder: document.querySelector("#cameraPlaceholder"),
	uploadStage: document.querySelector("#uploadStage"),
	cameraStage: document.querySelector("#cameraStage"),
	engineState: document.querySelector("#engineState"),
	detectionState: document.querySelector("#detectionState"),
	confidenceState: document.querySelector("#confidenceState"),
	activeModeLabel: document.querySelector("#activeModeLabel"),
	frameSizeLabel: document.querySelector("#frameSizeLabel"),
	cornersLabel: document.querySelector("#cornersLabel"),
	areaLabel: document.querySelector("#areaLabel"),
	liveBadge: document.querySelector("#liveBadge"),
	analysisCanvas: document.querySelector("#analysisCanvas"),
	modeButtons: [...document.querySelectorAll(".mode-button")],
	uploadPane: document.querySelector("#uploadPane"),
	cameraPane: document.querySelector("#cameraPane"),
};

function setEngineState(message) {
	refs.engineState.textContent = message;
}

function setDetectionState(message) {
	refs.detectionState.textContent = message;
}

function setConfidence(value) {
	refs.confidenceState.textContent = value;
}

function areEnginesReady() {
	return state.pyodideReady && state.aiReady;
}

function setInsightValues({ mode, frameWidth, frameHeight, corners, areaRatio }) {
	refs.activeModeLabel.textContent = mode === "camera" ? "Kamera" : "Slika";
	refs.frameSizeLabel.textContent = frameWidth && frameHeight ? `${frameWidth} x ${frameHeight}` : "-";
	refs.cornersLabel.textContent = Array.isArray(corners) && corners.length ? `${corners.length} / 4` : "-";
	refs.areaLabel.textContent = areaRatio ? `${Math.round(areaRatio * 100)}% kadra` : "-";
}

function setMode(mode) {
	if (mode === "upload" && state.cameraStream) {
		stopCamera();
	}

	state.activeMode = mode;
	refs.modeButtons.forEach((button) => {
		button.classList.toggle("is-active", button.dataset.mode === mode);
	});

	refs.uploadPane.classList.toggle("is-hidden", mode !== "upload");
	refs.cameraPane.classList.toggle("is-hidden", mode !== "camera");
	refs.uploadStage.classList.toggle("is-active", mode === "upload");
	refs.cameraStage.classList.toggle("is-active", mode === "camera");
	refs.liveBadge.textContent = mode === "camera" ? "Live kamera" : "Upload rezim";

	if (mode === "upload") {
		setInsightValues({
			mode,
			frameWidth: state.lastUploadResult?.frame_width,
			frameHeight: state.lastUploadResult?.frame_height,
			corners: state.lastUploadResult?.corners,
			areaRatio: state.lastUploadResult?.area_ratio,
		});
		redrawUploadOverlay();
		return;
	}

	setInsightValues({
		mode,
		frameWidth: state.lastCameraResult?.frame_width,
		frameHeight: state.lastCameraResult?.frame_height,
		corners: state.lastCameraResult?.corners,
		areaRatio: state.lastCameraResult?.area_ratio,
	});

	if (!state.cameraStream) {
		setDetectionState("Ukljuci kameru za live detekciju");
		setConfidence("-");
	}

	redrawCameraOverlay();
}

function clearOverlay(canvas) {
	const context = canvas.getContext("2d");
	context.clearRect(0, 0, canvas.width, canvas.height);
}

function getContainRect(sourceWidth, sourceHeight, containerWidth, containerHeight) {
	if (!sourceWidth || !sourceHeight || !containerWidth || !containerHeight) {
		return { x: 0, y: 0, width: containerWidth, height: containerHeight };
	}

	const sourceRatio = sourceWidth / sourceHeight;
	const containerRatio = containerWidth / containerHeight;

	if (sourceRatio > containerRatio) {
		const width = containerWidth;
		const height = width / sourceRatio;
		return { x: 0, y: (containerHeight - height) / 2, width, height };
	}

	const height = containerHeight;
	const width = height * sourceRatio;
	return { x: (containerWidth - width) / 2, y: 0, width, height };
}

function setupCanvasForFrame(canvas, frame) {
	const bounds = frame.getBoundingClientRect();
	const ratio = window.devicePixelRatio || 1;
	canvas.width = Math.max(1, Math.round(bounds.width * ratio));
	canvas.height = Math.max(1, Math.round(bounds.height * ratio));
	const context = canvas.getContext("2d");
	context.setTransform(ratio, 0, 0, ratio, 0, 0);
	context.clearRect(0, 0, bounds.width, bounds.height);
	return { context, width: bounds.width, height: bounds.height };
}

function drawCorners({ canvas, frame, frameWidth, frameHeight, corners, found, hold }) {
	const { context, width, height } = setupCanvasForFrame(canvas, frame);
	if (!Array.isArray(corners) || corners.length !== 4) {
		return;
	}

	const mediaRect = getContainRect(frameWidth, frameHeight, width, height);
	const scaled = corners.map(([x, y]) => ({
		x: mediaRect.x + (x / frameWidth) * mediaRect.width,
		y: mediaRect.y + (y / frameHeight) * mediaRect.height,
	}));

	context.save();
	context.lineJoin = "round";
	context.lineCap = "round";
	context.strokeStyle = hold ? "rgba(104, 240, 178, 0.55)" : "rgba(104, 240, 178, 0.98)";
	context.fillStyle = hold ? "rgba(104, 240, 178, 0.08)" : "rgba(104, 240, 178, 0.12)";
	context.lineWidth = hold ? 3 : 4;
	context.shadowColor = "rgba(104, 240, 178, 0.45)";
	context.shadowBlur = hold ? 10 : 18;

	context.beginPath();
	scaled.forEach((point, index) => {
		if (index === 0) {
			context.moveTo(point.x, point.y);
			return;
		}
		context.lineTo(point.x, point.y);
	});
	context.closePath();
	context.fill();
	context.stroke();

	scaled.forEach((point, index) => {
		context.beginPath();
		context.fillStyle = index === 0 ? "rgba(212, 107, 41, 0.95)" : "rgba(255, 248, 239, 0.95)";
		context.arc(point.x, point.y, found ? 5 : 4, 0, Math.PI * 2);
		context.fill();
	});

	context.restore();
}

function redrawUploadOverlay() {
	if (!state.lastUploadResult?.found) {
		const canvas = refs.uploadOverlay;
		const { context } = setupCanvasForFrame(canvas, refs.uploadFrame);
		context.clearRect(0, 0, canvas.width, canvas.height);
		return;
	}

	drawCorners({
		canvas: refs.uploadOverlay,
		frame: refs.uploadFrame,
		frameWidth: state.lastUploadResult.frame_width,
		frameHeight: state.lastUploadResult.frame_height,
		corners: state.lastUploadResult.corners,
		found: true,
		hold: false,
	});
}

function redrawCameraOverlay({ hold = false } = {}) {
	const result = state.lastCameraResult;
	if (!result?.corners?.length) {
		const canvas = refs.cameraOverlay;
		const { context } = setupCanvasForFrame(canvas, refs.cameraFrame);
		context.clearRect(0, 0, canvas.width, canvas.height);
		return;
	}

	drawCorners({
		canvas: refs.cameraOverlay,
		frame: refs.cameraFrame,
		frameWidth: result.frame_width,
		frameHeight: result.frame_height,
		corners: result.corners,
		found: Boolean(result.found),
		hold,
	});
}

function normalizeCorners(corners) {
	return corners.map(([x, y]) => [Number(x), Number(y)]);
}

function quadAverageDistance(cornersA, cornersB) {
	if (!Array.isArray(cornersA) || !Array.isArray(cornersB) || cornersA.length !== 4 || cornersB.length !== 4) {
		return Number.POSITIVE_INFINITY;
	}

	return cornersA.reduce((total, [ax, ay], index) => {
		const [bx, by] = cornersB[index];
		return total + Math.hypot(ax - bx, ay - by);
	}, 0) / 4;
}

function pickBetterDetection(baseResult, nextResult) {
	if (!baseResult) {
		return nextResult;
	}
	if (!nextResult) {
		return baseResult;
	}

	if (nextResult.found && !baseResult.found) {
		return nextResult;
	}
	if (baseResult.found && !nextResult.found) {
		return baseResult;
	}

	const baseConfidence = Number(baseResult.confidence || 0);
	const nextConfidence = Number(nextResult.confidence || 0);
	if (nextConfidence > baseConfidence + 0.03) {
		return nextResult;
	}

	const baseArea = Number(baseResult.area_ratio || 0);
	const nextArea = Number(nextResult.area_ratio || 0);
	if (Math.abs(nextConfidence - baseConfidence) <= 0.03 && nextArea > baseArea + 0.03) {
		return nextResult;
	}

	return baseResult;
}

function smoothCameraCorners(nextCorners, frameWidth, frameHeight) {
	if (!Array.isArray(nextCorners) || nextCorners.length !== 4) {
		return null;
	}

	if (!Array.isArray(state.smoothedCameraCorners) || state.smoothedCameraCorners.length !== 4) {
		state.smoothedCameraCorners = normalizeCorners(nextCorners);
		return state.smoothedCameraCorners;
	}

	const maxJump = Math.max(frameWidth, frameHeight) * 0.2;
	const jump = nextCorners.reduce((total, [x, y], index) => {
		const [prevX, prevY] = state.smoothedCameraCorners[index];
		return total + Math.hypot(x - prevX, y - prevY);
	}, 0) / nextCorners.length;

	if (jump > maxJump) {
		state.smoothedCameraCorners = normalizeCorners(nextCorners);
		return state.smoothedCameraCorners;
	}

	const alpha = 0.38;
	state.smoothedCameraCorners = state.smoothedCameraCorners.map(([prevX, prevY], index) => {
		const [nextX, nextY] = nextCorners[index];
		return [
			prevX + ((nextX - prevX) * alpha),
			prevY + ((nextY - prevY) * alpha),
		];
	});

	return state.smoothedCameraCorners;
}

function updateDetectionUI(result, mode) {
	if (result?.found) {
		if (mode === "camera") {
			if (result.confidence >= 0.72) {
				setDetectionState("Dokument je stabilno zakljucan u kadru");
			} else if (result.confidence >= 0.55) {
				setDetectionState("Dokument je pronadjen, poravnaj kadar za jos bolju preciznost");
			} else {
				setDetectionState("Dokument je detektovan, stabilizujem ivice");
			}
		} else {
			setDetectionState("Dokument je pronadjen na slici");
		}
		setConfidence(`${Math.round(result.confidence * 100)}%`);
	} else {
		setDetectionState(mode === "camera" ? "Trazi dokument u live kadru" : "Dokument nije dovoljno jasno izdvojen");
		setConfidence("-");
	}

	setInsightValues({
		mode,
		frameWidth: result?.frame_width,
		frameHeight: result?.frame_height,
		corners: result?.corners,
		areaRatio: result?.area_ratio,
	});
}

function getSourceDimensions(source) {
	if (source instanceof HTMLVideoElement) {
		return { width: source.videoWidth, height: source.videoHeight };
	}
	return { width: source.naturalWidth, height: source.naturalHeight };
}

function sampleToAnalysisCanvas(source, mode, forcedMaxDimension = null) {
	const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(source);
	const maxDimension = forcedMaxDimension ?? (mode === "camera" ? 640 : 1160);
	const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
	const frameWidth = Math.max(1, Math.round(sourceWidth * scale));
	const frameHeight = Math.max(1, Math.round(sourceHeight * scale));

	refs.analysisCanvas.width = frameWidth;
	refs.analysisCanvas.height = frameHeight;
	const context = refs.analysisCanvas.getContext("2d", { willReadFrequently: true });
	context.drawImage(source, 0, 0, frameWidth, frameHeight);
	return context.getImageData(0, 0, frameWidth, frameHeight);
}

async function detectDocumentFromPy(imageData, mode) {
	if (!state.pyodideReady || !state.detector) {
		return null;
	}

	const rawResult = state.detector(imageData.data, imageData.width, imageData.height, mode);
	const jsonText = typeof rawResult === "string" ? rawResult : rawResult.toString();
	if (rawResult && typeof rawResult.destroy === "function") {
		rawResult.destroy();
	}

	const parsed = JSON.parse(jsonText);

	if (parsed.found) {
		parsed.corners = normalizeCorners(parsed.corners);
	}

	return parsed;
}

async function detectDocumentDeep(imageData, mode) {
	if (!state.aiReady || !state.aiModel || !state.aiProcessor || !state.detector) {
		return null;
	}

	refs.analysisCanvas.width = imageData.width;
	refs.analysisCanvas.height = imageData.height;
	const context = refs.analysisCanvas.getContext("2d", { willReadFrequently: true });
	context.putImageData(imageData, 0, 0);

	let rawImage = RawImage.fromCanvas(refs.analysisCanvas).rgb();
	const maxDimension = mode === "camera" ? 448 : 768;
	const scale = Math.min(1, maxDimension / Math.max(rawImage.width, rawImage.height));
	if (scale < 1) {
		rawImage = await rawImage.resize(
			Math.max(1, Math.round(rawImage.width * scale)),
			Math.max(1, Math.round(rawImage.height * scale)),
		);
	}

	const { pixel_values } = await state.aiProcessor(rawImage);
	let outputs;
	try {
		outputs = await state.aiModel({ input_image: pixel_values });
	} catch (primaryCallError) {
		outputs = await state.aiModel({ pixel_values });
	}
	const modelTensor = outputs?.output_image?.[0] ?? outputs?.output_image ?? outputs?.logits?.[0] ?? outputs?.logits;
	if (!modelTensor) {
		return null;
	}

	const normalizedMask = typeof modelTensor.sigmoid === "function" ? modelTensor.sigmoid() : modelTensor;
	let maskRaw = RawImage.fromTensor(normalizedMask.mul(255).to("uint8"));
	if (maskRaw.width !== rawImage.width || maskRaw.height !== rawImage.height) {
		maskRaw = await maskRaw.resize(rawImage.width, rawImage.height);
	}

	const channels = Number(maskRaw.channels || 1);
	const maskData = maskRaw.data;
	const pixelCount = rawImage.width * rawImage.height;
	let intensitySum = 0;
	for (let i = 0; i < pixelCount; i += 1) {
		intensitySum += maskData[i * channels];
	}
	const meanIntensity = intensitySum / pixelCount;
	const threshold = Math.max(90, Math.min(185, meanIntensity + 14));

	const rgbaMask = new Uint8ClampedArray(pixelCount * 4);
	let foregroundCount = 0;
	for (let i = 0; i < pixelCount; i += 1) {
		const value = maskData[i * channels];
		const binary = value >= threshold ? 255 : 0;
		if (binary > 0) {
			foregroundCount += 1;
		}
		const offset = i * 4;
		rgbaMask[offset] = binary;
		rgbaMask[offset + 1] = binary;
		rgbaMask[offset + 2] = binary;
		rgbaMask[offset + 3] = 255;
	}

	const maskImageData = new ImageData(rgbaMask, rawImage.width, rawImage.height);
	const result = await detectDocumentFromPy(maskImageData, mode);
	if (!result) {
		return null;
	}

	const maskCoverage = foregroundCount / Math.max(pixelCount, 1);
	const aiSignal = Math.min(1, Math.max(0, ((meanIntensity / 255) * 0.55) + (maskCoverage * 0.45)));
	if (result.found) {
		result.confidence = Math.min(0.99, (Number(result.confidence || 0) * 0.82) + (aiSignal * 0.18));
	}

	return result;
}

async function detectDocument(imageData, mode) {
	if (!areEnginesReady()) {
		return null;
	}
	return detectDocumentDeep(imageData, mode);
}

async function processUploadImage() {
	if (!state.uploadImageLoaded) {
		return;
	}

	if (!areEnginesReady()) {
		state.pendingUploadDetection = true;
		setDetectionState("Ucitavam AI model i Python runtime...");
		return;
	}

	if (state.detectionInFlight) {
		return;
	}

	state.detectionInFlight = true;
	setDetectionState("Analiziram uploadovanu sliku...");

	try {
		const firstPass = sampleToAnalysisCanvas(refs.uploadPreview, "upload", 1080);
		let result = await detectDocument(firstPass, "upload");

		const shouldRefine = !result?.found || Number(result.confidence || 0) < 0.62;
		if (shouldRefine) {
			setDetectionState("Radim dodatni precizni prolaz...");
			const secondPass = sampleToAnalysisCanvas(refs.uploadPreview, "upload", 1520);
			const refined = await detectDocument(secondPass, "upload");
			result = pickBetterDetection(result, refined);
		}

		state.lastUploadResult = result;
		updateDetectionUI(result, "upload");
		redrawUploadOverlay();
	} catch (error) {
		console.error(error);
		setDetectionState("Doslo je do greske pri obradi slike");
		setConfidence("-");
	} finally {
		state.pendingUploadDetection = false;
		state.detectionInFlight = false;
	}
}

function handleUploadSelection(file) {
	if (!file) {
		return;
	}

	if (state.uploadObjectUrl) {
		URL.revokeObjectURL(state.uploadObjectUrl);
	}

	state.uploadImageLoaded = false;
	state.lastUploadResult = null;
	const objectUrl = URL.createObjectURL(file);
	state.uploadObjectUrl = objectUrl;
	refs.fileMeta.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(2)} MB`;
	refs.uploadPlaceholder.style.display = "none";
	refs.uploadPreview.classList.add("is-visible");
	refs.uploadPreview.onload = () => {
		state.uploadImageLoaded = true;
		processUploadImage();
	};
	refs.uploadPreview.src = objectUrl;
}

async function ensurePyodideReady() {
	try {
		setEngineState("Pokrecem Python geometrijski runtime...");
		const pyodide = await loadPyodide({
			indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/",
		});
		state.pyodide = pyodide;

		setEngineState("Preuzimam numpy + scikit-image pakete...");
		await pyodide.loadPackage(["numpy", "scikit-image"]);

		setEngineState("Kompajliram detektor ivica dokumenta...");
		await pyodide.runPythonAsync(PYTHON_DETECTOR_CODE);
		state.detector = pyodide.globals.get("detect_document_json");
		state.pyodideReady = true;
		setEngineState(state.aiReady
			? `AI model + Python runtime su spremni (${state.aiDevice.toUpperCase()})`
			: "Python runtime je spreman, cekam AI model");

		if (state.pendingUploadDetection) {
			await processUploadImage();
		}

		if (state.cameraStream && state.aiReady) {
			startCameraLoop();
		}
	} catch (error) {
		console.error(error);
		setEngineState("Pyodide nije uspesno ucitan");
		setDetectionState("Proveri internet konekciju i osvezi stranicu");
	}
}

async function ensureAiReady() {
	try {
		env.allowLocalModels = false;
		env.useBrowserCache = true;

		const progressCallback = (progress) => {
			if (progress?.status === "progress" && Number.isFinite(progress.progress)) {
				setEngineState(`Ucitavam AI model ${Math.round(progress.progress)}%`);
			}
		};

		setEngineState("Ucitavam DL segmentacioni model...");
		state.aiProcessor = await AutoProcessor.from_pretrained(DEEP_MODEL_ID, {
			progress_callback: progressCallback,
		});

		const wantsWebGPU = typeof navigator !== "undefined" && Boolean(navigator.gpu);
		state.aiDevice = wantsWebGPU ? "webgpu" : "wasm";

		try {
			state.aiModel = await AutoModel.from_pretrained(DEEP_MODEL_ID, {
				device: state.aiDevice,
				dtype: state.aiDevice === "webgpu" ? "fp16" : "fp32",
				progress_callback: progressCallback,
			});
		} catch (gpuError) {
			if (!wantsWebGPU) {
				throw gpuError;
			}

			state.aiDevice = "wasm";
			setEngineState("WebGPU nije stabilan, prelazim na WASM AI...");
			state.aiModel = await AutoModel.from_pretrained(DEEP_MODEL_ID, {
				device: "wasm",
				dtype: "fp32",
				progress_callback: progressCallback,
			});
		}

		state.aiReady = true;
		setEngineState(state.pyodideReady
			? `AI model + Python runtime su spremni (${state.aiDevice.toUpperCase()})`
			: `AI model je spreman (${state.aiDevice.toUpperCase()}), cekam Python runtime`);

		if (state.pendingUploadDetection) {
			await processUploadImage();
		}

		if (state.cameraStream && state.pyodideReady) {
			startCameraLoop();
		}
	} catch (error) {
		console.error(error);
		state.aiReady = false;
		setEngineState("AI model nije uspesno ucitan");
		setDetectionState("Proveri internet konekciju i osvezi stranicu");
	}
}

async function startCamera() {
	if (!navigator.mediaDevices?.getUserMedia) {
		refs.cameraHint.textContent = "Ovaj browser ne podrzava pristup kameri.";
		return;
	}

	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				facingMode: { ideal: "environment" },
				width: { ideal: 1920 },
				height: { ideal: 1080 },
			},
		});

		state.cameraStream = stream;
		state.cameraDetectionInterval = 150;
		state.lastDetectionDurationMs = 0;
		state.cameraOutlierFrames = 0;
		state.lastCameraDetectionAt = 0;
		state.lastCameraSeenAt = 0;
		state.smoothedCameraCorners = null;
		state.lastCameraResult = null;
		refs.cameraPreview.srcObject = stream;
		refs.cameraPreview.classList.remove("is-hidden");
		refs.cameraPlaceholder.style.display = "none";
		refs.cameraToggle.textContent = "Zaustavi kameru";
		refs.cameraHint.textContent = "Kamera je aktivna. Pomeri kadar dok cetvorougao ne legne na dokument.";

		await refs.cameraPreview.play();
		if (areEnginesReady()) {
			startCameraLoop();
		} else {
			setDetectionState("Kamera radi, AI model i Python runtime se jos ucitavaju");
		}
	} catch (error) {
		console.error(error);
		refs.cameraHint.textContent = "Pristup kameri nije dozvoljen ili nije dostupan na ovoj adresi.";
	}
}

function stopCamera() {
	if (state.cameraLoopId) {
		cancelAnimationFrame(state.cameraLoopId);
		state.cameraLoopId = null;
	}

	if (state.cameraStream) {
		state.cameraStream.getTracks().forEach((track) => track.stop());
		state.cameraStream = null;
	}

	state.smoothedCameraCorners = null;
	state.lastCameraResult = null;
	state.lastCameraSeenAt = 0;
	state.cameraDetectionInterval = 150;
	state.lastDetectionDurationMs = 0;
	state.cameraOutlierFrames = 0;
	state.lastCameraDetectionAt = 0;
	refs.cameraPreview.pause();
	refs.cameraPreview.srcObject = null;
	refs.cameraPreview.classList.add("is-hidden");
	refs.cameraPlaceholder.style.display = "grid";
	refs.cameraToggle.textContent = "Pokreni kameru";
	refs.cameraHint.textContent = "Kamera radi na localhost ili https adresi. Najbolji rezultat je kada je list ceo u kadru i bez jakih senki.";
	redrawCameraOverlay();

	if (state.activeMode === "camera") {
		setDetectionState("Kamera je zaustavljena");
		setConfidence("-");
		setInsightValues({ mode: "camera" });
	}
}

async function performCameraDetection() {
	if (!state.cameraStream || !state.pyodideReady || state.detectionInFlight) {
		return;
	}

	if (refs.cameraPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
		return;
	}

	state.detectionInFlight = true;
	const startedAt = performance.now();
	try {
		const imageData = sampleToAnalysisCanvas(refs.cameraPreview, "camera");
		const result = await detectDocument(imageData, "camera");
		const now = performance.now();

		if (result?.found) {
			const smoothedCorners = smoothCameraCorners(result.corners, result.frame_width, result.frame_height);
			const previousCorners = state.lastCameraResult?.corners;
			if (Array.isArray(previousCorners) && previousCorners.length === 4) {
				const drift = quadAverageDistance(smoothedCorners, previousCorners);
				const maxDrift = Math.max(result.frame_width, result.frame_height) * 0.22;
				const previousConfidence = Number(state.lastCameraResult?.confidence || 0);
				if (drift > maxDrift && Number(result.confidence || 0) < previousConfidence + 0.08) {
					state.cameraOutlierFrames += 1;
					redrawCameraOverlay({ hold: true });
					setDetectionState("Stabilizujem ivice dokumenta...");
					setConfidence(`${Math.round(previousConfidence * 100)}%`);
					return;
				}
			}

			state.cameraOutlierFrames = 0;
			result.corners = smoothedCorners;
			state.lastCameraResult = result;
			state.lastCameraSeenAt = now;
			updateDetectionUI(result, "camera");
			redrawCameraOverlay();
			return;
		}

		if (state.lastCameraResult?.corners?.length && now - state.lastCameraSeenAt < 700) {
			redrawCameraOverlay({ hold: true });
			setDetectionState("Dokument je privremeno nestao iz kadra");
			setConfidence(`${Math.round((state.lastCameraResult.confidence || 0) * 100)}%`);
			return;
		}

		state.smoothedCameraCorners = null;
		state.lastCameraResult = result;
		updateDetectionUI(result, "camera");
		redrawCameraOverlay();
	} catch (error) {
		console.error(error);
		setDetectionState("Greska tokom live detekcije");
		setConfidence("-");
	} finally {
		state.lastDetectionDurationMs = performance.now() - startedAt;
		state.cameraDetectionInterval = Math.min(320, Math.max(120, state.lastDetectionDurationMs * 1.35));
		state.detectionInFlight = false;
	}
}

function startCameraLoop() {
	if (state.cameraLoopId) {
		cancelAnimationFrame(state.cameraLoopId);
	}

	const loop = (timestamp) => {
		state.cameraLoopId = requestAnimationFrame(loop);
		if (!state.cameraStream) {
			return;
		}

		if (timestamp - state.lastCameraDetectionAt < state.cameraDetectionInterval) {
			return;
		}

		state.lastCameraDetectionAt = timestamp;
		void performCameraDetection();
	};

	state.cameraLoopId = requestAnimationFrame(loop);
}

function bindEvents() {
	refs.modeButtons.forEach((button) => {
		button.addEventListener("click", () => setMode(button.dataset.mode));
	});

	refs.fileInput.addEventListener("change", (event) => {
		const [file] = event.target.files || [];
		handleUploadSelection(file);
	});

	refs.cameraToggle.addEventListener("click", async () => {
		if (state.cameraStream) {
			stopCamera();
			return;
		}
		await startCamera();
	});

	window.addEventListener("resize", () => {
		redrawUploadOverlay();
		redrawCameraOverlay();
	});

	window.addEventListener("beforeunload", () => {
		if (state.uploadObjectUrl) {
			URL.revokeObjectURL(state.uploadObjectUrl);
		}
		stopCamera();
	});
}

function init() {
	bindEvents();
	setMode("upload");
	void ensurePyodideReady();
	void ensureAiReady();
}

init();
